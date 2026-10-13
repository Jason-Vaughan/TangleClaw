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

    describe('the likely cause, tmux\'s global environment (#2268)', () => {
      const CAUSE = /Likely cause: tmux's global environment/;
      const render = (differences) => verbs.renderPaneMismatch({ verdict: 'mismatch', reason: null, differences });

      it('is named when every difference is a variable this shell holds and the pane recorded none for', () => {
        const text = render([
          { key: 'TANGLECLAW_PROJECT_ID', process: '74', pane: null },
          { key: 'TANGLECLAW_ROLE', process: 'master', pane: null }
        ]);
        assert.match(text, CAUSE);
        assert.match(text, /Launching again fixes it on a TangleClaw that sets every launch identity variable at launch/);
        assert.match(text, /the operator runs this first: tmux set-environment -g -u TANGLECLAW_PROJECT_ID ; tmux set-environment -g -u TANGLECLAW_ROLE\n$/);
        // Everything the refusal said before is still there, in the same words.
        assert.match(text, /TANGLECLAW_ROLE: this shell has master, the pane recorded \(unset\)/);
        assert.match(text, /Nothing was sent to TangleClaw\. Do not act from this pane\./);
        assert.doesNotMatch(text, /export /);
      });

      it('names the command for the one variable that differs, and for no other', () => {
        const text = render([{ key: 'TANGLECLAW_WORKSPACE_ID', process: 'p-1234', pane: null }]);
        assert.match(text, /runs this first: tmux set-environment -g -u TANGLECLAW_WORKSPACE_ID\n$/);
        assert.equal(text.split('set-environment').length - 1, 1);
      });

      for (const [label, differences] of [
        ['the pane recorded a different value', [{ key: 'TANGLECLAW_LAUNCH_ID', process: 'L-aaa', pane: 'L-bbb' }]],
        ['this shell lost a variable the pane recorded', [{ key: 'TANGLECLAW_LAUNCH_ID', process: null, pane: 'L-bbb' }]],
        ['one difference has that shape and another does not', [
          { key: 'TANGLECLAW_ROLE', process: 'master', pane: null },
          { key: 'TANGLECLAW_LAUNCH_ID', process: 'L-aaa', pane: 'L-bbb' }
        ]],
        ['there is no difference to explain', []]
      ]) {
        it(`is not named when ${label}`, () => {
          const text = render(differences);
          assert.doesNotMatch(text, CAUSE);
          assert.doesNotMatch(text, /set-environment/);
          assert.match(text, /Tell them both values above\.\n$/, 'the refusal ends where it always did');
        });
      }

      it('is what a real judgement of an inherited role leads to', () => {
        const check = verbs.judgePaneIdentity({
          env: { TANGLECLAW_LAUNCH_ID: 'L-1', TANGLECLAW_PROJECT_ID: '14', TANGLECLAW_ROLE: 'master' },
          pane: { read: 'ok', vars: { TANGLECLAW_LAUNCH_ID: 'L-1', TANGLECLAW_PROJECT_ID: '14', TANGLECLAW_ROLE: '' } }
        });
        assert.equal(check.verdict, 'mismatch');
        assert.match(verbs.renderPaneMismatch(check), /runs this first: tmux set-environment -g -u TANGLECLAW_ROLE\n$/);
      });
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

  /**
   * A `tmux` stand-in that answers the pane's identity and its start command.
   * @param {string} startCommand - What `#{pane_start_command}` prints
   * @returns {string}
   */
  const paneStartedWith = (startCommand) => 'case "$*" in '
    + '"show-environment -t %7") echo "TANGLECLAW_LAUNCH_ID=L-aaa"; echo "TANGLECLAW_PROJECT_ID=14";; '
    + `"-u display-message -p -t %7 #{pane_start_command}") printf '%s\\n' '${startCommand}';; `
    + '*) exit 1;; esac';

  it('whoami and capabilities warn when the pane was started with the bare Codex name, and say whose the server\'s record is (#2228)', async () => {
    stubTmux(paneStartedWith('"export PATH=\\"/x/bin:\\$PATH\\"; codex --yolo"'));
    for (const verb of ['whoami', 'capabilities']) {
      requests.length = 0;
      const res = await tc([verb], PANE);
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /Launch isolation: NOT ISOLATED\. The pane named by this shell's environment was not started isolated/, verb);
      assert.match(res.stdout, /Server's record \(not a verdict about this shell\): the server lists no isolation record/, verb);
      assert.equal(res.stderr, '', `${verb}: loading the engine judgment printed something`);
      assert.deepEqual(requests.map((r) => r.split('?')[0]).filter((r) => r !== 'GET /api/control/mine'), ['GET /api/tc/whoami', 'GET /api/launch/isolation'], verb);
    }
  });

  it('whoami never calls a pane started with --no-daemon isolated, and asks the server nothing for another engine (#2228)', async () => {
    stubTmux(paneStartedWith('/opt/bin/codex --no-daemon'));
    const codex = await tc(['whoami'], PANE);
    assert.match(codex.stdout, /Launch isolation: NOT SHOWN ISOLATED\./);
    assert.doesNotMatch(codex.stdout, /(?<!NOT )(?<!NOT SHOWN )ISOLATED/);
    stubTmux(paneStartedWith('claude --dangerously-skip-permissions'));
    requests.length = 0;
    const claude = await tc(['whoami'], PANE);
    assert.match(claude.stdout, /Launch isolation: not applicable\./);
    assert.deepEqual(requests.map((r) => r.split('?')[0]).filter((r) => r !== 'GET /api/control/mine'), ['GET /api/tc/whoami']);
  });

  it('a verb that prints no isolation row does not read the pane\'s start command (#2228)', async () => {
    stubTmux('case "$1" in show-environment) echo "TANGLECLAW_LAUNCH_ID=L-aaa"; echo "TANGLECLAW_PROJECT_ID=14";; *) echo asked >> "$0.asked"; exit 1;; esac');
    const res = await tc(['sessions'], PANE);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(fs.existsSync(path.join(stubDir, 'tmux.asked')), false);
  });

  it('still answers help without asking tmux anything', async () => {
    stubTmux('echo "TANGLECLAW_LAUNCH_ID=L-other"');
    const res = await tc(['--help'], PANE);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /whoami/);
  });
});

// What `tc` tells a session about its launch's isolation (#2228): a reading of
// the start command of the pane its environment names, which is only ever
// negative or unknown, and beside it the server's record for the launch a
// verified binding names, worded as the server's.

/** Matches `ISOLATED` printed as a verdict, which is any that neither `NOT ` nor `NOT SHOWN ` leads. */
const POSITIVE_VERDICT = /(?<!NOT )(?<!NOT SHOWN )ISOLATED/;

/**
 * A start command as `readPaneStartCommand` answers it.
 * @param {string|null} command - The command
 * @returns {{read: 'ok', command: (string|null)}}
 */
function started(command) {
  return { read: 'ok', command };
}

/**
 * The `/api/launch/isolation` answer with one project row.
 * @param {number} sessionId - The row's session
 * @param {string} verdict - Its verdict
 * @returns {{sessions: object[]}}
 */
function inventoryOf(sessionId, verdict) {
  return { sessions: [{ sessionId, role: 'project', verdict, reason: `Row ${sessionId} reason.` }] };
}

/**
 * A `tc` context that records the paths asked of it.
 * @param {object} options
 * @param {object} options.read - What the pane's start command reads as
 * @param {object} [options.identity] - The whoami answer; omitted, the identity lookup fails
 * @param {object|Error} [options.inventory] - The inventory answer, or the error it fails with
 * @param {object} [options.envelope] - The `tc start` answer
 * @param {string[]} [options.argv] - Arguments after the verb
 * @returns {{ctx: object, asked: string[]}}
 */
function isolationCtx({ read, identity, inventory, envelope, argv = [] }) {
  const asked = [];
  const getJson = async (apiPath, opts) => {
    asked.push(`GET ${apiPath}${opts && opts.aux ? ' aux' : ''}`);
    if (apiPath.startsWith('/api/tc/whoami')) {
      if (!identity) throw new Error('no identity');
      return identity;
    }
    if (apiPath.startsWith('/api/launch/isolation')) {
      if (inventory instanceof Error) throw inventory;
      return inventory;
    }
    return envelope;
  };
  const ctx = {
    api: 'http://localhost:1', env: {}, argv, paneCheck: { verdict: 'match', reason: null },
    paneStartCommand: () => read,
    getJson,
    postJson: async (apiPath) => { asked.push(`POST ${apiPath}`); return envelope; }
  };
  return { ctx, asked };
}

describe('tc: the start command of the pane this shell names (#2228)', () => {
  const ENV = { TMUX: '/tmp/tmux-501/default,1,2', TMUX_PANE: '%7' };

  describe('readPaneStartCommand', () => {
    it('asks tmux for that pane\'s start command, as UTF-8 and with a bound on the wait', () => {
      const calls = [];
      const read = verbs.readPaneStartCommand(ENV, (file, args, options) => {
        calls.push({ file, args, options });
        return '/opt/bin/codex --no-daemon\n';
      });
      assert.deepEqual(read, { read: 'ok', command: '/opt/bin/codex --no-daemon' });
      assert.equal(calls[0].file, 'tmux');
      assert.deepEqual(calls[0].args, ['-u', 'display-message', '-p', '-t', '%7', '#{pane_start_command}']);
      assert.ok(calls[0].options.timeout > 0);
    });

    it('undoes the quoting tmux prints a command in', () => {
      const read = verbs.readPaneStartCommand(ENV, () => '"export PATH=\\"/x/bin:\\$PATH\\"; codex"\n');
      assert.deepEqual(read, { read: 'ok', command: 'export PATH="/x/bin:$PATH"; codex' });
    });

    it('answers no command, not a guess, for one that cannot be read back exactly', () => {
      assert.deepEqual(verbs.readPaneStartCommand(ENV, () => '"codex \\q"\n'), { read: 'ok', command: null });
      assert.deepEqual(verbs.readPaneStartCommand(ENV, () => 'codex\nsecond line\n'), { read: 'ok', command: null });
    });

    it('does not ask tmux at all without both TMUX and TMUX_PANE, or with a pane id that is not one', () => {
      const exec = () => { throw new Error('tmux was asked'); };
      assert.deepEqual(verbs.readPaneStartCommand({ TMUX_PANE: '%7' }, exec), { read: 'no-pane' });
      assert.deepEqual(verbs.readPaneStartCommand({ TMUX: 'x' }, exec), { read: 'no-pane' });
      assert.equal(verbs.readPaneStartCommand({ TMUX: 'x', TMUX_PANE: '7; rm' }, exec).read, 'unreadable');
    });

    for (const [label, err, said] of [
      ['tmux is not installed', Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }), /not on PATH/],
      ['tmux does not answer in time', Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), /did not answer/],
      ['tmux knows no such pane', Object.assign(new Error('exit 1'), { status: 1 }), /could not read/]
    ]) {
      it(`reports unreadable, with why, when ${label}`, () => {
        const read = verbs.readPaneStartCommand(ENV, () => { throw err; });
        assert.equal(read.read, 'unreadable');
        assert.match(read.detail, said);
      });
    }
  });

  describe('judgeOwnPaneCommand', () => {
    const bridgeHandoff = require('../lib/bridge-handoff');
    const FLOOR = 'export PATH="/x/bin:$PATH"; ';

    for (const [label, command] of [
      ['the bare command name', 'codex'],
      ['the bare name with arguments', 'codex --yolo'],
      ['the bare name behind the PATH floor', `${FLOOR}codex --yolo`],
      ['the bare name behind the credential handoff and the PATH floor', FLOOR + bridgeHandoff.wrapLaunchCommand('codex', '/tmp/f.fifo', { nodePath: '/usr/bin/node', receiverPath: '/x/receive.js' })],
      ['an exact executable with no isolation flag', '/opt/bin/codex --yolo'],
      ['an exact executable that repeats its isolation flag', '/opt/bin/codex --no-daemon --no-daemon'],
      ['an exact executable with the flag in a form Codex may not read', '/opt/bin/codex --no-daemon=1']
    ]) {
      it(`not-isolated: ${label}`, () => {
        const own = verbs.judgeOwnPaneCommand(started(command));
        assert.equal(own.verdict, 'not-isolated', own.reason);
        assert.doesNotMatch(own.reason, /this session/i, 'the reason is about the pane, not this process');
      });
    }

    for (const [label, read, said] of [
      ['an exact executable with --no-daemon, which a borrowed pane could equally show', started('/opt/bin/codex --no-daemon'), /Nothing ties this shell/],
      ['the same behind both wrappers', started(`${FLOOR}/opt/bin/codex --no-daemon`), /Nothing ties this shell/],
      ['a command attached with --remote, whose channel record tc does not hold', started('/opt/bin/codex --remote unix:///tmp/s.sock'), /recorded only by TangleClaw/],
      ['a command that carries --remote beside a contradicting flag', started('/opt/bin/codex --no-daemon --remote unix:///tmp/s.sock'), /recorded only by TangleClaw/],
      ['a PATH floor in a form tc does not take off', started('export PATH=/x/bin:$PATH; codex'), /could not judge/],
      ['a floor with a character the launch path never writes', started('export PATH="/x/`id`:$PATH"; codex'), /could not judge/],
      ['a wrapper that names Codex and is not it', started('/opt/bin/codex-wrap --no-daemon'), /could not judge/],
      ['Codex run through another program', started('env FOO=1 /opt/bin/codex --no-daemon'), /could not judge/],
      ['a command that could not be read back', started(null), /read back from tmux exactly/],
      ['a pane with no start command', started(''), /records no start command/],
      ['no pane', { read: 'no-pane' }, /names no tmux pane/],
      ['tmux not answering', { read: 'unreadable', detail: 'tmux did not answer within 1000 ms' }, /could not be read \(tmux did not answer/],
      ['nothing read at all', undefined, /names no tmux pane/]
    ]) {
      it(`not-shown, never a pass: ${label}`, () => {
        const own = verbs.judgeOwnPaneCommand(read);
        assert.equal(own.verdict, 'not-shown', own.reason);
        assert.match(own.reason, said);
      });
    }

    it('not-applicable: a command that names no engine with a shared background process', () => {
      assert.equal(verbs.judgeOwnPaneCommand(started('claude --dangerously-skip-permissions')).verdict, 'not-applicable');
      assert.equal(verbs.judgeOwnPaneCommand(started(`${FLOOR}claude`)).verdict, 'not-applicable');
    });

    it('not-shown when the judgment itself fails, or answers something it should not', () => {
      const thrown = verbs.judgeOwnPaneCommand(started('claude'), () => { throw new Error('boom'); });
      assert.equal(thrown.verdict, 'not-shown');
      assert.match(thrown.reason, /could not be judged \(boom\)/);
      assert.equal(verbs.judgeOwnPaneCommand(started('claude'), () => null).verdict, 'not-shown');
      assert.equal(verbs.judgeOwnPaneCommand(started('claude'), () => ({ applies: true, verdict: 'something-new' })).verdict, 'not-shown');
    });

    it('has no positive answer, whatever the judgment says', () => {
      const isolated = () => ({ applies: true, verdict: 'isolated', basis: 'no-daemon', reason: 'r' });
      for (const command of ['codex', '/opt/bin/codex --no-daemon', 'claude']) {
        assert.equal(verbs.judgeOwnPaneCommand(started(command), isolated).verdict, 'not-shown');
      }
    });
  });
});

describe('tc: the launch-isolation lines (#2228)', () => {
  const VERIFIED_140 = { state: 'verified', reason: null, role: 'project', projectId: 14, sessionId: 140, cause: null, recovery: null };

  it('NOT ISOLATED is said about the pane the environment names, with the reason, the version and what to do', () => {
    const [row] = verbs.renderOwnIsolation(verbs.judgeOwnPaneCommand(started('codex')), null);
    assert.match(row, /^Launch isolation: NOT ISOLATED\. The pane named by this shell's environment was not started isolated/);
    assert.match(row, /started with `codex`, not with an exact Codex executable path/);
    assert.match(row, /Codex version: unknown/);
    assert.match(row, /ask the operator to end this session and launch it again/);
  });

  it('NOT SHOWN ISOLATED gives no relaunch advice, because no negative was read', () => {
    const [row] = verbs.renderOwnIsolation(verbs.judgeOwnPaneCommand(started('/opt/bin/codex --no-daemon')), null);
    assert.match(row, /^Launch isolation: NOT SHOWN ISOLATED\. Nothing ties this shell/);
    assert.match(row, /tc never reports its own session as isolated/);
    assert.doesNotMatch(row, /launch it again/);
  });

  it('a borrowed but live verified binding whose row is isolated does not make the caller isolated', async () => {
    // The pane the environment names was started isolated and the launch the
    // binding names is recorded isolated: both true of some other session.
    const { ctx } = isolationCtx({ read: started('/opt/bin/codex --no-daemon'), inventory: inventoryOf(140, 'isolated') });
    const lines = await verbs.ownIsolationLines(ctx, answer(VERIFIED_140));
    assert.match(lines[0], /^Launch isolation: NOT SHOWN ISOLATED\./);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /Server's record \(not a verdict about this shell\): the launch this shell's binding names \(session 140\) is recorded as isolated\. Row 140 reason\. That does not show this shell is that launch\./);
    assert.doesNotMatch(lines.join('\n'), POSITIVE_VERDICT);
  });

  it('picks the server\'s row by the session the binding verified, never by one the answer claims', async () => {
    const claimed = { ...answer(VERIFIED_140), sessionId: 999 };
    const inventory = { sessions: [...inventoryOf(999, 'isolated').sessions, ...inventoryOf(140, 'not-isolated').sessions] };
    const { ctx } = isolationCtx({ read: started('codex'), inventory });
    const lines = await verbs.ownIsolationLines(ctx, claimed);
    assert.match(lines[1], /\(session 140\) is recorded as not isolated\. Row 140 reason\./);
    assert.doesNotMatch(lines.join('\n'), /999/);
  });

  it('does not ask the server for a binding that is not verified, and says it did not', async () => {
    for (const binding of [STALE, { state: 'unbound' }, { state: 'weird' }, undefined]) {
      const { ctx, asked } = isolationCtx({ read: started('codex'), inventory: inventoryOf(140, 'isolated') });
      const lines = await verbs.ownIsolationLines(ctx, answer(binding));
      assert.deepEqual(asked, [], 'no request for an unverified binding');
      assert.match(lines[0], /NOT ISOLATED/);
      assert.match(lines[1], /Server's record \(not a verdict about this shell\): not asked, because this shell's launch binding is not verified\./);
    }
  });

  it('does not ask the server at all when the local reading is not applicable', async () => {
    const { ctx, asked } = isolationCtx({ read: started('claude'), inventory: inventoryOf(140, 'isolated') });
    const lines = await verbs.ownIsolationLines(ctx, answer(VERIFIED_140));
    assert.deepEqual(asked, []);
    assert.deepEqual(lines, ['Launch isolation: not applicable. The pane this shell\'s environment names was not started with an engine that shares a background process between sessions.']);
  });

  it('says the record is unavailable when the lookup fails, and still answers', async () => {
    const refused = Object.assign(new Error('the TangleClaw API answered 403'), { code: 'LAUNCH_BINDING_INVALID' });
    for (const [failure, said] of [[refused, /unavailable \(LAUNCH_BINDING_INVALID\)/], [new Error('socket hang up'), /unavailable \(the request failed\)/]]) {
      const { ctx, asked } = isolationCtx({ read: started('codex'), inventory: failure });
      const lines = await verbs.ownIsolationLines(ctx, answer(VERIFIED_140));
      assert.deepEqual(asked, ['GET /api/launch/isolation aux']);
      assert.match(lines[0], /NOT ISOLATED/);
      assert.match(lines[1], said);
    }
  });

  it('says so when the server lists no row for the verified session, and for a verdict it does not know reads not shown', async () => {
    const none = isolationCtx({ read: started('codex'), inventory: inventoryOf(7, 'isolated') });
    assert.match((await verbs.ownIsolationLines(none.ctx, answer(VERIFIED_140)))[1], /lists no isolation record for the launch this shell's binding names \(session 140\)/);
    const odd = isolationCtx({ read: started('codex'), inventory: inventoryOf(140, 'brand-new') });
    assert.match((await verbs.ownIsolationLines(odd.ctx, answer(VERIFIED_140)))[1], /recorded as not shown isolated/);
  });

  it('gives the Project Master the Master\'s row, never a project\'s', async () => {
    const master = { role: 'master', binding: { state: 'verified', role: 'master', projectId: null, sessionId: null }, api: { origin: 'x' }, operator: { host: null, note: 'n' } };
    const inventory = { sessions: [{ sessionId: null, role: 'master', verdict: 'not-isolated', reason: 'Master reason.' }, ...inventoryOf(140, 'isolated').sessions] };
    const { ctx } = isolationCtx({ read: started('codex'), inventory });
    const lines = await verbs.ownIsolationLines(ctx, master);
    assert.match(lines[1], /\(the Project Master\) is recorded as not isolated\. Master reason\./);
  });

  it('never prints ISOLATED as the caller\'s own verdict, for any reading, binding or server answer', async () => {
    const reads = [started('codex'), started('/opt/bin/codex --no-daemon'), started('/opt/bin/codex --remote unix:///tmp/s'), started('claude'),
      started(null), started(''), { read: 'no-pane' }, { read: 'unreadable', detail: 'd' }];
    const inventories = ['isolated', 'not-isolated', 'unknown', 'not-applicable'].map((v) => inventoryOf(140, v)).concat([new Error('x'), { sessions: [] }]);
    for (const read of reads) {
      for (const binding of [VERIFIED_140, STALE, undefined]) {
        for (const inventory of inventories) {
          const { ctx } = isolationCtx({ read, inventory });
          const identity = answer(binding);
          const lines = await verbs.ownIsolationLines(ctx, identity);
          for (const text of [lines.join('\n'), verbs.renderWhoami(identity, undefined, lines), verbs.renderIsolationNotice(lines)]) {
            assert.doesNotMatch(text, POSITIVE_VERDICT);
            assert.doesNotMatch(text, /(you are|this shell is|this session is) isolated/i);
          }
        }
      }
    }
  });

  it('a tc that was handed no pane reader says the command was not read', async () => {
    const { ctx } = isolationCtx({ read: null });
    delete ctx.paneStartCommand;
    const lines = await verbs.ownIsolationLines(ctx, answer(STALE));
    assert.match(lines[0], /NOT SHOWN ISOLATED\. .*could not be read \(this tc did not read the pane\)/);
  });

  describe('where it is printed', () => {
    const run = (verb, ctx) => verbs.VERB_ROSTER.find((v) => v.id === verb).run(ctx);

    it('tc whoami: after the pane check, before the API line', async () => {
      const { ctx, asked } = isolationCtx({ read: started('codex'), identity: answer(VERIFIED_140), inventory: inventoryOf(140, 'not-isolated') });
      const out = (await run('whoami', ctx)).stdout.split('\n');
      const at = out.findIndex((l) => l.startsWith('Launch isolation: NOT ISOLATED.'));
      assert.ok(out[at - 1].startsWith('Pane check:'), out.join('\n'));
      assert.match(out[at + 1], /^ {2}Server's record/);
      assert.ok(out[at + 2].startsWith('TangleClaw API'));
      assert.deepEqual(asked, ['GET /api/tc/whoami', 'GET /api/launch/isolation aux'], 'the identity is fetched once and the record is a side lookup');
    });

    it('tc capabilities: after the roster', async () => {
      const { ctx } = isolationCtx({ read: started('codex'), identity: answer(STALE) });
      const out = (await run('capabilities', ctx)).stdout;
      assert.match(out, /^Capabilities:\n[\s\S]*\nLaunch isolation: NOT ISOLATED\.[^\n]*\n {2}Server's record[^\n]*not asked[^\n]*\n$/);
    });

    const STATE_PAGE = {
      step: { index: 2, id: 'state', of: 4 }, page: { index: 0, of: 1, continued: false }, revision: 1, content: 'STATE STEP TEXT\n',
      ack: { digest: 'abc', command: 'tc start next --ack state:1:abc' }, review: { readyAt: '2026-01-01T00:00:00.000Z' }, nextRef: null
    };

    for (const [sub, asks] of [['next', 'POST /api/tc/start/next'], ['review', 'GET /api/tc/start/review']]) {
      it(`tc start ${sub}: beside the state step, which is printed as served`, async () => {
        const { ctx, asked } = isolationCtx({ read: started('codex'), identity: answer(VERIFIED_140), inventory: inventoryOf(140, 'isolated'), envelope: STATE_PAGE, argv: [sub] });
        const out = (await run('start', ctx)).stdout;
        const without = (await run('start', isolationCtx({ read: started('claude'), envelope: { ...STATE_PAGE, step: { index: 1, id: 'governance', of: 4 } }, argv: [sub] }).ctx)).stdout;
        assert.match(out, /^\[read by tc now, not part of the step below — Launch isolation: NOT ISOLATED\..*ask the operator to end this session and launch it again\. Server's.*\]\n\n/);
        // A review page carries a longer banner of its own, which leaves the notice less room: it is cut, and says so.
        assert.match(out.slice(0, out.indexOf(']\n\n')), sub === 'next'
          ? /Server's record \(not a verdict about this shell\): .*recorded as isolated\. Row 140 reason\. That does not show this shell is that launch\.$/
          : /… Run tc whoami for the rest\.$/);
        assert.ok(out.includes('STATE STEP TEXT\n---\n'), 'the step\'s own text is unchanged');
        assert.equal(out.slice(out.indexOf(']\n\n') + 3), without.replace('governance', 'state').replace('step 2/4', 'step 3/4'), 'everything after the notice is the page as it is printed without one');
        assert.doesNotMatch(out, POSITIVE_VERDICT);
        assert.deepEqual(asked, [asks, 'GET /api/tc/whoami aux', 'GET /api/launch/isolation aux']);
      });

      it(`tc start ${sub}: nothing is added to any other step, and nothing is read for it`, async () => {
        const { ctx, asked } = isolationCtx({ read: started('codex'), identity: answer(VERIFIED_140), inventory: inventoryOf(140, 'isolated'), envelope: { ...STATE_PAGE, step: { index: 3, id: 'task', of: 4 } }, argv: [sub] });
        let reads = 0;
        ctx.paneStartCommand = () => { reads += 1; return started('codex'); };
        const out = (await run('start', ctx)).stdout;
        assert.doesNotMatch(out, /Launch isolation/);
        assert.deepEqual(asked, [asks]);
        assert.equal(reads, 0, 'the pane was read for a step that prints no row');
      });
    }

    for (const [sub, asks] of [['next', 'POST /api/tc/start/next'], ['review', 'GET /api/tc/start/review']]) {
      it(`tc start ${sub}: a session whose engine shares no background process is told nothing, and nothing more is asked`, async () => {
        const { ctx, asked } = isolationCtx({ read: started('claude --x'), identity: answer(VERIFIED_140), inventory: inventoryOf(140, 'isolated'), envelope: STATE_PAGE, argv: [sub] });
        const out = (await run('start', ctx)).stdout;
        assert.doesNotMatch(out, /Launch isolation|read by tc now/);
        assert.ok(out.includes('STATE STEP TEXT'));
        assert.deepEqual(asked, [asks]);
      });

      it(`tc start ${sub}: the state step is printed whatever becomes of the notice`, async () => {
        const { ctx } = isolationCtx({ read: started('codex'), identity: answer(VERIFIED_140), inventory: { sessions: 'not a list' }, envelope: STATE_PAGE, argv: [sub] });
        assert.match((await run('start', ctx)).stdout, /^\[read by tc now[\s\S]*STATE STEP TEXT/);
        ctx.paneStartCommand = () => { throw new Error('tmux fell over'); };
        const res = await run('start', ctx);
        assert.equal(res.code, 0);
        assert.doesNotMatch(res.stdout, /read by tc now/);
        assert.ok(res.stdout.includes('STATE STEP TEXT'));
      });

      it(`tc start ${sub}: a state page cut to the engine's limit still fits it with the notice, however long the reasons`, async () => {
        const launchSequence = require('../lib/launch-sequence');
        // A limit large enough that the budget is the limit less the overhead, not the floor a page is never cut below.
        const maxChars = 8000;
        assert.equal(launchSequence.pageBudgetFor(maxChars), maxChars - require('../lib/launch-page').pageOverhead());
        const content = 'word '.repeat(6000);
        const long = 'A reason that runs on. '.repeat(60);
        const inventory = { sessions: [{ sessionId: 140, role: 'project', verdict: 'not-isolated', reason: long }] };
        let noticed = 0;
        for (const [start, end] of launchSequence.paginate(content, launchSequence.pageBudgetFor(maxChars))) {
          const envelope = {
            step: { index: 2, id: 'state', of: 4 }, page: { index: 998, of: 999, continued: true }, revision: 999999, content: content.slice(start, end),
            ack: { command: 'tc start next --ack state:999999:' + 'a'.repeat(16) },
            revised: { code: 'SNAPSHOT_REVISED', reason: 'the project rules changed', revision: 999999 },
            review: { readyAt: '9999-12-31 23:59:59' }, nextRef: { command: 'tc start review --step task --page 998' }
          };
          const { ctx } = isolationCtx({ read: started('codex'), identity: answer(VERIFIED_140), inventory, envelope, argv: [sub] });
          ctx.judgeRecordedCommand = () => ({ applies: true, verdict: 'not-isolated', reason: long });
          const out = (await run('start', ctx)).stdout;
          assert.ok(out.length <= maxChars, `a printed state page fits: ${out.length} <= ${maxChars}`);
          if (out.startsWith('[read by tc now')) {
            noticed += 1;
            assert.match(out, /^\[read by tc now, not part of the step below — Launch isolation: NOT ISOLATED\./, 'a cut notice keeps the verdict');
            assert.match(out.slice(0, out.indexOf(']\n\n')), /… Run tc whoami for the rest\.$/);
          }
        }
        assert.ok(noticed > 0, 'the notice was printed on a full page');
      });
    }

    it('a notice with no room for its verdict is not printed in part', () => {
      const lines = ['Launch isolation: NOT SHOWN ISOLATED. Some reason.', '  Server\'s record: x.'];
      assert.equal(verbs.renderIsolationNotice(lines, 60), '');
      assert.equal(verbs.renderIsolationNotice(lines).length, 119);
      assert.equal(verbs.renderIsolationNotice(lines, 119).length, 119, 'a notice that fits exactly is whole');
      const cut = verbs.renderIsolationNotice(lines, 118);
      assert.equal(cut.length, 118);
      assert.match(cut, /^\[read by tc now, not part of the step below — Launch isolation: NOT SHOWN ISOLATED.*… Run tc whoami for the rest\.\]\n\n$/);
      assert.match(verbs.renderIsolationNotice(lines), /Server's record: x\.\]\n\n$/);
    });

    it('tc start next: the state step is still served when the identity cannot be read', async () => {
      const { ctx } = isolationCtx({ read: started('codex'), envelope: STATE_PAGE, argv: ['next'] });
      const res = await run('start', ctx);
      assert.equal(res.code, 0);
      assert.match(res.stdout, /NOT ISOLATED\..*not asked, because this shell's launch binding is not verified/);
      assert.ok(res.stdout.includes('tc start next --ack state:1:abc'));
    });
  });
});

describe('tc: the PATH floor is read as the launch path writes it (#2228)', () => {
  it('takes off exactly what lib/sessions.js takes off, and nothing it would not', () => {
    const sessions = require('../lib/sessions');
    for (const command of [
      'export PATH="/x/bin:$PATH"; codex', 'export PATH="/Users/a b/bin:$PATH"; /opt/bin/codex --no-daemon', 'export PATH=":$PATH"; codex',
      'export PATH="/x/bin:$PATH";codex', 'export PATH=/x/bin:$PATH; codex', 'export PATH="/x/`id`:$PATH"; codex', 'export PATH="/x/$HOME:$PATH"; codex',
      ' export PATH="/x/bin:$PATH"; codex', 'export PATH="/x/bin:$PATH"; export PATH="/y:$PATH"; codex', 'codex', ''
    ]) {
      assert.equal(verbs._withoutPathFloor(command), sessions._withoutPathFloor(command), command);
    }
  });
});

describe('tc: loading the engine judgment prints nothing of its own (#2228)', () => {
  /**
   * Run a load under `_requireQuietly` and collect what reaches the process's own `emitWarning`.
   * @param {function(): *} load - Stands in for `require`
   * @returns {{heard: Array<Array<*>>, result: *, thrown: (Error|null), restored: boolean}}
   */
  function loadHearing(load) {
    const real = process.emitWarning;
    const heard = [];
    const recorder = (...args) => { heard.push(args); };
    process.emitWarning = recorder;
    let result;
    let thrown = null;
    try {
      result = verbs._requireQuietly('x', load);
    } catch (err) {
      thrown = err;
    }
    const restored = process.emitWarning === recorder;
    process.emitWarning = real;
    return { heard, result, thrown, restored };
  }

  const SQLITE = 'SQLite is an experimental feature and might change at any time';

  it('drops node\'s SQLite ExperimentalWarning, in each form emitWarning takes it', () => {
    const { heard, result, restored } = loadHearing(() => {
      process.emitWarning(SQLITE, 'ExperimentalWarning');
      process.emitWarning(SQLITE, { type: 'ExperimentalWarning' });
      process.emitWarning(Object.assign(new Error(SQLITE), { name: 'ExperimentalWarning' }));
      return 'loaded';
    });
    assert.deepEqual(heard, []);
    assert.equal(result, 'loaded');
    assert.equal(restored, true);
  });

  it('passes on every other warning raised while the module loads, as it was given', () => {
    const deprecation = Object.assign(new Error('old thing'), { name: 'DeprecationWarning' });
    const { heard } = loadHearing(() => {
      process.emitWarning('Fetch is an experimental feature', 'ExperimentalWarning');
      process.emitWarning(SQLITE, 'DeprecationWarning');
      process.emitWarning(SQLITE);
      process.emitWarning(deprecation);
      process.emitWarning('custom', { type: 'CustomWarning', code: 'C1' });
    });
    assert.deepEqual(heard, [
      ['Fetch is an experimental feature', 'ExperimentalWarning'],
      [SQLITE, 'DeprecationWarning'],
      [SQLITE],
      [deprecation],
      ['custom', { type: 'CustomWarning', code: 'C1' }]
    ]);
  });

  it('puts the process\'s own emitWarning back when the load throws, and lets the throw out', () => {
    const { thrown, restored, heard } = loadHearing(() => { throw new Error('cannot load'); });
    assert.match(thrown.message, /cannot load/);
    assert.equal(restored, true);
    assert.deepEqual(heard, []);
  });
});
