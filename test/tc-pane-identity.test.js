'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const verbs = require('../lib/tc-verbs');

const TC_BIN = path.join(__dirname, '..', 'bin', 'tc');

// What `tc` tells a pane about its own launch identity (#2233): the server's
// verdict on the binding, printed by `tc whoami`, and the comparison `tc`
// makes by itself between its environment and what its tmux pane recorded.

/**
 * A whoami answer for a project session.
 * @param {object} [binding] - The binding verdict; omitted for a server that reports none
 * @returns {object}
 */
function answer(binding) {
  return {
    project: { id: 14, name: 'proj' },
    sessionId: 140,
    ...(binding ? { binding } : {}),
    api: { origin: 'http://localhost:3102' },
    operator: { host: 'box.example', note: 'note' },
    capabilities: []
  };
}

const VERIFIED = { state: 'verified', reason: null, role: 'project', projectId: 14, sessionId: 140, cause: null, recovery: null };
const STALE = {
  state: 'stale', reason: 'session-not-active', role: null, projectId: null, sessionId: null,
  cause: 'The session this launch belongs to has ended.',
  recovery: 'Do not act from this pane. Ask the operator to end this session and launch it again.'
};

describe('tc whoami: the launch binding (#2233)', () => {
  it('says a verified binding plainly, after the identity it verifies', () => {
    const out = verbs.renderWhoami(answer(VERIFIED));
    const lines = out.split('\n');
    assert.match(lines[0], /^You are a TangleClaw-managed session of project "proj"/);
    assert.match(out, /Launch binding: verified \(session 140 is this project's current session\)/);
  });

  it('leads with a stale binding, its cause and its recovery, and stops asserting the identity', () => {
    const out = verbs.renderWhoami(answer(STALE));
    const lines = out.split('\n');
    assert.match(lines[0], /^LAUNCH BINDING STALE \(session-not-active\)/);
    assert.ok(lines[0].includes(STALE.cause));
    assert.ok(lines[0].includes(STALE.recovery));
    assert.doesNotMatch(out, /You are a TangleClaw-managed session of project/);
    assert.match(out, /You claim project "proj" \(numeric project id 14\)\. TangleClaw has not verified that\./);
    assert.match(out, /That project's current session is 140, which is not shown to be this pane\./);
  });

  it('leads with an absent binding and how one is sent', () => {
    const unbound = { state: 'unbound', reason: 'unbound', role: null, projectId: null, sessionId: null, cause: 'No launch binding was presented.', recovery: 'Ask the operator to launch the session again.' };
    const lines = verbs.renderWhoami(answer(unbound)).split('\n');
    assert.match(lines[0], /^LAUNCH BINDING ABSENT/);
    assert.ok(lines[0].includes(unbound.cause) && lines[0].includes(unbound.recovery));
  });

  it('says a check that did not run did not run, and never calls it verified', () => {
    const unknown = { state: 'unknown', reason: 'check-failed', role: null, projectId: null, sessionId: null, cause: 'TangleClaw could not check this launch binding just now.', recovery: 'Run `tc whoami` again.' };
    const out = verbs.renderWhoami(answer(unknown));
    assert.match(out.split('\n')[0], /^LAUNCH BINDING NOT CHECKED/);
    assert.doesNotMatch(out, /Launch binding: verified/);
    assert.doesNotMatch(out, /You are a TangleClaw-managed session of project/);
  });

  it('treats a state it does not know as not verified', () => {
    const out = verbs.renderWhoami(answer({ state: 'something-new', reason: null, cause: null, recovery: null }));
    assert.match(out.split('\n')[0], /^LAUNCH BINDING NOT CHECKED/);
    assert.doesNotMatch(out, /Launch binding: verified/);
  });

  it('says so when the server reports no verdict at all, rather than implying one', () => {
    const out = verbs.renderWhoami(answer());
    assert.match(out, /Launch binding: not reported by this server/);
    assert.doesNotMatch(out, /Launch binding: verified/);
  });

  it('does not read a binding verified for one project as verifying another', () => {
    const out = verbs.renderWhoami(answer({ ...VERIFIED, projectId: 99 }));
    assert.match(out.split('\n')[0], /^LAUNCH BINDING STALE \(project-mismatch\)/);
    assert.match(out, /launch id belongs to project id 99/);
    assert.doesNotMatch(out, /You are a TangleClaw-managed session of project/);
  });

  it('gives the Project Master its own verified line', () => {
    const out = verbs.renderWhoami({
      role: 'master', project: null, sessionId: null,
      binding: { state: 'verified', reason: null, role: 'master', projectId: null, sessionId: null, cause: null, recovery: null },
      api: { origin: 'http://localhost:3102' }, operator: { host: null, note: 'note' }, capabilities: []
    });
    assert.match(out, /Launch binding: verified \(this is the live Project Master's launch\)/);
  });

  it('does not let a stale Master binding read as the Project Master', () => {
    const out = verbs.renderWhoami({
      role: 'master', project: null, sessionId: null,
      binding: { ...STALE, reason: 'master-launch-stale', cause: 'The launch id is not the one the live Project Master was started with.' },
      api: { origin: 'http://localhost:3102' }, operator: { host: null, note: 'note' }, capabilities: []
    });
    assert.match(out.split('\n')[0], /^LAUNCH BINDING STALE \(master-launch-stale\)/);
    assert.doesNotMatch(out, /You are the TangleClaw Project Master/);
    assert.match(out, /You claim to be the Project Master\. TangleClaw has not verified that\./);
  });

  it('prints the exact sentence the generated guide tells a session to look for', () => {
    const guide = fs.readFileSync(path.join(__dirname, '..', 'lib', 'engines.js'), 'utf8');
    const quoted = guide.match(/a `tc whoami` that does not read `([^`]+)` means stop/);
    assert.ok(quoted, 'the guide quotes the line a session checks for');
    for (const out of [
      verbs.renderWhoami(answer(VERIFIED)),
      verbs.renderWhoami({ role: 'master', project: null, sessionId: null, binding: { ...VERIFIED, role: 'master', projectId: null, sessionId: null }, api: { origin: 'http://localhost:3102' }, operator: { host: null, note: 'note' }, capabilities: [] })
    ]) {
      assert.ok(out.split('\n').some((line) => line.startsWith(quoted[1])), `${quoted[1]} leads a line of:\n${out}`);
    }
    assert.ok(!verbs.renderWhoami(answer(STALE)).includes(quoted[1]), 'and a stale binding never prints it');
  });

  it('tells a pane with a stale binding to do what the server\'s refusal tells it', () => {
    const guard = require('../lib/launch-binding-guard');
    assert.equal(verbs.PANE_RECOVERY, guard.recoveryFor(guard.BINDING_STATES.STALE, 'unknown-launch'));
  });

  it('prints what the pane check found, whichever answer it was', () => {
    const match = verbs.renderWhoami(answer(VERIFIED), { verdict: 'match', reason: null, differences: [] });
    assert.match(match, /Pane check: this pane's tmux session recorded the same launch identity\./);
    const cannot = verbs.renderWhoami(answer(VERIFIED), { verdict: 'cannot-check', reason: 'no-pane', differences: [] });
    assert.match(cannot, /Pane check: not made \(.+\)\. The launch binding line is the server's answer and stands by itself\./);
    assert.doesNotMatch(verbs.renderWhoami(answer(VERIFIED)), /Pane check/);
  });
});

describe('tc: the pane\'s own launch identity (#2233)', () => {
  const ENV = { TMUX: '/tmp/tmux-501/default,1,2', TMUX_PANE: '%7', TANGLECLAW_LAUNCH_ID: 'L-aaa', TANGLECLAW_PROJECT_ID: '14' };

  describe('parseSessionEnvironment', () => {
    it('reads KEY=value lines, keeps a value that contains "=", and drops a variable tmux marks removed', () => {
      const vars = verbs.parseSessionEnvironment('TANGLECLAW_LAUNCH_ID=L-aaa\nPATH=/a:/b=c\n-TANGLECLAW_ROLE\n\nTANGLECLAW_PROJECT_ID=14\n');
      assert.deepEqual(vars, { TANGLECLAW_LAUNCH_ID: 'L-aaa', PATH: '/a:/b=c', TANGLECLAW_PROJECT_ID: '14' });
    });

    it('answers nothing for no output', () => {
      assert.deepEqual(verbs.parseSessionEnvironment(''), {});
      assert.deepEqual(verbs.parseSessionEnvironment(undefined), {});
    });
  });

  describe('readPaneEnvironment', () => {
    it('asks tmux about the pane this shell is in, with a bound on the wait', () => {
      const calls = [];
      const read = verbs.readPaneEnvironment(ENV, (file, args, options) => {
        calls.push({ file, args, options });
        return 'TANGLECLAW_LAUNCH_ID=L-aaa\n';
      });
      assert.deepEqual(read, { read: 'ok', vars: { TANGLECLAW_LAUNCH_ID: 'L-aaa' } });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].file, 'tmux');
      assert.deepEqual(calls[0].args, ['show-environment', '-t', '%7']);
      assert.ok(calls[0].options.timeout > 0 && calls[0].options.timeout <= 2000);
    });

    it('does not ask tmux at all without both TMUX and TMUX_PANE', () => {
      for (const env of [{}, { TMUX_PANE: '%7' }, { TMUX: '/tmp/sock,1,2' }]) {
        let asked = false;
        const read = verbs.readPaneEnvironment(env, () => { asked = true; return ''; });
        assert.equal(read.read, 'no-pane');
        assert.equal(asked, false);
      }
    });

    it('does not hand tmux a pane id that is not one', () => {
      let asked = false;
      const read = verbs.readPaneEnvironment({ ...ENV, TMUX_PANE: '%7; rm -rf /' }, () => { asked = true; return ''; });
      assert.equal(read.read, 'unreadable');
      assert.equal(asked, false);
    });

    for (const [label, err, detail] of [
      ['tmux is not installed', Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }), /not on PATH/],
      ['tmux does not answer in time', Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), /did not answer/],
      ['tmux was killed at the bound', Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), /did not answer/],
      ['tmux knows no such pane', Object.assign(new Error('exit 1'), { status: 1 }), /could not read/]
    ]) {
      it(`reports unreadable, with why, when ${label}`, () => {
        const read = verbs.readPaneEnvironment(ENV, () => { throw err; });
        assert.equal(read.read, 'unreadable');
        assert.match(read.detail, detail);
      });
    }
  });

  describe('judgePaneIdentity', () => {
    const pane = (vars) => ({ read: 'ok', vars });

    it('match: the pane recorded the launch and project this shell carries', () => {
      const v = verbs.judgePaneIdentity({ env: ENV, pane: pane({ TANGLECLAW_LAUNCH_ID: 'L-aaa', TANGLECLAW_PROJECT_ID: '14', PATH: '/x' }) });
      assert.deepEqual(v, { verdict: 'match', reason: null, differences: [] });
    });

    it('match: the Project Master, which carries a role and no project', () => {
      const env = { TMUX: 's', TMUX_PANE: '%1', TANGLECLAW_LAUNCH_ID: 'L-m', TANGLECLAW_ROLE: 'master' };
      assert.equal(verbs.judgePaneIdentity({ env, pane: pane({ TANGLECLAW_LAUNCH_ID: 'L-m', TANGLECLAW_ROLE: 'master' }) }).verdict, 'match');
    });

    for (const [label, vars, keys] of [
      ['the launch id differs', { TANGLECLAW_LAUNCH_ID: 'L-bbb', TANGLECLAW_PROJECT_ID: '14' }, ['TANGLECLAW_LAUNCH_ID']],
      ['the project id differs', { TANGLECLAW_LAUNCH_ID: 'L-aaa', TANGLECLAW_PROJECT_ID: '15' }, ['TANGLECLAW_PROJECT_ID']],
      ['both differ', { TANGLECLAW_LAUNCH_ID: 'L-bbb', TANGLECLAW_PROJECT_ID: '15' }, ['TANGLECLAW_LAUNCH_ID', 'TANGLECLAW_PROJECT_ID']],
      ['the pane recorded a role this shell does not carry', { TANGLECLAW_LAUNCH_ID: 'L-aaa', TANGLECLAW_PROJECT_ID: '14', TANGLECLAW_ROLE: 'master' }, ['TANGLECLAW_ROLE']],
      ['the pane recorded no project while this shell claims one', { TANGLECLAW_LAUNCH_ID: 'L-aaa' }, ['TANGLECLAW_PROJECT_ID']]
    ]) {
      it(`mismatch: ${label}`, () => {
        const v = verbs.judgePaneIdentity({ env: ENV, pane: pane(vars) });
        assert.equal(v.verdict, 'mismatch');
        assert.deepEqual(v.differences.map((d) => d.key), keys);
        for (const d of v.differences) {
          assert.equal(d.process, ENV[d.key] || null);
          assert.equal(d.pane, vars[d.key] || null);
        }
      });
    }

    it('match: the workspace id the pane recorded is the one this shell carries', () => {
      const env = { ...ENV, TANGLECLAW_WORKSPACE_ID: 'proj-aaaa1111' };
      const v = verbs.judgePaneIdentity({ env, pane: pane({ TANGLECLAW_LAUNCH_ID: 'L-aaa', TANGLECLAW_PROJECT_ID: '14', TANGLECLAW_WORKSPACE_ID: 'proj-aaaa1111' }) });
      assert.equal(v.verdict, 'match');
    });

    for (const [label, mine, recorded] of [
      ['this shell carries another workspace\'s id', 'other-bbbb2222', 'proj-aaaa1111'],
      ['this shell carries a workspace id the pane never recorded', 'other-bbbb2222', null],
      ['this shell lost the workspace id the pane recorded', null, 'proj-aaaa1111']
    ]) {
      it(`mismatch: ${label}`, () => {
        const env = { ...ENV, ...(mine ? { TANGLECLAW_WORKSPACE_ID: mine } : {}) };
        const vars = { TANGLECLAW_LAUNCH_ID: 'L-aaa', TANGLECLAW_PROJECT_ID: '14', ...(recorded ? { TANGLECLAW_WORKSPACE_ID: recorded } : {}) };
        const v = verbs.judgePaneIdentity({ env, pane: pane(vars) });
        assert.equal(v.verdict, 'mismatch');
        assert.deepEqual(v.differences, [{ key: 'TANGLECLAW_WORKSPACE_ID', process: mine, pane: recorded }]);
      });
    }

    it('mismatch: this shell carries a role the pane did not record', () => {
      const v = verbs.judgePaneIdentity({ env: { ...ENV, TANGLECLAW_ROLE: 'master' }, pane: pane({ TANGLECLAW_LAUNCH_ID: 'L-aaa', TANGLECLAW_PROJECT_ID: '14' }) });
      assert.equal(v.verdict, 'mismatch');
      assert.deepEqual(v.differences, [{ key: 'TANGLECLAW_ROLE', process: 'master', pane: null }]);
    });

    it('mismatch: this shell lost its launch id while the pane has one', () => {
      const { TANGLECLAW_LAUNCH_ID: _gone, ...env } = ENV;
      const v = verbs.judgePaneIdentity({ env, pane: pane({ TANGLECLAW_LAUNCH_ID: 'L-aaa', TANGLECLAW_PROJECT_ID: '14' }) });
      assert.equal(v.verdict, 'mismatch');
      assert.deepEqual(v.differences, [{ key: 'TANGLECLAW_LAUNCH_ID', process: null, pane: 'L-aaa' }]);
    });

    it('cannot-check, never match: the three ways there is nothing to compare with', () => {
      for (const [input, reason] of [
        [{ read: 'no-pane' }, 'no-pane'],
        [{ read: 'unreadable', detail: 'tmux did not answer within a second' }, 'tmux-unreadable'],
        [pane({ PATH: '/x' }), 'pane-has-no-identity'],
        [pane({}), 'pane-has-no-identity'],
        [undefined, 'tmux-unreadable'],
        [{ read: 'something-new' }, 'tmux-unreadable']
      ]) {
        const v = verbs.judgePaneIdentity({ env: ENV, pane: input });
        assert.equal(v.verdict, 'cannot-check', JSON.stringify(input));
        assert.equal(v.reason, reason, JSON.stringify(input));
        assert.deepEqual(v.differences, []);
      }
    });
  });

  describe('renderPaneMismatch', () => {
    it('names both identities for every variable that differs, and rewrites neither', () => {
      const text = verbs.renderPaneMismatch({
        verdict: 'mismatch', reason: null,
        differences: [
          { key: 'TANGLECLAW_LAUNCH_ID', process: 'L-aaa', pane: 'L-bbb' },
          { key: 'TANGLECLAW_ROLE', process: null, pane: 'master' }
        ]
      });
      assert.match(text, /\[PANE_IDENTITY_MISMATCH\]/);
      assert.match(text, /TANGLECLAW_LAUNCH_ID: this shell has L-aaa, the pane recorded L-bbb/);
      assert.match(text, /TANGLECLAW_ROLE: this shell has \(unset\), the pane recorded master/);
      assert.match(text, /Nothing was sent/);
      assert.match(text, /Do not act from this pane/);
      assert.doesNotMatch(text, /export /, 'it must not teach the shell to rewrite its identity');
    });
  });
});

describe('bin/tc refuses to speak for a pane that recorded a different identity (#2233)', () => {
  let stubDir;
  let server;
  let requests;

  /**
   * Write a `tmux` stand-in that prints a fixed session environment.
   * @param {string} body - The shell script body
   * @returns {void}
   */
  function stubTmux(body) {
    fs.writeFileSync(path.join(stubDir, 'tmux'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  /**
   * Run the real binary.
   * @param {string[]} args - Verb and arguments
   * @param {object} env - Environment beyond PATH and the API origin
   * @returns {Promise<{code: number, stdout: string, stderr: string}>}
   */
  function tc(args, env) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [TC_BIN, ...args], {
        env: { PATH: `${stubDir}:/usr/bin:/bin`, TANGLECLAW_API: `http://127.0.0.1:${server.address().port}`, ...env }
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  const PANE = { TMUX: '/tmp/stub,1,2', TMUX_PANE: '%7', TANGLECLAW_LAUNCH_ID: 'L-aaa', TANGLECLAW_PROJECT_ID: '14' };

  before(async () => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pane-stub-'));
    requests = [];
    server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        project: { id: 14, name: 'proj' }, sessionId: 140,
        binding: { state: 'verified', reason: null, role: 'project', projectId: 14, sessionId: 140, cause: null, recovery: null },
        api: { origin: 'http://localhost:1' }, operator: { host: null, note: 'note' }, capabilities: [], sessions: []
      }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  it('sends nothing, exits 2 and names both identities, for a verb that reads and a verb that writes', async () => {
    stubTmux('echo "TANGLECLAW_LAUNCH_ID=L-other"; echo "TANGLECLAW_PROJECT_ID=15"');
    for (const args of [['whoami'], ['sessions'], ['workload', 'set', 'working', '--clearance', 'unknown', '--summary', 'x']]) {
      requests.length = 0;
      const res = await tc(args, PANE);
      assert.equal(res.code, 2, `${args[0]}: ${res.stderr}`);
      assert.equal(res.stdout, '', args[0]);
      assert.match(res.stderr, /\[PANE_IDENTITY_MISMATCH\]/, args[0]);
      assert.match(res.stderr, /this shell has L-aaa, the pane recorded L-other/, args[0]);
      assert.match(res.stderr, /this shell has 14, the pane recorded 15/, args[0]);
      assert.deepEqual(requests, [], `${args[0]}: a request left the pane`);
    }
  });

  it('answers as before when the pane recorded the same identity, and whoami says the check passed', async () => {
    stubTmux('[ "$1" = show-environment ] && [ "$2" = -t ] && [ "$3" = %7 ] || exit 1; echo "TANGLECLAW_LAUNCH_ID=L-aaa"; echo "TANGLECLAW_PROJECT_ID=14"');
    requests.length = 0;
    const res = await tc(['whoami'], PANE);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Launch binding: verified/);
    assert.match(res.stdout, /Pane check: this pane's tmux session recorded the same launch identity\./);
    assert.ok(requests.some((r) => r.startsWith('GET /api/tc/whoami')));
  });

  for (const [label, env, script] of [
    ['outside tmux', { TANGLECLAW_LAUNCH_ID: 'L-aaa', TANGLECLAW_PROJECT_ID: '14' }, 'echo "TANGLECLAW_LAUNCH_ID=L-other"'],
    ['when tmux cannot read the pane', PANE, 'exit 1'],
    ['when the pane\'s session carries no TangleClaw identity', PANE, 'echo "PATH=/x"']
  ]) {
    it(`proceeds ${label}, and whoami says the check was not made`, async () => {
      stubTmux(script);
      requests.length = 0;
      const res = await tc(['whoami'], env);
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /Pane check: not made \(/);
      assert.doesNotMatch(res.stdout, /recorded the same launch identity/);
      assert.ok(requests.some((r) => r.startsWith('GET /api/tc/whoami')));
    });
  }

  it('still answers help without asking tmux anything', async () => {
    stubTmux('echo "TANGLECLAW_LAUNCH_ID=L-other"');
    const res = await tc(['--help'], PANE);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /whoami/);
  });
});
