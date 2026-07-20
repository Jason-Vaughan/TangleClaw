'use strict';

/**
 * `learnings-db-write` wrap step (#466) — mirrors this session's freshly-captured
 * learnings from the markdown log into the SQLite `learnings` table so the D1
 * self-improvement loop actually has data.
 *
 * **Why this exists.** The `learnings-capture` ai-content step (which runs just
 * before this one) hands the AI a prompt that appends a `## YYYY-MM-DD — <title>`
 * entry to `<project>/.tangleclaw/memories/learnings.md`. That markdown file is the
 * human-readable log, but nothing ever wrote those learnings to the DB — so
 * `store.learnings.getActive()` (injected into the next session's prime by
 * `generatePrimePrompt`) and the D1b learnings→rule promote loop were permanently
 * empty (`SELECT COUNT(*) FROM learnings` → 0 across every project). This step
 * closes that gap: markdown stays the source of truth; the DB mirrors it.
 *
 * **Contract (ADR 0002 step philosophy — never blocks).**
 *   - Skip when there is no project path, `learnings.md` is missing, it holds no
 *     entry dated today, or every today-entry is already a row (dedup).
 *   - Otherwise insert one `learnings` row per new today-entry via
 *     `store.learnings.create({projectId, content, tier:'provisional', sourceSession})`
 *     and return `status:'done'` with the inserted count. Any failure degrades to
 *     a skip — a wrap must never block on learnings bookkeeping.
 *
 * **Parse contract.** Entries follow the `learnings-capture` prompt convention: a
 * `## YYYY-MM-DD — <title>` heading followed by a prose body, terminated by the
 * next `## ` heading or EOF. Only entries whose date equals *today* (local-zoned,
 * matching the prompt's `YYYY-MM-DD`) are considered — older entries were written
 * (and mirrored) in prior sessions. The honest "no novel learnings" sentinel line
 * (`- YYYY-MM-DD: no novel learnings (routine work).`) is not a `##` heading, so it
 * is naturally ignored. Stored `content` is the full entry (heading + body,
 * trimmed) so the DB row reads the same as the markdown.
 *
 * **Idempotence.** Dedup is an exact `content` match against the project's existing
 * rows, so re-running the wrap (a retry) inserts nothing the second time.
 *
 * **No filesystem staging.** Unlike the index/memory steps, this writes directly to
 * the SQLite store (the `learnings` table is not a git-tracked artifact — like the
 * activity log and port leases written during a wrap), so it does not participate in
 * the commit step's single-transaction flush.
 *
 * @module lib/wrap-steps/learnings-db-write
 */

const fs = require('node:fs');
const path = require('node:path');
const { todayIsoLocal } = require('./_date');
const { createLogger } = require('../logger');
const store = require('../store');

const log = createLogger('wrap-step-learnings-db-write');

const LEARNINGS_RELPATH = path.join('.tangleclaw', 'memories', 'learnings.md');

// A dated entry heading: `## YYYY-MM-DD — <title>` (em-dash or hyphen separator).
// The date is captured; the rest of the line is the title (kept in the stored
// content verbatim via the raw heading line, so this only needs the date).
const ENTRY_HEADING_RE = /^##\s+(\d{4}-\d{2}-\d{2})\b/;

/**
 * Step handler. See module docstring for the full contract.
 *
 * @param {object} context - Pipeline runner context.
 * @param {object} context.project - Project record (`{id, name, path}`).
 * @returns {Promise<{ok:boolean, status:string, output:object, blockers:string[]}>}
 */
async function run(context) {
  const { project } = context;
  if (!project || !project.path) {
    return _skipped('no project path');
  }
  if (!project.id) {
    return _skipped('no project id (learnings rows key on project_id)');
  }

  const learningsPath = path.join(project.path, LEARNINGS_RELPATH);
  let content;
  try {
    if (!_internal.existsSync(learningsPath)) {
      return _skipped('no learnings.md');
    }
    content = _internal.readFileSync(learningsPath, 'utf8');
  } catch (err) {
    return _skipped(`learnings.md unreadable: ${err.message}`);
  }

  const today = _internal.todayIso();
  const entries = _parseTodayEntries(content, today);
  if (entries.length === 0) {
    return _skipped(`no learnings.md entry dated ${today}`);
  }

  // Two different comparisons, doing two different jobs.
  //
  // Exact content match is the retry guard: re-running a wrap the same day must
  // not double-insert. It cannot detect RECURRENCE, though, because the stored
  // content begins with the entry's own `## YYYY-MM-DD` heading — the same
  // insight written on a later day is a different string by construction.
  //
  // The recurrence key strips that date and normalizes, so "we learned this
  // again" is detectable. That matters because a re-observed learning is the
  // signal `learnings.confirm` uses to advance provisional → active, and
  // without it every learning stays provisional forever and never reaches a
  // future session's prime (#569).
  let stored;
  try {
    stored = store.learnings.list(project.id);
  } catch (err) {
    return _skipped(`learnings.list failed: ${err.message}`);
  }
  const existing = new Set(stored.map((l) => l.content));
  const byRecurrenceKey = new Map();
  for (const row of stored) {
    const key = _recurrenceKey(row.content);
    // Oldest row wins: confirmations should accrue to one canonical row rather
    // than scattering across near-duplicates.
    if (key && !byRecurrenceKey.has(key)) byRecurrenceKey.set(key, row);
  }

  const notAlreadyStored = entries.filter((e) => !existing.has(e));

  // Recurrences confirm the row they repeat instead of inserting a near-twin.
  const fresh = [];
  let confirmed = 0;
  let promoted = 0;
  for (const entry of notAlreadyStored) {
    const prior = byRecurrenceKey.get(_recurrenceKey(entry));
    if (!prior) {
      fresh.push(entry);
      continue;
    }
    try {
      const after = store.learnings.confirm(prior.id);
      confirmed += 1;
      // A learning recorded on two different days is recurring, and that is the
      // bar for it reaching future sessions. `confirm()` alone would not promote
      // here: its own threshold is 2 CONFIRMATIONS, i.e. three sightings, which
      // is a general-purpose contract this step should not bend for everyone
      // else. But three exact repeats of a normalized learning almost never
      // happen in practice, so deferring to it would leave the tier gate shut
      // and reproduce the dead-end this step exists to open (#569).
      if (after && after.tier === 'provisional') {
        store.learnings.setTier(prior.id, 'active');
        promoted += 1;
      } else if (prior.tier === 'provisional' && after && after.tier === 'active') {
        promoted += 1;
      }
    } catch (err) {
      // A failed confirmation must not sink the wrap or the other entries.
      log.warn('learnings.confirm failed for a recurring entry — continuing', {
        project: project.name, learningId: prior.id, error: err.message
      });
    }
  }

  if (fresh.length === 0 && confirmed === 0) {
    return _skipped(`all ${entries.length} today-entr${entries.length === 1 ? 'y' : 'ies'} already in the DB`);
  }

  // Best-effort session attribution — nullable; a missing active session (e.g. a
  // WebUI wrap) must not prevent the insert.
  let sourceSession = null;
  try {
    const active = store.sessions.getActive(project.id);
    sourceSession = active ? active.id : null;
  } catch {
    sourceSession = null;
  }

  let inserted = 0;
  for (const entryContent of fresh) {
    try {
      store.learnings.create({ projectId: project.id, content: entryContent, tier: 'provisional', sourceSession });
      inserted += 1;
    } catch (err) {
      // One bad row shouldn't sink the rest or block the wrap.
      log.warn('learnings.create failed for one entry — continuing', { project: project.name, error: err.message });
    }
  }

  if (inserted === 0 && confirmed === 0) {
    return _skipped(`found ${fresh.length} new today-entr${fresh.length === 1 ? 'y' : 'ies'} but all inserts failed`);
  }

  log.info('mirrored today learnings into the DB', { project: project.name, inserted, confirmed, promoted, today });
  const parts = [];
  if (inserted > 0) parts.push(`${inserted} learning${inserted === 1 ? '' : 's'} written to the DB`);
  if (confirmed > 0) {
    parts.push(`${confirmed} recurring learning${confirmed === 1 ? '' : 's'} confirmed`
      + (promoted > 0 ? ` (${promoted} promoted to active)` : ''));
  }
  return {
    ok: true,
    status: 'done',
    output: {
      inserted,
      confirmed,
      promoted,
      today,
      detail: parts.join('; ')
    },
    blockers: []
  };
}

/**
 * A date-independent identity for a learning, used to recognise the same
 * insight recorded on a later day.
 *
 * Stored entries begin with their own `## YYYY-MM-DD — <title>` heading, so the
 * raw text of a repeated learning never matches its earlier self. Dropping the
 * date and normalizing whitespace and case leaves title + body, which is what
 * "the same learning" actually means here.
 *
 * Deliberately an EXACT match after normalization rather than a fuzzy one: a
 * confirmation advances a learning into every future session's prime, so a
 * false match promotes something the operator never saw twice. Reworded
 * recurrences are missed, which costs a promotion; wrong matches would cost
 * trust in the whole loop.
 *
 * @param {string} content - Stored entry text (heading + body)
 * @returns {string} Normalized key, or '' when there is nothing to key on
 */
function _recurrenceKey(content) {
  if (!content || typeof content !== 'string') return '';
  return content
    .replace(ENTRY_HEADING_RE, '##')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Parse `learnings.md` and return the trimmed full text of every entry whose
 * `## YYYY-MM-DD — <title>` heading is dated `today`. An entry spans from its
 * heading line through the line before the next `## ` heading (or EOF).
 *
 * @param {string} markdown - Full `learnings.md` content.
 * @param {string} today - Local-zoned `YYYY-MM-DD`.
 * @returns {string[]} One trimmed entry (heading + body) per today-dated section.
 */
function _parseTodayEntries(markdown, today) {
  if (!markdown || typeof markdown !== 'string') return [];
  const lines = markdown.split('\n');
  const out = [];
  let current = null; // { isToday: boolean, buf: string[] }
  const flush = () => {
    if (current && current.isToday) {
      const text = current.buf.join('\n').trim();
      if (text) out.push(text);
    }
    current = null;
  };
  for (const line of lines) {
    const m = line.match(ENTRY_HEADING_RE);
    if (m) {
      flush();
      current = { isToday: m[1] === today, buf: [line] };
    } else if (current) {
      current.buf.push(line);
    }
    // Lines before the first `## ` heading (the file's title/preamble) are ignored.
  }
  flush();
  return out;
}

/**
 * Canonical non-blocking skip result.
 * @param {string} reason
 * @returns {{ok:boolean, status:string, output:object, blockers:string[]}}
 */
function _skipped(reason) {
  return {
    ok: true,
    status: 'skipped',
    output: { reason, detail: reason },
    blockers: []
  };
}

// Seam for tests — mirrors the pattern in sibling wrap steps.
const _internal = {
  readFileSync: fs.readFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  todayIso: todayIsoLocal
};

module.exports = {
  run,
  _parseTodayEntries,
  _skipped,
  _internal,
  LEARNINGS_RELPATH
};
