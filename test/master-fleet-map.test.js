'use strict';

/*
 * #950 — the fleet map carries state, and says where it has none.
 *
 * FLEET.md is the Project Master's whole picture of what it coordinates. It
 * used to carry name, engine and path: enough to say a project EXISTS, nothing
 * about what it is DOING.
 *
 * The defect class these guards exist for is not "a field is missing" — it is
 * "two different facts render identically". A project with no live session and
 * a project whose liveness could not be established are opposite situations for
 * a coordinator: one is safe to act on, the other is the case where acting is
 * most dangerous. `lib/projects.js` already distinguishes them (`active: null`
 * with `incomplete: ['active']` vs `active: false`), so the map has no excuse
 * for flattening them, and every pair below asserts they diverge.
 *
 * `buildFleetMap` is pure, so these drive it with records rather than standing
 * up a fleet. The fixtures are shaped like `listProjects` output — enriched
 * records carrying `git`/`session` objects whose `incomplete` arrays are
 * present-and-empty when healthy, which is the contract those modules state.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const master = require('../lib/master');

/** A raw store row — what `store.projects.list()` returns. No state keys. */
function rawRow(over = {}) {
  return { name: 'Raw', engineId: 'claude', path: '/p/Raw', archived: false, ...over };
}

/** An enriched record — the shape `listProjects` resolves to. */
function enriched(over = {}) {
  return {
    name: 'Enriched',
    engineId: 'claude',
    engine: { id: 'claude', name: 'Claude Code', available: true },
    path: '/p/Enriched',
    archived: false,
    version: '1.2.3',
    unreadable: null,
    git: {
      branch: 'main',
      dirty: false,
      lastCommit: 'do a thing',
      lastCommitAge: '2 hours ago',
      latestTag: 'v1.2.3',
      incomplete: [],
      cause: null
    },
    session: {
      active: false,
      status: 'ended',
      startedAt: null,
      tmuxSession: null,
      incomplete: [],
      cause: null
    },
    ...over
  };
}

/** The line for one project, from a one-project map. */
function line(project) {
  const md = master.buildFleetMap([project]);
  const found = md.split('\n').find((l) => l.startsWith('- **'));
  assert.ok(found, 'the map must render a line for the project');
  return found;
}

describe('#950 — an unknown and an absence must not render the same', () => {
  it('separates "no live session" from "liveness could not be established"', () => {
    const none = line(enriched({
      session: { active: false, status: 'ended', startedAt: null, tmuxSession: null, incomplete: [], cause: null }
    }));
    const unknown = line(enriched({
      session: {
        active: null, status: 'active', startedAt: '2026-08-16 19:36', tmuxSession: 'Enriched',
        incomplete: ['active'], cause: 'read-timed-out'
      }
    }));

    assert.notEqual(none, unknown,
      'the two render identically — a coordinator cannot tell "nothing running" from "nobody looked"');
    assert.match(none, /no live session/);
    assert.match(unknown, /could not be established/i);
    assert.doesNotMatch(unknown, /no live session/,
      'an unestablished read must never be reported as an absent session');
    assert.match(unknown, /read-timed-out/, 'and it must carry why');
  });

  it('separates a clean tree from a tree whose dirtiness was not established', () => {
    // `dirty: null` is the read that did not get there. Rendering it as clean
    // tells the master a tree is safe to act on when nobody knows.
    const clean = line(enriched());
    const unknown = line(enriched({
      git: { branch: 'main', dirty: null, lastCommitAge: '2 hours ago', incomplete: ['dirty'], cause: 'read-timed-out' }
    }));

    assert.notEqual(clean, unknown);
    assert.match(clean, /\bclean\b/);
    assert.match(unknown, /dirty-state unknown/);
    assert.doesNotMatch(unknown, /\bclean\b/, 'an unread tree must not be called clean');
  });

  it('separates a branch it read from a branch it could not', () => {
    const known = line(enriched());
    const unknown = line(enriched({
      git: { branch: null, dirty: null, incomplete: ['branch', 'dirty'], cause: 'read-timed-out' }
    }));

    assert.notEqual(known, unknown);
    assert.match(known, /\bmain\b/);
    assert.match(unknown, /branch not established/);
  });

  it('separates "not a git repository" from "the git read fell short"', () => {
    // Caught on live data before it shipped: the first draft rendered a null
    // `git` as "git could not be read", which invents a failure for every
    // non-repo project on the fleet. `lib/dir-scanner-child.js#_gitInfo` returns
    // null for "not a repository, or git is absent" and an OBJECT carrying
    // `incomplete`/`cause` when a read genuinely fell short — opposite facts.
    const notRepo = line(enriched({ git: null }));
    const failedRead = line(enriched({
      git: { branch: null, dirty: null, incomplete: ['branch', 'dirty'], cause: 'read-timed-out' }
    }));

    assert.notEqual(notRepo, failedRead);
    assert.match(notRepo, /not a git repository/);
    assert.doesNotMatch(notRepo, /could not|not established|unknown/i,
      'a directory that is simply not a repo has nothing to report as unestablished');
    assert.match(failedRead, /not established/);
  });

  it('reports an unreadable directory once, instead of a row of separate unknowns', () => {
    const l = line(enriched({
      unreadable: 'EACCES', unreadableCode: 'TC_EACCES',
      version: null, git: null, session: null
    }));
    assert.match(l, /could not read the project directory/i);
    assert.match(l, /EACCES/);
    // The directory not answering is ONE fact. Repeating it per field would
    // bury the cause under its own consequences.
    assert.doesNotMatch(l, /dirty-state unknown/);
    assert.doesNotMatch(l, /branch not established/);
  });

  it('treats a missing version as an absence, not as an unknown', () => {
    // The mirror of the `git: null` correction. On a READABLE directory a null
    // version means the project has no version file; only the degraded path
    // nulls it for a reason, and that path always sets `unreadable`, which the
    // renderer branches on separately. Calling this "not established" would
    // manufacture an unknown out of a nothing.
    const noVersion = line(enriched({ version: null }));
    assert.doesNotMatch(noVersion, /version not established/);
    assert.doesNotMatch(noVersion, /version/i,
      'a project with no version has nothing to say about one');
    assert.match(noVersion, /\bmain\b/, 'and the rest of its state still renders');
    assert.match(line(enriched()), /v1\.2\.3/);
  });
});

describe('#950 — the identity-only pass declares itself', () => {
  it('says state was not gathered, so absence is not read as a report', () => {
    const md = master.buildFleetMap([rawRow()]);
    assert.match(md, /Identity only in this pass/);
    assert.match(md, /Absence of a state line below means nobody looked/);
    // And it must not invent state it never gathered.
    assert.doesNotMatch(md, /no live session/,
      'a pass that gathered nothing must not claim a project has no session');
    assert.doesNotMatch(md, /\bclean\b/);
  });

  it('drops the banner once records carry state', () => {
    const md = master.buildFleetMap([enriched()]);
    assert.doesNotMatch(md, /Identity only in this pass/);
    assert.match(md, /session/);
  });

  it('decides per record, so a mixed list does not mislabel either half', () => {
    // Derived from the records rather than passed as a flag, because a flag can
    // disagree with its data.
    const md = master.buildFleetMap([enriched(), rawRow()]);
    const enrichedLine = md.split('\n').find((l) => l.includes('**Enriched**'));
    const rawLine = md.split('\n').find((l) => l.includes('**Raw**'));
    assert.match(enrichedLine, /session/, 'the enriched record still reports its state');
    assert.doesNotMatch(rawLine, /session/, 'the raw row reports none, and claims none');
  });
});

describe('#950 — what the fleet map already did, it still does', () => {
  it('keeps the do-not-edit stamp, the heading and the path', () => {
    const md = master.buildFleetMap([rawRow()]);
    assert.match(md, /Generated by TangleClaw/);
    assert.match(md, /do not edit/);
    assert.match(md, /# Fleet map/);
    assert.match(md, /\/p\/Raw/);
  });

  it('still marks archived projects and engine-less ones', () => {
    assert.match(line(rawRow({ archived: true })), /ARCHIVED/);
    assert.match(line(rawRow({ engineId: null })), /no engine/);
  });

  it('still says so when nothing is registered', () => {
    assert.match(master.buildFleetMap([]), /\(no projects registered\)/);
  });

  it('prefers the enriched engine object over the raw id when both are present', () => {
    assert.match(line(enriched({ engine: { id: 'codex', name: 'Codex' }, engineId: 'claude' })), /codex/);
  });

  it('carries a generated-at stamp when given one, for the drift check to read', () => {
    const md = master.buildFleetMap([rawRow()], { generatedAt: '2026-08-16T22:00:00Z' });
    assert.match(md, /generated-at: 2026-08-16T22:00:00Z/);
    // Omitted rather than faked when the caller has no stamp to give.
    assert.doesNotMatch(master.buildFleetMap([rawRow()]), /generated-at/);
  });

  it('tolerates a malformed record instead of taking the whole map down', () => {
    // The map is written from a poll; one bad record must not cost the master
    // its entire picture of the fleet.
    const md = master.buildFleetMap([{ name: 'Odd', path: '/p/Odd', session: undefined, git: undefined }]);
    assert.match(md, /\*\*Odd\*\*/);
  });
});

describe('#950 — refreshFleetMap writes only the fleet map', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  /** A master home with a seeded memory dir. @returns {string} */
  function seedHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fleet-'));
    fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
    return home;
  }

  it('rewrites FLEET.md and leaves the master-owned files untouched', async () => {
    const home = seedHome();
    const mem = path.join(home, 'memory');
    for (const f of ['MEMORY.md', 'NOTES.md', 'CHANGELOG.md']) {
      fs.writeFileSync(path.join(mem, f), `MASTER OWNED ${f}`);
    }
    fs.writeFileSync(path.join(mem, 'FLEET.md'), 'stale');

    const res = await master.refreshFleetMap({
      home,
      listProjects: async () => [enriched()],
      generatedAt: '2026-08-16T22:00:00Z'
    });

    assert.equal(res.refreshed, true);
    assert.equal(res.count, 1);
    assert.match(fs.readFileSync(path.join(mem, 'FLEET.md'), 'utf8'), /session/);
    for (const f of ['MEMORY.md', 'NOTES.md', 'CHANGELOG.md']) {
      assert.equal(fs.readFileSync(path.join(mem, f), 'utf8'), `MASTER OWNED ${f}`,
        `${f} is the master's — TC must never overwrite it`);
    }
  });

  it('coalesces concurrent callers into one fleet read', async () => {
    // Not tidiness. `listProjects` is the path the ten-second dashboard poll
    // drives, and `lib/dir-scanner.js` starts each request's deadline at ISSUE
    // time against a SERIAL child — so a second caller's reads queue while their
    // clocks run, and a healthy project can burn its deadline waiting its turn
    // and earn the Full Disk Access hint it did not deserve (#884/#891).
    const home = seedHome();
    let reads = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const lister = async () => { reads += 1; await gate; return [enriched()]; };

    const all = Promise.all([
      master.refreshFleetMap({ home, listProjects: lister }),
      master.refreshFleetMap({ home, listProjects: lister }),
      master.refreshFleetMap({ home, listProjects: lister })
    ]);
    release();
    const results = await all;

    assert.equal(reads, 1, 'three concurrent callers must cost ONE fleet read');
    assert.deepEqual(results.map((r) => r.count), [1, 1, 1],
      'and every caller still gets a real result');
  });

  it('starts a fresh read once the previous one has settled', async () => {
    // The latch must not wedge the map at its first snapshot for the life of
    // the process — coalescing is per-flight, not once-ever.
    const home = seedHome();
    let reads = 0;
    const lister = async () => { reads += 1; return [enriched()]; };
    await master.refreshFleetMap({ home, listProjects: lister });
    await master.refreshFleetMap({ home, listProjects: lister });
    assert.equal(reads, 2);
  });

  it('releases the latch when the fleet read throws', async () => {
    // A rejected read that left the latch set would silently disable every
    // later refresh for the process's lifetime — the map would freeze without
    // anything saying so.
    const home = seedHome();
    await assert.rejects(master.refreshFleetMap({
      home, listProjects: async () => { throw new Error('scanner died'); }
    }), /scanner died/);

    let reads = 0;
    const res = await master.refreshFleetMap({
      home, listProjects: async () => { reads += 1; return [enriched()]; }
    });
    assert.equal(reads, 1, 'a later refresh must still run');
    assert.equal(res.refreshed, true);
  });

  it('does nothing when no master home exists, so boot cannot create one', async () => {
    const absent = path.join(os.tmpdir(), 'tc-fleet-absent-' + process.pid);
    let asked = false;
    const res = await master.refreshFleetMap({
      home: absent,
      listProjects: async () => { asked = true; return []; }
    });
    assert.equal(res.refreshed, false);
    assert.equal(asked, false,
      'it must not even enumerate the fleet for an operator who has never opened the master');
    assert.equal(fs.existsSync(absent), false);
  });
});

describe('#950 — the state pass is wired, and wired where home resolves', () => {
  const { before, after } = require('node:test');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const store = require('../lib/store');

  // `refreshMasterIdentity` loads config, so this suite needs a store — an
  // ISOLATED one, on its own base path, exactly as test/master.test.js does.
  let storeDir;
  before(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fleet-store-'));
    store._setBasePath(storeDir);
    store.init();
  });
  after(() => {
    store.close();
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  /**
   * Run `refreshMasterIdentity` against a temp home with the fleet read stubbed.
   * @param {object} opts - Extra options for refreshMasterIdentity.
   * @returns {{home: string, asked: () => number, settle: () => Promise<void>}}
   */
  function driveIdentity(opts) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fleet-wire-'));
    let asked = 0;
    let seenHome = null;
    master.refreshMasterIdentity({
      home,
      refreshFleet: async (o) => { asked += 1; seenHome = o.home; return { refreshed: false, count: 0 }; },
      ...opts
    });
    return { home, asked: () => asked, seenHome: () => seenHome };
  }

  it('refreshMasterIdentity starts the state pass only when asked', () => {
    // Opt-in on purpose: most callers of this function are tests that want file
    // writes and nothing else, and an always-on read would make every one of
    // them enumerate the real fleet.
    assert.equal(driveIdentity({ fleetState: true }).asked(), 1);
    assert.equal(driveIdentity({}).asked(), 0);
  });

  it('the state pass resolves home the same way the identity write does', () => {
    // The whole reason this trigger lives in master.js rather than at the
    // server's call sites. Called from server.js it resolved os.homedir()
    // regardless of what the caller passed, so a route test could overwrite the
    // OPERATOR'S real ~/.tangleclaw/master/memory/FLEET.md with an empty fleet.
    const d = driveIdentity({ fleetState: true });
    assert.equal(d.seenHome(), d.home,
      'a caller-supplied home must reach the fleet pass, or tests write to the real one');
  });

  it('the sync pass stamps generated-at, which the drift check consumes', () => {
    // The governing spec treats the stamp as an invariant of this file, and the
    // next build item compares it against the master's own observed-at notes.
    // An identity-only map with no stamp is undatable.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fleet-stamp-'));
    master._refreshMasterMemory(home, { projects: [], generatedAt: '2026-08-16T22:00:00Z' });
    const md = fs.readFileSync(path.join(home, 'memory', 'FLEET.md'), 'utf8');
    assert.match(md, /generated-at: 2026-08-16T22:00:00Z/);
  });

  it('_refreshMasterMemory renders the projects it is handed', () => {
    // The seam refreshMasterIdentity uses; without a caller-supplied list it
    // falls back to the raw store rows, which is the identity-only path.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fleet-seam-'));
    master._refreshMasterMemory(home, {
      projects: [{
        name: 'Handed', engineId: 'claude', path: '/p/Handed', archived: false,
        version: '9.9.9', unreadable: null,
        git: { branch: 'topic', dirty: true, incomplete: [], cause: null },
        session: { active: false, status: 'ended', incomplete: [], cause: null }
      }]
    });
    const md = fs.readFileSync(path.join(home, 'memory', 'FLEET.md'), 'utf8');
    assert.match(md, /\*\*Handed\*\*/);
    assert.match(md, /v9\.9\.9/);
    assert.match(md, /DIRTY/);
    assert.doesNotMatch(md, /Identity only in this pass/,
      'records carrying state must suppress the identity-only banner');
  });

  it('the identity-only banner does not promise a trigger that does not exist', () => {
    // It used to say the map refreshes "when the dashboard polls" — the poll
    // never writes this file. A banner in the honesty surface must not be the
    // one false claim in it.
    const md = master.buildFleetMap([{ name: 'Raw', engineId: 'claude', path: '/p/Raw' }]);
    assert.doesNotMatch(md, /dashboard polls/);
    assert.match(md, /at server boot and when the master\s+session is opened/);
    // And it must own the ambiguity it cannot resolve from inside the file.
    assert.match(md, /not finished yet or it failed/);
  });
});
