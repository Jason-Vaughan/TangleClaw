'use strict';

// Chunk G slice 1 (#331) — the Project Master singleton: identity generation,
// idempotent ensure, tmux-truth status, and the two operator API routes.
// The master is deliberately NOT a sessions row / project — tests pin that
// invariant. tmux and engine detection are injected fakes: tests must never
// create a real `tangleclaw-master` session or launch a real engine.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

// The generated base URL derives its port from TANGLECLAW_PORT before config
// (#654), and a dev session launched *by* TangleClaw inherits that variable from
// the server process — which would silently override every config-driven port
// assertion below and make results depend on how the test runner was started.
// Neutralize the ambient value; tests that mean to exercise the override set it
// explicitly and restore it.
delete process.env.TANGLECLAW_PORT;

const store = require('../lib/store');

/**
 * A no-op fleet refresher for `ensureMasterSession`.
 *
 * Without it every call here fires an unawaited REAL fleet pass — `listProjects`
 * → a dir-scanner fork plus `tmux list-sessions` — against a store pointing at
 * temp project paths, racing this file's own `after()` teardown. It stayed green
 * only because `refreshMasterIdentity` catches the resulting write failure and
 * this file logs at `error`, which is the shape of a test that passes for the
 * wrong reason.
 */
const NO_FLEET = async () => ({ refreshed: false, count: 0 });
const master = require('../lib/master');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-'));
  store._setBasePath(tmpDir);
  store.init();
});

after(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Fake tmux with programmable liveness; records createSession calls.
 *
 * `hasSession` is DERIVED from `probeSession` here exactly as it is in
 * `lib/tmux.js`, rather than being a second independent switch. A stub that let
 * the two disagree could report a combination the real module cannot produce,
 * and the whole subject of these tests is what the caller does with the
 * distinction between them.
 *
 * @param {object} [opts] - Options.
 * @param {boolean} [opts.alive] - Whether the session is live.
 * @param {boolean} [opts.answered] - Whether tmux replied at all. `false` is
 *   the wedged server (#94/#144/#380) — the state that reports every session
 *   as gone unless a caller asks for the third outcome.
 * @param {Function} [opts.createSession] - Override the creation behaviour
 *   (return false, throw) without hand-rolling a stub that would be free to
 *   omit `probeSession` and drift from the real module's shape.
 * @returns {object} A tmux-shaped stub.
 */
function fakeTmux({ alive = false, answered = true, createSession } = {}) {
  const calls = [];
  const probeSession = () => ({
    live: answered ? alive : false,
    answered,
    cause: answered ? null : 'read-timed-out'
  });
  return {
    calls,
    probeSession,
    // Modelled because `getMasterStatus` asks it (#968). Defaults to "answered,
    // no such session", which is the neutral honest answer for a stub that is
    // not modelling a live session's age — it yields `identityStale: false`, so
    // tests that do not care about freshness keep a boring payload. Tests that
    // DO care override this rather than the code defending against a stub that
    // does not model the module.
    sessionCreatedAt: () => ({ createdAt: null, answered, cause: answered ? null : 'read-timed-out' }),
    hasSession: () => probeSession().live,
    createSession: (name, opts) => {
      calls.push({ name, opts });
      return createSession ? createSession(name, opts) : true;
    }
  };
}

const availableEngines = {
  detectEngine: () => ({ available: true }),
  // _masterRuntime resolves through the injected lib (#707), so the stub must
  // answer resolution too — otherwise these tests silently fall back to the real
  // detector and their result depends on the host's installed CLIs.
  resolveDefaultEngine: (config) => (config && config.defaultEngine) || 'claude'
};

/**
 * An engines stub whose resolution uses the REAL precedence over a controlled
 * installed-set. `availableEngines` above is a pass-through that ignores
 * availability entirely, so it cannot exercise a fallback — it returns the same
 * answer whether or not the resolver is wired in, which is how the master-pin
 * bypass survived its own test.
 * @param {string[]} installed - Engine ids present on the imagined machine
 * @returns {object}
 */
function enginesInstalling(installed) {
  const realEngines = require('../lib/engines');
  const list = ['claude', 'codex', 'aider'].map((id) => ({ id, available: installed.includes(id) }));
  return {
    detectEngine: (profile) => ({ available: installed.includes(profile && profile.id) }),
    resolveDefaultEngine: (config) => realEngines.resolveDefaultEngine(config, list)
  };
}

describe('buildMasterClaudeMd', () => {
  it('carries the generated marker, the role, and both boundaries', () => {
    const md = master.buildMasterClaudeMd({ serverPort: 3101 });
    assert.match(md, /Generated by TangleClaw — Project Master identity/);
    assert.match(md, /TangleClaw Project Master/);
    // The API boundary is UNCONDITIONAL and must stay that way: #755 grants a
    // file-write tier, never API authority (decision B defers that to its own
    // issue). A change here would widen a boundary this work did not touch.
    assert.match(md, /Read-only\./);
    assert.match(md, /Use only GET endpoints/);
    // The FILE boundary now defers to the access level, but its restrictive
    // reading has to survive on its own for a reader who never reaches that
    // section.
    assert.match(md, /Do not edit files outside this directory/);
    assert.match(md, /unless your access level allows it/);
  });

  it('the Read API quick reference carries the awareness view — the Master is one of its two consumers', () => {
    // Ambient-awareness Chunk 05: "sessions that never became aware" surfaces
    // on the dashboard AND to the Project Master; the Master's half is this
    // quick-reference row, so dropping it silently halves the surface.
    const md = master.buildMasterClaudeMd({ serverPort: 3101 });
    assert.match(md, /GET \/api\/awareness/);
    assert.match(md, /confirmed\/sent\/unverified\/unaware/);
  });

  it('renders the API base URL from config port and the SERVED protocol (ENG-5R2W)', () => {
    // https only with the full willServeHttps conjunction (flag + both cert paths).
    const md = master.buildMasterClaudeMd({
      serverPort: 3200, httpsEnabled: true,
      httpsCertPath: '/c.pem', httpsKeyPath: '/k.pem'
    });
    assert.match(md, /https:\/\/localhost:3200/);
    const md2 = master.buildMasterClaudeMd({ serverPort: 3102 });
    assert.match(md2, /http:\/\/localhost:3102/);
    // httpsEnabled defaults to true — without cert paths the server serves
    // HTTP (createServer fallback), so the base URL must say http.
    const md3 = master.buildMasterClaudeMd({ serverPort: 3102, httpsEnabled: true });
    assert.match(md3, /http:\/\/localhost:3102/);
  });

  it('renders the port the server actually binds, not config.serverPort (#654)', () => {
    // Same drift as the injected project configs: the plist binds 3102 while
    // config keeps the 3101 default, so the master identity file handed the
    // Project Master session a base URL nothing was serving.
    const had = Object.prototype.hasOwnProperty.call(process.env, 'TANGLECLAW_PORT');
    const prev = process.env.TANGLECLAW_PORT;
    try {
      process.env.TANGLECLAW_PORT = '3102';
      const md = master.buildMasterClaudeMd({ serverPort: 3101 });
      assert.match(md, /http:\/\/localhost:3102/);
      assert.doesNotMatch(md, /localhost:3101/);
    } finally {
      if (had) process.env.TANGLECLAW_PORT = prev;
      else delete process.env.TANGLECLAW_PORT;
    }
  });

  it('renders an http base URL in caddy ingress mode even with full HTTPS config (ENG-5R2W)', () => {
    const md = master.buildMasterClaudeMd({
      serverPort: 3102, ingressMode: 'caddy', httpsEnabled: true,
      httpsCertPath: '/c.pem', httpsKeyPath: '/k.pem'
    });
    assert.match(md, /http:\/\/localhost:3102/);
    assert.doesNotMatch(md, /https:\/\/localhost/);
  });

  it('includes the bearer Authentication block only when the gate is on AND a token exists', () => {
    const on = master.buildMasterClaudeMd({ serviceTokenEnabled: true, serviceToken: 'tcsk_abc' });
    assert.match(on, /Authorization: Bearer tcsk_abc/);
    assert.match(on, /\(bearer token\)/);
    const offNoToken = master.buildMasterClaudeMd({ serviceTokenEnabled: true });
    assert.doesNotMatch(offNoToken, /Authorization: Bearer/);
    const tokenButDisabled = master.buildMasterClaudeMd({ serviceToken: 'tcsk_abc' });
    assert.doesNotMatch(tokenButDisabled, /Authorization: Bearer/);
    assert.doesNotMatch(tokenButDisabled, /\(bearer token\)/);
  });
});

describe('ensureMasterSession', () => {
  let home;

  beforeEach(() => {
    home = path.join(tmpDir, `master-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  it('creates the home dir + CLAUDE.md and launches when the session is absent', () => {
    const t = fakeTmux({ alive: false });
    const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: t, enginesLib: availableEngines });
    assert.equal(r.created, true);
    assert.equal(r.tmuxSession, master.MASTER_TMUX_SESSION);
    assert.equal(r.error, undefined);
    const md = fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8');
    assert.match(md, /Project Master identity/);
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0].name, 'tangleclaw-master');
    assert.equal(t.calls[0].opts.cwd, home, 'session cwd must be the master home');
    assert.ok(t.calls[0].opts.command, 'must send the engine launch command');
  });

  it('is idempotent — an alive session means no second launch, but CLAUDE.md still regenerates', () => {
    const t = fakeTmux({ alive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'CLAUDE.md'), 'stale hand-edit');
    const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: t, enginesLib: availableEngines });
    assert.equal(r.created, false);
    assert.equal(r.error, undefined);
    assert.equal(t.calls.length, 0, 'must not create a second session');
    const md = fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8');
    assert.match(md, /Project Master identity/, 'identity must be regenerated on every ensure');
    assert.doesNotMatch(md, /stale hand-edit/);
  });

  it('refuses with an error when the engine binary is unavailable — and does not create tmux', () => {
    const t = fakeTmux({ alive: false });
    const r = master.ensureMasterSession({ refreshFleet: NO_FLEET,
      home,
      tmuxLib: t,
      // Resolution is pinned so this test is about DETECTION only — without it the
      // real resolver runs and the assertion depends on the host's installed CLIs.
      enginesLib: { detectEngine: () => ({ available: false }), resolveDefaultEngine: () => 'claude' }
    });
    assert.equal(r.created, false);
    assert.match(r.error, /not available/);
    assert.equal(t.calls.length, 0);
  });

  it('names the real problem when NO engine is installed, not a phantom engine id (#707)', () => {
    // The bare-machine case. Before the resolver, config's shipped 'claude'
    // default meant the master reported `Engine "claude" not available (binary
    // not found)` — pointing the operator at a config value when the machine
    // simply had no engine. The resolver returns null here; reporting
    // `Engine "null" not found` would be no better, so the guard says it plainly.
    // Injected through the same seam the caller uses for detection, so this
    // doesn't depend on which CLIs the host machine has installed.
    const noEngines = { detectEngine: () => ({ available: false }), resolveDefaultEngine: () => null };
    const t = fakeTmux({ alive: false });
    const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: t, enginesLib: noEngines });
    assert.equal(r.created, false);
    assert.match(r.error, /No AI engine is installed/);
    assert.doesNotMatch(r.error, /null/, 'must not leak the null through to the operator');
    assert.equal(t.calls.length, 0, 'must not create a tmux session with no engine to run');
  });

  it('refuses with an error when the configured default engine has no profile', () => {
    const config = store.config.load();
    const saved = config.defaultEngine;
    try {
      config.defaultEngine = 'ghost-engine';
      store.config.save(config);
      const t = fakeTmux({ alive: false });
      const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: t, enginesLib: availableEngines });
      assert.equal(r.created, false);
      assert.match(r.error, /"ghost-engine" not found/);
      assert.equal(t.calls.length, 0);
    } finally {
      config.defaultEngine = saved;
      store.config.save(config);
    }
  });

  it('refuses when the engine is available but has no launch command — no bare-shell master', () => {
    const sessionsLib = require('../lib/sessions');
    const original = sessionsLib._buildLaunchCommand;
    try {
      sessionsLib._buildLaunchCommand = () => undefined;
      const t = fakeTmux({ alive: false });
      const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: t, enginesLib: availableEngines });
      assert.equal(r.created, false);
      assert.match(r.error, /no launch command/);
      assert.equal(t.calls.length, 0, 'must not create a session that would run a bare shell');
    } finally {
      sessionsLib._buildLaunchCommand = original;
    }
  });

  it('surfaces tmux failures as typed errors — create-false and thrown', () => {
    const engines = availableEngines;
    const refusing = fakeTmux({ alive: false, createSession: () => false });
    const r1 = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: refusing, enginesLib: engines });
    assert.equal(r1.created, false);
    assert.match(r1.error, /Failed to create tmux session/);

    const throwing = fakeTmux({ alive: false, createSession: () => { throw new Error('boom'); } });
    const r2 = master.ensureMasterSession({ refreshFleet: NO_FLEET, home: home + '-t', tmuxLib: throwing, enginesLib: engines });
    assert.equal(r2.created, false);
    assert.match(r2.error, /tmux error: boom/);
  });

  it('server boot honors master.autoStart (structural pin — boot code is not unit-launchable)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /master\.masterSettings\(config\)\.autoStart/,
      'server startup must consult the autoStart setting');
    // "Never fatal" needs a real catch: ensureMasterSession types tmux/engine
    // failures into result.error but THROWS on fs faults — an uncaught throw
    // here is self-locking (autoStart is only disablable via the crashed
    // server's own API).
    const block = src.slice(src.indexOf('Project Master auto-start'), src.indexOf('Master auto-start failed'));
    assert.match(block, /try \{/,
      'the auto-start block must catch throws, not just typed errors');
  });

  it('never records a sessions-table row — the master is not a project session', () => {
    // Structural guard (the TB-3 no-HTTP-client pattern): the module must not
    // touch the sessions store at all — its only lib/sessions dependency is
    // the launch-command builder.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'master.js'), 'utf8');
    assert.doesNotMatch(src, /store\.sessions/,
      'lib/master.js must never read or write the sessions table');
    assert.doesNotMatch(src, /sessions\.launchSession/,
      'the master must not go through the project launch path');
  });
});

describe('getMasterStatus', () => {
  // A home that does not exist, passed to every call below.
  //
  // Since #755 chunk 3 the payload includes a readback of the guard's ACTUAL
  // posture, which without an override reads the operator's real
  // `~/.tangleclaw/master`. Nothing here asserts those fields, so the omission
  // would not fail — it would just make this block's payload depend on whether
  // this machine has a master and what level it happens to sit at. That is the
  // "a branch that depends on a file which happens to exist on this machine"
  // trap, and it has already cost this issue one CI failure. An absent home
  // reports no guard posture at all, which is the deterministic answer.
  const NO_HOME = path.join(os.tmpdir(), 'tc-master-status-no-home-does-not-exist');

  it('reports liveness straight from tmux', () => {
    assert.equal(master.getMasterStatus({ tmuxLib: fakeTmux({ alive: true }), home: NO_HOME }).exists, true);
    assert.equal(master.getMasterStatus({ tmuxLib: fakeTmux({ alive: false }), home: NO_HOME }).exists, false);
    assert.equal(master.getMasterStatus({ tmuxLib: fakeTmux(), home: NO_HOME }).tmuxSession, 'tangleclaw-master');
  });

  it('carries the effective settings for the panel/settings UI', () => {
    // enginesLib is injected because `resolvedEngine` now comes from availability
    // resolution (#707); without it this asserts against whichever CLIs the host
    // happens to have installed, and fails on a machine with none — which is the
    // machine class the resolver exists for.
    const s = master.getMasterStatus({ tmuxLib: fakeTmux(), enginesLib: availableEngines, home: NO_HOME }).settings;
    assert.equal(s.accessLevel, 'read-only');
    assert.deepEqual(s.accessLevels, ['read-only', 'suggest', 'write']);
    // All three are selectable since #755 gave each one real enforcement in the
    // write guard. Asserted against the constant rather than a literal so this
    // stays a statement about the PAYLOAD carrying the enabled set, which is
    // what the settings UI renders from — the literal belongs in the test that
    // owns the gate ('every enabled level is one the guard actually understands').
    assert.deepEqual(s.enabledAccessLevels, master.MASTER_ENABLED_ACCESS_LEVELS);
    assert.ok(s.enabledAccessLevels.includes('write'));
    // WHEN a change binds, carried as its own fact so the settings copy stops
    // promising the structural answer on every engine (#755 chunk 2 / R-4).
    assert.equal(s.levelAppliesAt, 'next-tool-call');
    assert.equal(s.engine, null);
    assert.equal(s.resolvedEngine, 'claude');
    assert.equal(s.scope, 'all');
    assert.equal(s.autoStart, false);
    assert.equal(s.enforcement, 'structural');
  });

  it('an instructional master reports that a level change waits for the next ensure (#755)', () => {
    // THE MUTATION THIS CATCHES: hardcoding 'next-tool-call'. The hint copy
    // reads this field, so a constant here would put the structural promise in
    // front of an operator whose master has no write guard at all.
    const s = master.getMasterStatus({
      tmuxLib: fakeTmux(),
      enginesLib: { resolveDefaultEngine: () => 'gemini', reconcileLaunchMode: () => 'default' },
      home: NO_HOME
    }).settings;
    assert.equal(s.enforcement, 'instructional');
    assert.equal(s.levelAppliesAt, 'next-ensure');
  });

  // A wedged tmux answers nothing, and `hasSession` flattened that into
  // `false` — so the one machine state where an operator most needs to know
  // whether the master is up was the one state that reported it as down
  // (#905). Same defect #900 removed from the fleet view and #891 from
  // `git.dirty`; this was the surface they left alone.
  it('reports the master\'s state as UNKNOWN when tmux did not answer', () => {
    // THE MUTATION THIS CATCHES: `exists: probe.live` instead of the answered
    // ternary — which is `hasSession` again, and reports a running master as
    // absent for as long as the wedge lasts.
    const status = master.getMasterStatus({ tmuxLib: fakeTmux({ alive: true, answered: false }), home: NO_HOME });

    assert.equal(status.exists, null,
      'a liveness nobody could establish must not be reported as an absence');
    assert.deepEqual(status.incomplete, ['exists'],
      'and it has to be NAMED, or a consumer cannot tell null from a missing field');
    assert.equal(status.cause, 'read-timed-out');
  });

  it('names nothing incomplete on the healthy path, and still carries the field', () => {
    // THE MUTATION THIS CATCHES: emitting `incomplete` only on failure. A field
    // that appears only when something is wrong makes every consumer probe for
    // its existence instead of reading its value — the argument
    // `lib/sessions.js` already makes for its own wrapping payload.
    for (const alive of [true, false]) {
      const status = master.getMasterStatus({ tmuxLib: fakeTmux({ alive }), home: NO_HOME });
      assert.deepEqual(status.incomplete, [], `incomplete must be [] when alive=${alive}`);
      assert.equal(status.cause, null);
      assert.equal(status.exists, alive, 'an ANSWERED negative is still a real false');
    }
  });
});

// ── R-15 (#755 chunk 3): the guard's posture is read BACK, so a degraded
// boundary stops being invisible ──
//
// Chunk 2's review found that every surface reported the level out of config
// and called it `structural` without ever asking the guard. Two ways that lies:
// the guard falls back to read-only when it cannot read its posture, and a
// master at `write` can delete the hook outright — after which `structural` is
// what the UI says and nothing is what enforces.
//
// Fixtures are built by the REAL caller (`applyMasterAccessLevel`), not by
// hand-writing the two files. A hand-built fixture would encode this test's
// belief about what the writer produces, and #755's recurring failure has been
// exactly a fix and a test sharing a premise.
describe('_looksEditedFrom — is this rule an EDIT of a superseded baseline?', () => {
  // The detector that decides whether to tell the operator their Hard rule may
  // now contradict the access level. It replaced a `startsWith(was.slice(0, 60))`
  // prefix match, which missed the likeliest edit of all: rewording the OPENING
  // of the sentence.
  //
  // Consequence of either error is one log line, so a rough word-bag threshold is
  // the right tool rather than a diff — but "cheap" is not "untested", and this
  // was the one function in its commit with no guard.
  const WAS = 'Read-only. Use only GET endpoints and never mutate any project you do not own.';

  it('matches an edit that reworded the OPENING — the case the prefix match missed', () => {
    // THE MUTATION THIS CATCHES: reverting to `startsWith(was.slice(0, 60))`,
    // which is green for a trailing edit and blind to this one.
    assert.equal(
      master._looksEditedFrom('Mostly read-only. Use only GET endpoints and never mutate any project you do not own.', WAS),
      true);
  });

  it('matches an edit to the tail, which the prefix match already caught', () => {
    assert.equal(
      master._looksEditedFrom(WAS + ' Ask me before anything else.', WAS), true);
  });

  it('does NOT match an unrelated operator rule', () => {
    // The other direction, and the one that would make the notice noise: a rule
    // sharing a handful of common words must not read as an edit.
    //
    // THE MUTATION THIS CATCHES: dropping the threshold toward zero, which makes
    // every rule an "edit" and puts the notice in front of everyone.
    for (const other of [
      'Always use the project group scope when summarising status.',
      'Never start a session on a project you do not own.',
      ''
    ]) {
      assert.equal(master._looksEditedFrom(other, WAS), false, `must not match: ${other}`);
    }
  });

  it('an empty superseded text matches nothing, rather than everything', () => {
    // A zero-length original makes `kept / original.length` a divide-by-zero that
    // evaluates NaN — and `NaN >= 0.66` is false, so it happens to be safe. Pinned
    // because "happens to be safe" is not a property, and the guard clause that
    // makes it deliberate is the thing under test.
    assert.equal(master._looksEditedFrom('anything at all', ''), false);
  });
});

describe('#968 a level change reaches the Master\'s own instructions', () => {
  const STRUCTURAL_968 = { resolveDefaultEngine: () => 'claude', reconcileLaunchMode: () => 'default' };
  const homes968 = [];
  const mk = () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-968-'));
    homes968.push(h);
    return h;
  };
  after(() => { for (const h of homes968) fs.rmSync(h, { recursive: true, force: true }); });

  /** @param {string} home @returns {string} The identity's access-level section. */
  const levelSection = (home) => {
    const md = fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8');
    const at = md.indexOf('## Your current access level');
    assert.notEqual(at, -1, 'the identity must carry an access-level section at all');
    return md.slice(at, at + 400);
  };

  it('rewrites CLAUDE.md, not only the level file and the guard', () => {
    // THE BUG, and the mutation that must go red: reverting this path to write
    // the level file and the guardrails without refreshing the identity. Every
    // other assertion in this suite stayed green while it shipped, because they
    // all read the level file or the guard — the two artifacts that WERE being
    // written. The Master reads a third one.
    const home = mk();
    master.applyMasterAccessLevel('read-only', { home, enginesLib: STRUCTURAL_968 });
    assert.match(levelSection(home), /\*\*read-only\*\*/, 'precondition');

    master.applyMasterAccessLevel('write', { home, enginesLib: STRUCTURAL_968 });
    const after = levelSection(home);
    assert.match(after, /\*\*write\*\*/,
      'the identity must state the level the operator just chose');
    assert.doesNotMatch(after, /\*\*read-only\*\*/,
      'and must not still assert the old one — the Master reads this and refuses itself');
  });

  it('still writes the level file and the guard it delegated away', () => {
    // The delegation must not LOSE what the partial path did. Asserted because
    // "one refresher instead of two" is only an improvement if the one does
    // everything the two did.
    const home = mk();
    master.applyMasterAccessLevel('write', { home, enginesLib: STRUCTURAL_968 });
    assert.equal(fs.readFileSync(master.masterAccessLevelPath(home), 'utf8').trim(), 'write');
    assert.equal(fs.existsSync(master.masterGuardScriptPath(home)), true);
    assert.equal(master.readMasterGuardPosture('write', 'structural', { home }).guardDegraded, false,
      'and the three artifacts must agree afterwards');
  });

  it('REVOKING write puts read-only back in the identity — the direction #968 was reported from', () => {
    // Granting was asserted; revoking was not, and revoking is the direction that
    // matters most: a Master left believing it may write, after the operator took
    // that away, is the failure with teeth. It is also the exact blind spot this
    // issue was reported from, one step along.
    //
    // THE MUTATION THIS CATCHES: refreshing the identity only when the level
    // rises — which passes every grant test in this file.
    const home = mk();
    master.applyMasterAccessLevel('write', { home, enginesLib: STRUCTURAL_968 });
    assert.match(levelSection(home), /\*\*write\*\*/, 'precondition');

    master.applyMasterAccessLevel('read-only', { home, enginesLib: STRUCTURAL_968 });
    const after = levelSection(home);
    assert.match(after, /\*\*read-only\*\*/);
    assert.doesNotMatch(after, /\*\*write\*\*/,
      'a revoked master must not go on being told it may write');
    assert.equal(fs.readFileSync(master.masterAccessLevelPath(home), 'utf8').trim(), 'read-only',
      'and the guard must agree with the identity');
  });

  it('the identity follows the level ARGUMENT, not whatever config happens to say', () => {
    // The change path saves config and then passes the level it saved, so the
    // two agree in production. Passing it explicitly means they cannot disagree
    // even for the width of a write — and this pins that the argument is what
    // renders, since the test store's config says read-only throughout.
    //
    // THE MUTATION THIS CATCHES: dropping the `accessLevel` override so the
    // refresher falls back to config, which would silently re-introduce the bug
    // for any caller whose config write has not landed yet.
    const home = mk();
    master.applyMasterAccessLevel('suggest', { home, enginesLib: STRUCTURAL_968 });
    assert.match(levelSection(home), /\*\*suggest\*\*/);
  });

  it('an instructional master gets the identity refresh too — it is the whole boundary there', () => {
    // On a non-Claude master the prose IS the enforcement, so a stale identity
    // is not a cosmetic problem, it is the boundary being wrong.
    const home = mk();
    master.applyMasterAccessLevel('write', {
      home, enginesLib: { resolveDefaultEngine: () => 'gemini', reconcileLaunchMode: () => 'default' }
    });
    assert.match(levelSection(home), /\*\*write\*\*/);
    assert.equal(fs.existsSync(master.masterGuardScriptPath(home)), false,
      'and it still gets no guard it never had');
  });
});

describe('killMasterSession — the remedy #968 makes load-bearing', () => {
  /** @param {object} probe - What the stubbed probe reports. */
  const stub = (probe, killed = true) => {
    const calls = [];
    return {
      lib: {
        probeSession: () => probe,
        killSession: (n) => { calls.push(n); return killed; }
      },
      calls
    };
  };

  it('kills a live session', () => {
    const { lib, calls } = stub({ live: true, answered: true, cause: null });
    const r = master.killMasterSession({ tmuxLib: lib });
    assert.equal(r.killed, true);
    assert.equal(r.wasRunning, true);
    assert.deepEqual(calls, ['tangleclaw-master'], 'and kills the RESERVED session, not another');
  });

  it('an absent Master is SUCCESS, not an error', () => {
    // The operator's intent is "not running", and it already is. Reporting that
    // as a failure would make the honest case look broken.
    //
    // THE MUTATION THIS CATCHES: returning an error for the absent case, which
    // is the reflex reading of "nothing to kill".
    const { lib, calls } = stub({ live: false, answered: true, cause: null });
    const r = master.killMasterSession({ tmuxLib: lib });
    assert.equal(r.error, undefined, 'not an error');
    assert.equal(r.killed, false, 'but honest that THIS call did not do the killing');
    assert.equal(r.wasRunning, false);
    assert.deepEqual(calls, [], 'and it must not ask tmux to kill something absent');
  });

  it('a kill tmux would not CONFIRM is refused, even though the session was live', () => {
    // The gap three reviewers found independently. `killMasterSession` keeps the
    // three-state discipline and then calls `tmux.killSession`, whose first line
    // re-asks with the TWO-state `hasSession` — which answers "not there" both
    // for a session that ended and for a tmux that stopped answering. So the
    // wedge arrives one call later, and reporting it as success prints "Master
    // stopped" about a Master most likely still running.
    //
    // `wasRunning` stays true because that part WAS established; only the kill is
    // unconfirmed. This is also what gives `killed` a reader.
    //
    // THE MUTATION THIS CATCHES: returning `{ killed, wasRunning: true }` from
    // the tmux result directly, which is what shipped and which every other kill
    // test allows — none of them passes `killed = false`.
    const { lib } = stub({ live: true, answered: true, cause: null }, false);
    const r = master.killMasterSession({ tmuxLib: lib });
    assert.equal(r.killed, false);
    assert.equal(r.wasRunning, true, 'liveness WAS established; only the kill was not');
    assert.ok(r.error, 'and it must not read as a successful kill');
    assert.equal(r.cause, 'kill-unconfirmed');
  });

  it('refuses when tmux did not answer — an unconfirmed kill is not a kill', () => {
    // `hasSession` flattens a wedged tmux into "not there", and this install
    // reaches that wedge (#94/#144/#380). Built on it, the route would report
    // "already stopped" during exactly the condition where the Master is most
    // likely still running.
    //
    // THE MUTATION THIS CATCHES: using hasSession, or folding `!answered` into
    // the absent branch — both of which make this case silently claim success.
    const { lib, calls } = stub({ live: false, answered: false, cause: 'read-timed-out' });
    const r = master.killMasterSession({ tmuxLib: lib });
    assert.ok(r.error, 'it must refuse rather than claim a kill it cannot confirm');
    assert.deepEqual(r.incomplete, ['exists'],
      'named in the same vocabulary ensure uses, so one client branch covers both');
    assert.equal(r.killed, false);
    assert.deepEqual(calls, [], 'and nothing was killed');
  });
});

describe('readMasterIdentityFreshness — has the RUNNING Master read this? (#968)', () => {
  const homes = [];
  const mk = () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fresh-'));
    homes.push(h);
    return h;
  };
  after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

  /** @param {object} answer - What the stubbed tmux reports. */
  const tmuxAt = (answer) => ({ sessionCreatedAt: () => answer, probeSession: () => ({ live: true, answered: true, cause: null }) });

  /** Write an identity whose mtime is `offsetSec` from now. */
  const identityAt = (home, offsetSec) => {
    const f = master.masterIdentityPath(home);
    fs.writeFileSync(f, '# identity');
    const when = new Date(Date.now() + offsetSec * 1000);
    fs.utimesSync(f, when, when);
    return Math.floor(when.getTime() / 1000);
  };

  it('an identity written AFTER the session started has reached nobody', () => {
    // The reported bug's shape: the file is right and the running Master is
    // acting on what it read at launch.
    //
    // THE MUTATION THIS CATCHES: comparing the other way round, which reports
    // every freshly-restarted Master as stale and every stale one as fine.
    const home = mk();
    const written = identityAt(home, 0);
    const p = master.readMasterIdentityFreshness({
      home, tmuxLib: tmuxAt({ createdAt: written - 3600, answered: true, cause: null })
    });
    assert.equal(p.identityStale, true);
    assert.ok(p.identityWrittenAt, 'and it names WHEN, or the operator cannot judge how far behind');
  });

  it('an identity the session already read is not stale', () => {
    const home = mk();
    const written = identityAt(home, -3600);
    const p = master.readMasterIdentityFreshness({
      home, tmuxLib: tmuxAt({ createdAt: written + 60, answered: true, cause: null })
    });
    assert.equal(p.identityStale, false);
  });

  it('tmux not answering is UNKNOWN, never "fine"', () => {
    // The #905 discipline: a caller that renders "all good" from a read that
    // never happened writes a fact nobody has.
    //
    // THE MUTATION THIS CATCHES: folding the unanswered case into `false`, which
    // is the tidier two-state version and silently reassures during exactly the
    // tmux wedge this install hits (#94/#144/#380).
    const home = mk();
    identityAt(home, 0);
    const p = master.readMasterIdentityFreshness({
      home, tmuxLib: tmuxAt({ createdAt: null, answered: false, cause: 'read-timed-out' })
    });
    assert.equal(p.identityStale, null);
    assert.ok(p.identityWrittenAt, 'the timestamp is still known even when the comparison is not');
  });

  it('an unparseable answer is UNKNOWN, not "no session"', () => {
    // tmux answered, but with nothing usable. Folding that into "there is no
    // session" would report a live Master as never stale — same consequence as
    // the timeout (the comparison could not be made), different cause.
    //
    // THE MUTATION THIS CATCHES: keying only on `answered`, which leaves `cause`
    // with no consumer at all — a field nothing reads is its own smell.
    const home = mk();
    identityAt(home, 0);
    const p = master.readMasterIdentityFreshness({
      home, tmuxLib: tmuxAt({ createdAt: null, answered: true, cause: 'unparseable' })
    });
    assert.equal(p.identityStale, null);
  });

  it('a failure AFTER the level lands is flagged as level-applied, wherever it happens', () => {
    // The route branches on `err.levelApplied` to choose between "nothing
    // changed" and "the new level is in force but the refresh did not finish".
    // Moving the level write to the top of the refresh made everything below it
    // capable of throwing with the level already on disk — and the flag was set
    // in ONE place, the guard write, so a failure in seeding or the identity
    // write reported the reassuring sentence about a guard that was already
    // permitting writes.
    //
    // Injected at the identity write, which is squarely in the middle of the
    // reordered region — not at the guard write, where the old flag already sat
    // and which would pass either way.
    //
    // THE MUTATION THIS CATCHES: narrowing the try back to the guard write.
    const home = mk();
    fs.mkdirSync(path.join(home, 'CLAUDE.md'), { recursive: true });
    let caught = null;
    try {
      master.refreshMasterIdentity({
        home,
        accessLevel: 'write',
        enginesLib: { resolveDefaultEngine: () => 'claude', reconcileLaunchMode: () => 'default' }
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'precondition: the identity write must actually fail');
    assert.equal(fs.readFileSync(master.masterAccessLevelPath(home), 'utf8').trim(), 'write',
      'precondition: the level landed before the failure — that is what makes the flag necessary');
    assert.equal(caught.levelApplied, true,
      'the caller must be told the level IS in force, not that nothing changed');
  });

  it('an identity rewritten with IDENTICAL content does not become stale', () => {
    // The defect the review caught, and the one that would have made this whole
    // feature a permanent nag: `refreshMasterIdentity` runs on every ensure —
    // which both surfaces fire on drawer open, and which runs at boot — so an
    // unconditional write bumped the mtime past the session start every time.
    // The bar would have read "NOT IN EFFECT … Restart it to apply" forever, on
    // a perfectly healthy Master. `buildMasterClaudeMd` is deterministic, so the
    // mtime is load-bearing and not touching it is part of the contract.
    //
    // THE MUTATION THIS CATCHES: reverting to an unconditional writeFileSync.
    const home = mk();
    master.refreshMasterIdentity({ home, enginesLib: { resolveDefaultEngine: () => 'claude', reconcileLaunchMode: () => 'default' } });
    const first = fs.statSync(master.masterIdentityPath(home)).mtimeMs;
    // Push the recorded mtime back so an unconditional rewrite is detectable
    // without sleeping for a filesystem tick.
    const past = new Date(first - 60000);
    fs.utimesSync(master.masterIdentityPath(home), past, past);

    master.refreshMasterIdentity({ home, enginesLib: { resolveDefaultEngine: () => 'claude', reconcileLaunchMode: () => 'default' } });
    // Compared with a tolerance rather than exactly, because an exact comparison
    // scores the host's clock plumbing instead of the contract. `utimesSync`
    // hands the kernel a float of SECONDS, and a millisecond value that is not
    // representable in that float comes back off by a fraction: ext4 stored
    // 1787039343102 and returned 1787039343101.999, so CI went red on Linux
    // while macOS — where the same 2000-value probe drifts on none of them —
    // stayed green. The code under test never ran differently.
    //
    // The tolerance costs the assertion nothing. The mutation it exists to catch
    // is an unconditional `writeFileSync`, which sets the mtime to NOW — 60s
    // from `past` by construction above. Sub-millisecond and sixty seconds are
    // not close together, so the guard still fails the moment the write returns.
    const rewritten = fs.statSync(master.masterIdentityPath(home)).mtimeMs;
    assert.ok(Math.abs(rewritten - past.getTime()) < 2,
      `an ensure that changes nothing must not touch the identity mtime (got ${rewritten}, expected ~${past.getTime()})`);
  });

  it('a read that failed on a LIVE session is unknown, not "no such session"', () => {
    // `probeSession` confirmed the session is live, then the timestamp read
    // failed without timing out. The bare negative shape (`answered: true`,
    // `createdAt: null`) means "no such session" everywhere else, and reading it
    // that way here would report a live Master as never stale — a report
    // reassuring from a read that did not happen.
    //
    // THE MUTATION THIS CATCHES: dropping `read-failed` from the unknown set, or
    // having tmux return a bare null for that case.
    const home = mk();
    identityAt(home, 0);
    const p = master.readMasterIdentityFreshness({
      home, tmuxLib: tmuxAt({ createdAt: null, answered: true, cause: 'read-failed' })
    });
    assert.equal(p.identityStale, null);
  });

  it('a stat failure that is NOT "absent" reports unknown, not "nothing is stale"', () => {
    // Changed behavior that shipped without a test: only ENOENT means nothing
    // has been generated. EACCES, EIO or ENOTDIR mean the identity may well
    // exist and could not be read, and answering "nothing is stale" there is a
    // report reassuring from a read that never happened.
    //
    // Driven with ENOTDIR because it is portable and needs no permission games:
    // a home whose parent component is a regular FILE.
    //
    // THE MUTATION THIS CATCHES: collapsing the branch back to a bare `return
    // none`, which leaves every existing stat test green — the only other one
    // exercises the ENOENT arm.
    const notADir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-enotdir-'));
    homes.push(notADir);
    const asFile = path.join(notADir, 'afile');
    fs.writeFileSync(asFile, 'not a directory');
    const p = master.readMasterIdentityFreshness({
      home: path.join(asFile, 'home'),
      tmuxLib: tmuxAt({ createdAt: 1, answered: true, cause: null })
    });
    assert.equal(p.identityStale, null,
      'an unreadable identity is unknown; only an ABSENT one is "nothing is stale"');
    assert.equal(p.identityWrittenAt, null,
      'and it must not report a write time it could not read');
  });

  it('no running Master, and no identity at all, are both "nothing is stale"', () => {
    // Nothing is running to hold a stale belief, and an operator who has never
    // opened the Master must not meet a warning about it.
    const home = mk();
    identityAt(home, 0);
    assert.equal(master.readMasterIdentityFreshness({
      home, tmuxLib: tmuxAt({ createdAt: null, answered: true, cause: null })
    }).identityStale, false, 'answered, no session');

    const bare = mk();
    assert.equal(master.readMasterIdentityFreshness({
      home: bare, tmuxLib: tmuxAt({ createdAt: 1, answered: true, cause: null })
    }).identityStale, false, 'no identity on disk');
  });

  it('getMasterStatus probes tmux ONCE, not once per question', () => {
    // The freshness read guards session existence itself, so without reusing the
    // caller's probe a single status read spawned three tmux subprocesses where
    // it used to spawn one — on an install whose recurring failure mode is PTY
    // exhaustion (#94/#144/#380), and on a page that polls this route.
    //
    // THE MUTATION THIS CATCHES: dropping `options.probe` so `sessionCreatedAt`
    // probes again. Nothing else in the suite counts spawns, so that regression
    // is otherwise invisible.
    const home = mk();
    identityAt(home, 0);
    // Asserts the probe is HANDED OVER, which is the half this module owns.
    // Counting real spawns is not available from here: `sessionCreatedAt` calls
    // tmux.js's module-local `probeSession`, so any stub that could count it is
    // also a stub of the function under test — the fixture would not reach the
    // subject. `test/tmux.test.js` owns the other half.
    let passedProbe;
    let probes = 0;
    const counting = Object.assign(fakeTmux({ alive: true }), {
      probeSession: () => { probes++; return { live: true, answered: true, cause: null }; },
      sessionCreatedAt: (name, opts) => {
        passedProbe = opts && opts.probe;
        return { createdAt: 1, answered: true, cause: null };
      }
    });
    master.getMasterStatus({
      home, tmuxLib: counting,
      enginesLib: { resolveDefaultEngine: () => 'claude', reconcileLaunchMode: () => 'default' }
    });
    assert.equal(probes, 1, `the status read itself must probe once, not ${probes} times`);
    assert.ok(passedProbe && passedProbe.answered,
      'and it must hand that probe on, or the freshness read spawns another tmux');
  });

  it('getMasterStatus carries it, so a surface can render it', () => {
    // THE MUTATION THIS CATCHES: computing the freshness and not spreading it
    // into settings — every unit test above stays green while the only consumer
    // that matters receives nothing.
    const home = mk();
    const written = identityAt(home, 0);
    const s = master.getMasterStatus({
      home,
      enginesLib: { resolveDefaultEngine: () => 'claude', reconcileLaunchMode: () => 'default' },
      tmuxLib: Object.assign(fakeTmux({ alive: true }), {
        sessionCreatedAt: () => ({ createdAt: written - 60, answered: true, cause: null })
      })
    }).settings;
    assert.equal(s.identityStale, true);
    assert.ok(s.identityWrittenAt);
  });
});

describe('readMasterGuardPosture — a degraded guard is visible (#755 chunk 3, R-15)', () => {
  const STRUCTURAL = { resolveDefaultEngine: () => 'claude', reconcileLaunchMode: () => 'default' };
  const INSTRUCTIONAL = { resolveDefaultEngine: () => 'gemini', reconcileLaunchMode: () => 'default' };
  const homes = [];

  /**
   * A master home provisioned the way the product provisions one.
   * @param {string} level - Access level to apply.
   * @param {object} enginesLib - Engine resolver stub deciding the enforcement tier.
   * @returns {string} The home path.
   */
  function provision(level, enginesLib) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-r15-'));
    homes.push(home);
    const result = master.applyMasterAccessLevel(level, { home, enginesLib });
    assert.equal(result.applied, true,
      'the fixture must actually be provisioned, or every assertion below measures an empty directory');
    return home;
  }

  after(() => {
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
  });

  it('an instructional master raises no alarm — it was never meant to have a guard', () => {
    // THE MUTATION THIS CATCHES: dropping the `enforcement !== 'structural'`
    // early return. Every non-Claude master would then permanently report
    // "guard missing", because a guard is exactly what an instructional master
    // does not have — an alarm that is always on is an alarm nobody reads.
    const home = provision('write', INSTRUCTIONAL);
    assert.equal(fs.existsSync(master.masterGuardScriptPath(home)), false,
      'precondition: an instructional master genuinely has no guard script');

    const p = master.readMasterGuardPosture('write', 'instructional', { home });
    assert.equal(p.guardDegraded, false);
    assert.equal(p.guardDegradedCode, null);
    assert.equal(p.guardLevel, null, 'there is no guard to report a level for');
  });

  it('a master that has never been opened raises no alarm', () => {
    // THE MUTATION THIS CATCHES: dropping the home-exists check, which would
    // show a degraded boundary to every operator who has not opened the Master
    // yet — a scary badge about a subsystem that does not exist.
    const home = path.join(os.tmpdir(), 'tc-r15-never-opened-does-not-exist');
    assert.equal(fs.existsSync(home), false, 'precondition: the home must be absent');

    const p = master.readMasterGuardPosture('read-only', 'structural', { home });
    assert.equal(p.guardDegraded, false);
    assert.equal(p.guardLevel, null);
  });

  it('a healthy structural master reports the level the guard will actually apply', () => {
    for (const level of ['read-only', 'suggest', 'write']) {
      const home = provision(level, STRUCTURAL);
      const p = master.readMasterGuardPosture(level, 'structural', { home });
      assert.equal(p.guardDegraded, false, `${level} is provisioned and consistent`);
      assert.equal(p.guardDegradedReason, null);
      assert.equal(p.guardLevel, level,
        'the reported level must come from DISK, not be echoed back from the argument');
    }
  });

  it('a deleted guard script is reported — the write tier can remove its own hook', () => {
    // The threat in its own words: at `write` the guard permits edits to every
    // path including its own hook file, and under the bypassPermissions launch
    // mode the `rm` is not confirmed either. Before this, deleting it changed
    // nothing any surface said.
    //
    // THE MUTATION THIS CATCHES: returning the healthy shape when the script is
    // absent — which is what the code did before this chunk, silently, on the
    // one state where the boundary has stopped existing altogether.
    const home = provision('write', STRUCTURAL);
    fs.rmSync(master.masterGuardScriptPath(home));

    const p = master.readMasterGuardPosture('write', 'structural', { home });
    assert.equal(p.guardDegraded, true);
    assert.equal(p.guardDegradedCode, 'guard-missing');
    assert.equal(p.guardLevel, null, 'a guard that is gone enforces no level at all');
    assert.match(p.guardDegradedReason, /not there|nothing is bounding/i,
      'the reason has to say the boundary is absent, not merely that something differs');
  });

  it('the missing-guard check is NOT keyed on the guard file — it is keyed on enforcement', () => {
    // Chunk 2 shipped a bound keyed on `existsSync(guard-writes.js)`, the exact
    // artifact the threat removes, so deleting the guard made the check conclude
    // there was nothing to check. This pins the inversion: with BOTH artifacts
    // gone, the answer is still "degraded", never "clean".
    //
    // THE MUTATION THIS CATCHES: an early `if (!guardPresent) return none;`
    // guard-clause "optimisation", which reads as skipping irrelevant work and
    // is a silent all-clear on a master with no boundary at all.
    const home = provision('write', STRUCTURAL);
    fs.rmSync(master.masterGuardScriptPath(home));
    fs.rmSync(master.masterAccessLevelPath(home));

    const p = master.readMasterGuardPosture('write', 'structural', { home });
    assert.equal(p.guardDegraded, true,
      'removing every artifact the check reads must not be a way to pass the check');
    assert.equal(p.guardDegradedCode, 'guard-missing',
      'and the WORSE of the two findings is the one reported');
  });

  it('a guard that exists but is no longer WIRED is reported (R-1)', () => {
    // Presence was the whole of this check when it shipped, and presence is the
    // weakest of the three ways the boundary goes away. Claude Code only invokes
    // the script because `.claude/settings.json` registers it as a PreToolUse
    // matcher — remove that and every artifact is still on disk while nothing
    // runs. At the `write` tier the master can make exactly this edit, and under
    // bypassPermissions it is not confirmed.
    //
    // THE MUTATION THIS CATCHES: checking only `existsSync(guardPath)`, which is
    // what this function did before the review, and which is green here.
    const home = provision('write', STRUCTURAL);
    assert.equal(fs.existsSync(master.masterGuardScriptPath(home)), true,
      'precondition: the script itself must still be there, or this measures guard-missing');
    fs.rmSync(master.masterGuardSettingsPath(home));

    const p = master.readMasterGuardPosture('write', 'structural', { home });
    assert.equal(p.guardDegraded, true);
    assert.equal(p.guardDegradedCode, 'guard-unwired');
    assert.equal(p.guardLevel, null, 'a hook that never runs enforces no level');
  });

  it('a settings file that parses but registers something else is also unwired', () => {
    // The failure that a bare existence check cannot see. Every restrictive
    // reading here is deliberate: absent, unreadable, unparseable, wrong shape,
    // matcher removed — all answer "not wired", because this feeds a degradation
    // report and the restrictive direction is raising the alarm.
    //
    // THE MUTATION THIS CATCHES: `_masterGuardIsWired` returning true on a parse
    // failure or an unexpected shape — the "assume wired unless proven otherwise"
    // reading, which is this issue's recurring fail-open.
    const cases = [
      ['empty object', '{}'],
      ['not JSON at all', 'not json {{{'],
      ['PreToolUse present but empty', '{"hooks":{"PreToolUse":[]}}'],
      ['a hook for a different script', '{"hooks":{"PreToolUse":[{"matcher":"Edit","hooks":[{"type":"command","command":"node other.js"}]}]}}'],
      ['PreToolUse is not an array', '{"hooks":{"PreToolUse":{"matcher":"Edit"}}}']
    ];
    for (const [name, body] of cases) {
      const home = provision('write', STRUCTURAL);
      fs.writeFileSync(master.masterGuardSettingsPath(home), body);
      const p = master.readMasterGuardPosture('write', 'structural', { home });
      assert.equal(p.guardDegradedCode, 'guard-unwired', `${name}: must read as unwired`);
    }
  });

  it('a guard whose SOURCE has been altered is reported (R-1)', () => {
    // Blanking the script is the cheap tamper: it stays present, stays wired,
    // and decides nothing. Byte-comparing against what this version generates
    // catches that and every other edit.
    //
    // THE MUTATION THIS CATCHES: comparing only length, or only that the file is
    // non-empty — a one-line `process.exit(0)` passes both and permits every
    // write, because the harness fails OPEN when a hook emits no decision.
    for (const [name, body] of [['blanked', ''], ['replaced with a no-op', 'process.exit(0);\n']]) {
      const home = provision('write', STRUCTURAL);
      fs.writeFileSync(master.masterGuardScriptPath(home), body);
      const p = master.readMasterGuardPosture('write', 'structural', { home });
      assert.equal(p.guardDegraded, true, `${name}: must be flagged`);
      assert.equal(p.guardDegradedCode, 'guard-tampered', `${name}: code`);
    }
  });

  it('an unreadable or unrecognized level file reports read-only — what the guard will do', () => {
    // Three shapes of the same failure, each of which makes the generated
    // guard's own `readLevel()` fall back to read-only. The report has to model
    // the guard's behaviour, not the file's bytes: the operator needs to know
    // what will happen, and "the file says <garbage>" does not tell them.
    //
    // THE MUTATION THIS CATCHES: reporting `guardLevel: token` (the raw value)
    // or the configured level. Either one tells an operator whose master is
    // silently refusing every write that the level is what they set.
    const cases = [
      ['deleted', (h) => fs.rmSync(master.masterAccessLevelPath(h))],
      ['garbage', (h) => fs.writeFileSync(master.masterAccessLevelPath(h), 'WRITE-ish\n')],
      ['empty', (h) => fs.writeFileSync(master.masterAccessLevelPath(h), '   \n')],
      ['a directory', (h) => {
        fs.rmSync(master.masterAccessLevelPath(h));
        fs.mkdirSync(master.masterAccessLevelPath(h));
      }]
    ];
    for (const [name, corrupt] of cases) {
      const home = provision('write', STRUCTURAL);
      corrupt(home);
      const p = master.readMasterGuardPosture('write', 'structural', { home });
      assert.equal(p.guardDegraded, true, `${name}: must be flagged`);
      assert.equal(p.guardDegradedCode, 'level-unreadable', `${name}: code`);
      assert.equal(p.guardLevel, 'read-only',
        `${name}: the guard falls back to read-only, so that is what is in force`);
    }
  });

  it('a level on disk that disagrees with config is reported, and says WHICH WAY', () => {
    // The two directions are different problems and a single "they differ"
    // sentence leaves the operator to work out which: a guard permitting MORE
    // than configured is a boundary that is not holding; permitting LESS is a
    // master that will not do its job.
    //
    // THE MUTATION THIS CATCHES: comparing with `>=`/`<=`, or emitting one
    // fixed sentence for both directions — the security-relevant case then
    // reads exactly like the merely-annoying one.
    const permissive = provision('write', STRUCTURAL);
    const pMore = master.readMasterGuardPosture('read-only', 'structural', { home: permissive });
    assert.equal(pMore.guardDegraded, true);
    assert.equal(pMore.guardDegradedCode, 'level-mismatch');
    assert.equal(pMore.guardLevel, 'write', 'what is in force is what is on disk');
    assert.match(pMore.guardDegradedReason, /permitting MORE/);

    const restrictive = provision('read-only', STRUCTURAL);
    const pLess = master.readMasterGuardPosture('write', 'structural', { home: restrictive });
    assert.equal(pLess.guardDegraded, true);
    assert.equal(pLess.guardDegradedCode, 'level-mismatch');
    assert.equal(pLess.guardLevel, 'read-only');
    assert.match(pLess.guardDegradedReason, /permitting LESS/);
  });

  it('getMasterStatus carries the readback, so a surface can render it', () => {
    // R-15's actual complaint: `getMasterStatus` was listed in chunk 1's own
    // consumer table as the cross-check and was never built. This is that.
    //
    // THE MUTATION THIS CATCHES: computing the posture and not spreading it into
    // `settings` — every unit test above would stay green while the only
    // consumer that matters received nothing.
    const home = provision('write', STRUCTURAL);
    fs.rmSync(master.masterGuardScriptPath(home));

    const s = master.getMasterStatus({
      tmuxLib: fakeTmux(), enginesLib: STRUCTURAL, home
    }).settings;
    assert.equal(s.enforcement, 'structural');
    assert.equal(s.guardDegraded, true);
    assert.equal(s.guardDegradedCode, 'guard-missing');
    assert.ok(s.guardDegradedReason, 'the surface needs a sentence to show, not just a flag');
  });

  it('getMasterStatus reads the guard from the home it REPORTS, not the live one', () => {
    // Route tests reached the operator's real `~/.tangleclaw/master` twice
    // during this issue. `home` is resolved once and used for both the reported
    // path and the readback, so the payload cannot half-describe a fixture and
    // half-describe the real master.
    //
    // THE MUTATION THIS CATCHES: calling `masterHome()` again inside the
    // readback instead of threading the resolved `home` — the fields would then
    // describe whatever master this machine happens to have, which passes on a
    // developer box and fails on CI (or vice versa).
    const home = provision('suggest', STRUCTURAL);
    const status = master.getMasterStatus({ tmuxLib: fakeTmux(), enginesLib: STRUCTURAL, home });
    assert.equal(status.home, home);
    assert.equal(status.settings.guardLevel, 'suggest',
      'the readback must follow the overridden home');
  });
});

describe('ensureMasterSession refuses to start a second master over one it cannot see', () => {
  it('declines, and does not create a session, when tmux did not answer', () => {
    // THE MUTATION THIS CATCHES: keeping `t.hasSession(...)` as the guard.
    // False then means BOTH "not running" and "tmux is wedged", and this caller
    // acts on false by starting one — so a wedge aimed a `tmux new-session` at
    // a master that was already running. `lib/sessions.js` refuses on the same
    // grounds for project sessions; this is that rule on the master's path.
    const t = fakeTmux({ alive: true, answered: false });
    const home = path.join(tmpDir, 'master-wedge');

    const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: t, enginesLib: availableEngines });

    assert.equal(r.created, false);
    assert.match(r.error, /could not determine/i,
      'the refusal must say what it could not establish, not report a failed start');
    assert.equal(t.calls.length, 0,
      'and it must not have tried — a created session here is a SECOND master over a live one');
    // THE MUTATION THIS CATCHES: returning only a message. The route maps this
    // field to its own error code, and without it the panel falls back to the
    // generic failure code and paints the master DOWN — a definite claim about
    // the exact thing this refusal says could not be established.
    assert.deepEqual(r.incomplete, ['exists'],
      'the refusal has to be machine-distinguishable from a failed start, not just worded differently');
    assert.equal(r.cause, 'read-timed-out');
  });

  it('routes an unestablished liveness to its own error code, not the generic failure', () => {
    // The mapping is one line in server.js and it is the seam between "the
    // server knows this is an unknown" and "the panel renders it as one".
    // Structural pin: the route is not unit-launchable, and the repo pins boot
    // and route wiring this way elsewhere.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /MASTER_LIVENESS_UNKNOWN/,
      'the distinct code must exist, or the client cannot branch on it');
    assert.match(src, /\(result\.incomplete \|\| \[\]\)\.includes\('exists'\)/,
      'and it must be selected from the refusal\'s own field rather than by matching its wording');
  });

  it('still starts one when tmux answered that nothing is running', () => {
    // The other half, keeping the refusal from becoming a blanket "never start":
    // an answered negative is a real negative, and the master must still launch.
    const t = fakeTmux({ alive: false, answered: true });
    const home = path.join(tmpDir, 'master-answered-absent');

    const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: t, enginesLib: availableEngines });

    assert.equal(r.error, undefined, 'an answered absence is not an error');
    assert.equal(t.calls.length, 1, 'it has to actually start the master');
  });
});

/** Remove every master rule row (store-level delete has no confirm gate). */
function clearMasterRules() {
  for (const rule of store.sessionRules.list({ kind: 'master' })) {
    store.sessionRules.delete(rule.id);
  }
}

describe('masterSettings normalization', () => {
  it('applies defaults for a missing/partial master block (shallow-merge safety)', () => {
    assert.deepEqual(master.masterSettings({}), {
      accessLevel: 'read-only', engine: null, launchMode: 'default', scope: 'all', autoStart: false,
      medusaEnabled: false, medusaWake: false
    });
    const partial = master.masterSettings({ master: { autoStart: true } });
    assert.equal(partial.autoStart, true);
    assert.equal(partial.accessLevel, 'read-only');
    assert.equal(partial.engine, null);
    // #756: a hand-edited partial block must not surface launchMode as
    // undefined — `_buildLaunchCommand` would then receive it and the Master
    // would launch under whatever that coerces to.
    assert.equal(partial.launchMode, 'default');
  });

  it('rejects out-of-enum access levels back to read-only', () => {
    assert.equal(master.masterSettings({ master: { accessLevel: 'god-mode' } }).accessLevel, 'read-only');
  });
});

describe('master Hard rules — seeding, fail-safe, restore', () => {
  beforeEach(clearMasterRules);

  it('seeds the shipped baseline once, idempotently, as system rows', () => {
    assert.equal(master.seedBaselineMasterRules(), master.MASTER_BASELINE_RULES.length);
    assert.equal(master.seedBaselineMasterRules(), 0, 'second call must not duplicate');
    const rules = store.sessionRules.list({ kind: 'master' });
    assert.equal(rules.length, master.MASTER_BASELINE_RULES.length);
    for (const rule of rules) {
      assert.equal(rule.createdBy, 'system');
      assert.equal(rule.projectId, null);
    }
  });

  it('does not re-seed after the operator deleted individual rules (their choice sticks)', () => {
    master.seedBaselineMasterRules();
    const rules = store.sessionRules.list({ kind: 'master' });
    store.sessionRules.delete(rules[0].id);
    assert.equal(master.seedBaselineMasterRules(), 0);
    assert.equal(store.sessionRules.list({ kind: 'master' }).length, rules.length - 1);
  });

  it('restoreDefaultMasterRules replaces custom rules with the baseline, preserving history', () => {
    master.seedBaselineMasterRules();
    const custom = store.sessionRules.create({ content: 'my custom boundary', kind: 'master' });
    const restored = master.restoreDefaultMasterRules();
    assert.equal(restored.length, master.MASTER_BASELINE_RULES.length);
    assert.ok(restored.every((r) => r.createdBy === 'system'));
    assert.ok(!restored.some((r) => r.content === 'my custom boundary'));
    // History outlives the deleted rule (audit) — the delete op is recorded.
    const history = store.sessionRules.listVersions(custom.id);
    assert.ok(history.length >= 2);
    assert.equal(history[0].op, 'delete');
  });

  it('buildMasterClaudeMd renders live rules, and falls back to the baseline at zero enabled rules', () => {
    const withRules = master.buildMasterClaudeMd({ serverPort: 3101 }, {
      rules: [{ content: 'Custom rule one.' }, { content: 'Custom rule two.' }]
    });
    assert.match(withRules, /- Custom rule one\./);
    assert.match(withRules, /- Custom rule two\./);
    assert.doesNotMatch(withRules, /Use only GET endpoints/, 'custom rules REPLACE the baseline');

    // Zero enabled rules → the boundary cannot be emptied: baseline renders.
    const failSafe = master.buildMasterClaudeMd({ serverPort: 3101 }, { rules: [] });
    assert.match(failSafe, /Use only GET endpoints/);
    assert.match(failSafe, /Do not edit files outside this directory/);
  });
});

describe('superseded baseline rules reach installs that already seeded (#755 chunk 2)', () => {
  const OLD = '**Never edit files outside this directory.** Your home is your only writable'
    + ' surface, and durable notes belong under `memory/`. You have no project'
    + ' working tree by design — do not go looking for one.';

  beforeEach(() => clearMasterRules());

  it('upgrades an UNEDITED superseded row, so an existing install stops contradicting itself', () => {
    // Seeding only ever runs on an empty table, so without this every install
    // that ever opened the Master would keep "Never edit files outside this
    // directory" while the same generated CLAUDE.md says "you may create and
    // edit files anywhere" at `write`. On a non-Claude master that contradiction
    // IS the boundary.
    store.sessionRules.create({
      content: OLD, kind: 'master', createdBy: 'system', criticGate: 'not-required'
    });
    master.seedBaselineMasterRules();

    const rules = store.sessionRules.list({ kind: 'master' }).map((r) => r.content);
    assert.ok(!rules.includes(OLD), 'the superseded text must be gone');
    assert.ok(rules.some((c) => c.includes('unless your access level allows it')),
      'and replaced by the shipped one');
  });

  it('leaves an operator-EDITED row alone — their text is theirs', () => {
    const mine = OLD + ' And one more thing I added myself.';
    store.sessionRules.create({
      content: mine, kind: 'master', createdBy: 'operator', criticGate: 'not-required'
    });
    master.seedBaselineMasterRules();

    const rules = store.sessionRules.list({ kind: 'master' }).map((r) => r.content);
    assert.ok(rules.includes(mine), 'an edited row must survive verbatim');
  });

  it('keeps the migration history — provenance outlives the rewrite', () => {
    const created = store.sessionRules.create({
      content: OLD, kind: 'master', createdBy: 'system', criticGate: 'not-required'
    });
    master.seedBaselineMasterRules();
    const versions = store.sessionRules.listVersions(created.id);
    assert.ok(versions.length >= 1, 'the rewrite must be recorded, not silent');
    assert.ok(versions.some((v) => (v.changeReason || '').includes('#755')));
  });

  it('does not re-seed when rows already exist', () => {
    store.sessionRules.create({
      content: 'Just one rule.', kind: 'master', createdBy: 'operator', criticGate: 'not-required'
    });
    assert.equal(master.seedBaselineMasterRules(), 0);
    assert.equal(store.sessionRules.list({ kind: 'master' }).length, 1);
  });
});

describe('the identity states the access level (#755 chunk 2)', () => {
  const STRUCT = { serverPort: 3101, master: { engine: 'claude' } };

  /** Identity rendered at an explicit level/enforcement pair. */
  function idAt(level, enforcement) {
    return master.buildMasterClaudeMd(STRUCT, { accessLevel: level, enforcement });
  }

  it('says what the master may write, differently at each tier', () => {
    const ro = idAt('read-only', 'structural');
    assert.match(ro, /## Your current access level/);
    assert.match(ro, /\*\*read-only\*\* — structurally enforced/);
    assert.match(ro, /may \*\*not\*\* create or edit files outside `memory\/`/);

    const sg = idAt('suggest', 'structural');
    assert.match(sg, /\*\*suggest\*\* — structurally enforced/);
    assert.match(sg, /stops for/);
    assert.match(sg, /confirm or decline in this terminal/);
    // The tier is useless if the master treats the confirmation as an obstacle.
    assert.match(sg, /Do not treat a refusal as an error to work around/);

    const wr = idAt('write', 'structural');
    assert.match(wr, /\*\*write\*\* — structurally enforced/);
    assert.match(wr, /without asking first/);
    assert.match(wr, /revocable/);

    // Each tier must say something DIFFERENT — a section that renders the same
    // prose at every level would pass a "contains the level" assertion while
    // telling the master nothing.
    assert.notEqual(ro, sg);
    assert.notEqual(sg, wr);
    assert.notEqual(ro, wr);
  });

  it('never claims a write it cannot make: read-only prose has no permissive sentence', () => {
    const ro = idAt('read-only', 'structural');
    assert.doesNotMatch(ro, /without asking first/);
    assert.doesNotMatch(ro, /You may create and edit files anywhere/);
  });

  it('an unknown level degrades to the read-only statement, not to silence', () => {
    // Matches the guard: anything unrecognized is read-only. Silence here would
    // be the failure — an identity with no access-level section at all reads as
    // "unbounded" to a master that has no other source for the answer.
    const junk = idAt('root', 'structural');
    assert.match(junk, /## Your current access level/);
    assert.match(junk, /could not be determined, so you are read-only/);
    assert.match(junk, /may not/);
  });

  it('tells an instructional master that nothing mechanically stops it', () => {
    // On four of five engines this prose IS the boundary. Claiming structural
    // enforcement there would be the silently-false capability the honest-
    // degradation rule exists to prevent.
    const inst = idAt('write', 'instructional');
    assert.match(inst, /instructional only/);
    assert.match(inst, /no write guard/);
    assert.match(inst, /only because you honor it/);
    assert.doesNotMatch(inst, /very next tool call/);

    const struct = idAt('write', 'structural');
    assert.match(struct, /very next tool call/);
    assert.doesNotMatch(struct, /only because you honor it/);
  });

  it('names the shell gap to the master, and names it differently per tier', () => {
    // The guard's matcher is Edit|Write|NotebookEdit, so a shell redirect is not
    // covered. That gap is the one a well-meaning agent walks straight through,
    // so the identity has to say it — and say it in a form that is TRUE at the
    // tier. Rendering one sentence at both tiers produced "the guard covers the
    // file-editing tools" two lines above "there is no write guard".
    const struct = idAt('read-only', 'structural');
    assert.match(struct, /shell commands are not hooked/);
    assert.match(struct, /working around the boundary, not around a bug/);
    assert.doesNotMatch(struct, /no write guard at all/);

    const inst = idAt('read-only', 'instructional');
    assert.match(inst, /no write guard at all/);
    assert.match(inst, /not for shell commands/);
    assert.doesNotMatch(inst, /shell commands are not hooked/,
      'the structural phrasing implies a guard exists, which is false here');
  });

  it('resolves the level from config when the caller did not pass one', () => {
    // THE MUTATION THIS CATCHES: defaulting to 'read-only' here. That is the
    // safe-LOOKING choice and the wrong one — it would render "you are
    // read-only" into the identity of a master the operator set to `write`,
    // disagreeing with the guard, and on an instructional engine that prose is
    // the only boundary there is.
    const cfg = store.config.load();
    const previous = cfg.master;
    store.config.save({ ...cfg, master: { ...(cfg.master || {}), accessLevel: 'write' } });
    try {
      const md = master.buildMasterClaudeMd(store.config.load());
      assert.match(md, /\*\*write\*\*/);
      assert.doesNotMatch(md, /\*\*read-only\*\* —/);
    } finally {
      store.config.save({ ...store.config.load(), master: previous });
    }
  });

  it('the API boundary stays unconditional at every tier — #755 grants files, never the API', () => {
    for (const level of master.MASTER_ACCESS_LEVELS) {
      const md = idAt(level, 'structural');
      assert.match(md, /Use only GET endpoints/, `${level}: the API rule must survive`);
      assert.match(md, /you use read-only/, `${level}: the role prose must keep the API half`);
    }
  });

  it('a level change does not touch the operator\'s edited rules', () => {
    // The rules are the operator's text, versioned and restorable; the level is
    // generated. Rewriting rules to track a setting would either destroy an edit
    // or leave it contradicting the live posture.
    const edited = [{ content: 'My own rule, do not rewrite me.' }];
    const before = master.buildMasterClaudeMd(STRUCT, { rules: edited, accessLevel: 'read-only', enforcement: 'structural' });
    const after = master.buildMasterClaudeMd(STRUCT, { rules: edited, accessLevel: 'write', enforcement: 'structural' });
    for (const md of [before, after]) {
      assert.match(md, /- My own rule, do not rewrite me\./);
      assert.doesNotMatch(md, /Do not edit files outside this directory/,
        'custom rules REPLACE the baseline, at every level');
    }
    assert.notEqual(before, after, 'but the generated level section still moved');
  });
});

describe('buildMasterClaudeMd — scope and memory sections', () => {
  it('renders the all-projects scope by default, with the fallback warning when present', () => {
    const md = master.buildMasterClaudeMd({ serverPort: 3101 });
    assert.match(md, /## Scope/);
    assert.match(md, /All projects on this TangleClaw instance are in scope\./);
    const warned = master.buildMasterClaudeMd({ serverPort: 3101 }, {
      scope: { kind: 'all', warning: 'The configured scope group no longer exists; scope fell back to all projects.' }
    });
    assert.match(warned, /scope fell back to all projects/);
  });

  it('renders group scope with the member project list and the honest not-a-boundary line', () => {
    const md = master.buildMasterClaudeMd({ serverPort: 3101 }, {
      scope: { kind: 'group', groupName: 'backend', projects: [{ name: 'api-server' }, { name: 'worker' }] }
    });
    assert.match(md, /scoped to the \*\*backend\*\* project group/);
    assert.match(md, /- api-server/);
    assert.match(md, /- worker/);
    assert.match(md, /not a security boundary/);
  });

  it('describes the memory carve-out: TC-refreshed vs master-maintained files', () => {
    const md = master.buildMasterClaudeMd({ serverPort: 3101 });
    assert.match(md, /## Memory/);
    assert.match(md, /memory\/FLEET\.md/);
    assert.match(md, /memory\/CHANGELOG\.md/);
    assert.match(md, /never edit them/);
  });
});

describe('_resolveScope', () => {
  it('falls back to all-projects (with warning) when the configured group is gone', () => {
    const resolved = master._resolveScope({ type: 'group', groupId: 'no-such-group' });
    assert.equal(resolved.kind, 'all');
    assert.match(resolved.warning, /no longer exists/);
  });

  it('resolves a real group to its name and member projects', () => {
    const p = store.projects.create({ name: 'scope-proj', path: '/tmp/scope-proj' });
    const g = store.projectGroups.create({ name: 'scope-group' });
    store.projectGroups.addMember(g.id, p.id);
    const resolved = master._resolveScope({ type: 'group', groupId: g.id });
    assert.equal(resolved.kind, 'group');
    assert.equal(resolved.groupName, 'scope-group');
    assert.deepEqual(resolved.projects.map((x) => x.name), ['scope-proj']);
  });
});

describe('master memory scaffold', () => {
  it('refreshes TC-maintained files and seeds master-maintained files exactly once', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-mem-'));
    try {
      master._refreshMasterMemory(home);
      const memDir = path.join(home, 'memory');
      for (const f of ['FLEET.md', 'HOWTO.md', 'MEMORY.md', 'CHANGELOG.md', 'NOTES.md']) {
        assert.ok(fs.existsSync(path.join(memDir, f)), `${f} must exist`);
      }
      // Master-maintained files survive a second refresh untouched…
      fs.writeFileSync(path.join(memDir, 'NOTES.md'), 'master wrote this');
      fs.writeFileSync(path.join(memDir, 'CHANGELOG.md'), 'activity entry');
      // …while TC-maintained files are overwritten (hand-edits are futile).
      fs.writeFileSync(path.join(memDir, 'FLEET.md'), 'stale hand-edit');
      master._refreshMasterMemory(home);
      assert.equal(fs.readFileSync(path.join(memDir, 'NOTES.md'), 'utf8'), 'master wrote this');
      assert.equal(fs.readFileSync(path.join(memDir, 'CHANGELOG.md'), 'utf8'), 'activity entry');
      assert.match(fs.readFileSync(path.join(memDir, 'FLEET.md'), 'utf8'), /Generated by TangleClaw/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('lists registered projects (including archived, labeled) in the fleet map', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-fleet-'));
    try {
      const p = store.projects.create({ name: 'fleet-proj', path: '/tmp/fleet-proj', engineId: 'claude' });
      store.projects.archive(p.id);
      master._refreshMasterMemory(home);
      const fleet = fs.readFileSync(path.join(home, 'memory', 'FLEET.md'), 'utf8');
      assert.match(fleet, /\*\*fleet-proj\*\*/);
      assert.match(fleet, /ARCHIVED/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('read-only guardrails (structural enforcement)', () => {
  const { spawnSync } = require('node:child_process');

  /** Run the generated guard script with a tool-input payload; returns
   *  { denied, reason } parsed from its stdout contract. */
  function runGuard(home, payload) {
    const script = path.join(home, '.claude', 'hooks', 'guard-writes.js');
    const res = spawnSync(process.execPath, [script], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8'
    });
    assert.equal(res.status, 0, `guard must always exit 0 (got ${res.status}: ${res.stderr})`);
    // No stdout is the fall-through case: the guard declined to decide, so the
    // harness's own permission rules apply. `decision: null` names that, rather
    // than letting it read as an allow the guard actually issued.
    if (!res.stdout) return { denied: false, decision: null };
    const out = JSON.parse(res.stdout);
    return {
      denied: out.hookSpecificOutput.permissionDecision === 'deny',
      decision: out.hookSpecificOutput.permissionDecision,
      reason: out.hookSpecificOutput.permissionDecisionReason
    };
  }

  it('writes settings.json (memory allow rules + PreToolUse matcher) and the guard script', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-guard-'));
    try {
      master._writeMasterGuardrails(home);
      const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
      assert.deepEqual(settings.permissions.allow, ['Edit(./memory/**)', 'Write(./memory/**)']);
      assert.equal(settings.hooks.PreToolUse[0].matcher, 'Edit|Write|NotebookEdit');
      assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /guard-writes\.js/);
      assert.ok(fs.existsSync(path.join(home, '.claude', 'hooks', 'guard-writes.js')));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('the guard allows writes inside memory/ and hard-denies everywhere else — including .claude/ itself', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-guard-'));
    try {
      master._writeMasterGuardrails(home);
      assert.equal(runGuard(home, { tool_input: { file_path: path.join(home, 'memory', 'NOTES.md') } }).denied, false);
      assert.equal(runGuard(home, { tool_input: { file_path: 'memory/nested/deep.md' } }).denied, false, 'relative paths resolve against the home');
      assert.equal(runGuard(home, { tool_input: { file_path: path.join(home, 'CLAUDE.md') } }).denied, true);
      assert.equal(runGuard(home, { tool_input: { file_path: '/etc/hosts' } }).denied, true);
      // The guard protects its own config — the master cannot edit away its guardrails.
      assert.equal(runGuard(home, { tool_input: { file_path: path.join(home, '.claude', 'settings.json') } }).denied, true);
      // Escape attempts via .. resolve outside and deny.
      assert.equal(runGuard(home, { tool_input: { file_path: 'memory/../CLAUDE.md' } }).denied, true);
      // A sibling like memory-evil/ must not prefix-match the carve-out.
      assert.equal(runGuard(home, { tool_input: { file_path: path.join(home, 'memory-evil', 'x.md') } }).denied, true);
      // NotebookEdit carries notebook_path.
      assert.equal(runGuard(home, { tool_input: { notebook_path: path.join(home, 'memory', 'n.ipynb') } }).denied, false);
      assert.equal(runGuard(home, { tool_input: { notebook_path: path.join(home, 'n.ipynb') } }).denied, true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('the guard denies by default on malformed or pathless input (harness fails open on crashes — the guard must not crash)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-guard-'));
    try {
      master._writeMasterGuardrails(home);
      assert.equal(runGuard(home, 'not json at all').denied, true);
      assert.equal(runGuard(home, { tool_input: {} }).denied, true);
      assert.equal(runGuard(home, {}).denied, true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('access level — the guard reads it per invocation (#755)', () => {
  const { spawnSync } = require('node:child_process');

  /** Run the generated guard and report which of the three PreToolUse outcomes
   *  it chose: 'deny' | 'ask' | 'allow', or null for fall-through (no stdout). */
  function guardDecision(home, payload) {
    const script = path.join(home, '.claude', 'hooks', 'guard-writes.js');
    const res = spawnSync(process.execPath, [script], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8'
    });
    assert.equal(res.status, 0, `guard must always exit 0 (got ${res.status}: ${res.stderr})`);
    if (!res.stdout) return null;
    return JSON.parse(res.stdout).hookSpecificOutput.permissionDecision;
  }

  /** Engine resolvers pinned per test, so enforcement is decided by the CASE and
   *  not by which CLIs the host happens to have installed. Without this, the
   *  guard-restoration tests read the machine's real config and go red anywhere
   *  `claude` is not the resolved default — CI included — for an environment
   *  reason rather than a code one. */
  const STRUCTURAL = { resolveDefaultEngine: () => 'claude', reconcileLaunchMode: () => 'default' };
  const INSTRUCTIONAL = { resolveDefaultEngine: () => 'gemini', reconcileLaunchMode: () => 'default' };

  /** A master home with guardrails written and `level` in place. Pass `null` to
   *  leave no level file at all. */
  function homeAt(level) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-level-'));
    master._writeMasterGuardrails(home);
    if (level !== null) master.writeMasterAccessLevel(home, level);
    return home;
  }

  const OUTSIDE = '/etc/hosts';

  it('the generated guard is syntactically valid JavaScript', () => {
    // The guard is built inside a template literal, so a stray backtick in one of
    // its comments silently ends the string — which is a syntax error in
    // lib/master.js, not in the guard, and it takes the whole module down at
    // require time. This names that failure directly instead of leaving it to be
    // inferred from every other test in the file failing at once.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-syn-'));
    try {
      const script = path.join(home, 'guard.js');
      fs.writeFileSync(script, master.buildMasterGuardScript(home));
      const res = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
      assert.equal(res.status, 0, `generated guard does not parse:\n${res.stderr}`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('stores the level beside memory/, never inside it — a level file the master could edit is one it could raise', () => {
    const home = '/tmp/tc-master-x';
    const levelFile = master.masterAccessLevelPath(home);
    assert.equal(path.dirname(levelFile), home, 'level file lives at the home root');
    const memoryDir = path.join(home, 'memory') + path.sep;
    assert.ok(!levelFile.startsWith(memoryDir),
      `the level file must not sit inside the master's own write carve-out (got ${levelFile})`);
  });

  it('read-only denies outside memory/ and falls through inside it', () => {
    const home = homeAt('read-only');
    try {
      assert.equal(guardDecision(home, { tool_input: { file_path: OUTSIDE } }), 'deny');
      assert.equal(guardDecision(home, { tool_input: { file_path: path.join(home, 'memory', 'N.md') } }), null);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('suggest asks outside memory/ — the confirmation IS the tier — and falls through inside it', () => {
    const home = homeAt('suggest');
    try {
      assert.equal(guardDecision(home, { tool_input: { file_path: OUTSIDE } }), 'ask');
      assert.equal(guardDecision(home, { tool_input: { notebook_path: OUTSIDE } }), 'ask');
      // Inside the carve-out there is nothing to confirm — it was already the
      // master's own writable surface at every tier.
      assert.equal(guardDecision(home, { tool_input: { file_path: path.join(home, 'memory', 'N.md') } }), null);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('suggest never merely ASKS about the guard\'s own controls — that would be a one-click escalation', () => {
    // A tier whose point is per-action approval must not let one approval hand
    // over every future action: confirming an edit to .access-level grants
    // permanent write, and confirming one to the hook removes the boundary.
    const home = homeAt('suggest');
    try {
      for (const target of [
        master.masterAccessLevelPath(home),
        path.join(home, '.claude', 'settings.json'),
        path.join(home, '.claude', 'hooks', 'guard-writes.js')
      ]) {
        assert.equal(guardDecision(home, { tool_input: { file_path: target } }), 'deny',
          `${target} must be refused outright, not offered for confirmation`);
      }
      // An ordinary path is still the tier's normal ask.
      assert.equal(guardDecision(home, { tool_input: { file_path: OUTSIDE } }), 'ask');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a symlink inside memory/ cannot smuggle a write outside it', () => {
    // `path.resolve` normalises ".." lexically but does not follow links, so a
    // link created inside the carve-out — which the master may create at every
    // tier, since memory/ is writable — would otherwise pass the prefix test and
    // write wherever it points.
    const home = homeAt('read-only');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-escape-'));
    try {
      fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
      const link = path.join(home, 'memory', 'escape');
      fs.symlinkSync(outsideDir, link, 'dir');
      assert.equal(guardDecision(home, { tool_input: { file_path: path.join(link, 'pwned.txt') } }), 'deny',
        'a write through a symlink out of memory/ must be refused');
      // The carve-out itself still works.
      assert.equal(guardDecision(home, { tool_input: { file_path: path.join(home, 'memory', 'NOTES.md') } }), null);
      assert.equal(guardDecision(home, { tool_input: { file_path: path.join(home, 'memory', 'deep', 'new.md') } }), null,
        'a not-yet-existing path under memory/ is still allowed');

      // The LEAF case: the target itself is the link, so resolving only its
      // parent would leave the final component unfollowed.
      const outsideFile = path.join(outsideDir, 'target.txt');
      fs.writeFileSync(outsideFile, 'x');
      const leaf = path.join(home, 'memory', 'leaflink');
      fs.symlinkSync(outsideFile, leaf, 'file');
      assert.equal(guardDecision(home, { tool_input: { file_path: leaf } }), 'deny',
        'a symlinked FILE inside memory/ must be refused too');

      // The DANGLING case, which is the shape an attacker actually controls and
      // the one an existence check cannot see: `existsSync` follows links, so it
      // answers false here — while `writeFileSync` through the link still
      // creates the file at the destination, outside the carve-out.
      const dangling = path.join(home, 'memory', 'danglink');
      fs.symlinkSync(path.join(outsideDir, 'not-created-yet.md'), dangling, 'file');
      assert.equal(guardDecision(home, { tool_input: { file_path: dangling } }), 'deny',
        'a write through a DANGLING symlink out of memory/ must be refused');

      // A link chain must not launder it either.
      const hop = path.join(home, 'memory', 'hoplink');
      fs.symlinkSync(dangling, hop, 'file');
      assert.equal(guardDecision(home, { tool_input: { file_path: hop } }), 'deny',
        'a chain of links landing outside must be refused');

      // A chain LONGER than the guard's hop cap. The kernel follows far more
      // links than the guard does (MAXSYMLINKS is 32 on macOS, 40 on Linux), so
      // if exhausting the counter resolved permissively, this would write
      // outside the carve-out. A chain shorter than the cap measures nothing —
      // it exits through the normal break — so this one is deliberately 20.
      let prev = path.join(outsideDir, 'deep-target.md');
      for (let i = 20; i >= 1; i--) {
        const linkPath = path.join(home, 'memory', `chain${i}`);
        fs.symlinkSync(prev, linkPath, 'file');
        prev = linkPath;
      }
      assert.equal(guardDecision(home, { tool_input: { file_path: prev } }), 'deny',
        'a chain longer than the hop cap must be refused, not resolved permissively');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('read-only refuses the control surface too, for the same reason', () => {
    const home = homeAt('read-only');
    try {
      assert.equal(guardDecision(home, { tool_input: { file_path: master.masterAccessLevelPath(home) } }), 'deny');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('suggest refuses TangleClaw\'s OWN config — the level really lives there (R-2)', () => {
    // The other control-surface entries all sit inside the master home. The
    // AUTHORITATIVE copy of the level does not: `~/.tangleclaw/config.json` is
    // the home's sibling, and every ensure copies `master.accessLevel` out of it
    // into `.access-level`. So before this, `suggest` contained its own permanent
    // escalation one directory up — one confirmed edit there, and the next ensure
    // makes the master `write` forever. A tier whose whole promise is that each
    // action is individually approved would have been handing over every future
    // action on a single click.
    //
    // `suggest` is the tier under test, not `read-only`: at read-only everything
    // outside `memory/` is denied anyway, so the deny there proves nothing about
    // the control list. `ask` is the outcome the escalation rides.
    //
    // THE MUTATION THIS CATCHES: removing TC_CONFIG_FILE from the guard's
    // `control` array — which leaves every other control-surface assertion green.
    //
    // The path comes from the STORE, not from `master.masterControlConfigPath()`.
    // Asking master where its own config is would let a fix and this test share a
    // premise: hardcoding the accessor to `~/.tangleclaw/config.json` moves both
    // sides together and the assertion stays green while the guard protects a
    // path this test suite never uses. That mutation was run, and it WAS green
    // until this line changed.
    const cfg = store.config.file();
    for (const level of ['read-only', 'suggest']) {
      const home = homeAt(level);
      try {
        assert.equal(guardDecision(home, { tool_input: { file_path: cfg } }), 'deny',
          `${level} must refuse TangleClaw's config outright, never merely ask`);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('the control-surface refusal reaches the config path the STORE reports', () => {
    // Not a second `path.join` in the test either. If the guard interpolated one
    // path and the store used another, both this assertion and the product would
    // be wrong together — which is the shape that makes a guard look proven and
    // protect nothing.
    //
    // THE MUTATION THIS CATCHES: hardcoding `~/.tangleclaw/config.json` in the
    // guard instead of asking the store, which silently stops matching the moment
    // `_setBasePath` moves it — the exact condition every test run creates.
    const home = homeAt('suggest');
    try {
      const src = fs.readFileSync(path.join(home, '.claude', 'hooks', 'guard-writes.js'), 'utf8');
      assert.ok(src.includes(JSON.stringify(store.config.file())),
        'the generated guard must carry the store\'s own config path');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a dangling DIRECTORY link inside the carve-out is refused, like the file one (R-3)', () => {
    // Chunk 2 replaced `existsSync` with `lstat` for LEAF-ness because
    // `existsSync` follows links and answers false for a dangling one. The
    // ancestor climb kept `existsSync`, so the directory-shaped variant of the
    // same hole survived: the walk stepped straight PAST the dangling component,
    // `realpath` resolved only the surviving ancestor, and the target rebuilt
    // lexically inside `memory/` — allowed.
    //
    // The already-covered case is a dangling FILE link. This is the sibling, and
    // the reason it needed its own test is that the two go through different
    // halves of the resolver.
    //
    // THE MUTATION THIS CATCHES: reverting the climb's predicate to
    // `fs.existsSync(dir)`, which leaves the leaf test green.
    const home = homeAt('read-only');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-escape-dir-'));
    try {
      fs.rmSync(outsideDir, { recursive: true, force: true }); // now a dangling TARGET
      fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
      const link = path.join(home, 'memory', 'gonedir');
      fs.symlinkSync(outsideDir, link, 'dir');
      assert.equal(fs.existsSync(link), false,
        'precondition: the link must be dangling, or this measures the resolved case');
      assert.equal(guardDecision(home, { tool_input: { file_path: path.join(link, 'x.md') } }), 'deny',
        'a path whose parent cannot be resolved must be refused, not rebuilt lexically');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('write allows — and allows explicitly, because falling through would only reach the ask-gate', () => {
    const home = homeAt('write');
    try {
      assert.equal(guardDecision(home, { tool_input: { file_path: OUTSIDE } }), 'allow');
      assert.equal(guardDecision(home, { tool_input: { file_path: path.join(home, '.claude', 'settings.json') } }), 'allow');
      assert.equal(guardDecision(home, { tool_input: { file_path: path.join(home, 'memory', 'N.md') } }), 'allow');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a flip binds on the NEXT invocation — no regeneration, no restart', () => {
    const home = homeAt('read-only');
    try {
      assert.equal(guardDecision(home, { tool_input: { file_path: OUTSIDE } }), 'deny');
      // Only the level file changes. The guard script is NOT rewritten, which is
      // the property that makes the operator's toggle immediate.
      const before = fs.readFileSync(path.join(home, '.claude', 'hooks', 'guard-writes.js'), 'utf8');
      master.writeMasterAccessLevel(home, 'write');
      assert.equal(guardDecision(home, { tool_input: { file_path: OUTSIDE } }), 'allow');
      master.writeMasterAccessLevel(home, 'read-only');
      assert.equal(guardDecision(home, { tool_input: { file_path: OUTSIDE } }), 'deny');
      const after = fs.readFileSync(path.join(home, '.claude', 'hooks', 'guard-writes.js'), 'utf8');
      assert.equal(before, after, 'the guard script itself must not change when the level does');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // THE MUTATION THESE CATCH: any `readLevel()` failure path returning a
  // permissive level instead of 'read-only'. A level-aware guard that fails OPEN
  // is strictly worse than the baked-in one it replaced, so each of these is the
  // acceptance criterion rather than a nicety.
  it('every unreadable level degrades to read-only — absent, empty, whitespace, garbage, wrong case', () => {
    const cases = [
      ['absent', null],
      ['empty', ''],
      ['whitespace only', '   \n  '],
      ['garbage', 'yes-please'],
      ['wrong case', 'WRITE'],
      ['a token from a newer TangleClaw', 'write-with-confirmation'],
      ['an almost-match', 'writer'],
      ['a JSON object, in case someone changes the format under the guard', '{"level":"write"}']
    ];
    for (const [label, contents] of cases) {
      const home = homeAt(null);
      try {
        if (contents !== null) fs.writeFileSync(master.masterAccessLevelPath(home), contents);
        assert.equal(guardDecision(home, { tool_input: { file_path: OUTSIDE } }), 'deny',
          `level file (${label}) must degrade to read-only`);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('says WHY when read-only was reached by failing rather than by choice', () => {
    // Same outcome either way — that is the fail-closed property — but the
    // operator debugging a master that will not write has to be able to tell
    // "this is the posture I set" from "this guard cannot read its posture".
    function reasonFor(setup) {
      const home = homeAt(null);
      try {
        setup(home);
        const script = path.join(home, '.claude', 'hooks', 'guard-writes.js');
        const res = spawnSync(process.execPath, [script], {
          input: JSON.stringify({ tool_input: { file_path: OUTSIDE } }), encoding: 'utf8'
        });
        return JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason;
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
    const chosen = reasonFor((home) => master.writeMasterAccessLevel(home, 'read-only'));
    const failed = reasonFor((home) => fs.writeFileSync(master.masterAccessLevelPath(home), 'nonsense'));
    const absent = reasonFor(() => {});

    assert.doesNotMatch(chosen, /could not be read/,
      'a deliberate read-only must not accuse its own level file');
    for (const [label, reason] of [['garbage', failed], ['absent', absent]]) {
      assert.match(reason, /could not be read/, `${label}: the degrade must be stated`);
      assert.ok(reason.includes('.access-level'), `${label}: name the file to fix`);
    }
  });

  it('a level file that is a directory degrades to read-only', () => {
    const home = homeAt(null);
    try {
      fs.mkdirSync(master.masterAccessLevelPath(home), { recursive: true });
      assert.equal(guardDecision(home, { tool_input: { file_path: OUTSIDE } }), 'deny');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a level file that cannot be read degrades to read-only', (t) => {
    // Root bypasses mode bits, so the unreadable case cannot be staged as root.
    // Skipping is honest; asserting would report a pass the run never tested.
    if (process.getuid && process.getuid() === 0) {
      t.skip('running as root — mode 0o000 is still readable, so this cannot be staged');
      return;
    }
    const home = homeAt('write');
    try {
      // Staged from a level that WOULD allow, so a guard ignoring the read error
      // and reusing a cached/parsed value would show up as an allow here.
      fs.chmodSync(master.masterAccessLevelPath(home), 0o000);
      assert.equal(guardDecision(home, { tool_input: { file_path: OUTSIDE } }), 'deny');
    } finally {
      try { fs.chmodSync(master.masterAccessLevelPath(home), 0o600); } catch { /* already gone */ }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('trims surrounding whitespace, since the file is written with a trailing newline', () => {
    const home = homeAt(null);
    try {
      fs.writeFileSync(master.masterAccessLevelPath(home), '  write \n');
      assert.equal(guardDecision(home, { tool_input: { file_path: OUTSIDE } }), 'allow');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('revoking restores a guard the master tampered with while it was at write (#755)', () => {
    // At `write` the guard permits edits to every path INCLUDING its own hook
    // file, so a master that has been at write may have altered or deleted the
    // script meant to bind it again. Rewriting only the level file would then
    // revoke nothing until the next ensure — a toggle reporting a boundary it
    // did not restore.
    const home = homeAt('write');
    try {
      const script = path.join(home, '.claude', 'hooks', 'guard-writes.js');
      const genuine = fs.readFileSync(script, 'utf8');
      fs.writeFileSync(script, '#!/usr/bin/env node\nprocess.exit(0);\n'); // neutered
      assert.equal(guardDecision(home, { tool_input: { file_path: OUTSIDE } }), null,
        'precondition: the tampered guard decides nothing');

      master.applyMasterAccessLevel('read-only', { home, enginesLib: STRUCTURAL });

      assert.equal(fs.readFileSync(script, 'utf8'), genuine, 'the guard must be restored, not just the level');
      assert.equal(guardDecision(home, { tool_input: { file_path: OUTSIDE } }), 'deny',
        'revocation must actually bind');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('revoking restores a guard the master DELETED, not merely blanked (#755)', () => {
    // The sharper half of the same threat, and the one that defeated the first
    // fix: that version gated regeneration on the guard file existing — the very
    // artifact a master at `write` would remove. Under bypassPermissions an `rm`
    // is unconfirmed too, so deletion is not the exotic case.
    const home = homeAt('write');
    try {
      const script = path.join(home, '.claude', 'hooks', 'guard-writes.js');
      const genuine = fs.readFileSync(script, 'utf8');
      fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
      assert.ok(!fs.existsSync(script), 'precondition: the guard is gone');

      master.applyMasterAccessLevel('read-only', { home, enginesLib: STRUCTURAL });

      assert.ok(fs.existsSync(script), 'revocation must re-provision a deleted guard');
      assert.equal(fs.readFileSync(script, 'utf8'), genuine);
      assert.equal(guardDecision(home, { tool_input: { file_path: OUTSIDE } }), 'deny',
        'and it must actually bind');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('applyMasterAccessLevel does not provision structural enforcement on an INSTRUCTIONAL master', () => {
    // The change path must not hand a non-Claude master a guard it never had —
    // that would be a posture change nobody asked for, on the surface that is
    // supposed to degrade visibly instead. Driven through the engine resolver
    // rather than through "does a guard already exist", because that is what
    // decides enforcement everywhere else.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-instr-'));
    try {
      const result = master.applyMasterAccessLevel('write', { home, enginesLib: INSTRUCTIONAL });
      assert.equal(result.applied, true);
      assert.equal(result.enforcement, 'instructional');
      assert.equal(fs.readFileSync(master.masterAccessLevelPath(home), 'utf8').trim(), 'write',
        'the level is still recorded — intent is useful even where it is not structurally backed');
      assert.ok(!fs.existsSync(path.join(home, '.claude')),
        'an instructional master must not be handed a guard by the change path');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('writeMasterAccessLevel round-trips every level the settings surface can store', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-level-rt-'));
    try {
      for (const level of master.MASTER_ACCESS_LEVELS) {
        master.writeMasterAccessLevel(home, level);
        assert.equal(fs.readFileSync(master.masterAccessLevelPath(home), 'utf8').trim(), level);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('every enabled level is one the guard actually understands', () => {
    // The gate this holds: a tier becomes selectable only WITH its enforcement.
    // Adding a fourth id to MASTER_ACCESS_LEVELS and enabling it without
    // teaching the guard would leave it silently equal to read-only.
    const understood = new Set(['read-only', 'suggest', 'write']);
    for (const level of master.MASTER_ENABLED_ACCESS_LEVELS) {
      assert.ok(understood.has(level),
        `"${level}" is selectable but the write guard has no branch for it — it would silently mean read-only`);
      assert.ok(master.MASTER_ACCESS_LEVELS.includes(level),
        `"${level}" is enabled but not a known access level`);
    }
  });
});

describe('ensureMasterSession — settings integration', () => {
  let home;

  beforeEach(() => {
    clearMasterRules();
    home = path.join(tmpDir, `master-home-s-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  it('seeds the baseline, renders it into CLAUDE.md, scaffolds memory, and writes guardrails (claude engine)', () => {
    const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux({ alive: false }), enginesLib: availableEngines });
    assert.equal(r.created, true);
    assert.equal(r.engine, 'claude');
    assert.equal(r.accessLevel, 'read-only');
    assert.equal(r.enforcement, 'structural');
    assert.equal(store.sessionRules.list({ kind: 'master' }).length, master.MASTER_BASELINE_RULES.length);
    assert.match(fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8'), /Use only GET endpoints/);
    assert.ok(fs.existsSync(path.join(home, 'memory', 'FLEET.md')));
    assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')));
  });

  it('renders edited rules into the identity on the next ensure', () => {
    master.seedBaselineMasterRules();
    store.sessionRules.create({ content: 'Session-rules-backed custom boundary.', kind: 'master' });
    master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux({ alive: true }), enginesLib: availableEngines });
    assert.match(fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8'), /Session-rules-backed custom boundary\./);
  });

  it('resolves a pinned master.engine that is not installed (#707)', () => {
    // The bypass this closes: `_masterRuntime` honored `settings.engine`
    // unconditionally, so an operator who pinned Claude in Master settings on a
    // machine without Claude got `Engine "claude" not available (binary not
    // found)` — the exact failure the resolver exists to prevent, reached
    // through a second door. Fails against `settings.engine || ...`.
    const config = store.config.load();
    const saved = config.master;
    try {
      config.master = { accessLevel: 'read-only', engine: 'claude', scope: 'all', autoStart: false };
      store.config.save(config);
      const r = master.ensureMasterSession({ refreshFleet: NO_FLEET,
        home, tmuxLib: fakeTmux({ alive: false }), enginesLib: enginesInstalling(['codex'])
      });
      assert.equal(r.engine, 'codex', 'a pinned engine that is not installed must resolve, not be honored');
      assert.equal(r.enforcement, 'instructional');
    } finally {
      config.master = saved;
      store.config.save(config);
    }
  });

  it('keeps a pinned master.engine that IS installed', () => {
    const config = store.config.load();
    const saved = config.master;
    try {
      config.master = { accessLevel: 'read-only', engine: 'codex', scope: 'all', autoStart: false };
      store.config.save(config);
      const r = master.ensureMasterSession({ refreshFleet: NO_FLEET,
        home, tmuxLib: fakeTmux({ alive: false }), enginesLib: enginesInstalling(['claude', 'codex'])
      });
      assert.equal(r.engine, 'codex', 'an installed pin must be honored, not overridden');
    } finally {
      config.master = saved;
      store.config.save(config);
    }
  });

  /*
   * #756 — the Master had no launch mode at any layer. `lib/master.js` built its
   * session with a hardcoded `null`, on the reasoning that ask-gating everything
   * was part of the read-only posture. That conflated two independent axes: this
   * one governs whether the agent prompts inside ITS OWN session and is enforced
   * by the engine; the access level governs what the Master may do to the fleet
   * and is enforced by TangleClaw. A read-only Master in `bypassPermissions` is
   * coherent — it edits its own `memory/` without nagging and still cannot touch
   * the fleet.
   *
   * These assert the FLAGS that reach the launch command, not the argument
   * passed to a spy: the engine profile is the thing that turns a mode id into
   * `--permission-mode acceptEdits`, so a test that stopped at the call boundary
   * would keep passing if the mode never reached the CLI.
   */
  describe('#756 — the Master honors a launch mode', () => {
    /** Run an ensure with a stored master block, restoring config after. */
    function ensureWithMaster(masterBlock, opts = {}) {
      const config = store.config.load();
      const saved = config.master;
      try {
        config.master = { accessLevel: 'read-only', engine: null, scope: 'all', autoStart: false, ...masterBlock };
        store.config.save(config);
        const tmuxLib = fakeTmux({ alive: false });
        const r = master.ensureMasterSession({ refreshFleet: NO_FLEET,
          home, tmuxLib, enginesLib: opts.enginesLib || availableEngines
        });
        return { result: r, command: tmuxLib.calls.length ? tmuxLib.calls[0].opts.command : null };
      } finally {
        config.master = saved;
        store.config.save(config);
      }
    }

    it('puts the stored mode\'s real flags into the launch command', () => {
      const { result, command } = ensureWithMaster({ launchMode: 'acceptEdits', engine: 'claude' });
      assert.equal(result.created, true);
      assert.match(command, /--permission-mode acceptEdits/,
        'the mode must reach the CLI, not stop at the call boundary');
      assert.equal(result.launchMode, 'acceptEdits');
    });

    it('defaults to the interactive mode when nothing is stored', () => {
      const { result, command } = ensureWithMaster({ engine: 'claude' });
      assert.equal(result.launchMode, 'default');
      assert.doesNotMatch(command, /--permission-mode|--dangerously-skip-permissions/,
        "the default mode adds no flags — it is the engine's own interactive default");
    });

    it('reconciles a mode the effective engine cannot honor down to default', () => {
      // `acceptEdits` is Claude's; aider defines `yesAlways` and knows nothing
      // about it. Passing it through would hand the CLI a flag it rejects.
      const { result, command } = ensureWithMaster(
        { launchMode: 'acceptEdits', engine: 'aider' },
        { enginesLib: enginesInstalling(['aider']) }
      );
      assert.equal(result.launchMode, 'default',
        'an unhonored mode must reconcile, never reach the CLI');
      assert.doesNotMatch(String(command), /acceptEdits/);
    });

    it('does not FLATTEN the stored choice when an engine cannot honor it', () => {
      // The reconcile happens at launch, not at rest. An operator who picks
      // acceptEdits on Claude, switches the Master to aider, and switches back
      // must find their choice intact rather than silently rewritten to
      // 'default' on the way past.
      const config = store.config.load();
      const saved = config.master;
      try {
        config.master = { accessLevel: 'read-only', engine: 'aider', launchMode: 'acceptEdits', scope: 'all', autoStart: false };
        store.config.save(config);
        master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux({ alive: false }), enginesLib: enginesInstalling(['aider']) });
        assert.equal(master.masterSettings(store.config.load()).launchMode, 'acceptEdits',
          'the stored preference must survive an engine that cannot honor it');
      } finally {
        config.master = saved;
        store.config.save(config);
      }
    });

    it('status reports the stored mode, the resolved mode, and what the engine offers', () => {
      const config = store.config.load();
      const saved = config.master;
      try {
        config.master = { accessLevel: 'read-only', engine: 'aider', launchMode: 'acceptEdits', scope: 'all', autoStart: false };
        store.config.save(config);
        const st = master.getMasterStatus({ tmuxLib: fakeTmux({ alive: true }), enginesLib: enginesInstalling(['aider']) });
        assert.equal(st.settings.launchMode, 'acceptEdits', 'what the operator picked');
        assert.equal(st.settings.resolvedLaunchMode, 'default', 'what will actually run');
        assert.ok(Array.isArray(st.settings.launchModes), 'the surface must not re-derive the offered set');
        assert.ok(!st.settings.launchModes.includes('acceptEdits'),
          'aider does not offer acceptEdits, so the picker must not show it as available');
      } finally {
        config.master = saved;
        store.config.save(config);
      }
    });

    it('WARNS on the launch path when the stored mode is not honored', () => {
      // This warn IS the R-24 fix. The debug line in `_masterRuntime` writes
      // nothing on a default install (logger defaults to `info`), so the launch
      // path is the only place the degrade is actually recorded — and nothing
      // asserted it. The sibling warn in lib/sessions.js is pinned by
      // test/codex-launch-modes.test.js against a DIFFERENT string
      // ("not honored by this engine"), so it cannot stand in for this one.
      const logger = require('../lib/logger');
      const captured = [];
      const priorLevel = 'error';
      logger.setLevel('warn');
      logger.setConsoleStream({ write: (s) => captured.push(s) });
      const config = store.config.load();
      const saved = config.master;
      try {
        config.master = { accessLevel: 'read-only', engine: 'aider', launchMode: 'acceptEdits', scope: 'all', autoStart: false };
        store.config.save(config);
        master.ensureMasterSession({ refreshFleet: NO_FLEET,
          home, tmuxLib: fakeTmux({ alive: false }), enginesLib: enginesInstalling(['aider'])
        });
        assert.match(captured.join(''), /not honored by the resolved engine/,
          'a stranded mode must leave a record on the path where it actually bites');
        assert.match(captured.join(''), /acceptEdits/, 'naming what was stored');
      } finally {
        config.master = saved;
        store.config.save(config);
        logger.setConsoleStream(null);
        logger.setLevel(priorLevel);
      }
    });

    it('records the stranded mode on the STATUS path too, at debug', () => {
      // The polled path's counterpart to the launch warn. Debug because
      // `getMasterStatus` runs on every poll and a warn there would report a
      // stable condition at the poll's cadence (#906). Asserted at debug level
      // because that is the only level at which it is observable at all.
      const logger = require('../lib/logger');
      const captured = [];
      logger.setLevel('debug');
      logger.setConsoleStream({ write: (s) => captured.push(s) });
      const config = store.config.load();
      const saved = config.master;
      try {
        config.master = { accessLevel: 'read-only', engine: 'aider', launchMode: 'acceptEdits', scope: 'all', autoStart: false };
        store.config.save(config);
        master.getMasterStatus({ tmuxLib: fakeTmux({ alive: true }), enginesLib: enginesInstalling(['aider']) });
        assert.match(captured.join(''), /not honored by the resolved engine/);
      } finally {
        config.master = saved;
        store.config.save(config);
        logger.setConsoleStream(null);
        logger.setLevel('error');
      }
    });

    it('does NOT warn when the stored mode is honored', () => {
      // The negative case: a warn that always fires is not a signal.
      const logger = require('../lib/logger');
      const captured = [];
      logger.setLevel('warn');
      logger.setConsoleStream({ write: (s) => captured.push(s) });
      const config = store.config.load();
      const saved = config.master;
      try {
        config.master = { accessLevel: 'read-only', engine: 'claude', launchMode: 'acceptEdits', scope: 'all', autoStart: false };
        store.config.save(config);
        master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux({ alive: false }), enginesLib: availableEngines });
        assert.doesNotMatch(captured.join(''), /not honored by the resolved engine/);
      } finally {
        config.master = saved;
        store.config.save(config);
        logger.setConsoleStream(null);
        logger.setLevel('error');
      }
    });

    it('ships each offered mode with its human label, not a bare id', () => {
      // The project-settings picker renders `m.label || key`; a Master picker
      // showing `acceptEdits` would be the visibly poorer of two controls doing
      // the same job. Shipping the label here keeps the frontend from needing
      // the engine profile at all.
      const st = master.getMasterStatus({ tmuxLib: fakeTmux({ alive: true }), enginesLib: availableEngines });
      assert.ok(st.settings.launchModes.length > 0, 'this fixture must offer modes, or it proves nothing');
      for (const m of st.settings.launchModes) {
        assert.equal(typeof m.id, 'string');
        assert.equal(typeof m.label, 'string');
        assert.ok(m.label.length, `${m.id} must carry a label`);
      }
      const def = st.settings.launchModes.find((m) => m.id === 'default');
      assert.ok(def && def.label !== 'default', 'the label must come from the engine profile, not echo the id');

      // The SAFETY half, which the label assertions above do not cover:
      // data/engines/claude.json marks bypassPermissions with a warning, and
      // dropping it server-side would leave the picker unable to render ⚠ no
      // matter what the frontend does.
      const bypass = st.settings.launchModes.find((m) => m.id === 'bypassPermissions');
      assert.ok(bypass, 'claude offers bypassPermissions, or this fixture proves nothing');
      assert.ok(bypass.warning && bypass.warning.length,
        'a warned mode must carry its warning to the client');
      assert.ok(bypass.description && bypass.description.length,
        'and its description');
      const plain = st.settings.launchModes.find((m) => m.id === 'default');
      assert.equal(plain.warning, null, 'an unwarned mode carries null, not a missing field');
    });

    it('ensure and status agree on the mode that will run', () => {
      // The lockstep hazard `_masterRuntime` exists to prevent: the settings
      // modal must never show one mode while the session launches another.
      const config = store.config.load();
      const saved = config.master;
      try {
        config.master = { accessLevel: 'read-only', engine: 'aider', launchMode: 'plan', scope: 'all', autoStart: false };
        store.config.save(config);
        const lib = enginesInstalling(['aider']);
        const ensured = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux({ alive: false }), enginesLib: lib });
        const status = master.getMasterStatus({ tmuxLib: fakeTmux({ alive: true }), enginesLib: lib });
        assert.equal(ensured.launchMode, status.settings.resolvedLaunchMode);
      } finally {
        config.master = saved;
        store.config.save(config);
      }
    });
  });

  it('honors master.engine over defaultEngine, and reports instructional enforcement off-claude', () => {
    const config = store.config.load();
    const saved = config.master;
    try {
      // A non-claude engine id that has no profile: the ensure must resolve it
      // (proving master.engine wins) and skip the claude-only guardrails.
      config.master = { accessLevel: 'read-only', engine: 'ghost-engine', scope: 'all', autoStart: false };
      store.config.save(config);
      const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: fakeTmux({ alive: false }), enginesLib: availableEngines });
      assert.equal(r.engine, 'ghost-engine');
      assert.equal(r.enforcement, 'instructional');
      assert.match(r.error, /"ghost-engine" not found/);
      assert.ok(!fs.existsSync(path.join(home, '.claude')), 'claude-only guardrails must not be written for other engines');
    } finally {
      config.master = saved;
      store.config.save(config);
    }
  });
});

describe('master API routes over HTTP', () => {
  let server;

  before(async () => {
    const { createServer } = require('../server');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function request(method, urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port, path: urlPath, method,
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('GET /api/master/status returns the tmux-truth shape', async () => {
    const { status, data } = await request('GET', '/api/master/status');
    assert.equal(status, 200);
    // Tri-state, not boolean. This assertion used to read `typeof data.exists
    // === 'boolean'`, which passes on this machine only because tmux answers
    // here — it would have rejected the very state the payload now exists to
    // carry, and it is the one test that hits the real caller shape
    // (`getMasterStatus()` with no options, exactly as `server.js` calls it).
    assert.ok(data.exists === true || data.exists === false || data.exists === null,
      `exists must be true | false | null, got ${JSON.stringify(data.exists)}`);
    assert.ok(Array.isArray(data.incomplete),
      'incomplete is present on every answer, so consumers read it rather than probe for it');
    assert.ok('cause' in data);
    // The two must agree: naming `exists` as unestablished is exactly what null
    // means, and either one without the other is a payload that contradicts
    // itself.
    assert.equal(data.exists === null, data.incomplete.includes('exists'),
      'exists === null and incomplete naming it are the same claim, and must not disagree');
    assert.equal(data.tmuxSession, 'tangleclaw-master');
  });

  it('POST /api/master/ensure returns 200 on success and 500 with a code on refusal', async () => {
    // Stub the module function the route dispatches to — hitting the real one
    // from a test would create a real tmux session and launch a real engine.
    const original = master.ensureMasterSession;
    try {
      master.ensureMasterSession = () => ({ created: true, tmuxSession: 'tangleclaw-master', home: '/tmp/x' });
      const ok = await request('POST', '/api/master/ensure');
      assert.equal(ok.status, 200);
      assert.equal(ok.data.created, true);

      master.ensureMasterSession = () => ({ created: false, tmuxSession: 'tangleclaw-master', home: '/tmp/x', error: 'Engine "claude" not available (binary not found)' });
      const bad = await request('POST', '/api/master/ensure');
      assert.equal(bad.status, 500);
      assert.equal(bad.data.code, 'MASTER_ENSURE_FAILED');
    } finally {
      master.ensureMasterSession = original;
    }
  });

  it('errorResponse: extra can never blank error or code', () => {
    // Driven against `errorResponse` DIRECTLY, because no route reaches this
    // property: the one caller passing an `extra` passes `{ cause }`, which
    // contains neither field, so a route-level test stays green whichever order
    // the spread uses.
    //
    // I learned that the hard way here — the mutation I first ran changed the
    // spread order AND made the caller shadow `code`, so its red proved the
    // caller change. A compound mutation proves less than it looks like, and the
    // comment it justified claimed coverage that did not exist.
    //
    // THE MUTATION THIS CATCHES: spreading `extra` last, on its own.
    const { errorResponse } = require('../server');
    let body = null;
    const res = { writeHead() {}, end(b) { body = JSON.parse(b); } };
    errorResponse(res, 500, 'the real message', 'REAL_CODE',
      { cause: 'read-timed-out', error: 'clobbered', code: 'CLOBBERED' });
    assert.equal(body.error, 'the real message', 'a caller must not be able to replace the message');
    assert.equal(body.code, 'REAL_CODE', 'nor the code every client branches on');
    assert.equal(body.cause, 'read-timed-out', 'while the extra it legitimately carries survives');
  });

  it('POST /api/master/kill: 200 whether it killed or found nothing, 500 when tmux is silent', async () => {
    // Stubbed for the same reason ensure is: reaching the real one from a test
    // would kill the operator's actual Master session.
    //
    // The three outcomes are the whole contract. An ABSENT master is 200 —
    // "not running" is what the operator asked for and it already holds — while
    // a tmux that would not answer is 500 with the SAME code ensure uses, so a
    // client branches on one vocabulary. Reporting the silent case as a
    // successful kill would tell the operator their Master is stopped during
    // exactly the wedge where it is most likely still running.
    const original = master.killMasterSession;
    try {
      master.killMasterSession = () => ({ killed: true, wasRunning: true, tmuxSession: 'tangleclaw-master', incomplete: [], cause: null });
      const killed = await request('POST', '/api/master/kill');
      assert.equal(killed.status, 200);
      assert.equal(killed.data.killed, true);

      master.killMasterSession = () => ({ killed: false, wasRunning: false, tmuxSession: 'tangleclaw-master', incomplete: [], cause: null });
      const absent = await request('POST', '/api/master/kill');
      assert.equal(absent.status, 200, 'an absent master is success, not an error');
      assert.equal(absent.data.wasRunning, false);

      master.killMasterSession = () => ({ killed: false, wasRunning: false, tmuxSession: 'tangleclaw-master', incomplete: ['exists'], cause: 'read-timed-out', error: 'tmux did not answer' });
      const unknown = await request('POST', '/api/master/kill');
      assert.equal(unknown.status, 500);
      assert.equal(unknown.data.code, 'MASTER_LIVENESS_UNKNOWN',
        'the same code ensure uses — one client branch covers both');
      assert.equal(unknown.data.cause, 'read-timed-out',
        'and the CAUSE travels, or a client cannot tell this refusal from the '
        + 'unconfirmed-kill one that shares its code');
      assert.ok(unknown.data.error, 'and the error text still travels beside it');
    } finally {
      master.killMasterSession = original;
    }
  });
});

describe('refreshMasterIdentity (#726)', () => {
  const os = require('node:os');
  const fsx = require('node:fs');
  const pathx = require('node:path');

  function tmpHome() {
    return fsx.mkdtempSync(pathx.join(os.tmpdir(), 'tc-master-'));
  }

  it('writes the access level on every refresh, so the guard survives a restart with the right posture (#755)', () => {
    const home = tmpHome();
    try {
      master.refreshMasterIdentity({ home });
      const levelFile = master.masterAccessLevelPath(home);
      assert.ok(fsx.existsSync(levelFile), 'the refresh must leave a level file behind');
      // The default posture, and the file must say it rather than being absent —
      // absent happens to degrade to read-only in the guard, so an assertion on
      // BEHAVIOUR alone would pass with nothing written at all.
      assert.equal(fsx.readFileSync(levelFile, 'utf8').trim(), 'read-only');
      // Written outside the master's own write carve-out.
      assert.ok(!levelFile.startsWith(pathx.join(home, 'memory') + pathx.sep));
    } finally {
      fsx.rmSync(home, { recursive: true, force: true });
    }
  });

  it('the refresh writes the CONFIGURED level, not a hardcoded one — a write Master must not be downgraded every boot (#755)', () => {
    // THE MUTATION THIS CATCHES: `writeMasterAccessLevel(home, 'read-only')` in
    // the refresh path. Asserting only the default leaves that green while every
    // server restart silently revokes a `write` Master's access.
    const config = store.config.load();
    const previous = config.master;
    store.config.save({ ...config, master: { ...(config.master || {}), accessLevel: 'write' } });
    const home = tmpHome();
    try {
      master.refreshMasterIdentity({ home });
      assert.equal(fsx.readFileSync(master.masterAccessLevelPath(home), 'utf8').trim(), 'write',
        'the refresh must carry the stored level, not a constant');
    } finally {
      store.config.save({ ...store.config.load(), master: previous });
      fsx.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rewrites a stale API base URL without starting a session', () => {
    const home = tmpHome();
    // Simulate an identity generated when the port was wrong — the #726 state.
    fsx.writeFileSync(pathx.join(home, 'CLAUDE.md'),
      '# CLAUDE.md — TangleClaw Project Master\n**TangleClaw API base URL**: `http://localhost:3101`\n');

    const result = master.refreshMasterIdentity({ home });
    assert.equal(result.refreshed, true);

    const after = fsx.readFileSync(pathx.join(home, 'CLAUDE.md'), 'utf8');
    // Assert the API base URL LINE specifically — the file also embeds guide
    // prose that legitimately mentions other ports, so a whole-file search for
    // the stale value reports a false failure.
    const urlLine = (after.match(/\*\*TangleClaw API base URL\*\*: `[^`]+`/) || [])[0];
    assert.ok(urlLine, 'refreshed identity must carry an API base URL line');

    const expectedPort = require('../lib/https-setup').effectiveServerPort(require('../lib/store').config.load());
    assert.match(urlLine, new RegExp(`localhost:${expectedPort}\``),
      `identity should name the effective port ${expectedPort}, got: ${urlLine}`);
  });

  it('does nothing when skipIfAbsent is set and no master home exists', () => {
    const home = pathx.join(os.tmpdir(), `tc-master-absent-${process.pid}`);
    if (fsx.existsSync(home)) fsx.rmSync(home, { recursive: true });

    const result = master.refreshMasterIdentity({ home, skipIfAbsent: true });
    assert.equal(result.refreshed, false, 'must not create master state as a boot side effect');
    assert.equal(fsx.existsSync(home), false, 'the home directory must not be created');
  });

  it('creates the identity when the home exists but the file does not', () => {
    const home = tmpHome();
    const result = master.refreshMasterIdentity({ home, skipIfAbsent: true });
    assert.equal(result.refreshed, true);
    assert.ok(fsx.existsSync(pathx.join(home, 'CLAUDE.md')));
  });
});
