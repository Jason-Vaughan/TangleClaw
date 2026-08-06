'use strict';

// The wizard's provisioning decision, and the mechanics of observing an
// operation that restarts the observer.
//
// Two properties earn their own suite here:
//
//   1. Every Caddyfile state maps to exactly one action, and an unknown state
//      refuses. The wizard shows or hides a password field on this answer, so a
//      state that fell through to a permissive default would collect a
//      credential nothing enforces — the specific failure #710 chunk 2 exists
//      to prevent.
//
//   2. The cutover child is spawned detached, with its output sent to a log file
//      rather than discarded, and any previous result cleared FIRST. Each is
//      load-bearing: the child restarts this server, so a child sharing the
//      parent's fate (or a poller reading last week's `ok`) reports success for
//      a cutover that has not happened — and when the result file is the thing
//      that failed, the child's own stderr is the only remaining witness.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const provision = require('../lib/ingress-provision');

const ALL_STATES = ['absent', 'generated', 'adoptable', 'ambiguous', 'ungated', 'unreadable'];

// `safeToWrite` is true for exactly `absent` and `generated` (lib/caddy.js), and
// an existing login only counts as in force when Caddy is the live ingress.
// Helpers build the real shape so a case cannot pass by omitting a fact.
const SAFE = new Set(['absent', 'generated']);
/** Facts as classifyIngressState + detectCaddy would really report them. */
function facts(state, over = {}) {
  return {
    state,
    safeToWrite: SAFE.has(state),
    caddyAvailable: true,
    ingressMode: 'caddy',
    ...over
  };
}

describe('decideProvisioning', () => {
  it('provisions for the two states where nothing a human maintains is at risk', () => {
    for (const state of ['absent', 'generated']) {
      const d = provision.decideProvisioning(facts(state));
      assert.equal(d.action, 'provision', `${state} should provision`);
      assert.equal(d.remedy, null, `${state} has nothing to remedy`);
    }
  });

  it('adopts an existing single-credential Caddyfile and names the user back', () => {
    const d = provision.decideProvisioning(facts('adoptable', { user: 'jason' }));
    assert.equal(d.action, 'adopt');
    assert.equal(d.user, 'jason');
    assert.match(d.reason, /jason/);
    assert.equal(d.remedy, null);
  });

  it('adopts without a username when the state is adoptable but no user was passed', () => {
    // classifyIngressState reports the user; a caller that omits it must still
    // get the adopt action rather than falling through to a refusal.
    const d = provision.decideProvisioning(facts('adoptable'));
    assert.equal(d.action, 'adopt');
    assert.equal(d.user, null);
    assert.ok(d.reason.length > 0);
  });

  it('refuses the three states it cannot act on safely, each with a remedy', () => {
    for (const state of ['ambiguous', 'ungated', 'unreadable']) {
      const d = provision.decideProvisioning(facts(state));
      assert.equal(d.action, 'refuse', `${state} should refuse`);
      assert.ok(d.reason.length > 0, `${state} must say why`);
      assert.ok(d.remedy && d.remedy.length > 0, `${state} must say what fixes it`);
    }
  });

  it('routes an ungated hand-written config to the CLI, where a backup and rollback exist', () => {
    const d = provision.decideProvisioning(facts('ungated'));
    assert.match(d.remedy, /ingress-cutover\.js/);
    assert.match(d.remedy, /--force/);
    assert.match(d.remedy, /rollback/);
  });

  it('never offers --force for an unreadable config, which cannot be backed up', () => {
    const d = provision.decideProvisioning(facts('unreadable'));
    assert.equal(d.action, 'refuse');
    assert.ok(!/--force/.test(d.remedy), `unreadable must not suggest --force: ${d.remedy}`);
  });

  it('refuses an unrecognized state instead of guessing', () => {
    for (const state of ['', null, undefined, 'partially-gated', 'GENERATED']) {
      const d = provision.decideProvisioning(facts(state));
      assert.equal(d.action, 'refuse', `${String(state)} must fail closed`);
    }
  });

  it('refuses every state when caddy is not installed — including adoptable', () => {
    // A hand-written Caddyfile on a machine with no caddy binary is a config
    // nothing is running. Adopting its credential would mark TangleClaw
    // protected while nothing enforces the gate.
    for (const state of ALL_STATES) {
      const d = provision.decideProvisioning(facts(state, { caddyAvailable: false, user: 'jason' }));
      assert.equal(d.action, 'refuse', `${state} must refuse with no caddy`);
      assert.match(d.reason, /not installed/);
      assert.match(d.remedy, /install/i);
      assert.equal(d.user, null, `${state} must not name a user it cannot honor`);
    }
  });

  it('answers with an action for every state classifyIngressState can report', () => {
    // Pins the two tables together: a state added to lib/caddy.js with no row
    // here would otherwise land in the fail-closed default silently.
    for (const state of ALL_STATES) {
      const d = provision.decideProvisioning(facts(state));
      assert.ok(['provision', 'adopt', 'refuse'].includes(d.action), `${state} → ${d.action}`);
    }
  });

  it('is pure — the same facts give the same answer and the input is not mutated', () => {
    const input = facts('adoptable', { user: 'jason' });
    const frozen = JSON.stringify(input);
    const a = provision.decideProvisioning(input);
    const b = provision.decideProvisioning(input);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(input), frozen);
  });

  it('does not throw on a missing facts object', () => {
    const d = provision.decideProvisioning();
    assert.equal(d.action, 'refuse');
  });

  it('consumes safeToWrite rather than re-deriving it from the state name', () => {
    // The project keeps ONE derivation of "may this file be overwritten", in
    // lib/caddy.js. If the classifier ever stops calling `generated` writable —
    // a plausible hardening — a copy of the rule here would still answer
    // `provision` and spawn a cutover against a file it was told to leave alone.
    for (const state of ['absent', 'generated']) {
      const d = provision.decideProvisioning(facts(state, { safeToWrite: false }));
      assert.equal(d.action, 'refuse', `${state} must follow safeToWrite, not its own name`);
    }
  });

  it('pins provision ⟺ safeToWrite across every state', () => {
    for (const state of ALL_STATES) {
      const d = provision.decideProvisioning(facts(state));
      if (d.action === 'provision') assert.equal(SAFE.has(state), true, `${state} provisioned unsafely`);
    }
  });

  it('refuses to adopt a login that Caddy is not actually serving', () => {
    // Reachable by a supported sequence: `ingress-cutover.js --rollback` unloads
    // Caddy and sets ingressMode back to direct, leaving the Caddyfile on disk.
    // Adopting there would set authEnabled on an install with no gate.
    const d = provision.decideProvisioning(facts('adoptable', { ingressMode: 'direct', user: 'jason' }));
    assert.equal(d.action, 'refuse');
    assert.match(d.reason, /not the active ingress/);
    assert.equal(d.user, null, 'must not name a login it cannot vouch for');
  });

  it('still adopts when Caddy IS the active ingress', () => {
    const d = provision.decideProvisioning(facts('adoptable', { ingressMode: 'caddy', user: 'jason' }));
    assert.equal(d.action, 'adopt');
  });
});

describe('cutover result file', () => {
  let tmpBase;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-provision-'));
    store._setBasePath(tmpBase);
  });

  after(() => {
    store._setBasePath(prevBase);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(provision.resultPath(), { force: true });
  });

  it('lives under the store base path, so it survives the restart the cutover performs', () => {
    assert.equal(provision.resultPath(), path.join(tmpBase, provision.RESULT_FILENAME));
  });

  it('reports absent — not malformed — when no run has finished', () => {
    assert.deepEqual(provision.readResult(), { present: false, malformed: false, result: null });
  });

  it('reads a real outcome back and leaves its codes untouched', () => {
    fs.writeFileSync(provision.resultPath(), JSON.stringify({
      ok: false, code: 'ungate-refused', target: 'caddy', error: 'no credential in config'
    }));
    const r = provision.readResult();
    assert.equal(r.present, true);
    assert.equal(r.malformed, false);
    assert.equal(r.result.code, 'ungate-refused');
    assert.equal(r.result.ok, false);
  });

  it('distinguishes malformed from absent, so a corrupt file is never read as pending', () => {
    fs.writeFileSync(provision.resultPath(), '{ this is not json');
    const r = provision.readResult();
    assert.deepEqual(r, { present: true, malformed: true, result: null });
  });

  it('treats a JSON array or scalar as malformed, not as an outcome', () => {
    for (const body of ['[]', '"ok"', 'null', '42']) {
      fs.writeFileSync(provision.resultPath(), body);
      const r = provision.readResult();
      assert.equal(r.malformed, true, `${body} is not an outcome object`);
      assert.equal(r.result, null);
    }
  });

  it('clears a previous outcome so a stale ok cannot be read as this run', () => {
    fs.writeFileSync(provision.resultPath(), JSON.stringify({ ok: true, code: 'ok' }));
    assert.equal(provision.readResult().present, true);
    const cleared = provision.clearResult();
    assert.equal(cleared.cleared, true);
    assert.equal(cleared.error, null);
    assert.equal(provision.readResult().present, false);
  });

  it('clearing when there is nothing to clear succeeds rather than erroring', () => {
    assert.deepEqual(provision.clearResult(), { cleared: true, error: null });
  });
});

describe('spawnCutover', () => {
  // Base-path isolation, matching the block above. NOT optional here: this repo
  // has no package.json, so the suite runs `node --test` straight against $HOME —
  // and on this machine the clone IS the live install. Without it, the log-
  // permission tests below rm and chmod the operator's REAL
  // ~/.tangleclaw/logs/ingress-cutover.log: they would delete the file this whole
  // chunk points operators at as their only durable evidence, and briefly leave it
  // 0644, which is the exact exposure the code under test exists to close.
  let tmpBase;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-spawn-'));
    store._setBasePath(tmpBase);
  });

  after(() => {
    store._setBasePath(prevBase);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  /**
   * Refuse to touch a path outside this block's temp base.
   *
   * A failing assertion does not abort the rest of the file, so a guard that only
   * *reports* lost isolation still lets the destructive tests below run against
   * the operator's real `~/.tangleclaw`. This throws instead, at the top of each
   * one, before any rm or chmod.
   * @param {string} p - Path the test is about to write to.
   * @returns {string} The same path, once proven sandboxed.
   */
  function requireSandboxed(p) {
    if (!p.startsWith(tmpBase)) {
      throw new Error(`refusing to touch ${p}: outside the test base ${tmpBase}. `
        + 'Base-path isolation was lost — this clone is the live install.');
    }
    return p;
  }

  it('writes its log inside the configured base path, never the real one', () => {
    // Guards the isolation itself, so losing it is a named failure rather than a
    // silent deletion of the operator's log.
    assert.ok(provision.cutoverLogPath().startsWith(tmpBase),
      `the log path must resolve inside the test base, got ${provision.cutoverLogPath()}`);
  });

  it('runs the repo\'s cutover script with the target and result file', () => {
    const calls = [];
    const res = provision.spawnCutover({
      target: 'caddy',
      resultFile: '/tmp/tc-result.json',
      spawnFn: (cmd, argv, opts) => { calls.push({ cmd, argv, opts }); return { pid: 4242, unref() {} }; }
    });
    assert.equal(res.ok, true);
    assert.equal(res.pid, 4242);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, [
      path.join(provision.repoDir(), 'scripts', 'ingress-cutover.js'),
      '--to', 'caddy', '--result-file', '/tmp/tc-result.json'
    ]);
  });

  it('runs the same node runtime as the server, not whatever `node` is on PATH', () => {
    // Under launchd the service PATH is whatever install.sh captured; resolving
    // `node` from it can pick a different runtime, or none.
    let seen = null;
    provision.spawnCutover({
      resultFile: '/tmp/x.json',
      spawnFn: (cmd) => { seen = cmd; return { pid: 1, unref() {} }; }
    });
    assert.equal(seen, process.execPath);
  });

  it('detaches and unrefs — the child restarts this server', () => {
    let opts = null;
    let unrefCalls = 0;
    provision.spawnCutover({
      resultFile: '/tmp/x.json',
      spawnFn: (_cmd, _argv, o) => { opts = o; return { pid: 7, unref() { unrefCalls++; } }; }
    });
    assert.equal(opts.detached, true);
    assert.equal(opts.cwd, provision.repoDir());
    assert.equal(unrefCalls, 1, 'an un-unrefd child holds the event loop open past the response');
    // Stdin is closed; stdout/stderr go to the log (asserted in its own case).
    assert.equal(opts.stdio[0], 'ignore');
  });

  it('clears a previous outcome itself, so the ordering is not a caller obligation', () => {
    // The channel's correctness depends on clearing BEFORE the child starts. When
    // that lived in the caller, today's one call site was covered and the next one
    // would not have been.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-spawn-clear-'));
    const resultFile = path.join(tmp, 'result.json');
    fs.writeFileSync(resultFile, JSON.stringify({ ok: true, code: 'ok' }));
    let existedAtSpawn = true;
    provision.spawnCutover({
      resultFile,
      spawnFn: () => { existedAtSpawn = fs.existsSync(resultFile); return { pid: 1, unref() {} }; }
    });
    assert.equal(existedAtSpawn, false, 'a stale outcome was still on disk when the child started');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('sends the child\'s output to a log file rather than discarding it', () => {
    // stdio: 'ignore' threw away the cutover's own "could not write result file"
    // warning — the one diagnostic that matters when the result channel is what
    // failed, leaving no trace anywhere.
    let opts = null;
    const res = provision.spawnCutover({
      resultFile: path.join(os.tmpdir(), 'tc-x.json'),
      spawnFn: (_c, _a, o) => { opts = o; return { pid: 2, unref() {} }; }
    });
    assert.ok(Array.isArray(opts.stdio), 'stdio must name a destination, not discard');
    assert.equal(opts.stdio[0], 'ignore', 'the child has no stdin');
    assert.equal(typeof opts.stdio[1], 'number', 'stdout goes to a descriptor');
    assert.equal(opts.stdio[1], opts.stdio[2], 'stdout and stderr share the log');
    assert.equal(res.logPath, provision.cutoverLogPath());
  });

  it('opens the cutover log 0600, like the result file it sits beside', () => {
    // The child's stderr lands here verbatim, and on the validate-failed path
    // that text is `caddy validate` output quoting a `basic_auth <user> <hash>`
    // line. #821 stopped the hash itself from reaching this file, but 0600 is
    // the control that does not depend on every future writer remembering to
    // redact — and the username is deliberately still written here. The result
    // file, same rationale, has been 0600 all along; this one took the default
    // until now.
    const logPath = requireSandboxed(provision.cutoverLogPath());
    fs.rmSync(logPath, { force: true });
    provision.spawnCutover({
      resultFile: path.join(os.tmpdir(), 'tc-perm.json'),
      spawnFn: () => ({ pid: 3, unref() {} })
    });
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600,
      'a log that can carry a credential hash must not be world-readable');
  });

  it('tightens an EXISTING log too, since mode applies only on create', () => {
    // The trap: fs.openSync's mode argument is honoured when the file is created
    // and ignored when it already exists. Every install that ran a cutover before
    // this change already has a 0644 log, so create-time mode alone would leave
    // exactly the machines with real history unprotected.
    const logPath = requireSandboxed(provision.cutoverLogPath());
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'from an earlier run\n', { mode: 0o644 });
    fs.chmodSync(logPath, 0o644);
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o644, 'precondition: the old log is loose');

    provision.spawnCutover({
      resultFile: path.join(os.tmpdir(), 'tc-perm2.json'),
      spawnFn: () => ({ pid: 4, unref() {} })
    });
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600,
      'an existing loose log must be tightened, not left as found');
  });

  // #821 — the log was opened append-only with no lifecycle at all: no cap, no
  // rotation, no pruning, unlike the caddy access log beside it.
  describe('cutover log retention (#821)', () => {
    /**
     * Write a log larger than the rotation cap.
     * @param {string} p - Log path.
     * @returns {string} The same path.
     */
    function writeOversizedLog(p) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'x'.repeat(provision.CUTOVER_LOG_MAX_BYTES + 1), { mode: 0o600 });
      return p;
    }

    it('leaves a log under the cap exactly where it is', () => {
      // The common case by far: a cutover writes kilobytes. Rotating here would
      // churn the operator's only narration of what setup did.
      const logPath = requireSandboxed(provision.cutoverLogPath());
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'a short run\n', { mode: 0o600 });

      assert.equal(provision.rotateCutoverLogIfNeeded(logPath), false);
      assert.equal(fs.readFileSync(logPath, 'utf8'), 'a short run\n');
      assert.equal(fs.existsSync(`${logPath}.1`), false, 'nothing should have been rotated');
    });

    it('rotates a log past the cap, clearing the live path for a fresh one', () => {
      const logPath = requireSandboxed(provision.cutoverLogPath());
      fs.rmSync(`${logPath}.1`, { force: true });
      writeOversizedLog(logPath);

      assert.equal(provision.rotateCutoverLogIfNeeded(logPath), true);
      assert.equal(fs.existsSync(logPath), false,
        'the live path must be free so the next open starts a new file');
      assert.equal(fs.statSync(`${logPath}.1`).size, provision.CUTOVER_LOG_MAX_BYTES + 1);
    });

    it('retires the oldest generation rather than keeping every one forever', () => {
      // Rotation only bounds growth if generations are finite. With two, the
      // previous .1 is displaced and its content is gone — which is the only
      // thing here that ever actually retires old text.
      const logPath = requireSandboxed(provision.cutoverLogPath());
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(`${logPath}.1`, 'the oldest run\n', { mode: 0o600 });
      writeOversizedLog(logPath);

      provision.rotateCutoverLogIfNeeded(logPath);

      assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8').startsWith('x'), true,
        'the displaced current log becomes .1');
      assert.equal(fs.existsSync(`${logPath}.${provision.CUTOVER_LOG_MAX_FILES}`), false,
        'generations must not grow past the cap');
    });

    it('a rotated generation keeps 0600 — it holds the same text the live one did', () => {
      const logPath = requireSandboxed(provision.cutoverLogPath());
      fs.rmSync(`${logPath}.1`, { force: true });
      writeOversizedLog(logPath);
      provision.rotateCutoverLogIfNeeded(logPath);
      assert.equal(fs.statSync(`${logPath}.1`).mode & 0o777, 0o600);
    });

    it('spawnCutover rotates BEFORE opening, never under a running child', () => {
      // The timing is the design: the fd becomes a detached child's stdout and
      // stderr, so renaming the file mid-run would leave that child writing to a
      // detached inode. Between runs nobody holds it.
      const logPath = requireSandboxed(provision.cutoverLogPath());
      fs.rmSync(`${logPath}.1`, { force: true });
      writeOversizedLog(logPath);

      provision.spawnCutover({
        resultFile: path.join(os.tmpdir(), 'tc-rot.json'),
        spawnFn: () => ({ pid: 9, unref() {} })
      });

      assert.equal(fs.statSync(logPath).size, 0, 'the run appends to a fresh log');
      assert.equal(fs.statSync(logPath).mode & 0o777, 0o600, 'and the fresh log is still 0600');
      assert.equal(fs.existsSync(`${logPath}.1`), true, 'the previous content is kept as one generation');
    });

    it('still runs the cutover when the log cannot be rotated', () => {
      // Housekeeping must never cost the operator their ingress. An unrotatable
      // log degrades to appending, it does not abort the run.
      const logPath = requireSandboxed(provision.cutoverLogPath());
      fs.rmSync(logPath, { force: true });
      fs.mkdirSync(logPath, { recursive: true }); // a DIRECTORY where the log goes
      try {
        const res = provision.spawnCutover({
          resultFile: path.join(os.tmpdir(), 'tc-rot2.json'),
          spawnFn: () => ({ pid: 10, unref() {} })
        });
        assert.equal(res.ok, true, 'the cutover proceeds despite an unusable log path');
      } finally {
        fs.rmSync(logPath, { recursive: true, force: true });
      }
    });
  });

  it('defaults to the caddy target and the shared result path', () => {
    let argv = null;
    provision.spawnCutover({ spawnFn: (_c, a) => { argv = a; return { pid: 1, unref() {} }; } });
    assert.deepEqual(argv.slice(1), ['--to', 'caddy', '--result-file', provision.resultPath()]);
  });

  it('reports a spawn failure instead of throwing into the request handler', () => {
    const res = provision.spawnCutover({
      resultFile: '/tmp/x.json',
      spawnFn: () => { throw new Error('EPERM'); }
    });
    assert.equal(res.ok, false);
    assert.equal(res.pid, null);
    assert.match(res.error, /EPERM/);
  });

  it('survives a spawn stub that returns nothing usable', () => {
    const res = provision.spawnCutover({ resultFile: '/tmp/x.json', spawnFn: () => null });
    assert.equal(res.ok, true);
    assert.equal(res.pid, null);
  });

  it('refuses to start a REAL cutover from a test process', () => {
    // The mutation this catches: someone reaches spawnCutover without a stub
    // (directly, or through a route whose spawner was not overridden). A real run
    // rewrites launchd plists and kickstarts the live server, so on a developer's
    // machine that ends the suite by taking the install down.
    assert.ok(process.env.NODE_TEST_CONTEXT, 'the interlock keys off the test runner marker');
    const res = provision.spawnCutover({ target: 'caddy', resultFile: '/tmp/x.json' });
    assert.equal(res.ok, false);
    assert.equal(res.pid, null);
    assert.match(res.error, /refusing to start a real ingress cutover/);
  });
});
