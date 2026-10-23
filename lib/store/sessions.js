'use strict';

/**
 * The sessions domain of the store: the lifecycle vocabulary and its
 * transition map, `sessionsApi`, and the row mappers that read a session row
 * back, launch blocker and launch baseline included.
 *
 * The facade binds the handle with `_bind` from `init()` and unbinds it from
 * `close()`. The launch-sequence insert that `start()` runs inside its
 * transaction and the handoff api that `wrap()` binds a publication through
 * are required from their own modules, neither of which requires this one;
 * the launch domain reads this module's vocabulary through its own binding
 * instead, so no require cycle can hand either a half-built export.
 *
 * Unbinding also forgets the launch-blocker values warned about: those keys
 * name rows of the database just closed, and another database opened in the
 * same process reuses session ids for different rows.
 *
 * Everything below is moved from `lib/store.js` unchanged (#2248); what this
 * file adds is the handle, its binder and guard, and the export list.
 *
 * @module lib/store/sessions
 */

const crypto = require('node:crypto');
const { createLogger } = require('../logger');
const { StoreError } = require('./_db');
const { activityApi } = require('./activity');
const { _insertLaunchSequence } = require('./launch');
const { handoffsApi } = require('./handoffs');

// The logger keeps the facade's name so every log line this domain writes
// reads exactly as it did before the move.
const log = createLogger('store');

let _db = null;

/**
 * Bind the database handle the facade opened, or unbind it with `null`.
 * Unbinding clears the launch-blocker warning memory (see the module header).
 * @param {import('node:sqlite').DatabaseSync|null} db - The open database, or null on close.
 * @returns {void}
 */
function _bind(db) {
  _db = db;
  if (!db) _launchBlockerWarned.clear();
}

/**
 * Refuse while THIS module holds no handle. Over the module's own handle, not
 * the handle module's: a domain the facade forgot to bind would otherwise pass
 * the shared guard and read a null handle. Checking here is what makes that
 * slip fail at the first use with `NOT_INITIALIZED`.
 * @returns {void}
 * @throws {StoreError} `NOT_INITIALIZED` when the facade has not bound this module.
 */
function _ensureDb() {
  if (!_db) {
    throw new StoreError('Store not initialized. Call store.init() first.', 'NOT_INITIALIZED');
  }
}

// ── Sessions (store layer only — lifecycle in lib/sessions.js) ──

/**
 * The session lifecycle vocabulary (#1034). `active` is the only non-terminal
 * status; the other three each record HOW a session stopped, and nothing
 * follows them.
 *
 * There is deliberately no wrap-in-progress value. A wrap is a pipeline running
 * in this process, and `lib/wrap-run-registry.js` is where that fact lives: a
 * persisted row saying "wrapping" would survive a restart the pipeline itself
 * cannot, so it would durably record something false. The registry's empty
 * answer after a boot is the true one.
 *
 * `degraded` and `ended` are NOT session statuses despite appearing as status
 * strings elsewhere in the codebase — they belong to `lib/model-status.js`, the
 * health check, and `ai-content.js`'s gateway states.
 * @type {Readonly<{ACTIVE: string, WRAPPED: string, KILLED: string, CRASHED: string}>}
 */
const SESSION_STATUS = Object.freeze({
  ACTIVE: 'active',
  WRAPPED: 'wrapped',
  KILLED: 'killed',
  CRASHED: 'crashed'
});

/**
 * Every value `sessions.status` may hold, as a list.
 * @type {readonly string[]}
 */
const SESSION_STATUSES = Object.freeze(Object.values(SESSION_STATUS));

/**
 * The allowed transitions, keyed by the status being left. Every status has an
 * entry, so an absent key is a modelling error rather than "anything goes", and
 * the three terminal statuses map to an empty list because a session that has
 * ended does not end again.
 *
 * This is not a description — `_transitionSession` derives its SQL precondition
 * from it, so a transition missing here cannot be written. That is what stops a
 * second `kill` on an ended session from rewriting `ended_at` and appending a
 * duplicate `session.killed` row to the activity log, which is the history
 * anyone auditing the lifecycle has to read.
 * @type {Readonly<Object<string, readonly string[]>>}
 */
const SESSION_STATUS_TRANSITIONS = Object.freeze({
  [SESSION_STATUS.ACTIVE]: Object.freeze([
    SESSION_STATUS.WRAPPED, SESSION_STATUS.KILLED, SESSION_STATUS.CRASHED
  ]),
  [SESSION_STATUS.WRAPPED]: Object.freeze([]),
  [SESSION_STATUS.KILLED]: Object.freeze([]),
  [SESSION_STATUS.CRASHED]: Object.freeze([])
});

/**
 * Whether a session may move from one status to another.
 * @param {string} from - Current status
 * @param {string} to - Proposed status
 * @returns {boolean} - True only if the transition is modelled
 */
function canTransition(from, to) {
  const allowed = SESSION_STATUS_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * The statuses a session may hold and still reach `to` — the inverse of the
 * transition map, and the precondition every status write is guarded by.
 * @param {string} to - Target status
 * @returns {string[]} - Statuses from which `to` is reachable
 */
function _statusSourcesFor(to) {
  return SESSION_STATUSES.filter((from) => canTransition(from, to));
}

/**
 * Move a session to a terminal status, refusing any transition the map does not
 * allow.
 *
 * A refusal is a no-op, not a throw: the kill and wrap routes — and a great many
 * fixtures — call these as "end it if it is still live", and turning that benign
 * redundancy into an exception would buy nothing. It is not silent either: the
 * refusal is logged, and `changed` is what the public writers turn into `null`
 * so a caller can tell a transition it performed from one it did not.
 *
 * @param {number} id - Session id
 * @param {string} to - Target status
 * @param {string} setClause - Extra SQL assignments, applied with `status`
 * @param {any[]} setParams - Parameters for `setClause`, in order
 * @returns {{session: object|null, changed: boolean}} - The row as it now
 *   stands (unchanged on a refusal), and whether this call wrote it
 */
function _transitionSession(id, to, setClause, setParams) {
  const sources = _statusSourcesFor(to);
  // An unmodelled target leaves `sources` empty, and that needs no special
  // case: SQLite reads `status IN ()` as the empty set, so the UPDATE matches
  // nothing and falls into the same refusal below as any other transition the
  // map does not allow. Checked, not assumed — the plausible-looking guard here
  // would have been keyed to a parse error that does not happen.
  const placeholders = sources.map(() => '?').join(', ');
  const result = _db.prepare(
    `UPDATE sessions SET status = ?, ${setClause}
       WHERE id = ? AND status IN (${placeholders})`
  ).run(to, ...setParams, id, ...sources);

  const session = _getSessionById(id);
  if (result.changes === 0) {
    log.warn('Refused a session status transition the lifecycle does not allow', {
      session: id, from: session ? session.status : null, to
    });
    return { session, changed: false };
  }
  return { session, changed: true };
}

const sessionsApi = {
  /**
   * Get the active session for a project.
   *
   * `started_at` is second-resolution, so two rows created in the same second
   * tie — and this lookup decides which session a wrap or a kill lands on. The
   * id breaks the tie toward the newer row, which is the one the operator is
   * looking at; without it SQLite picks, and it picked the older one.
   *
   * Every session ordering in this API breaks the tie the same way, including
   * the ones that return a list: `list` feeds a LIMIT, so there too the tie
   * decides which rows a caller sees.
   * @param {number} projectId - Project id
   * @returns {object|null}
   */
  getActive(projectId) {
    _ensureDb();
    const row = _db.prepare(
      `SELECT * FROM sessions WHERE project_id = ? AND status = ?
         ORDER BY started_at DESC, id DESC LIMIT 1`
    ).get(projectId, SESSION_STATUS.ACTIVE);
    return row ? _rowToSession(row) : null;
  },

  /**
   * Get a session by its globally-unique id (any status, any project).
   * Public wrapper over the internal id lookup — added for the
   * session-ownership primitive (#347), which resolves a session from a
   * handle even after it has ended (e.g. routing to a known address).
   * @param {number} id - Session id
   * @returns {object|null}
   */
  get(id) {
    _ensureDb();
    return _getSessionById(id);
  },

  /**
   * List every live session across all projects, most-recently-started first.
   * The getActive/list helpers above are project-scoped; this is the fleet-wide
   * view the session-ownership primitive's (#347) listLive() consumer needs.
   *
   * `active` is the whole of "live" — it is the only non-terminal status, and a
   * session stays `active` for the duration of its wrap, so a wrapping agent is
   * included here exactly as it always was.
   * @returns {object[]}
   */
  listLiveAll() {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM sessions WHERE status = ? ORDER BY started_at DESC, id DESC'
    ).all(SESSION_STATUS.ACTIVE).map(_rowToSession);
  },

  /**
   * List sessions for a project.
   * @param {number} projectId - Project id
   * @param {object} [options]
   * @param {string} [options.status] - Filter by status
   * @param {number} [options.limit] - Max results (default 20)
   * @returns {object[]}
   */
  list(projectId, options = {}) {
    _ensureDb();
    let sql = 'SELECT * FROM sessions WHERE project_id = ?';
    const params = [projectId];

    if (options.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }
    // The id tiebreak is not cosmetic here: this ORDER BY feeds a LIMIT, so two
    // rows sharing a second-resolution `started_at` decide which of them falls
    // inside the page. Every session ordering in this API breaks the tie the
    // same way — see `getActive`.
    sql += ' ORDER BY started_at DESC, id DESC';
    sql += ` LIMIT ${options.limit || 20}`;

    return _db.prepare(sql).all(...params).map(_rowToSession);
  },

  /**
   * Get the most recent session for a project (any status).
   *
   * Same second-resolution tie as `getActive`, broken the same way.
   * @param {number} projectId - Project id
   * @returns {object|null}
   */
  getLatest(projectId) {
    _ensureDb();
    const row = _db.prepare(
      'SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC, id DESC LIMIT 1'
    ).get(projectId);
    return row ? _rowToSession(row) : null;
  },

  /**
   * The session that came immediately before a given one in the same project,
   * by session id (any status).
   *
   * Session id is the ordering the launch preflight uses for "the prior
   * session" (`lib/launch-preflight.js#_newestSession`), so this names the same
   * session it judged.
   * @param {number} projectId - Project id
   * @param {number} sessionId - The session to look behind
   * @returns {object|null} Null when the project has no earlier session
   */
  getPreviousInProject(projectId, sessionId) {
    _ensureDb();
    const row = _db.prepare(
      'SELECT * FROM sessions WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT 1'
    ).get(projectId, sessionId);
    return row ? _rowToSession(row) : null;
  },

  /**
   * Count sessions for a project.
   * @param {number} projectId - Project id
   * @param {object} [options]
   * @param {string} [options.status] - Filter by status
   * @returns {number}
   */
  count(projectId, options = {}) {
    _ensureDb();
    let sql = 'SELECT COUNT(*) as count FROM sessions WHERE project_id = ?';
    const params = [projectId];
    if (options.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }
    const row = _db.prepare(sql).get(...params);
    return row ? row.count : 0;
  },

  /**
   * Start a new session.
   * @param {object} data
   * @param {number} data.projectId - Project id
   * @param {string} data.engineId - Engine profile id
   * @param {string} [data.tmuxSession] - tmux session name
   * @param {string} [data.primePrompt] - Prime prompt text
   * @param {string} [data.sessionMode='tmux'] - Session mode ('tmux' or 'webui')
   * @param {{sha:string, toplevel:string, dirty:({paths:string[], truncated:boolean}|null)}|null} [data.launchBaseline]
   *   From `lib/launch-baseline.js#capture`; null/absent when the project is not a repo.
   * @param {object} [data.launchSequence] - The launch sequence to bind to this session in the
   *   same transaction (`lib/launch-sequence.js#buildSnapshot`). A failure to write it fails the
   *   whole start, so no session row exists without its sequence.
   * @returns {object} - Created session
   */
  start(data) {
    _ensureDb();
    if (!data.projectId || !data.engineId) {
      throw new StoreError('projectId and engineId are required', 'BAD_REQUEST');
    }
    const baseline = data.launchBaseline && data.launchBaseline.sha ? data.launchBaseline : null;
    const insertSession = () => {
      _db.prepare(
        `INSERT INTO sessions (project_id, engine_id, tmux_session, prime_prompt, session_mode, launch_mode, owner,
           launch_sha, launch_toplevel, launch_dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        data.projectId,
        data.engineId,
        data.tmuxSession || null,
        data.primePrompt || null,
        data.sessionMode || 'tmux',
        data.launchMode || null,
        data.owner || null,
        baseline ? baseline.sha : null,
        baseline ? baseline.toplevel || null : null,
        baseline && baseline.dirty ? JSON.stringify(baseline.dirty) : null
      );
      const row = _db.prepare('SELECT * FROM sessions WHERE id = last_insert_rowid()').get();
      return _rowToSession(row);
    };

    let session;
    if (data.launchSequence) {
      // The launch id is bound in the same transaction as the session row, so a
      // sequence can exist only for a session that does, and a failed bind
      // leaves no session row either (Train 21, #1579).
      _db.exec('BEGIN IMMEDIATE');
      try {
        session = insertSession();
        _insertLaunchSequence(session.id, data.projectId, data.engineId, data.launchSequence);
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
    } else {
      session = insertSession();
    }
    activityApi.log({
      projectId: data.projectId,
      sessionId: session.id,
      eventType: 'session.started',
      detail: { engine: data.engineId, primeLength: (data.primePrompt || '').length }
    });
    return session;
  },

  /**
   * Read a session's launch baseline (#1309, #1406) — the HEAD and dirty-path set
   * captured when it launched. Kept off the session object every API serves; the
   * wrap is its only reader.
   *
   * @param {number} id - Session id
   * @returns {{sha:string, toplevel:(string|null), dirty:({paths:string[], truncated:boolean}|null)}|null}
   *   Null for an unknown session, a non-repo project, or a session launched
   *   before the baseline existed.
   */
  getLaunchBaseline(id) {
    _ensureDb();
    const row = _db.prepare('SELECT id, launch_sha, launch_toplevel, launch_dirty FROM sessions WHERE id = ?').get(id);
    return row ? _launchBaselineFromRow(row) : null;
  },

  /**
   * The active session whose pane is this tmux session, if there is one. For a
   * caller that holds only a pane's name and needs the session's standing
   * launch blocker (#2128).
   * @param {string} tmuxSession - tmux session name
   * @returns {object|null}
   */
  getActiveByTmuxSession(tmuxSession) {
    _ensureDb();
    if (!tmuxSession) return null;
    const row = _db.prepare('SELECT * FROM sessions WHERE tmux_session = ? AND status = ? ORDER BY id DESC LIMIT 1')
      .get(tmuxSession, SESSION_STATUS.ACTIVE);
    return row ? _rowToSession(row) : null;
  },

  /**
   * Record what is keeping a launch from being typed into (#2128): an engine's
   * startup dialog nobody has answered. The row keeps it after the pane dies,
   * which is the point: a death is noticed by a later status read, when the
   * screen that explained it no longer exists.
   *
   * Only an ACTIVE session takes one. A blocker written onto a session that
   * has already ended would rewrite the account of how it ended.
   *
   * Recording the code already stored is a no-op: nothing is written and
   * nothing is logged, so the stored blocker keeps saying when the dialog was
   * first seen. Two readers can each see one dialog — the boot watch, and a
   * send holding a row read before the watch wrote — and the decision is made
   * here, under one write lock, so neither has to know about the other.
   * @param {number} id - Session id
   * @param {{code: string, label: string, meaning: string, engineId?: (string|null)}} blocker - What was seen
   * @returns {object|null} The session as it stands with its blocker, or null when the session takes no
   *   blocker (no code given, or no such active session)
   */
  setLaunchBlocker(id, blocker) {
    _ensureDb();
    if (!blocker || typeof blocker.code !== 'string' || !blocker.code) return null;
    const stored = JSON.stringify({
      code: blocker.code,
      label: blocker.label || blocker.code,
      meaning: blocker.meaning || '',
      engineId: blocker.engineId || null,
      observedAt: new Date().toISOString()
    });
    let written = false;
    let current = null;
    _db.exec('BEGIN IMMEDIATE');
    try {
      current = _getSessionById(id);
      if (!current || current.status !== SESSION_STATUS.ACTIVE) {
        current = null;
      } else if (!current.launchBlocker || current.launchBlocker.code !== blocker.code) {
        _db.prepare('UPDATE sessions SET launch_blocker = ? WHERE id = ? AND status = ?')
          .run(stored, id, SESSION_STATUS.ACTIVE);
        written = true;
      }
      _db.exec('COMMIT');
    } catch (err) {
      try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw err;
    }
    if (!written) return current;
    const session = _getSessionById(id);
    activityApi.log({
      projectId: session.projectId,
      sessionId: id,
      eventType: 'session.launch_blocked',
      detail: { code: blocker.code, label: session.launchBlocker.label, meaning: session.launchBlocker.meaning }
    });
    return session;
  },

  /**
   * Clear a launch blocker once what caused it is gone: the operator answered
   * the dialog and the engine reached its prompt. Only an active session's is
   * cleared, so a session that died behind its dialog keeps saying why.
   * @param {number} id - Session id
   * @returns {object|null} The session, or null when there was nothing to clear
   */
  clearLaunchBlocker(id) {
    _ensureDb();
    const before = _getSessionById(id);
    if (!before || !before.launchBlocker || before.status !== SESSION_STATUS.ACTIVE) return null;
    const res = _db.prepare('UPDATE sessions SET launch_blocker = NULL WHERE id = ? AND status = ?')
      .run(id, SESSION_STATUS.ACTIVE);
    if (!res.changes) return null;
    activityApi.log({
      projectId: before.projectId,
      sessionId: id,
      eventType: 'session.launch_unblocked',
      detail: { code: before.launchBlocker.code }
    });
    return _getSessionById(id);
  },

  /**
   * Wrap a session (set status='wrapped', capture summary).
   *
   * **`null` means this call did not wrap it** — the session had already ended,
   * or there is no such row. Reading `.status` back cannot answer that for
   * `wrap`: a refusal on an already-`wrapped` row reads identically to success,
   * which is why the outcome travels in the return value rather than the row.
   * @param {number} id - Session id
   * @param {string} [summary] - Wrap summary markdown
   * @param {object} [options]
   * @param {string} [options.publicationId] - A staged final handoff attempt to bind in the same transaction
   * @param {string} [options.wrapRunId] - The run that staged it
   * @param {boolean} [options.requireBound] - Roll the transition back unless the attempt binds;
   *   throws `StoreError` `PUBLICATION_NOT_BOUND`, with nothing changed
   * @returns {object|null} - The wrapped session, or null if this call did not wrap it
   */
  wrap(id, summary, options = {}) {
    _ensureDb();

    /**
     * The lifecycle transition itself, plus — when this wrap staged a handoff —
     * the eligibility binding for that exact attempt.
     * @returns {{session: object|null, changed: boolean, publicationBound: boolean|null}}
     */
    const transition = () => {
      const { session, changed } = _transitionSession(
        id,
        SESSION_STATUS.WRAPPED,
        `ended_at = datetime('now'),
         wrap_summary = ?,
         duration_seconds = CAST((julianday(datetime('now')) - julianday(started_at)) * 86400 AS INTEGER)`,
        [summary || null]
      );
      // A refused transition (Kill won the race) binds nothing: the attempt did
      // not complete, so it must not be able to claim it did.
      if (!changed || !options.publicationId) {
        return { session, changed, publicationBound: options.publicationId ? false : null };
      }
      const publicationBound = handoffsApi.bindLifecycleEligibility(
        options.publicationId, id, options.wrapRunId, new Date().toISOString()
      );
      // A caller whose end is only valid WITH its handoff (governed finalization,
      // #2027) asks for both or neither: the throw rolls the transition back.
      if (options.requireBound && !publicationBound) {
        throw new StoreError('the handoff attempt could not be bound to this session end', 'PUBLICATION_NOT_BOUND');
      }
      return { session, changed, publicationBound };
    };

    // Train 21, #1585: when this wrap staged a handoff, the `active → wrapped`
    // UPDATE and the eligibility binding commit or fail TOGETHER. Splitting
    // them is what would let a wrapped session carry an unbound attempt, or an
    // attempt claim a lifecycle that never completed.
    let result;
    if (options.publicationId) {
      _db.exec('BEGIN IMMEDIATE');
      try {
        result = transition();
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
    } else {
      result = transition();
    }

    const { session, changed, publicationBound } = result;
    if (changed && session) {
      activityApi.log({
        projectId: session.projectId,
        sessionId: id,
        eventType: 'session.wrapped',
        detail: { durationSeconds: session.durationSeconds, summaryLength: (summary || '').length }
      });
    }
    if (!changed) return null;
    // The publication verdict rides on the session object rather than changing
    // the return contract: every existing caller reads a session or null, and
    // only the handoff-aware caller looks for this.
    return options.publicationId ? { ...session, publicationBound } : session;
  },

  /**
   * Kill a session (set status='killed').
   *
   * **`null` means this call did not kill it** — the session had already ended,
   * or there is no such row. Same contract as `wrap`.
   * @param {number} id - Session id
   * @param {string} [reason] - Kill reason
   * @returns {object|null} - The killed session, or null if this call did not kill it
   */
  kill(id, reason) {
    _ensureDb();
    const { session, changed } = _transitionSession(
      id,
      SESSION_STATUS.KILLED,
      `ended_at = datetime('now'),
       duration_seconds = CAST((julianday(datetime('now')) - julianday(started_at)) * 86400 AS INTEGER)`,
      []
    );
    if (changed && session) {
      activityApi.log({
        projectId: session.projectId,
        sessionId: id,
        eventType: 'session.killed',
        detail: { reason: reason || 'Manual kill' }
      });
    }
    return changed ? session : null;
  },

  /**
   * Mark a session as crashed.
   *
   * **`null` means this call did not record the crash** — the session had
   * already ended, or there is no such row. Same contract as `wrap`.
   *
   * A session that died with a launch blocker still on it died behind that
   * blocker, and the activity entry says so (`cause`): "tmux session died" is
   * what was observed, the blocker is why.
   * @param {number} id - Session id
   * @param {string} [error] - Error description
   * @returns {object|null} - The crashed session, or null if this call did not record it
   */
  markCrashed(id, error) {
    _ensureDb();
    const { session, changed } = _transitionSession(
      id,
      SESSION_STATUS.CRASHED,
      `ended_at = datetime('now'),
       duration_seconds = CAST((julianday(datetime('now')) - julianday(started_at)) * 86400 AS INTEGER)`,
      []
    );
    if (changed && session) {
      activityApi.log({
        projectId: session.projectId,
        sessionId: id,
        eventType: 'session.crashed',
        detail: {
          error: error || 'Unknown',
          ...(session.launchBlocker ? { cause: session.launchBlocker.code, causeMeaning: session.launchBlocker.meaning } : {})
        }
      });
    }
    return changed ? session : null;
  }
};

/**
 * Get a session by id (internal helper).
 * @param {number} id - Session id
 * @returns {object|null}
 */
function _getSessionById(id) {
  const row = _db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  return row ? _rowToSession(row) : null;
}

/**
 * Convert a SQLite session row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToSession(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    engineId: row.engine_id,
    tmuxSession: row.tmux_session,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    wrapSummary: row.wrap_summary,
    primePrompt: row.prime_prompt,
    durationSeconds: row.duration_seconds,
    sessionMode: row.session_mode || 'tmux',
    launchMode: row.launch_mode || null,
    wrapStartedAt: row.wrap_started_at || null,
    owner: row.owner || null,
    launchBlocker: _launchBlockerFromRow(row)
    // The launch baseline is deliberately NOT here: this object is what every
    // session API serves, and the baseline carries up to thousands of repo paths
    // that only the wrap reads. `store.sessions.getLaunchBaseline(id)` is its read.
  };
}

/**
 * How many damaged launch-blocker values the store remembers having warned
 * about. Every session read parses the column, so without a memory one damaged
 * row would log on every poll; without a cap a long-running server would grow
 * that memory for as long as new damaged values keep appearing. When it is full
 * it is cleared, so the cost of the cap is one repeated warning per value.
 */
const LAUNCH_BLOCKER_WARN_CAP = 1000;

/** Keys (session id + digest of the raw value) already warned about. */
const _launchBlockerWarned = new Set();

/**
 * Warn, once per (session, raw value), that a stored launch blocker could not
 * be read. The value itself is never logged: the column can hold anything that
 * was written to it, so only its length is.
 * @param {object} row - Raw sessions row whose `launch_blocker` is damaged
 * @param {string} reason - `not JSON` or `no code`
 */
function _warnUnreadableLaunchBlocker(row, reason) {
  const raw = String(row.launch_blocker);
  const key = `${row.id}:${crypto.createHash('sha256').update(raw).digest('hex')}`;
  if (_launchBlockerWarned.has(key)) return;
  if (_launchBlockerWarned.size >= LAUNCH_BLOCKER_WARN_CAP) _launchBlockerWarned.clear();
  _launchBlockerWarned.add(key);
  log.warn('A session\'s launch blocker could not be read; it reads as no blocker', {
    sessionId: row.id, reason, length: raw.length
  });
}

/**
 * Read a session row's launch blocker. A value that is missing, will not parse,
 * or names no code is `null`: a blocker nobody can name is not one a reader
 * can act on. A value that is present but unreadable is logged once (see
 * {@link _warnUnreadableLaunchBlocker}), so a damaged row is never dropped
 * silently.
 * @param {object} row - Raw sessions row
 * @returns {{code: string, label: string, meaning: string, engineId: (string|null), observedAt: (string|null)}|null}
 */
function _launchBlockerFromRow(row) {
  if (!row.launch_blocker) return null;
  let parsed;
  try {
    parsed = JSON.parse(row.launch_blocker);
  } catch {
    _warnUnreadableLaunchBlocker(row, 'not JSON');
    return null;
  }
  if (!parsed || typeof parsed.code !== 'string' || !parsed.code) {
    _warnUnreadableLaunchBlocker(row, 'no code');
    return null;
  }
  return {
    code: parsed.code,
    label: typeof parsed.label === 'string' ? parsed.label : parsed.code,
    meaning: typeof parsed.meaning === 'string' ? parsed.meaning : '',
    engineId: typeof parsed.engineId === 'string' ? parsed.engineId : null,
    observedAt: typeof parsed.observedAt === 'string' ? parsed.observedAt : null
  };
}

/**
 * Read a session row's launch baseline back into the shape `launch-baseline.js`
 * captured. A row with no `launch_sha` has no baseline at all. A `launch_dirty`
 * that is missing or will not parse becomes `dirty: null` — "not captured", which
 * the ownership check treats as no snapshot, never as "nothing was dirty".
 *
 * @param {object} row - Raw sessions row
 * @returns {{sha:string, toplevel:(string|null), dirty:({paths:string[], truncated:boolean}|null)}|null}
 */
function _launchBaselineFromRow(row) {
  if (!row.launch_sha) return null;
  let dirty = null;
  if (row.launch_dirty) {
    try {
      const parsed = JSON.parse(row.launch_dirty);
      if (parsed && Array.isArray(parsed.paths)) {
        dirty = { paths: parsed.paths.filter((p) => typeof p === 'string'), truncated: parsed.truncated === true };
        // Identity fingerprints (#2027) ride the same JSON. A row written before
        // they existed has none, and readers treat that as "cannot verify".
        if (parsed.fingerprints && typeof parsed.fingerprints === 'object' && !Array.isArray(parsed.fingerprints)
            && Number.isInteger(parsed.fingerprintVersion)) {
          dirty.fingerprintVersion = parsed.fingerprintVersion;
          dirty.fingerprints = parsed.fingerprints;
          if (parsed.worktrees && typeof parsed.worktrees === 'object' && parsed.worktrees.entries
              && typeof parsed.worktrees.entries === 'object') {
            dirty.worktrees = parsed.worktrees;
          }
        }
      }
    } catch {
      log.warn('sessions.launch_dirty is not valid JSON; treating the launch dirty set as not captured', { id: row.id });
    }
  }
  return { sha: row.launch_sha, toplevel: row.launch_toplevel || null, dirty };
}

module.exports = {
  _bind,
  sessionsApi,
  SESSION_STATUS,
  SESSION_STATUSES,
  SESSION_STATUS_TRANSITIONS,
  canTransition,
  _transitionSession,
  LAUNCH_BLOCKER_WARN_CAP
};
