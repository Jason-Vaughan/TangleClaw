'use strict';

/**
 * `project_handoff_epoch` — where handoffs began, per project (Train 21, #1586).
 *
 * The property under test throughout: a boundary is recorded once, at a moment
 * that can justify it, and is never re-derived afterwards. Everything else here
 * follows from that. A store crossing into handoff support this startup can take
 * its own maximum session id and mean it; a store that was already at v41 cannot,
 * because the instant handoffs began is not written anywhere it could read — so
 * it records the uncertainty instead of a number it would have to pretend about.
 *
 * Why that matters in one sentence: a cutoff taken too late sweeps post-epoch
 * sessions into the legacy window, which turns "a session ran and lost its
 * handoff" (recovery) into "this project predates handoffs" (no recovery) — a
 * failure in the direction of silence.
 *
 * The cases below are the six required by the Architect's ruling of 2026-09-17
 * (`train-21-epoch-migration-ruling.md`, amended into §2.7 of the plan).
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const store = require('../lib/store.js');
const continuity = require('../lib/continuity.js');
const { runPreflight, VERDICTS } = require('../lib/launch-preflight.js');

const tmpDirs = [];

/** The columns an old `projects` table carried, before this migration. */
const OLD_PROJECTS_DDL = `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE,
    engine_id TEXT NOT NULL DEFAULT 'claude', tags TEXT DEFAULT '[]', ports TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived INTEGER NOT NULL DEFAULT 0, migration_status TEXT, orchestration_profile TEXT
  );`;

/** The columns an old `sessions` table carried. */
const OLD_SESSIONS_DDL = `
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    engine_id TEXT NOT NULL, tmux_session TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'active', wrap_summary TEXT, prime_prompt TEXT, duration_seconds INTEGER,
    session_mode TEXT NOT NULL DEFAULT 'tmux', launch_mode TEXT, wrap_started_at TEXT, owner TEXT,
    launch_sha TEXT, launch_toplevel TEXT, launch_dirty TEXT
  );`;

/**
 * A `handoff_publications` table missing the constraint that makes a staged
 * attempt collide with its own replay — the v41 prerequisite v42 depends on.
 */
const DAMAGED_PUBLICATIONS_DDL = `
  CREATE TABLE handoff_publications (
    publication_id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, project_id INTEGER NOT NULL,
    session_id INTEGER NOT NULL, wrap_run_id TEXT NOT NULL, kind TEXT NOT NULL,
    state TEXT NOT NULL, file_digest TEXT NOT NULL, eligible_at TEXT, eligible_via TEXT,
    staged_at TEXT NOT NULL, published_at TEXT, superseded_at TEXT, superseded_by TEXT,
    abandoned_at TEXT, abandoned_reason TEXT
  );`;

/**
 * Seed a database at an older schema version and hand back its directory.
 *
 * Only the tables a case actually reads are seeded; `_createTables` fills in the
 * rest with CREATE IF NOT EXISTS at init, which is exactly how a real upgrade
 * reaches this code.
 *
 * @param {number} version - Schema version the store enters this startup at
 * @param {string} [extraSql] - Further DDL/rows for the case under test
 * @returns {string} The store's base directory
 */
function seedStoreAt(version, extraSql = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-epoch-'));
  tmpDirs.push(dir);
  const seed = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
  seed.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO schema_version (version) VALUES (${version});
    ${OLD_PROJECTS_DDL}
    ${OLD_SESSIONS_DDL}
    ${extraSql}
  `);
  seed.close();
  return dir;
}

/**
 * Open a seeded directory as the live store.
 * @param {string} dir - Base directory from `seedStoreAt`
 * @returns {void}
 */
function open(dir) {
  store._setBasePath(dir);
  store.init();
}

/**
 * A store on an empty temp directory — the fresh-install path.
 * @returns {string} Its base directory
 */
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-epoch-fresh-'));
  tmpDirs.push(dir);
  open(dir);
  return dir;
}

/**
 * Write a continuity index for a project, so its baseline can read clean.
 * @param {string} projectPath - Absolute project root
 * @returns {void}
 */
function writeContinuityIndex(projectPath) {
  const file = continuity.indexPath(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Continuity index\n');
}

/**
 * Every version stamp the store has recorded, ascending.
 * @returns {number[]}
 */
function stamps() {
  return store.getDb().prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version);
}

after(() => {
  try { store.close(); } catch { /* already closed */ }
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('case 1 — v40→v42 records a boundary it can justify', () => {
  it('classifies clean, unclean and empty side by side, and the cutoff is that project\'s own', () => {
    // Three projects entering the same upgrade from below v41. This startup is
    // the one crossing into handoff support, so each maximum session id really
    // is that project's boundary.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-epoch-projects-'));
    tmpDirs.push(root);
    const cleanPath = path.join(root, 'clean');
    const uncleanPath = path.join(root, 'unclean');
    fs.mkdirSync(cleanPath, { recursive: true });
    fs.mkdirSync(uncleanPath, { recursive: true });
    writeContinuityIndex(cleanPath);

    const dir = seedStoreAt(40, `
      INSERT INTO projects (id, name, path) VALUES
        (1, 'clean-proj', '${cleanPath}'),
        (2, 'unclean-proj', '${uncleanPath}'),
        (3, 'empty-proj', '${path.join(root, 'empty')}');
      INSERT INTO sessions (id, project_id, engine_id, status) VALUES
        (1, 1, 'claude', 'wrapped'),
        (2, 1, 'claude', 'wrapped'),
        (3, 2, 'claude', 'crashed');
    `);
    open(dir);

    const clean = store.handoffEpoch.get(1);
    assert.equal(clean.baseline, store.HANDOFF_BASELINES.CLEAN);
    assert.equal(clean.epochSessionId, 2, 'the cutoff is that project\'s own maximum, not the install\'s');
    assert.equal(clean.baselineReason, null);

    const unclean = store.handoffEpoch.get(2);
    assert.equal(unclean.baseline, store.HANDOFF_BASELINES.UNCLEAN);
    assert.equal(unclean.epochSessionId, 3);
    assert.match(unclean.baselineReason, /crashed/, 'the reason names which half of the baseline failed');
    assert.match(unclean.baselineReason, /no continuity index/);

    const empty = store.handoffEpoch.get(3);
    assert.equal(empty.baseline, store.HANDOFF_BASELINES.EMPTY);
    assert.equal(empty.epochSessionId, 0, 'no history means no session can ever be pre-epoch');
    assert.equal(empty.baselineReason, null);
  });

  it('a wrapped project with no continuity index is unclean, not clean', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-epoch-noindex-'));
    tmpDirs.push(root);
    fs.mkdirSync(root, { recursive: true });
    const dir = seedStoreAt(40, `
      INSERT INTO projects (id, name, path) VALUES (1, 'no-index', '${root}');
      INSERT INTO sessions (id, project_id, engine_id, status) VALUES (1, 1, 'claude', 'wrapped');
    `);
    open(dir);
    const epoch = store.handoffEpoch.get(1);
    assert.equal(epoch.baseline, store.HANDOFF_BASELINES.UNCLEAN);
    assert.match(epoch.baselineReason, /no continuity index/);
  });

  it('a project whose directory is gone reads as unclean rather than clean', () => {
    // The continuity index cannot be read, so the second half of the clean
    // baseline is unproved. Unproved is unclean.
    const dir = seedStoreAt(40, `
      INSERT INTO projects (id, name, path) VALUES (1, 'vanished', '/nonexistent/tc-epoch-vanished');
      INSERT INTO sessions (id, project_id, engine_id, status) VALUES (1, 1, 'claude', 'wrapped');
    `);
    open(dir);
    assert.equal(store.handoffEpoch.get(1).baseline, store.HANDOFF_BASELINES.UNCLEAN);
  });

  it('later sessions never move the cutoff', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-epoch-later-'));
    tmpDirs.push(root);
    writeContinuityIndex(root);
    const dir = seedStoreAt(40, `
      INSERT INTO projects (id, name, path) VALUES (1, 'later', '${root}');
      INSERT INTO sessions (id, project_id, engine_id, status) VALUES (1, 1, 'claude', 'wrapped');
    `);
    open(dir);
    const before = store.handoffEpoch.get(1);
    assert.equal(before.epochSessionId, 1);

    store.getDb().prepare(
      "INSERT INTO sessions (project_id, engine_id, status) VALUES (1, 'claude', 'wrapped')"
    ).run();
    store.close();
    open(dir);

    const after2 = store.handoffEpoch.get(1);
    assert.equal(after2.epochSessionId, 1, 'a session after the boundary must not move it');
    assert.equal(after2.recordedAt, before.recordedAt);
    assert.equal(after2.baseline, before.baseline);
  });

  it('the pre-epoch project reaches legacy, and the post-epoch session does not', () => {
    // The point of the cutoff, stated as the verdict it produces.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-epoch-verdict-'));
    tmpDirs.push(root);
    writeContinuityIndex(root);
    const dir = seedStoreAt(40, `
      INSERT INTO projects (id, name, path) VALUES (1, 'legacy-proj', '${root}');
      INSERT INTO sessions (id, project_id, engine_id, status) VALUES (1, 1, 'claude', 'wrapped');
    `);
    open(dir);
    const boundary = store.handoffEpoch.readBoundary(1);

    const legacy = runPreflight({
      projectId: 1,
      sessions: [{ id: 1, status: 'wrapped' }],
      publications: [],
      file: { state: 'absent' },
      continuityIndexPresent: true,
      handoffEpoch: boundary
    });
    assert.equal(legacy.verdict, VERDICTS.LEGACY);

    const afterEpoch = runPreflight({
      projectId: 1,
      sessions: [{ id: 1, status: 'wrapped' }, { id: 2, status: 'wrapped' }],
      publications: [],
      file: { state: 'absent' },
      continuityIndexPresent: true,
      handoffEpoch: boundary
    });
    assert.equal(afterEpoch.verdict, VERDICTS.HANDOFF_NEVER_PUBLISHED,
      'legacy acceptance ends permanently at the first session after the epoch');
  });
});

describe('case 2 — v41→v42 cannot mint a clean boundary it never recorded', () => {
  it('records the cutoff as an unclean observation, with the reason', () => {
    // This project would have classified CLEAN on a v40 store: wrapped history,
    // continuity index present. It does not here, because the store already took
    // v41 and the instant handoffs began was never written down.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-epoch-v41-'));
    tmpDirs.push(root);
    writeContinuityIndex(root);
    const dir = seedStoreAt(41, `
      INSERT INTO projects (id, name, path) VALUES (1, 'late-upgrade', '${root}');
      INSERT INTO sessions (id, project_id, engine_id, status) VALUES
        (1, 1, 'claude', 'wrapped'), (2, 1, 'claude', 'wrapped');
    `);
    open(dir);

    const epoch = store.handoffEpoch.get(1);
    assert.equal(epoch.baseline, store.HANDOFF_BASELINES.UNCLEAN);
    assert.equal(epoch.baselineReason, store.EPOCH_UNKNOWN_FROM_V41);
    assert.equal(epoch.epochSessionId, 2, 'the observation is still recorded, just not trusted as the boundary');
  });

  it('a publication-less wrap on such a store reaches recovery, never legacy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-epoch-v41-verdict-'));
    tmpDirs.push(root);
    writeContinuityIndex(root);
    const dir = seedStoreAt(41, `
      INSERT INTO projects (id, name, path) VALUES (1, 'late-verdict', '${root}');
      INSERT INTO sessions (id, project_id, engine_id, status) VALUES (1, 1, 'claude', 'wrapped');
    `);
    open(dir);

    const result = runPreflight({
      projectId: 1,
      sessions: [{ id: 1, status: 'wrapped' }],
      publications: [],
      file: { state: 'absent' },
      continuityIndexPresent: true,
      handoffEpoch: store.handoffEpoch.readBoundary(1)
    });
    assert.equal(result.verdict, VERDICTS.LEGACY_UNCLEAN,
      'honest uncertainty routes to recovery; it never becomes the clean-legacy bypass');
    assert.ok(result.reasons.includes(store.EPOCH_UNKNOWN_FROM_V41),
      'the operator is told the boundary is unknown, not that a failure was proven');
  });

  it('an empty project on an already-v41 store is still empty, not uncertain', () => {
    // There is no history to misclassify, so there is nothing to be uncertain
    // about — the conservative rule applies to boundaries, not to blank slates.
    const dir = seedStoreAt(41, `
      INSERT INTO projects (id, name, path) VALUES (1, 'no-history', '/tmp/tc-epoch-no-history');
    `);
    open(dir);
    const epoch = store.handoffEpoch.get(1);
    assert.equal(epoch.baseline, store.HANDOFF_BASELINES.EMPTY);
    assert.equal(epoch.epochSessionId, 0);
    assert.equal(epoch.baselineReason, null);
  });
});

describe('case 3 — an unclean baseline never stands between a good publication and ok', () => {
  it('a valid current publication still reaches ok on an already-v41 store', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-epoch-ok-'));
    tmpDirs.push(root);
    writeContinuityIndex(root);
    const dir = seedStoreAt(41, `
      INSERT INTO projects (id, name, path) VALUES (1, 'publishing', '${root}');
      INSERT INTO sessions (id, project_id, engine_id, status) VALUES (1, 1, 'claude', 'wrapped');
    `);
    open(dir);
    const boundary = store.handoffEpoch.readBoundary(1);
    assert.equal(boundary.baseline, store.HANDOFF_BASELINES.UNCLEAN, 'precondition: the baseline really is unclean');

    const publication = {
      publicationId: 'pub-1',
      seq: 1,
      projectId: 1,
      sessionId: 1,
      kind: 'final',
      state: 'published',
      fileDigest: 'digest-1',
      eligibleAt: '2026-09-18T01:00:00.000Z'
    };
    const result = runPreflight({
      projectId: 1,
      workspaceId: null,
      sessions: [{ id: 1, status: 'wrapped' }],
      publications: [publication],
      file: {
        state: 'valid',
        digest: 'digest-1',
        doc: { publicationId: 'pub-1', projectId: 1, workspaceId: null, worktree: null }
      },
      continuityIndexPresent: true,
      handoffEpoch: boundary
    });
    assert.equal(result.verdict, VERDICTS.OK,
      'the baseline is read only where there are no publications; good evidence outranks it');
  });
});

describe('case 4 — a retried or failed migration leaves no drift and no marker', () => {
  it('preserves an epoch left by a partial upgrade and fills only what is missing', () => {
    const dir = seedStoreAt(40, `
      CREATE TABLE project_handoff_epoch (
        project_id INTEGER PRIMARY KEY, epoch_session_id INTEGER NOT NULL,
        baseline TEXT NOT NULL CHECK (baseline IN ('clean','unclean','empty')),
        baseline_reason TEXT, recorded_at TEXT NOT NULL
      );
      INSERT INTO projects (id, name, path) VALUES
        (1, 'already-done', '/tmp/tc-epoch-done'), (2, 'not-yet', '/tmp/tc-epoch-notyet');
      INSERT INTO sessions (id, project_id, engine_id, status) VALUES
        (1, 1, 'claude', 'wrapped'), (2, 1, 'claude', 'wrapped'), (3, 2, 'claude', 'wrapped');
      INSERT INTO project_handoff_epoch VALUES (1, 1, 'clean', NULL, '2026-09-17T00:00:00.000Z');
    `);
    open(dir);

    const preserved = store.handoffEpoch.get(1);
    assert.deepEqual(
      [preserved.epochSessionId, preserved.baseline, preserved.recordedAt],
      [1, 'clean', '2026-09-17T00:00:00.000Z'],
      'a boundary already recorded is never recomputed from newer sessions'
    );
    assert.equal(store.handoffEpoch.get(2).epochSessionId, 3, 'the project that was missing one gets it');
  });

  it('a repeated boot changes nothing', () => {
    const dir = seedStoreAt(40, `
      INSERT INTO projects (id, name, path) VALUES (1, 'reboot', '/tmp/tc-epoch-reboot');
      INSERT INTO sessions (id, project_id, engine_id, status) VALUES (1, 1, 'claude', 'wrapped');
    `);
    open(dir);
    const first = store.handoffEpoch.get(1);
    const firstStamps = stamps();
    store.close();
    open(dir);
    assert.deepEqual(store.handoffEpoch.get(1), first);
    assert.deepEqual(stamps(), firstStamps, 'a boot with nothing to migrate stamps nothing');
  });

  it('refuses to advance to 42 when an existing epoch row is invalid', () => {
    // A CHECK wide enough to admit a fourth value passes the DDL gate — it does
    // carry all three baselines — and then lets a row through that the preflight
    // would read as neither clean nor unclean, falling out of both branches. The
    // migration refuses rather than replacing the row, because replacing it means
    // recomputing the one boundary it must never touch.
    const dir = seedStoreAt(40, `
      CREATE TABLE project_handoff_epoch (
        project_id INTEGER PRIMARY KEY, epoch_session_id INTEGER NOT NULL,
        baseline TEXT NOT NULL CHECK (baseline IN ('clean','unclean','empty','probably-fine')),
        baseline_reason TEXT, recorded_at TEXT NOT NULL
      );
      INSERT INTO projects (id, name, path) VALUES (1, 'bad-row', '/tmp/tc-epoch-badrow');
      INSERT INTO project_handoff_epoch VALUES (1, 4, 'probably-fine', NULL, '2026-09-17T00:00:00.000Z');
    `);
    assert.throws(() => open(dir), /baseline is "probably-fine"/);

    const db = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    const recorded = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    const row = db.prepare('SELECT * FROM project_handoff_epoch WHERE project_id = 1').get();
    db.close();
    assert.equal(recorded, 40, 'a failed initialization advertises no v42');
    assert.equal(row.baseline, 'probably-fine', 'and it rewrites nothing on the way out');
  });

  it('refuses an empty recorded_at, which NOT NULL alone lets through', () => {
    const dir = seedStoreAt(40, `
      CREATE TABLE project_handoff_epoch (
        project_id INTEGER PRIMARY KEY, epoch_session_id INTEGER NOT NULL,
        baseline TEXT NOT NULL CHECK (baseline IN ('clean','unclean','empty')),
        baseline_reason TEXT, recorded_at TEXT NOT NULL
      );
      INSERT INTO projects (id, name, path) VALUES (1, 'no-time', '/tmp/tc-epoch-notime');
      INSERT INTO project_handoff_epoch VALUES (1, 2, 'clean', NULL, '');
    `);
    assert.throws(() => open(dir), /recorded_at is empty/);
  });

  it('refuses a negative cutoff rather than treating it as no history', () => {
    const dir = seedStoreAt(40, `
      CREATE TABLE project_handoff_epoch (
        project_id INTEGER PRIMARY KEY, epoch_session_id INTEGER NOT NULL,
        baseline TEXT NOT NULL CHECK (baseline IN ('clean','unclean','empty')),
        baseline_reason TEXT, recorded_at TEXT NOT NULL
      );
      INSERT INTO projects (id, name, path) VALUES (1, 'neg', '/tmp/tc-epoch-neg');
      INSERT INTO project_handoff_epoch VALUES (1, -1, 'clean', NULL, '2026-09-17T00:00:00.000Z');
    `);
    assert.throws(() => open(dir), /epoch_session_id is -1/);
  });

  it('a successful migration stamps 42 exactly once', () => {
    const dir = seedStoreAt(40, `
      INSERT INTO projects (id, name, path) VALUES (1, 'stamped', '/tmp/tc-epoch-stamped');
    `);
    open(dir);
    const stamped = stamps();
    assert.equal(stamped.filter((v) => v === 42).length, 1,
      'the marker rides inside the epoch transaction, so the shared stamp must not write a second one');
    // Every version the store crossed, and no repeats. Written as a set rather
    // than as the literal `[40, 42]` it once was: this test is about 42 not
    // being stamped twice, and a later migration adding its own stamp is not
    // that failure — it is the normal way this list grows.
    assert.deepEqual(stamped, [...new Set(stamped)].sort((a, b) => a - b),
      'no version is stamped more than once');
    assert.ok(stamped.includes(43), 'the versions after 42 are stamped by the shared line');
  });
});

describe('case 5 — a fresh database and a project created after the migration', () => {
  it('a fresh store is at 42 and creates each project\'s epoch with the project', () => {
    // `_createTables` stamps a fresh database at the current version and the
    // upgrade blocks never run, so this path is covered by project creation, not
    // by the migration.
    const dir = freshStore();
    assert.equal(stamps().at(-1), store.CURRENT_SCHEMA_VERSION);

    const project = store.projects.create({ name: 'brand-new', path: path.join(dir, 'brand-new') });
    const epoch = store.handoffEpoch.get(project.id);
    assert.ok(epoch, 'the epoch exists before the project can have a first session');
    assert.equal(epoch.baseline, store.HANDOFF_BASELINES.EMPTY);
    assert.equal(epoch.epochSessionId, 0);
    const history = store.getDb()
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?').get(project.id);
    assert.equal(history.n, 0, 'and it has no history yet');
  });

  it('a project created on an upgraded store gets its epoch the same way', () => {
    const dir = seedStoreAt(40, `
      INSERT INTO projects (id, name, path) VALUES (1, 'incumbent', '/tmp/tc-epoch-incumbent');
    `);
    open(dir);
    const project = store.projects.create({ name: 'newcomer', path: path.join(dir, 'newcomer') });
    assert.equal(store.handoffEpoch.get(project.id).baseline, store.HANDOFF_BASELINES.EMPTY);
  });

  it('an empty epoch does not classify a corrupt artifact as a first launch', () => {
    // Integrity is decided before any exception, so a brand-new project holding
    // an unreadable handoff is still a corrupt artifact — not a clean slate.
    const dir = freshStore();
    const project = store.projects.create({ name: 'corrupt-artifact', path: path.join(dir, 'corrupt-artifact') });
    const result = runPreflight({
      projectId: project.id,
      sessions: [],
      publications: [],
      file: { state: 'invalid' },
      continuityIndexPresent: false,
      handoffEpoch: store.handoffEpoch.readBoundary(project.id)
    });
    assert.equal(result.verdict, VERDICTS.HANDOFF_CORRUPT);
  });

  it('an unexpected handoff on a project with no history is not a first launch either', () => {
    const dir = freshStore();
    const project = store.projects.create({ name: 'unexpected-artifact', path: path.join(dir, 'unexpected-artifact') });
    const result = runPreflight({
      projectId: project.id,
      workspaceId: null,
      sessions: [],
      publications: [],
      file: { state: 'valid', digest: 'd', doc: { publicationId: 'pub-x', projectId: project.id, workspaceId: null } },
      continuityIndexPresent: false,
      handoffEpoch: store.handoffEpoch.readBoundary(project.id)
    });
    assert.equal(result.verdict, VERDICTS.HANDOFF_UNEXPECTED);
  });

  it('a genuinely new project still reaches first-launch', () => {
    const dir = freshStore();
    const project = store.projects.create({ name: 'genuinely-new', path: path.join(dir, 'genuinely-new') });
    const result = runPreflight({
      projectId: project.id,
      sessions: [],
      publications: [],
      file: { state: 'absent' },
      continuityIndexPresent: false,
      handoffEpoch: store.handoffEpoch.readBoundary(project.id)
    });
    assert.equal(result.verdict, VERDICTS.FIRST_LAUNCH);
  });
});

describe('case 6 — missing evidence is reported, never backfilled', () => {
  it('a missing row reads as an unknown boundary that cannot reach legacy', () => {
    // The row is gone but the project has history. The tempting repair — take
    // today\'s MAX(id) — is precisely what grants the legacy acceptance the
    // missing row cannot justify, so the read answers with a cutoff of 0.
    const dir = seedStoreAt(40, `
      INSERT INTO projects (id, name, path) VALUES (1, 'lost-row', '/tmp/tc-epoch-lostrow');
      INSERT INTO sessions (id, project_id, engine_id, status) VALUES
        (1, 1, 'claude', 'wrapped'), (2, 1, 'claude', 'wrapped');
    `);
    open(dir);
    store.getDb().prepare('DELETE FROM project_handoff_epoch WHERE project_id = 1').run();

    const boundary = store.handoffEpoch.readBoundary(1);
    assert.equal(boundary.present, false, 'the caller can see this is an integrity condition');
    assert.equal(boundary.epochSessionId, 0, 'no late MAX(id) backfill');
    assert.equal(boundary.baseline, store.HANDOFF_BASELINES.UNCLEAN);
    assert.equal(boundary.baselineReason, store.EPOCH_ROW_MISSING);

    const result = runPreflight({
      projectId: 1,
      sessions: [{ id: 1, status: 'wrapped' }, { id: 2, status: 'wrapped' }],
      publications: [],
      file: { state: 'absent' },
      continuityIndexPresent: true,
      handoffEpoch: boundary
    });
    assert.equal(result.verdict, VERDICTS.HANDOFF_NEVER_PUBLISHED,
      'a project with history and no recorded boundary reaches recovery');
  });

  it('get() answers null for a missing row, so absence is never mistaken for a record', () => {
    freshStore();
    assert.equal(store.handoffEpoch.get(4242), null);
  });

  it('refuses to advance when the v41 publication prerequisites are damaged', () => {
    // A store that entered at 41 skipped the gate that checked this, which is
    // why v42 re-checks it: the epoch draws a line in front of a publication
    // table that must be able to enforce attempt-exact eligibility.
    const dir = seedStoreAt(41, `
      ${DAMAGED_PUBLICATIONS_DDL}
      INSERT INTO projects (id, name, path) VALUES (1, 'damaged', '/tmp/tc-epoch-damaged');
    `);
    assert.throws(() => open(dir), /v41→42 did not create handoff_publications with UNIQUE \(session_id, wrap_run_id\)/);

    const db = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
    const recorded = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    const epochRows = db.prepare('SELECT COUNT(*) AS n FROM project_handoff_epoch').get().n;
    db.close();
    assert.equal(recorded, 41, 'no v42 marker after a failed initialization');
    assert.equal(epochRows, 0, 'and no rows admitted against a boundary that was never validated');
  });

  it('refuses to advance when the epoch table cannot constrain its own baseline', () => {
    const dir = seedStoreAt(40, `
      CREATE TABLE project_handoff_epoch (
        project_id INTEGER, epoch_session_id INTEGER NOT NULL,
        baseline TEXT NOT NULL, baseline_reason TEXT, recorded_at TEXT NOT NULL
      );
      INSERT INTO projects (id, name, path) VALUES (1, 'unkeyed', '/tmp/tc-epoch-unkeyed');
    `);
    assert.throws(() => open(dir), /keyed by project_id/);
  });

  it('ensureEmpty never overwrites a boundary that already exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-epoch-ensure-'));
    tmpDirs.push(root);
    writeContinuityIndex(root);
    const dir = seedStoreAt(40, `
      INSERT INTO projects (id, name, path) VALUES (1, 'existing', '${root}');
      INSERT INTO sessions (id, project_id, engine_id, status) VALUES (1, 1, 'claude', 'wrapped');
    `);
    open(dir);
    const before = store.handoffEpoch.get(1);
    assert.equal(before.baseline, store.HANDOFF_BASELINES.CLEAN);

    const after2 = store.handoffEpoch.ensureEmpty(1);
    assert.deepEqual(after2, before, 're-deriving a recorded boundary is the one thing this must never do');
  });
});

describe('the baseline vocabulary exists in two places and must stay one list', () => {
  it('the store\'s constant and the preflight\'s are the same set', () => {
    // `lib/store.js` writes the SQL CHECK from its list; `lib/launch-preflight.js`
    // branches rows 7 and 8 on its own copy, and it keeps a copy on purpose —
    // importing the store would give a module whose whole contract is "reads
    // nothing" a database dependency.
    //
    // The cost of that separation is that nothing stops them drifting, and the
    // drift is silent in the worst direction: a baseline the store can write but
    // the preflight matches in neither branch falls out of both and every legacy
    // project degrades to the catch-all. This is the assertion that makes the
    // duplication safe, so it is the thing to fix rather than delete if it reds.
    const { BASELINES } = require('../lib/launch-preflight.js');
    assert.deepEqual(
      [...store.HANDOFF_BASELINE_VALUES].sort(),
      Object.values(BASELINES).sort(),
      'add the value to BOTH lists, or the preflight cannot classify what the store can store'
    );
  });
});
