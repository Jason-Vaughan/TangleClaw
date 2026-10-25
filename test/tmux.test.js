'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tmux = require('../lib/tmux');
const { shellWord } = require('../lib/shell-word');
const { uniqueSessionName } = require('./_tmux-session-names');

describe('tmux — a timed-out command says so (#894)', () => {
  it('raises the timeout error instead of the raw exec failure', () => {
    // `lib/tmux.js` tested `err.killed` to spot its own timeout. `execSync` never
    // sets that on the error it throws — it throws code 'ETIMEDOUT' — so the
    // branch, and the 'tmux command timed out' log line inside it, had NEVER
    // executed. A wedged tmux server (a state #94/#144/#380 record this install
    // reaching) produced no timeout diagnostic at all.
    //
    // Driven by a REAL stalling `tmux` on PATH: a stubbed error would assert the
    // very model that was wrong.
    const os = require('node:os');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-slow-tmux-'));
    fs.writeFileSync(path.join(binDir, 'tmux'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${binDir}:${realPath}`;
    try {
      assert.throws(
        () => tmux._exec('tmux list-sessions', { timeout: 300 }),
        /tmux command timed out after 300ms/,
        'a killed tmux command must be reported as timed out, not as a bare exec failure'
      );
    } finally {
      process.env.PATH = realPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe('tmux — one session probe, two questions (#900)', () => {
  it('reports that tmux never answered, where hasSession can only say "not live"', () => {
    // A REAL stalling `tmux`, for the reason the file's other timeout guards use
    // one: the behaviour begins with recognising a killed process, and this repo
    // has shipped three wrong hand-written models of that error shape
    // (#891/#894). It also covers a step a stub would skip entirely — `_exec`
    // REPLACES the timeout error with one of its own, so the flag it puts on
    // that replacement is the only thing `probeSession` has left to read.
    const os = require('node:os');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-slow-tmux-probe-'));
    fs.writeFileSync(path.join(binDir, 'tmux'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${binDir}:${realPath}`;
    try {
      const probe = tmux.probeSession('anything', { timeout: 300 });

      // THE MUTATION THIS CATCHES: reporting `answered: true` for a killed
      // probe. Every caller that RECORDS a death — `getSessionStatus` marking a
      // session crashed, `launchSession` clearing one — would then write a fact
      // nobody established, and the record does not recover when tmux does.
      assert.equal(probe.answered, false);
      assert.equal(probe.live, false);
      assert.equal(probe.cause, 'read-timed-out');

      assert.equal(tmux.hasSession('anything', { timeout: 300 }), false,
        'the boolean form keeps its conservative answer for callers about to act');
    } finally {
      process.env.PATH = realPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('reports a plain "no such session" as an answer', () => {
    // tmux is really on PATH here and really replies. The negative has to stay a
    // negative, or the fix above degenerates into "never conclude anything".
    const probe = tmux.probeSession('tc-definitely-not-a-real-session-900');

    assert.equal(probe.answered, true);
    assert.equal(probe.live, false);
    assert.equal(probe.cause, null);
  });
});

describe('tmux — one session listing serves a whole fleet (#890)', () => {
  /**
   * A stand-in for `execFile` that counts calls and replies with fixed output.
   * @param {object} reply - `{ stdout }` to succeed with, or `{ err }` to fail.
   * @returns {{ execFn: Function, calls: object[] }}
   */
  function stubExec(reply) {
    const calls = [];
    const execFn = (file, args, opts, cb) => {
      calls.push({ file, args, opts });
      setImmediate(() => cb(reply.err || null, reply.stdout || ''));
    };
    return { execFn, calls };
  }

  it('returns every live name, and asks tmux exactly once to learn them all', async () => {
    const { execFn, calls } = stubExec({ stdout: 'alpha\nbeta\ngamma\n' });
    const snap = tmux.createSessionNameSnapshot({ execFn });

    const verdict = await snap.get();
    assert.deepEqual([...verdict.names].sort(), ['alpha', 'beta', 'gamma']);
    assert.equal(verdict.answered, true, 'tmux replied, so the set is the whole truth');
    assert.equal(verdict.cause, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'tmux');
  });

  it('spawns nothing until someone asks', async () => {
    const { execFn, calls } = stubExec({ stdout: 'alpha\n' });
    tmux.createSessionNameSnapshot({ execFn });
    // THE MUTATION THIS CATCHES: reading the list eagerly in the constructor. A
    // fleet whose projects have no sessions would then pay a tmux invocation per
    // poll to learn nothing — more expensive than the per-project calls this
    // replaced, for exactly the operators with the least going on.
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 0);
  });

  it('answers concurrent askers from ONE invocation, not one each', async () => {
    const { execFn, calls } = stubExec({ stdout: 'alpha\n' });
    const snap = tmux.createSessionNameSnapshot({ execFn });

    // THE MUTATION THIS CATCHES: memoising the settled Set instead of the
    // in-flight promise. Enrichment runs under `Promise.all`, so every caller
    // would miss the cache before the first reply landed and spawn its own tmux
    // — the per-project multiplication back again, behind a cache that looks
    // like it works when called sequentially.
    const results = await Promise.all([snap.get(), snap.get(), snap.get()]);

    assert.equal(calls.length, 1);
    for (const verdict of results) assert.ok(verdict.names.has('alpha'));
  });

  it('keeps a name containing the old field delimiter intact', async () => {
    // `listSessions` asks for four `|`-joined fields and splits on `|`. A tmux
    // session someone else created whose name contains a `|` splits early there,
    // yielding a TRUNCATED name — which could collide with a real project's
    // session and report it live. One field has nothing to split on.
    const { execFn, calls } = stubExec({ stdout: 'we|rd\n' });
    const { names } = await tmux.createSessionNameSnapshot({ execFn }).get();

    assert.ok(names.has('we|rd'), 'the whole name must survive');
    assert.ok(!names.has('we'), 'and must not be truncated into another name');
    assert.ok(!calls[0].args.some((a) => a.includes('|')),
      'asking for one field is what makes that true — a joined format brings the split back');
  });

  it('treats a tmux that replied "no server running" as an ANSWER of none live', async () => {
    // THE MUTATION THIS CATCHES: widening "unknown" from a stop we caused to
    // every failure. tmux not running is the ordinary state of a machine with no
    // sessions — an answer, not a gap. Call it unknown and every stale `active`
    // row on a rebooted machine sits at unknown forever, never cleaned up,
    // which is the same defect as #900 pointed the other way.
    //
    // A REAL executable exiting 1 with tmux's own message on stderr, not a
    // hand-built error: this classifier's whole job is telling one `execFile`
    // failure shape from another, and a stub asserts the author's model of the
    // shape rather than the shape (#891/#894, three times).
    const os = require('node:os');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dead-tmux-'));
    // The shim leaves a marker, because `answered: true` is ALSO what a machine
    // with no `tmux` at all produces — so without proof the shim executed, this
    // guard cannot tell "tmux replied with exit 1" from "the fixture never ran",
    // which is the vacuousness it was rewritten to escape.
    const ran = path.join(binDir, 'ran');
    fs.writeFileSync(path.join(binDir, 'tmux'),
      `#!/bin/sh\ntouch "${ran}"\necho "no server running on /tmp/tmux-501/default" >&2\nexit 1\n`,
      { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${binDir}:${realPath}`;
    try {
      // A generous cap on purpose. The stub exits immediately, so this costs
      // nothing on the happy path — but the whole point of the guard is that the
      // verdict came from tmux REPLYING rather than from our timeout, and a tight
      // cap makes that indistinguishable whenever the machine is busy enough to
      // delay a fork. Seen: this failed under a four-file parallel run at 2000ms
      // and passed alone, which is the flake shape a guard about timeouts must
      // not have.
      const verdict = await tmux.createSessionNameSnapshot({ timeout: 20000 }).get();

      assert.ok(fs.existsSync(ran),
        'the shim must actually have run — otherwise this asserts nothing about a tmux that replied');
      assert.equal(verdict.names.size, 0);
      assert.equal(verdict.answered, true,
        'tmux ran and told us there is nothing live — that is an answer');
      assert.equal(verdict.cause, null);
    } finally {
      process.env.PATH = realPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('reports that it could not establish anything when the listing times out (#900)', async () => {
    // Driven by a REAL stalling `tmux`, not a stub: the subject is a timeout, and
    // a stub asserts the author's model of a timeout rather than the timeout
    // (#891/#894 — three hand-written versions of this check were all dead).
    //
    // THE MUTATION THIS CATCHES: resolving the empty set with `answered: true`,
    // which is what this did before #900. A wedged tmux server then made every
    // running session in the fleet report as not live — an unknown wearing a
    // fact's clothes, on precisely the machine state (#94/#144/#380) where the
    // operator most needs to see what is still up.
    const os = require('node:os');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-slow-tmux-snap-'));
    fs.writeFileSync(path.join(binDir, 'tmux'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${binDir}:${realPath}`;
    try {
      const verdict = await tmux.createSessionNameSnapshot({ timeout: 300 }).get();
      assert.equal(verdict.answered, false,
        'a wedged tmux establishes nothing — the empty set must not read as "none live"');
      assert.equal(verdict.cause, 'read-timed-out');
      assert.equal(verdict.names.size, 0);
    } finally {
      process.env.PATH = realPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe('tmux', () => {
  describe('toSessionName', () => {
    it('should pass through valid names unchanged', () => {
      assert.equal(tmux.toSessionName('my-project'), 'my-project');
      assert.equal(tmux.toSessionName('TiLT-v2'), 'TiLT-v2');
    });

    it('should replace spaces with hyphens', () => {
      assert.equal(tmux.toSessionName('TiLT v2'), 'TiLT-v2');
      assert.equal(tmux.toSessionName('My Cool Project'), 'My-Cool-Project');
    });

    it('should strip invalid characters', () => {
      assert.equal(tmux.toSessionName('project@123'), 'project123');
      assert.equal(tmux.toSessionName('a/b:c'), 'abc');
    });

    it('should handle multiple consecutive spaces', () => {
      assert.equal(tmux.toSessionName('a  b'), 'a-b');
    });
  });

  describe('isValidSessionName', () => {
    it('should accept valid names', () => {
      assert.ok(tmux.isValidSessionName('my-project'));
      assert.ok(tmux.isValidSessionName('TiLT-v2'));
      assert.ok(tmux.isValidSessionName('test_project'));
      assert.ok(tmux.isValidSessionName('abc123'));
      assert.ok(tmux.isValidSessionName('A'));
    });

    it('should reject empty or non-string values', () => {
      assert.equal(tmux.isValidSessionName(''), false);
      assert.equal(tmux.isValidSessionName(null), false);
      assert.equal(tmux.isValidSessionName(undefined), false);
      assert.equal(tmux.isValidSessionName(42), false);
    });

    it('should reject names with special characters', () => {
      assert.equal(tmux.isValidSessionName('my project'), false);
      assert.equal(tmux.isValidSessionName('my.project'), false);
      assert.equal(tmux.isValidSessionName('my/project'), false);
      assert.equal(tmux.isValidSessionName('my:project'), false);
      assert.equal(tmux.isValidSessionName('$project'), false);
      assert.equal(tmux.isValidSessionName("'; rm -rf /"), false);
    });

    it('should reject names that are too long', () => {
      assert.equal(tmux.isValidSessionName('a'.repeat(129)), false);
      assert.ok(tmux.isValidSessionName('a'.repeat(128)));
    });
  });

  describe('_escapeArg', () => {
    it('is shellWord itself, not a second implementation (#1399)', () => {
      assert.equal(tmux._escapeArg, shellWord);
    });

    it('should wrap in single quotes', () => {
      assert.equal(tmux._escapeArg('hello'), "'hello'");
    });

    it('should escape embedded single quotes', () => {
      assert.equal(tmux._escapeArg("it's"), "'it'\\''s'");
    });

    it('should handle empty string', () => {
      assert.equal(tmux._escapeArg(''), "''");
    });

    it('should handle strings with special chars', () => {
      const result = tmux._escapeArg('hello world; rm -rf /');
      assert.equal(result, "'hello world; rm -rf /'");
    });
  });

  describe('listSessions', () => {
    it('should return an array', () => {
      const sessions = tmux.listSessions();
      assert.ok(Array.isArray(sessions));
    });

    it('should return objects with expected fields', () => {
      const sessions = tmux.listSessions();
      // Even if empty, the function should not throw
      for (const session of sessions) {
        assert.ok(typeof session.name === 'string');
        assert.ok(typeof session.windows === 'number');
        assert.ok(typeof session.attached === 'boolean');
      }
    });
  });

  describe('hasSession', () => {
    it('should return false for non-existent session', () => {
      assert.equal(tmux.hasSession('__nonexistent_test_session__'), false);
    });
  });

  describe('isServerRunning', () => {
    it('should return a boolean', () => {
      const result = tmux.isServerRunning();
      assert.ok(typeof result === 'boolean');
    });
  });

  describe('sendKeys - error cases', () => {
    it('should throw for non-existent session', () => {
      assert.throws(
        () => tmux.sendKeys('__nonexistent_test_session__', 'hello'),
        /does not exist/
      );
    });
  });

  describe('capturePane - error cases', () => {
    it('should throw for non-existent session', () => {
      assert.throws(
        () => tmux.capturePane('__nonexistent_test_session__'),
        /does not exist/
      );
    });
  });

  describe('cursorInfo - error cases (#1103)', () => {
    it('should throw for non-existent session', () => {
      assert.throws(
        () => tmux.cursorInfo('__nonexistent_test_session__'),
        /does not exist/
      );
    });
  });

  describe('setMouse - error cases', () => {
    it('should throw for non-existent session', () => {
      assert.throws(
        () => tmux.setMouse('__nonexistent_test_session__', true),
        /does not exist/
      );
    });
  });

  describe('getMouse - error cases', () => {
    it('should throw for non-existent session', () => {
      assert.throws(
        () => tmux.getMouse('__nonexistent_test_session__'),
        /does not exist/
      );
    });
  });

  describe('createSession - validation', () => {
    it('should throw for invalid session name', () => {
      assert.throws(
        () => tmux.createSession('invalid name!'),
        /Invalid tmux session name/
      );
    });

    it('should throw for empty session name', () => {
      assert.throws(
        () => tmux.createSession(''),
        /Invalid tmux session name/
      );
    });
  });

  describe('createSession - the pane it created (#2186)', () => {
    const { execFileSync } = require('node:child_process');

    it('hands back the id of the pane the session started with, from the creating invocation', () => {
      const name = uniqueSessionName('born-pane');
      try {
        const born = {};
        assert.equal(tmux.createSession(name, { command: 'sleep 60', born }), true);
        assert.match(born.paneId, /^%\d+$/);
        assert.equal(born.paneId, tmux.solePaneId(name));
        assert.equal(born.server, execFileSync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{pid}.#{start_time}'], { encoding: 'utf8' }).trim(), 'and the server it was created in');
        assert.equal(tmux.visiblePane(name, born.paneId, born.server).paneId, born.paneId, 'the pair is exactly what the pinned read accepts');
      } finally {
        try { tmux.killSession(name); } catch (_) {}
      }
    });

    it('that id still names the created pane after the session\'s pane is replaced, where asking the session does not', () => {
      const name = uniqueSessionName('born-replaced');
      try {
        const born = {};
        tmux.createSession(name, { command: 'sleep 60', born });
        execFileSync('tmux', ['split-window', '-t', `=${name}:`, 'sleep 60']);
        execFileSync('tmux', ['kill-pane', '-t', born.paneId]);
        const now = tmux.solePaneId(name);
        assert.match(now, /^%\d+$/);
        assert.notEqual(now, born.paneId, 'asking afterwards returns the replacement');
      } finally {
        try { tmux.killSession(name); } catch (_) {}
      }
    });

    it('a caller that asks for nothing gets the same boolean as before', () => {
      const name = uniqueSessionName('born-none');
      try {
        assert.equal(tmux.createSession(name, { command: 'sleep 60' }), true);
        assert.equal(tmux.createSession(name, { command: 'sleep 60' }), false, 'an existing session is still reported, not recreated');
        const stale = { paneId: '%1', server: '1.1' };
        assert.equal(tmux.createSession(name, { command: 'sleep 60', born: stale }), false);
        assert.deepEqual(stale, { paneId: null, server: null }, 'a session this call did not create leaves no pane in the answer, not an earlier one');
      } finally {
        try { tmux.killSession(name); } catch (_) {}
      }
    });
  });

  describe('createSession - history-limit', () => {
    const testSession = uniqueSessionName('histlimit');

    it('should set history-limit to 50000 on new session', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        const { execSync } = require('node:child_process');
        const val = execSync(
          `tmux show-option -t ${testSession} history-limit`,
          { encoding: 'utf8', timeout: 3000 }
        ).trim();
        assert.ok(val.includes('50000'), `Expected history-limit 50000, got: ${val}`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  describe('createSession - status bar', () => {
    // Each test uses its own unique session name: killing the last tmux session
    // triggers an exit-empty server shutdown, which races the next test's
    // new-session. Per-test names eliminate the shared-session coupling (#2569).
    it('should set status-left to "TangleClaw" label', () => {
      const testSession = uniqueSessionName('statusbar');
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        const { execSync } = require('node:child_process');
        const val = execSync(
          `tmux show-option -t ${testSession} status-left`,
          { encoding: 'utf8', timeout: 3000 }
        ).trim();
        assert.ok(val.includes('TangleClaw'), `Expected status-left to contain "TangleClaw", got: ${val}`);
        // Should NOT contain raw tmux session name variables — that's confusing
        assert.ok(!val.includes('#{session_name}'), `status-left should not include session_name variable, got: ${val}`);
        assert.ok(!val.includes('#S'), `status-left should not include #S variable, got: ${val}`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should set status-right with time and date', () => {
      const testSession = uniqueSessionName('statusbar');
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        const { execSync } = require('node:child_process');
        const val = execSync(
          `tmux show-option -t ${testSession} status-right`,
          { encoding: 'utf8', timeout: 3000 }
        ).trim();
        assert.ok(val.includes('%H:%M'), `Expected status-right to contain time format, got: ${val}`);
        assert.ok(val.includes('%Y-%m-%d'), `Expected status-right to contain date format, got: ${val}`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  describe('createSession - launch env injection', () => {
    const testSession = uniqueSessionName('launchenv');
    const os = require('node:os');
    const { execSync } = require('node:child_process');

    /**
     * Poll until `p` exists and is non-empty, up to a 3s deadline. Fails the
     * test with a diagnostic showing whether the file was missing or 0 bytes,
     * instead of a fixed sleep that races on loaded CI runners (#2565).
     * @param {string} p - Absolute path to the env dump file
     */
    function waitForEnvDump(p) {
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(p) || fs.statSync(p).size === 0) {
        if (Date.now() >= deadline) {
          const state = fs.existsSync(p) ? 'present but 0 bytes' : 'missing';
          assert.fail(`timed out after 3s waiting for env dump at ${p} (${state})`);
        }
        execSync('sleep 0.02');
      }
    }

    it('makes options.env visible to the spawned launch command (regression: #189 / Aider override)', () => {
      try {
        // The launch command writes its PROCESS env to a file. If the
        // env vars were set on the session BEFORE the command spawned,
        // the file will contain the values; if they were set after (the
        // pre-fix behavior), the file is missing them and the smoke
        // test for the Aider engine override breaks the same way it
        // did during Web-API ↔ LiteLLM integration.

        // A directory of its own: a name built from the clock is shared by two
        // runs that reach this line in the same millisecond.
        const envDumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-launchenv-'));
        const envDumpPath = path.join(envDumpDir, 'env.txt');
        try {
          // `sh -c` writes the two env vars we care about, then keeps
          // the session alive so we have time to inspect before tmux
          // tears it down on command exit.
          const command = `sh -c 'printf "OPENAI_API_KEY=%s\\nOPENAI_API_BASE=%s\\n" "$OPENAI_API_KEY" "$OPENAI_API_BASE" > ${envDumpPath}; exec sleep 5'`;
          tmux.createSession(testSession, {
            command,
            env: {
              OPENAI_API_KEY: 'sk-test-launchenv-pin',
              OPENAI_API_BASE: 'http://example.test:4000'
            }
          });
          waitForEnvDump(envDumpPath);

          assert.ok(fs.existsSync(envDumpPath), `Expected env dump file at ${envDumpPath}`);
          const dumped = fs.readFileSync(envDumpPath, 'utf8');
          assert.match(dumped, /OPENAI_API_KEY=sk-test-launchenv-pin/,
            `Launch command must inherit OPENAI_API_KEY from options.env. Got:\n${dumped}`);
          assert.match(dumped, /OPENAI_API_BASE=http:\/\/example\.test:4000/,
            `Launch command must inherit OPENAI_API_BASE from options.env. Got:\n${dumped}`);
        } finally {
          fs.rmSync(envDumpDir, { recursive: true, force: true });
        }
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('escapes values containing shell metacharacters in env injection', () => {
      try {
        // Values with spaces, quotes, $, and ; would break a naive
        // unescaped `-e KEY=VAL` concatenation. _escapeArg wraps in
        // single quotes and escapes embedded quotes, so the value
        // reaches the child process byte-intact.
        const tricky = `a b'c$d;e"f`;
        // A directory of its own: a name built from the clock is shared by two
        // runs that reach this line in the same millisecond.
        const envDumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-launchenv-tricky-'));
        const envDumpPath = path.join(envDumpDir, 'env.txt');
        try {
          const command = `sh -c 'printf "TRICKY=%s\\n" "$TRICKY" > ${envDumpPath}; exec sleep 5'`;
          tmux.createSession(testSession, {
            command,
            env: { TRICKY: tricky }
          });
          waitForEnvDump(envDumpPath);

          assert.ok(fs.existsSync(envDumpPath));
          const dumped = fs.readFileSync(envDumpPath, 'utf8');
          assert.equal(dumped.trim(), `TRICKY=${tricky}`,
            `Tricky env value must reach the child byte-intact. Got: ${dumped.trim()}`);
        } finally {
          fs.rmSync(envDumpDir, { recursive: true, force: true });
        }
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  describe('createSession - server-exit retry (#2569)', () => {
    // Uses PATH-shimmed #!/bin/sh tmux stubs (same pattern as timeout/probe tests at top of
    // file) to drive the retry path deterministically without a live tmux server.

    it('retries once on "server exited unexpectedly" and returns true with born populated', () => {
      const os = require('node:os');
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-retry-tmux-'));
      const realPath = process.env.PATH;
      // State file: first new-session call touches it and exits 1; second call removes it and succeeds.
      const stateFile = path.join(binDir, 'new-session-called');
      fs.writeFileSync(path.join(binDir, 'tmux'), [
        '#!/bin/sh',
        'case "$1" in',
        '  has-session) exit 1 ;;',
        '  new-session)',
        `    if [ ! -f '${stateFile}' ]; then`,
        `      touch '${stateFile}'`,
        "      echo 'server exited unexpectedly' >&2",
        '      exit 1',
        '    fi',
        "    echo '%0 12345.67890'",
        '    ;;',
        '  set-option) exit 0 ;;',
        '  *) exit 0 ;;',
        'esac',
      ].join('\n'), { mode: 0o755 });
      process.env.PATH = `${binDir}:${realPath}`;
      try {
        const name = uniqueSessionName('srv-exit-retry');
        const born = {};
        assert.equal(tmux.createSession(name, { command: 'exec bash', born }), true);
        assert.equal(born.paneId, '%0', 'born.paneId must be populated from the retry output');
        assert.equal(born.server, '12345.67890', 'born.server must be populated from the retry output');
      } finally {
        process.env.PATH = realPath;
        fs.rmSync(binDir, { recursive: true, force: true });
      }
    });

    it('rethrows immediately when the error does not match "server exited unexpectedly"', () => {
      const os = require('node:os');
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-retry-tmux-nomatch-'));
      const realPath = process.env.PATH;
      fs.writeFileSync(path.join(binDir, 'tmux'), [
        '#!/bin/sh',
        'case "$1" in',
        '  has-session) exit 1 ;;',
        '  new-session)',
        "    echo 'some other tmux error' >&2",
        '    exit 1',
        '    ;;',
        '  *) exit 0 ;;',
        'esac',
      ].join('\n'), { mode: 0o755 });
      process.env.PATH = `${binDir}:${realPath}`;
      try {
        const name = uniqueSessionName('srv-exit-nomatch');
        assert.throws(
          () => tmux.createSession(name, { command: 'exec bash' }),
          /some other tmux error/,
          'a non-matching error must propagate immediately without retry'
        );
      } finally {
        process.env.PATH = realPath;
        fs.rmSync(binDir, { recursive: true, force: true });
      }
    });
  });

  describe('createSession - every launch decides every identity variable (#2268)', () => {
    const IDENTITY = ['TANGLECLAW_LAUNCH_ID', 'TANGLECLAW_PROJECT_ID', 'TANGLECLAW_ROLE', 'TANGLECLAW_WORKSPACE_ID'];
    const MASTER = { TANGLECLAW_LAUNCH_ID: 'L-master', TANGLECLAW_ROLE: 'master', TANGLECLAW_WORKSPACE_ID: 'master-1234abcd' };
    const PROJECT = { TANGLECLAW_LAUNCH_ID: 'L-project', TANGLECLAW_PROJECT_ID: '14' };

    /**
     * The `-e` entries of a built command, in order, as `KEY=VALUE` strings.
     * @param {string} cmd - What `_newSessionCommand` returned
     * @returns {string[]}
     */
    const entries = (cmd) => [...cmd.matchAll(/ -e '([^']*)'/g)].map((m) => m[1]);

    describe('the command it builds', () => {
      it('gives a Project Master launch its three values and an empty project id', () => {
        assert.deepEqual(entries(tmux._newSessionCommand('s', { env: MASTER })), [
          'TANGLECLAW_LAUNCH_ID=L-master', 'TANGLECLAW_ROLE=master', 'TANGLECLAW_WORKSPACE_ID=master-1234abcd',
          'TANGLECLAW_PROJECT_ID='
        ]);
      });

      it('gives a project launch its two values and an empty role and workspace id', () => {
        assert.deepEqual(entries(tmux._newSessionCommand('s', { env: PROJECT })), [
          'TANGLECLAW_LAUNCH_ID=L-project', 'TANGLECLAW_PROJECT_ID=14',
          'TANGLECLAW_ROLE=', 'TANGLECLAW_WORKSPACE_ID='
        ]);
        assert.deepEqual(
          entries(tmux._newSessionCommand('s', { env: { ...PROJECT, TANGLECLAW_WORKSPACE_ID: 'proj-1234abcd' } })).slice(-1),
          ['TANGLECLAW_ROLE='],
          'with the switchboard on, only the role is left to decide'
        );
      });

      it('decides all four as empty for a caller that passes no environment at all', () => {
        const all = IDENTITY.map((key) => `${key}=`);
        for (const options of [undefined, {}, { env: undefined }, { env: null }, { env: {} }, { env: 'TANGLECLAW_ROLE=master' }]) {
          assert.deepEqual(entries(tmux._newSessionCommand('s', options)), all, `for ${JSON.stringify(options)}`);
        }
      });

      it('adds no entry for a launch that gives all four', () => {
        const given = { ...MASTER, TANGLECLAW_PROJECT_ID: '14' };
        assert.deepEqual(entries(tmux._newSessionCommand('s', { env: given })), Object.entries(given).map(([k, v]) => `${k}=${v}`));
      });

      it('keeps an identity value an engine profile\'s launch.env set, where the caller put it', () => {
        // The caller lays the profile's entries over its own, so a profile that
        // names a role arrives here as a given value like any other.
        const env = { OPENAI_API_BASE: 'http://example.test:4000', ...PROJECT, TANGLECLAW_ROLE: 'profile-role' };
        assert.deepEqual(entries(tmux._newSessionCommand('s', { env })), [
          'OPENAI_API_BASE=http://example.test:4000', 'TANGLECLAW_LAUNCH_ID=L-project', 'TANGLECLAW_PROJECT_ID=14', 'TANGLECLAW_ROLE=profile-role',
          'TANGLECLAW_WORKSPACE_ID='
        ]);
      });

      it('leaves every variable that is not an identity variable alone', () => {
        const cmd = tmux._newSessionCommand('s', { env: { ...PROJECT, TANGLECLAW_API: 'http://localhost:3102', TANGLECLAW_PORT: '3102' } });
        const keys = entries(cmd).map((e) => e.slice(0, e.indexOf('=')));
        assert.deepEqual(keys, ['TANGLECLAW_LAUNCH_ID', 'TANGLECLAW_PROJECT_ID', 'TANGLECLAW_API', 'TANGLECLAW_PORT', 'TANGLECLAW_ROLE', 'TANGLECLAW_WORKSPACE_ID']);
        assert.deepEqual(entries(tmux._newSessionCommand('s', {})).filter((e) => !IDENTITY.includes(e.slice(0, -1))), [], 'and adds none of its own');
      });

      it('puts the empty entries after the caller\'s and before the command, and hands the command over unchanged', () => {
        const command = 'export PATH="/x y/bin:$PATH"; claude --dangerously-skip-permissions';
        const cmd = tmux._newSessionCommand('name-1', { cwd: '/a b/c', command, env: PROJECT });
        assert.equal(cmd, [
          "tmux new-session -d -P -F '#{pane_id} #{pid}.#{start_time}' -s 'name-1' -c '/a b/c'",
          "-e 'TANGLECLAW_LAUNCH_ID=L-project' -e 'TANGLECLAW_PROJECT_ID=14'",
          "-e 'TANGLECLAW_ROLE=' -e 'TANGLECLAW_WORKSPACE_ID='",
          `'${command}'`
        ].join(' '));
      });
    });

    describe('on a real tmux server, private to this block, whose global environment holds all four', () => {
      const { execFileSync } = require('node:child_process');
      const verbs = require('../lib/tc-verbs');
      const saved = { TMUX: process.env.TMUX, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
      const STRAY = Object.fromEntries(IDENTITY.map((key) => [key, `stray-${key.toLowerCase()}`]));
      let root = null;
      // The private server's socket and identity, set only once tmux has been
      // seen answering from under `root`. Nothing below writes a global
      // environment, or stops a server, anywhere else.
      let privateSocket = null;
      let privateServer = null;

      /**
       * Run tmux against the private server and return its output.
       * @param {string[]} args - tmux arguments
       * @returns {string} stdout
       */
      function t(args) {
        assert.ok(privateSocket, 'the private tmux server was not established; refusing to run tmux');
        return execFileSync('tmux', ['-S', privateSocket, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      }

      /**
       * A pane command that writes the four identity variables as it sees them,
       * one `KEY=value` per line with `UNSET` for one it does not have, then
       * signals a tmux channel and stays alive.
       * @param {string} label - Names the file and the channel
       * @returns {{command: string, seen: function(): Object<string, string>}} The command, and a reader that blocks until it has written
       */
      function witness(label) {
        const out = path.join(root, `${label}.env`);
        const channel = `seen-${label}`;
        const lines = IDENTITY.map((key) => `"${key}=\${${key}-UNSET}"`).join(' ');
        return {
          command: `printf '%s\\n' ${lines} > '${out}'; tmux wait-for -S '${channel}'; exec sleep 600`,
          seen: () => {
            t(['wait-for', channel]);
            return verbs.parseSessionEnvironment(fs.readFileSync(out, 'utf8'));
          }
        };
      }

      /**
       * Create a session through `tmux.createSession` and prove it landed on the private server.
       * @param {string} name - A factory name
       * @param {object} env - The launch's environment entries
       * @param {string} command - The pane's command
       * @returns {void}
       */
      function create(name, env, command) {
        const born = {};
        assert.equal(tmux.createSession(name, { command, env, born }), true);
        assert.equal(born.server, privateServer, 'the session was created in the private server, by the invocation that printed it');
      }

      before(() => {
        root = fs.mkdtempSync('/tmp/tc-2268-');
        delete process.env.TMUX;
        process.env.TMUX_TMPDIR = root;
        // Proven before anything relies on it: the server this process reaches
        // is the one under `root`. `-f /dev/null`: this call starts the server,
        // and the operator's own tmux config has no place in it.
        const privateProbe = uniqueSessionName('identity-probe');
        execFileSync('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', privateProbe, 'exec sleep 600'], { timeout: 10000 });
        const [socket, server] = execFileSync('tmux', ['display-message', '-p', '-t', `=${privateProbe}:`, '#{socket_path} #{pid}.#{start_time}'],
          { encoding: 'utf8', timeout: 10000 }).trim().split(' ');
        if (!fs.realpathSync(socket).startsWith(fs.realpathSync(root) + path.sep)) {
          // Not ours. Take back the one session just started there, by its
          // exact name, and stop: nothing below may run against that server.
          try { execFileSync('tmux', ['kill-session', '-t', `=${privateProbe}`], { timeout: 10000, stdio: 'ignore' }); } catch (_) { /* gone */ }
          assert.fail(`the test server must be private to this block, but tmux answered from ${socket}`);
        }
        privateSocket = socket;
        privateServer = server;
        // The fault under test, made on purpose and only here: a global
        // environment that holds every identity variable, as a tmux server
        // started from inside a launched pane does.
        for (const [key, value] of Object.entries(STRAY)) t(['set-environment', '-g', key, value]);
      });

      after(() => {
        // Only a server proven private is stopped, and by its socket path.
        if (privateSocket) {
          try { t(['kill-server']); } catch (_) { /* already gone */ }
        }
        if (saved.TMUX === undefined) delete process.env.TMUX; else process.env.TMUX = saved.TMUX;
        if (saved.TMUX_TMPDIR === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = saved.TMUX_TMPDIR;
        if (root) fs.rmSync(root, { recursive: true, force: true });
      });

      it('the seeded values do reach a session that decides only its launch id: what the cases below are measured against', () => {
        const undecided = uniqueSessionName('identity-undecided');
        const w = witness('undecided');
        assert.ok(privateSocket, 'the private tmux server was not established; refusing to start a session');
        execFileSync('tmux', ['-S', privateSocket, 'new-session', '-d', '-s', undecided, '-e', 'TANGLECLAW_LAUNCH_ID=L-only', w.command], { timeout: 10000 });
        assert.deepEqual(w.seen(), { ...STRAY, TANGLECLAW_LAUNCH_ID: 'L-only' });
      });

      for (const [shape, env, expected] of [
        ['a Project Master', MASTER, { ...MASTER, TANGLECLAW_PROJECT_ID: '' }],
        ['a project', PROJECT, { ...PROJECT, TANGLECLAW_ROLE: '', TANGLECLAW_WORKSPACE_ID: '' }]
      ]) {
        const label = shape.split(' ').pop().toLowerCase();

        it(`${shape} launch runs its command with what it gave and nothing from the global environment`, () => {
          const name = uniqueSessionName(`identity-${label}`);
          const w = witness(label);
          create(name, env, w.command);
          assert.deepEqual(w.seen(), expected);
        });

        it(`a window and a pane opened later in ${shape} session see the same, and the session recorded it`, () => {
          const name = uniqueSessionName(`identity-later-${label}`);
          const first = witness(`later-${label}`);
          create(name, env, first.command);
          first.seen();
          const split = witness(`split-${label}`);
          t(['split-window', '-d', '-t', `=${name}:`, split.command]);
          assert.deepEqual(split.seen(), expected, 'a pane split off afterwards');
          const win = witness(`window-${label}`);
          t(['new-window', '-d', '-t', `=${name}:`, win.command]);
          assert.deepEqual(win.seen(), expected, 'a window opened afterwards');
          const recorded = verbs.parseSessionEnvironment(t(['show-environment', '-t', `=${name}:`]));
          for (const key of IDENTITY) assert.equal(recorded[key], expected[key], `the session's own environment holds ${key}`);
        });

        it(`tc's pane check in ${shape} pane answers match, where the undecided session's answers mismatch`, () => {
          const name = uniqueSessionName(`identity-judge-${label}`);
          const w = witness(`judge-${label}`);
          create(name, env, w.command);
          const shell = w.seen();
          const pane = { read: 'ok', vars: verbs.parseSessionEnvironment(t(['show-environment', '-t', `=${name}:`])) };
          assert.deepEqual(verbs.judgePaneIdentity({ env: shell, pane }), { verdict: 'match', reason: null, differences: [] });
          // The same pane record against a shell that inherited the global
          // values: the check this launch path now keeps from firing.
          const inherited = { ...STRAY, ...env };
          assert.equal(verbs.judgePaneIdentity({ env: inherited, pane }).verdict, 'mismatch');
        });
      }

      it('readGlobalIdentityKeys names the four that server holds, gives no value, and changes nothing', () => {
        const before = t(['show-environment', '-g']);
        const found = tmux.readGlobalIdentityKeys();
        assert.deepEqual(found, { present: IDENTITY, answered: true, cause: null });
        for (const value of Object.values(STRAY)) {
          assert.ok(!JSON.stringify(found).includes(value), `the read must not carry the value ${value}`);
        }
        assert.equal(t(['show-environment', '-g']), before, 'the global environment is the same after the read as before it');
      });

      it('left the global environment as it was seeded', () => {
        const globals = verbs.parseSessionEnvironment(t(['show-environment', '-g']));
        for (const key of IDENTITY) assert.equal(globals[key], STRAY[key]);
      });

      it('wrote nothing to any tmux server but the one under its own directory', () => {
        assert.equal(process.env.TMUX, undefined);
        assert.equal(process.env.TMUX_TMPDIR, root);
        assert.ok(fs.realpathSync(privateSocket).startsWith(fs.realpathSync(root) + path.sep));
      });
    });
  });

  describe('capturePane - full mode', () => {
    const testSession = uniqueSessionName('fullcap');

    it('should capture full scrollback with full option', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        // Send some content
        tmux.sendKeys(testSession, 'echo peek-full-test');
        // Small delay for output
        const { execSync } = require('node:child_process');
        execSync('sleep 0.5');
        const capture = tmux.capturePane(testSession, { full: true });
        assert.ok(Array.isArray(capture.lines));
        assert.ok(capture.lines.length > 0, 'Expected at least some output');
        assert.equal(typeof capture.alternateScreen, 'boolean');
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should return more output with full than limited lines', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        // Generate several lines of output
        for (let i = 0; i < 10; i++) {
          tmux.sendKeys(testSession, `echo line-${i}`);
        }
        const { execSync } = require('node:child_process');
        execSync('sleep 1');
        const limited = tmux.capturePane(testSession, { lines: 3 });
        const full = tmux.capturePane(testSession, { full: true });
        assert.ok(full.lines.length >= limited.lines.length,
          `Full (${full.lines.length}) should be >= limited (${limited.lines.length})`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  describe('isAlternateScreen', () => {
    it('should return false for non-existent session', () => {
      assert.equal(tmux.isAlternateScreen('__nonexistent_test_session__'), false);
    });

    it('should return false for a normal bash session (not in alternate screen)', () => {
      const testSession = uniqueSessionName('altscreen');
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        assert.equal(tmux.isAlternateScreen(testSession), false);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  describe('capturePane - alternate screen handling', () => {
    const testSession = uniqueSessionName('altcap');

    it('should return alternateScreen false for normal bash pane', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        const capture = tmux.capturePane(testSession, { full: true });
        assert.equal(capture.alternateScreen, false);
        assert.ok(Array.isArray(capture.lines));
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should return alternateScreen true and visible content for TUI pane', () => {
      try {
        // Use `less` as a controlled alternate screen app
        tmux.createSession(testSession, { command: 'exec bash' });
        tmux.sendKeys(testSession, 'echo hello-alt-test | less');
        // less must start, read stdin and switch screens; on a loaded runner
        // that takes longer than any fixed delay, so wait for what it draws.
        const capture = waitForCapture(testSession,
          (cap) => cap.alternateScreen && cap.lines.join('\n').includes('hello-alt-test'),
          'less on the alternate screen');
        assert.equal(capture.alternateScreen, true);
        assert.ok(Array.isArray(capture.lines));
        // less should show our content on the visible screen
        const joined = capture.lines.join('\n');
        assert.ok(joined.includes('hello-alt-test'),
          `Expected visible content to include "hello-alt-test", got: ${joined.slice(0, 200)}`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  // The shell-typing helpers the two groups below share.
  const { execSync } = require('node:child_process');

  // bash's bare prompt under --norc: `bash-3.2$` on macOS, `bash-5.2$` on Linux.
  // `capturePane` trims tmux's output, so the prompt's trailing space is gone.
  const BASH_PROMPT = /^bash-[\d.]+\$$/;

  /**
   * Poll a pane until `predicate` holds for its captured lines, so a test acts
   * on what the shell has drawn rather than on a guessed delay. A timeout
   * fails the test with the last capture, never passes it.
   * @param {string} session - tmux session name
   * @param {(lines: string[]) => boolean} predicate - receives right-trimmed lines
   * @param {string} what - what is awaited, for the failure message
   * @returns {string[]} the right-trimmed lines that satisfied `predicate`
   */
  function waitForPane(session, predicate, what) {
    const trimmed = (cap) => cap.lines.map((l) => l.trimEnd());
    return trimmed(waitForCapture(session, (cap) => predicate(trimmed(cap)), what));
  }

  /**
   * Poll a pane until `predicate` holds for the whole capture, so a test can
   * wait on the screen mode as well as the lines. A timeout fails the test
   * with the last capture, never passes it.
   * @param {string} session - tmux session name
   * @param {(cap: {lines: string[], alternateScreen: boolean}) => boolean} predicate - receives the raw `capturePane` result
   * @param {string} what - what is awaited, for the failure message
   * @returns {{lines: string[], alternateScreen: boolean}} the capture that satisfied `predicate`
   */
  function waitForCapture(session, predicate, what) {
    const deadline = Date.now() + 10000;
    let cap;
    for (;;) {
      cap = tmux.capturePane(session, { full: true });
      if (predicate(cap)) return cap;
      if (Date.now() >= deadline) {
        const lines = cap.lines.map((l) => l.trimEnd());
        assert.fail(`timed out after 10s waiting for ${what}; last lines:\n${lines.slice(-10).join('\n')}`);
      }
      execSync('sleep 0.1');
    }
  }

  /**
   * The last non-blank line of a capture, trimmed.
   * @param {string[]} lines - captured lines
   * @returns {string} the line, or '' when the pane is blank
   */
  function lastLine(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) return lines[i].trim();
    }
    return '';
  }

  /** The command that starts a bare bash, whose prompt `BASH_PROMPT` matches. */
  const BARE_BASH = 'exec bash --norc --noprofile';

  /**
   * Wait until a bare bash has drawn its prompt. Text typed before the prompt
   * is echoed by the tty above it and never reaches readline, so a test that
   * types sooner scores pane echo rather than what ran (#2447). Each test
   * starts its own session, so the name it passes tmux stays one the session
   * name guard can trace to `uniqueSessionName`.
   * @param {string} session - tmux session name
   * @returns {string[]} the right-trimmed lines once the prompt is drawn
   */
  function awaitBashPrompt(session) {
    return waitForPane(session, (lines) => BASH_PROMPT.test(lastLine(lines)), "bash's prompt");
  }

  describe('sendKeys - behavioral', () => {
    const testSession = uniqueSessionName('sendkeys');

    /**
     * The line the last command printed: the non-blank line just above the
     * fresh prompt. A capture does not join wrapped lines, so matching any line
     * could score a wrapped piece of the typed command instead of its output.
     * @param {string[]} lines - captured lines
     * @returns {string} the line, or '' when there is none
     */
    function outputLine(lines) {
      const shown = lines.map((l) => l.trim()).filter(Boolean);
      return shown.length >= 2 ? shown[shown.length - 2] : '';
    }

    /**
     * Wait until the command just sent has printed `expected` as its own line
     * and bash has drawn a fresh prompt below it. The typed command line holds
     * the same text, so finding the text anywhere in the pane would pass even if
     * the command never ran; and a fixed delay before one capture loses to a
     * loaded host (#2088).
     * @param {string} session - tmux session name
     * @param {string} expected - the exact output line
     * @returns {string[]} the right-trimmed lines once it is printed
     */
    function awaitOutput(session, expected) {
      return waitForPane(session, (lines) => BASH_PROMPT.test(lastLine(lines)) && outputLine(lines) === expected,
        `the output line ${JSON.stringify(expected)} and a fresh prompt`);
    }

    it('should deliver simple text and execute it when enter:true (default)', () => {
      try {
        tmux.createSession(testSession, { command: BARE_BASH });
        awaitBashPrompt(testSession);
        tmux.sendKeys(testSession, 'echo hello-from-send-keys');
        const lines = awaitOutput(testSession, 'hello-from-send-keys');
        assert.ok(
          outputLine(lines) === 'hello-from-send-keys',
          `Expected the command to print the echoed string, got:\n${lines.slice(-10).join('\n')}`
        );
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('does not submit unsent draft text sitting at the prompt (#812)', () => {
      // paste-buffer APPENDS. With a draft already typed, the Enter would submit
      // the operator's line concatenated with ours — executing work nobody asked
      // for, with both instructions corrupted. Exercised against a real pane
      // because the defect lives in what tmux does, not in the command string.
      try {
        tmux.createSession(testSession, { command: BARE_BASH });
        awaitBashPrompt(testSession);
        // The operator's half-typed line: delivered literally, deliberately NOT submitted.
        execSync(`tmux send-keys -t '=${testSession}:' -l 'echo DRAFTRAN'`);
        waitForPane(testSession, (lines) => /^bash-[\d.]+\$ echo DRAFTRAN$/.test(lastLine(lines)),
          'the draft on the prompt line');

        tmux.sendKeys(testSession, 'echo INJECTEDOK');
        // Done when a line of output (not a prompt line) names INJECTEDOK and a fresh
        // prompt follows it; a concatenated submission satisfies this too, so the
        // assertions below are what tell the two apart.
        const lines = waitForPane(testSession, (ls) => BASH_PROMPT.test(lastLine(ls)) &&
          ls.some((l) => !l.startsWith('bash-') && l.includes('INJECTEDOK')),
        'the injected command to finish');
        const tail = lines.slice(-10).join('\n');

        assert.ok(
          lines.some((l) => l === 'INJECTEDOK'),
          `the injected command must run on its own, got:\n${tail}`
        );
        assert.ok(
          !lines.some((l) => l.startsWith('DRAFTRAN')),
          `the operator's unsent draft must not be submitted or prefixed to ours, got:\n${tail}`
        );
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('leaves the draft alone when clearPrompt is false (explicit opt-out)', () => {
      try {
        tmux.createSession(testSession, { command: BARE_BASH });
        awaitBashPrompt(testSession);
        execSync(`tmux send-keys -t '=${testSession}:' -l 'echo DRAFTKEPT'`);
        waitForPane(testSession, (lines) => /^bash-[\d.]+\$ echo DRAFTKEPT$/.test(lastLine(lines)),
          'the draft on the prompt line');

        tmux.sendKeys(testSession, ' && echo APPENDED', { clearPrompt: false });
        // The kept draft and the appended text run as one line, so both print.
        // Had the draft been cleared, ` && echo APPENDED` alone is a syntax
        // error and no APPENDED line is ever printed.
        const lines = waitForPane(testSession, (ls) => BASH_PROMPT.test(lastLine(ls)) && ls.includes('APPENDED'),
          'the kept draft and the appended command to finish');
        const tail = lines.slice(-10).join('\n');

        assert.ok(lines.includes('DRAFTKEPT'), `opting out must keep and submit the prompt contents, got:\n${tail}`);
        assert.ok(lines.includes('APPENDED'), `the appended text must run after the kept draft, got:\n${tail}`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should NOT execute the line when enter:false', () => {
      try {
        tmux.createSession(testSession, { command: BARE_BASH });
        awaitBashPrompt(testSession);
        tmux.sendKeys(testSession, 'echo not-executed-marker', { enter: false });
        const STAGED = /^bash-[\d.]+\$ echo not-executed-marker$/;
        waitForPane(testSession, (lines) => STAGED.test(lastLine(lines)), 'the command on the prompt line');
        // Absence needs a bounded settle. It starts from a drawn prompt, so the
        // tty cannot have echoed the command a second time above it.
        execSync('sleep 0.4');
        const lines = tmux.capturePane(testSession, { full: true }).lines.map((l) => l.trimEnd());
        const tail = lines.slice(-10).join('\n');
        assert.match(lastLine(lines), STAGED, `the command must still sit unsubmitted on the prompt line, got:\n${tail}`);
        assert.ok(!lines.includes('not-executed-marker'), `the command must not have run, got:\n${tail}`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should preserve single quotes in delivered text', () => {
      try {
        tmux.createSession(testSession, { command: BARE_BASH });
        awaitBashPrompt(testSession);
        // Single quotes are the trickiest case for shell escaping
        tmux.sendKeys(testSession, `echo "it's working"`);
        const lines = awaitOutput(testSession, "it's working");
        assert.ok(
          outputLine(lines) === "it's working",
          `Expected single-quoted content to be preserved, got:\n${lines.slice(-10).join('\n')}`
        );
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should preserve special shell characters ($, `, \\)', () => {
      try {
        tmux.createSession(testSession, { command: BARE_BASH });
        awaitBashPrompt(testSession);
        // Send a literal string with characters that would normally be interpreted
        tmux.sendKeys(testSession, `echo 'a$b\`c\\d'`);
        const lines = awaitOutput(testSession, 'a$b`c\\d');
        assert.ok(
          outputLine(lines) === 'a$b`c\\d',
          `Expected special chars preserved literally, got:\n${lines.slice(-10).join('\n')}`
        );
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should deliver large multi-line payloads (>4KB) intact', () => {
      try {
        tmux.createSession(testSession, { command: BARE_BASH });
        awaitBashPrompt(testSession);
        // Build a heredoc that echoes a large unique marker after a long preamble
        // This catches the original 3.11.0 regression where large payloads truncated.
        const filler = 'x'.repeat(4500);
        const marker = 'large-payload-marker-end';
        tmux.sendKeys(testSession, `echo '${filler}' > /dev/null && echo ${marker}`);
        const lines = awaitOutput(testSession, marker);
        assert.ok(
          outputLine(lines) === marker,
          `Expected large payload to execute fully and reach marker, got tail:\n${lines.slice(-10).join('\n')}`
        );
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should use tmux paste-buffer -p so LFs are not replaced with CR (#75)', () => {
      // Source-level regression: tmux's `paste-buffer` default replaces every LF
      // with CR (per tmux 3.6 man page), which collapses multi-line prime prompts
      // into a single line when pasted into a TUI (#75). The -p flag wraps the
      // paste in bracketed-paste escape sequences — tmux then sends LFs literally
      // to apps that advertise bracketed-paste mode (Claude Code, Codex, etc.).
      // If this ever regresses to `paste-buffer -t` (no -p) the bug is back.
      const fs = require('node:fs');
      const path = require('node:path');
      const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tmux.js'), 'utf8');
      assert.match(
        source,
        /tmux paste-buffer -p -t/,
        'lib/tmux.js must invoke `tmux paste-buffer -p -t ...` to preserve LFs in multi-line payloads (#75)'
      );
      assert.doesNotMatch(
        source,
        /tmux paste-buffer -t /,
        'lib/tmux.js must not call paste-buffer without -p — default LF→CR replacement causes #75'
      );
    });
  });

  describe('sendRawKey', () => {
    const testSession = uniqueSessionName('rawkey');

    it('should throw for non-existent session', () => {
      assert.throws(
        () => tmux.sendRawKey('__nonexistent_test_session__', 'Enter'),
        /does not exist/
      );
    });

    it('should send Enter as a raw key (executes pending command)', () => {
      try {
        tmux.createSession(testSession, { command: BARE_BASH });
        awaitBashPrompt(testSession);
        // Stage a command without executing it
        tmux.sendKeys(testSession, 'echo raw-enter-marker', { enter: false });
        waitForPane(testSession, (lines) => /^bash-[\d.]+\$ echo raw-enter-marker$/.test(lastLine(lines)),
          'the command on the prompt line');
        // Now send Enter via sendRawKey to execute it: done when the marker is a
        // line of output and a fresh prompt follows it.
        tmux.sendRawKey(testSession, 'Enter');
        waitForPane(testSession, (lines) => BASH_PROMPT.test(lastLine(lines)) && lines.includes('raw-enter-marker'),
          'the marker as output and a fresh prompt');
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  describe('killSession - success path', () => {
    const testSession = uniqueSessionName('killsuccess');

    it('should return true and remove the session', () => {
      tmux.createSession(testSession, { command: 'exec bash --norc --noprofile' });
      assert.equal(tmux.hasSession(testSession), true, 'precondition: session should exist');
      const result = tmux.killSession(testSession);
      assert.equal(result, true, 'killSession should return true on success');
      assert.equal(tmux.hasSession(testSession), false, 'session should be gone after kill');
    });

    it('should return false when killing a non-existent session', () => {
      const result = tmux.killSession('__never_existed_session__');
      assert.equal(result, false);
    });
  });

  // tmux resolves a `-t` target by exact name, then by unique PREFIX, then by
  // fnmatch. The prefix fallback is why a relaunch of project `Foo` killed live
  // session `Foo-Bar`: with no `Foo` session, every `-t Foo` silently retargeted
  // its longer-named neighbour. These tests pin the exact-match contract, so a
  // target that loses its `=` prefix goes red instead of eating a neighbour.
  describe('exact session-name targeting (no prefix fallback)', () => {
    const base = uniqueSessionName('prefix');
    const longer = `${base}-neighbour`;

    const withNeighbour = (fn) => {
      tmux.createSession(longer, { command: 'exec bash --norc --noprofile' });
      try {
        assert.equal(tmux.hasSession(longer), true, 'precondition: neighbour should exist');
        fn();
      } finally {
        try { tmux.killSession(longer); } catch (_) {}
      }
    };

    it('should not report a session as existing when only a longer-named one does', () => {
      withNeighbour(() => {
        assert.equal(
          tmux.hasSession(base),
          false,
          `hasSession('${base}') must be false while only '${longer}' is running`
        );
      });
    });

    it('should refuse to kill a longer-named session when the exact name is absent', () => {
      withNeighbour(() => {
        assert.equal(
          tmux.killSession(base),
          false,
          'killSession must not resolve to a prefix-matched neighbour'
        );
        assert.equal(
          tmux.hasSession(longer),
          true,
          'the neighbour session must survive — this is the data-loss case'
        );
      });
    });

    it('should refuse to send keys to a prefix-matched neighbour', () => {
      withNeighbour(() => {
        assert.throws(
          () => tmux.sendKeys(base, 'echo prefix-leak'),
          /does not exist/,
          'sendKeys must not type into a prefix-matched neighbour'
        );
      });
    });

    it('should check existence before every display-message, since -t cannot', () => {
      // STRUCTURAL, and deliberately so — the behavioural test below CANNOT hold
      // this. `display-message` falls back to the ATTACHED CLIENT's session, and
      // a headless test run has no attached client, so removing the existence
      // check leaves that test green. Measured: the guard was mutated away and
      // the behavioural assertions did not move.
      //
      // Same reasoning as this file's `-t` site sweep two tests down — reading
      // the source is the only way to hold a property whose misuse is silent.
      //
      // THE MUTATION THIS CATCHES: dropping the `probeSession`/`hasSession` check
      // from any display-message caller, which is the exact #968 defect.
      // Comments STRIPPED first. Both callers explain the hazard in prose
      // directly above the guard, so scanning raw source finds the word
      // `display-message` before the check and reports a correctly-guarded
      // function as unguarded — which is what the first version of this test
      // did. A guard that reads documentation as implementation cannot be
      // trusted in either direction.
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tmux.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const callers = [...src.matchAll(/function (\w+)\(([\s\S]*?)\n\}/g)]
        .filter(([body]) => /display-message/.test(body));
      assert.ok(callers.length >= 2,
        `expected the display-message callers to be found, got ${callers.length}`);
      for (const [body, name] of callers) {
        const at = body.indexOf('display-message');
        const before = body.slice(0, at);
        // `probeSessionAsync` is the non-blocking probe: the same question, for
        // the one caller that must not hold the event loop (#2086).
        assert.match(before, /hasSession\(|probeSession\(|probeSessionAsync\(/,
          `${name}() must establish the session exists BEFORE display-message — `
          + 'that command answers for the attached client instead of failing');
      }
    });

    it('should use an injected probe instead of asking tmux again', () => {
      // The other half of the spawn fix. Its caller already asked this exact
      // question, and re-asking spawns another tmux on an install whose
      // recurring failure is running out of PTYs.
      //
      // Driven with a probe that says NOT LIVE for a session that really IS
      // live: if the injected probe were ignored, the real one would answer live
      // and a timestamp would come back. The answer proves which was used.
      //
      // THE MUTATION THIS CATCHES: dropping `options.probe ||`.
      withNeighbour(() => {
        const answer = tmux.sessionCreatedAt(longer, {
          probe: { live: false, answered: true, cause: null }
        });
        assert.equal(answer.createdAt, null,
          'the injected probe must be believed over a fresh one');
      });
    });

    it('should name a cause when a LIVE session\'s timestamp read fails', () => {
      // STRUCTURAL, for the same reason the existence check above is: the branch
      // needs `has-session` to succeed and `display-message` to fail without
      // timing out, which cannot be arranged from a test without racing a kill
      // between the two calls.
      //
      // It matters because the bare negative shape — `answered: true`,
      // `createdAt: null`, no cause — means "no such session" to every caller,
      // and a live session whose read failed is not that. Its consumer treats a
      // named cause as unknown; an unnamed one would read as "nothing to be
      // stale about".
      //
      // THE MUTATION THIS CATCHES: returning `cause: null` from that catch.
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tmux.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const fn = src.slice(src.indexOf('function sessionCreatedAt'));
      const body = fn.slice(0, fn.indexOf('\n}'));
      // The CATCH block specifically. A whole-function scan is satisfied by the
      // `unparseable` return — which is also an answered-negative with a cause —
      // so it passed while the catch was mutated back to a bare null. Measured.
      const catchAt = body.indexOf('} catch (err) {');
      assert.notEqual(catchAt, -1, 'the failed-read catch must still exist');
      const catchBody = body.slice(catchAt);
      const answered = [...catchBody.matchAll(/answered: true, cause: ([^ }]+)/g)].map((m) => m[1]);
      assert.equal(answered.length, 1,
        `expected exactly one answered-negative return in the catch, got ${answered.length}`);
      assert.notEqual(answered[0], 'null',
        'the failed-read return must name a cause, or it is indistinguishable from "no such session"');
    });

    it('should not report an absent session\'s creation time from a neighbour', () => {
      // THE REGRESSION THIS EXISTS FOR: `display-message` does not fail on an
      // absent session — it answers for the attached client — so without an
      // explicit existence check `sessionCreatedAt` hands back SOME OTHER
      // session's start time. Its caller compares that against a file's mtime to
      // decide whether a running process has read the file, so a borrowed
      // timestamp is not a wrong number, it is a confident wrong answer.
      //
      // NOTE what this does and does not prove. It pins the answer for an absent
      // session in a headless run. It does NOT reproduce the attached-client
      // fallback — mutating the existence guard away leaves this green, which was
      // measured rather than assumed — so the structural guard above is what
      // actually holds that property.
      withNeighbour(() => {
        const answer = tmux.sessionCreatedAt(base);
        assert.equal(answer.answered, true, 'tmux ran and gave a real negative');
        assert.equal(answer.createdAt, null,
          `sessionCreatedAt('${base}') must not borrow '${longer}'s start time`);
      });
    });

    it('should report a real session\'s creation time', () => {
      // The positive control. Without it, a function that always returned
      // `{createdAt: null}` would pass the negative above.
      withNeighbour(() => {
        const answer = tmux.sessionCreatedAt(longer);
        assert.equal(answer.answered, true);
        assert.equal(typeof answer.createdAt, 'number');
        const skew = Math.abs(Date.now() / 1000 - answer.createdAt);
        assert.ok(skew < 600,
          `a session created moments ago must report a recent timestamp, got skew ${skew}s`);
      });
    });

    it('should refuse to capture a prefix-matched neighbour', () => {
      withNeighbour(() => {
        assert.throws(
          () => tmux.capturePane(base),
          /does not exist/,
          'capturePane must not read a prefix-matched neighbour'
        );
      });
    });

    // The behavioural tests above all enter through hasSession, so a `-t` that
    // lost its exact-match target on some OTHER verb would still pass them.
    // This reads the source instead, which is the only way to hold "every
    // target goes through _target" for verbs whose misuse is silent.
    it('should route every tmux -t target in lib/tmux.js through _target', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tmux.js'), 'utf8');
      // Matches a quoted spelling too (`-t '${x}'`), which the bare-brace form
      // would let slip past unchecked.
      const targets = [...src.matchAll(/-t '?\$\{([^}]+)\}/g)].map(m => m[1]);

      // An exact floor, not a lower bound: a site DISAPPEARING is as much a
      // regression as one losing its wrapper, and `>=` would wave that through.
      // 24 since `cursorInfo` gained two sites (#1103): a `display-message`
      // reading `cursor_x`/`cursor_y`, and a `capture-pane -e` re-reading just
      // the cursor's own row with styling intact — the pair that tells a pending
      // inline suggestion from text the operator actually typed. Bumping this
      // number is the acknowledgement the tripwire asks for — it fired
      // correctly, and the `_target` loop below already confirmed both new sites
      // are wrapped. 25 since `paneCurrentPath` (#1469) added a `display-message`
      // reading `pane_current_path`, so a wrap can tell which worktree the
      // session's pane is in; it is wrapped, and it checks the session exists
      // first because `display-message` falls back to the attached client.
      // 26 since `readSessionEnv` (#1626) added a `show-environment`, which reads
      // back the Project Master's launch id; it is wrapped, and unlike
      // `display-message` it fails on an absent session rather than falling back.
      // 28 since `visiblePane` (#2186) added one invocation with two sites: a
      // `display-message` reading the pane's height and cursor, and a
      // `capture-pane -e` of the visible rows, so the row under the cursor is
      // known by position. Both are wrapped, and it checks the session exists
      // first, for the reason `paneCurrentPath` does.
      // 29 since `solePaneId` (#2186) added a `list-panes -s`, which pins the one
      // pane a witness reads; `visiblePane`'s two sites now aim at that pane id
      // through `_target(session, paneId)`.
      assert.equal(targets.length, 29, `expected 29 -t sites in lib/tmux.js, found ${targets.length}`);
      for (const expr of targets) {
        assert.match(
          expr,
          /^_target\(/,
          `every tmux -t target must be built by _target(), found: -t \${${expr}}`
        );
      }
      // `new-session -s` names a session being created; it is not a target and
      // must stay bare, or tmux would create a session literally called "=x:".
      assert.match(src, /new-session[^\n]*-s \$\{_escapeArg\(name\)\}/,
        'new-session -s names a new session and must NOT be exact-match wrapped');
    });

    // These four verbs reject a bare `=name` and are the ones whose failure is
    // invisible: getMouseState catches and returns {on:false, explicit:false} —
    // the wrong-but-plausible value #574/#579 record as poisoning
    // sessionState.mouseOn. A round trip is the only thing that catches it.
    it('should round-trip mouse state and hooks through exact-match targets', () => {
      /** @returns {string} The session's installed hooks, via an exact-match target. */
      const showHooks = () =>
        tmux._exec(`tmux show-hooks -t ${tmux._escapeArg(`=${longer}:`)} 2>/dev/null`);

      tmux.createSession(longer, { command: 'exec bash --norc --noprofile' });
      try {
        tmux.setMouse(longer, true, { hooks: true });
        const on = tmux.getMouseState(longer);
        assert.equal(on.on, true, 'mouse should read back on — a rejected target would read false');
        assert.equal(on.explicit, true, 'a session-level override should be visible as explicit');

        // setMouse only log.warns when `set-hook -t` fails, so a rejected hook
        // target leaves the auto-toggle hooks uninstalled with the test still
        // green. Read them back or this assertion is decoration.
        assert.match(
          showHooks(),
          /after-select-window/,
          'enabling with hooks:true must actually install the after-select-window hook'
        );

        tmux.setMouse(longer, false, { hooks: true });
        assert.equal(tmux.getMouse(longer), false, 'mouse should read back off');
        assert.doesNotMatch(
          showHooks(),
          /after-select-window/,
          'disabling with hooks:true must actually unset the hook'
        );

        tmux.unsetMouse(longer);
        assert.equal(
          tmux.getMouseState(longer).explicit,
          false,
          'unsetMouse should remove the session-level override, not silently no-op'
        );
      } finally {
        try { tmux.killSession(longer); } catch (_) {}
      }
    });

    it('should refuse mouse and capture calls aimed at a prefix-matched neighbour', () => {
      withNeighbour(() => {
        assert.throws(() => tmux.getMouseState(base), /does not exist/);
        assert.throws(() => tmux.setMouse(base, true), /does not exist/);
        assert.throws(() => tmux.unsetMouse(base), /does not exist/);
        assert.equal(
          tmux.isAlternateScreen(base),
          false,
          'isAlternateScreen must not answer for the attached client when the session is absent'
        );
      });
    });

    it('should still act on the exact name when both it and a longer one exist', () => {
      withNeighbour(() => {
        tmux.createSession(base, { command: 'exec bash --norc --noprofile' });
        try {
          assert.equal(tmux.hasSession(base), true);
          assert.equal(tmux.killSession(base), true);
          assert.equal(tmux.hasSession(base), false, 'the exact-named session should be gone');
          assert.equal(tmux.hasSession(longer), true, 'the neighbour should be untouched');
        } finally {
          try { tmux.killSession(base); } catch (_) {}
        }
      });
    });
  });
});

describe('tmux — reading back a session\'s launch environment (#1626)', () => {
  const { execFileSync } = require('node:child_process');
  const name = uniqueSessionName('read-env-1626');

  it('returns the value a session was created with, and nothing for an unset one', () => {
    // A REAL session, started with `-e` exactly as `createSession` does, because
    // what is under test is that tmux keeps `-e` values in the session
    // environment. A stub would assert that belief instead of checking it.
    execFileSync('tmux', ['new-session', '-d', '-s', name, '-e', 'TC_PROBE_1626=abc-123', 'sleep 60']);
    try {
      assert.deepEqual(tmux.readSessionEnv(name, 'TC_PROBE_1626'),
        { value: 'abc-123', answered: true, cause: null });
      assert.deepEqual(tmux.readSessionEnv(name, 'TC_NOT_SET_1626'),
        { value: null, answered: true, cause: null });
    } finally {
      execFileSync('tmux', ['kill-session', '-t', `=${name}`]);
    }
  });

  it('answers "no value" for a session that does not exist, and matches names exactly', () => {
    execFileSync('tmux', ['new-session', '-d', '-s', `${name}-longer`, '-e', 'TC_PROBE_1626=wrong', 'sleep 60']);
    try {
      // A prefix of a live session's name must not read that session.
      assert.deepEqual(tmux.readSessionEnv(name, 'TC_PROBE_1626'),
        { value: null, answered: true, cause: null });
    } finally {
      execFileSync('tmux', ['kill-session', '-t', `=${name}-longer`]);
    }
  });

  it('says tmux did not answer when the read times out, rather than "no value"', () => {
    const os = require('node:os');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-slow-tmux-env-'));
    fs.writeFileSync(path.join(binDir, 'tmux'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${binDir}:${realPath}`;
    try {
      assert.deepEqual(tmux.readSessionEnv('anything', 'TC_PROBE_1626', { timeout: 300 }),
        { value: null, answered: false, cause: 'read-timed-out' });
    } finally {
      process.env.PATH = realPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('refuses a variable name that is not a plain identifier', () => {
    for (const bad of ['a b', 'X;rm', '', 'lower']) {
      assert.throws(() => tmux.readSessionEnv(name, bad), /Invalid environment variable name/);
    }
  });
});

describe('tmux — which launch identity variables the global environment holds (#2268)', () => {
  const IDENTITY = ['TANGLECLAW_LAUNCH_ID', 'TANGLECLAW_PROJECT_ID', 'TANGLECLAW_ROLE', 'TANGLECLAW_WORKSPACE_ID'];

  describe('reading a listing', () => {
    it('names an identity variable that has a value, in the list\'s order, and never its value', () => {
      const listing = [
        'TANGLECLAW_WORKSPACE_ID=master-1234abcd',
        'PATH=/usr/bin:/bin',
        'TANGLECLAW_LAUNCH_ID=L-3f9c2b7e-secret',
        'TANGLECLAW_PORT=3102'
      ].join('\n');
      const found = tmux._identityKeysIn(listing);
      assert.deepEqual(found, ['TANGLECLAW_LAUNCH_ID', 'TANGLECLAW_WORKSPACE_ID']);
      assert.ok(!JSON.stringify(found).includes('L-3f9c2b7e-secret'));
    });

    it('does not count one tmux marks removed, or one that is set and empty', () => {
      assert.deepEqual(tmux._identityKeysIn('-TANGLECLAW_ROLE\nTANGLECLAW_PROJECT_ID=\nTANGLECLAW_LAUNCH_ID=L-1'), ['TANGLECLAW_LAUNCH_ID']);
    });

    it('does not count a variable that only resembles one, or another TangleClaw variable', () => {
      assert.deepEqual(tmux._identityKeysIn('TANGLECLAW_ROLE_OLD=master\nXTANGLECLAW_ROLE=master\nTANGLECLAW_API=http://localhost:3102\nTANGLECLAW_PORT=3102'), []);
    });

    it('keeps a value that contains "=" from hiding its variable, and reads all four', () => {
      assert.deepEqual(tmux._identityKeysIn(IDENTITY.map((key) => `${key}=a=b`).join('\n')), IDENTITY);
    });

    it('answers none for no listing at all', () => {
      for (const nothing of ['', null, undefined]) assert.deepEqual(tmux._identityKeysIn(nothing), []);
    });
  });

  describe('asking tmux', () => {
    const os = require('node:os');

    it('answers "none" where no tmux server is running, and starts none', () => {
      // A directory of its own for tmux's socket, with nothing in it: the
      // read is aimed at a server that does not exist, never at the host's.
      const saved = { TMUX: process.env.TMUX, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
      const root = fs.mkdtempSync('/tmp/tc-2268-none-');
      delete process.env.TMUX;
      process.env.TMUX_TMPDIR = root;
      try {
        assert.deepEqual(tmux.readGlobalIdentityKeys(), { present: [], answered: true, cause: null });
        // tmux makes its socket directory on any call; a server would leave a socket in it.
        const left = fs.readdirSync(root, { recursive: true }).filter((entry) => fs.statSync(path.join(root, entry)).isSocket());
        assert.deepEqual(left, [], 'the read must not start a tmux server');
      } finally {
        if (saved.TMUX === undefined) delete process.env.TMUX; else process.env.TMUX = saved.TMUX;
        if (saved.TMUX_TMPDIR === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = saved.TMUX_TMPDIR;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('says tmux did not answer when the read times out, rather than "none"', () => {
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-slow-tmux-global-'));
      fs.writeFileSync(path.join(binDir, 'tmux'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
      const realPath = process.env.PATH;
      process.env.PATH = `${binDir}:${realPath}`;
      try {
        const started = Date.now();
        assert.deepEqual(tmux.readGlobalIdentityKeys({ timeout: 300 }), { present: [], answered: false, cause: 'read-timed-out' });
        assert.ok(Date.now() - started < 5000, 'the read is bounded by its timeout');
      } finally {
        process.env.PATH = realPath;
        fs.rmSync(binDir, { recursive: true, force: true });
      }
    });

    /**
     * Run the read against a stub `tmux` that prints to stderr and exits.
     * @param {string} script - The stub's body, after its `#!/bin/sh` line
     * @returns {object} What `readGlobalIdentityKeys` answered
     */
    function readWithStub(script) {
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stub-tmux-global-'));
      fs.writeFileSync(path.join(binDir, 'tmux'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      const realPath = process.env.PATH;
      process.env.PATH = `${binDir}:${realPath}`;
      try {
        return tmux.readGlobalIdentityKeys();
      } finally {
        process.env.PATH = realPath;
        fs.rmSync(binDir, { recursive: true, force: true });
      }
    }

    for (const words of [
      'no server running on /tmp/tmux-501/default',
      'error connecting to /tmp/tmux-501/default (No such file or directory)',
      'error connecting to /tmp/tmux-501/default (Connection refused)'
    ]) {
      it(`answers "none" when tmux says "${words}"`, () => {
        assert.deepEqual(readWithStub(`echo '${words}' >&2; exit 1`), { present: [], answered: true, cause: null });
      });
    }

    it('says the read failed, with tmux\'s exit status, for any other failure: that is not "none"', () => {
      assert.deepEqual(readWithStub('echo \'error connecting to /tmp/tmux-501/default (Permission denied)\' >&2; exit 1'),
        { present: [], answered: false, cause: 'read-failed', failure: { status: 1, signal: null, code: null } });
      assert.deepEqual(readWithStub('echo \'no server running on /x\' >&2; exit 3'),
        { present: [], answered: false, cause: 'read-failed', failure: { status: 3, signal: null, code: null } },
        'the words alone are not the answer: tmux exits 1 when it has no server');
      assert.deepEqual(readWithStub('exit 1'),
        { present: [], answered: false, cause: 'read-failed', failure: { status: 1, signal: null, code: null } });
    });

    it('does not answer "none" for a tmux a signal ended', () => {
      // `lib/exec-timeout.js` reads any kill signal as this module's own
      // timeout, so this is "did not answer" and not "failed". Either way it
      // is not an answer.
      const answer = readWithStub('kill -KILL $$');
      assert.equal(answer.answered, false);
      assert.equal(answer.cause, 'read-timed-out');
    });

    it('says the read failed, with the error code, when tmux cannot be run at all', () => {
      const realPath = process.env.PATH;
      process.env.PATH = '/nonexistent-tc-2268';
      try {
        assert.deepEqual(tmux.readGlobalIdentityKeys(),
          { present: [], answered: false, cause: 'read-failed', failure: { status: null, signal: null, code: 'ENOENT' } });
      } finally {
        process.env.PATH = realPath;
      }
    });

    it('carries nothing tmux printed on a failure', () => {
      const answer = readWithStub('echo \'TANGLECLAW_LAUNCH_ID=L-3f9c2b7e-secret\'; echo \'TANGLECLAW_LAUNCH_ID=L-3f9c2b7e-secret\' >&2; exit 2');
      assert.equal(answer.cause, 'read-failed');
      assert.ok(!JSON.stringify(answer).includes('L-3f9c2b7e-secret'));
    });

    it('asks only to be shown the global environment', () => {
      // A tmux that records what it was asked and answers with a listing.
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fake-tmux-global-'));
      const asked = path.join(binDir, 'asked');
      fs.writeFileSync(path.join(binDir, 'tmux'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${asked}'\nprintf 'TANGLECLAW_ROLE=master\\nHOME=/h\\n'\n`, { mode: 0o755 });
      const realPath = process.env.PATH;
      process.env.PATH = `${binDir}:${realPath}`;
      try {
        assert.deepEqual(tmux.readGlobalIdentityKeys(), { present: ['TANGLECLAW_ROLE'], answered: true, cause: null });
        assert.deepEqual(fs.readFileSync(asked, 'utf8').trim().split('\n'), ['show-environment -g']);
      } finally {
        process.env.PATH = realPath;
        fs.rmSync(binDir, { recursive: true, force: true });
      }
    });
  });
});

describe('tmux — one pinned pane and its cursor, row for row (#2186)', () => {
  const { execFileSync } = require('node:child_process');
  const SERVER = '4242.1790431343';
  const PIN = { session: 'tc-x', paneId: '%7', server: SERVER };
  const head = (h, x, y, over = {}) => `${over.paneId || '%7'},${over.windows || 1},${over.panes || 1},${h},${x},${y},${over.server === undefined ? SERVER : over.server},${over.session || 'tc-x'}`;

  it('keeps every row in place, leading blank rows included, so cursor_y indexes the rows', () => {
    const out = `${head(6, 2, 3)}\n\n\n  hello\n\u001b[1m›\u001b[0m Ask\n\n  status · line\n`;
    const pane = tmux._parseVisiblePane(out, PIN);
    assert.deepEqual(pane, { paneId: '%7', height: 6, x: 2, y: 3, rows: ['', '', '  hello', '\u001b[1m›\u001b[0m Ask', '', '  status · line'] });
    assert.equal(pane.rows[pane.y], '\u001b[1m›\u001b[0m Ask', 'the row under the cursor, with its styling');
  });

  it('keeps trailing blank rows too: a pane is its height in rows', () => {
    assert.equal(tmux._parseVisiblePane(`${head(4, 0, 0)}\n>\n\n\n\n`, PIN).rows.length, 4);
  });

  it('a session name holding commas is still read whole', () => {
    const odd = { session: 'a,b,c', paneId: '%7', server: SERVER };
    assert.equal(tmux._parseVisiblePane(`${head(1, 0, 0, { session: 'a,b,c' })}\n>\n`, odd).height, 1);
  });

  it('refuses an answer that does not line up: wrong row count, a cursor outside the pane, or fields that are not whole integers', () => {
    const bad = [
      `${head(4, 0, 0)}\n>\n\n`, `${head(2, 0, 0)}\n>\n\n\n\n`, `${head(3, 0, 3)}\n\n\n\n`, `${head(3, 0, -1)}\n\n\n\n`,
      `${head('3abc', 0, 0)}\n\n\n\n`, `${head(3, '0x', 0)}\n\n\n\n`, `${head(3, 0, '1e0')}\n\n\n\n`, `${head('3.0', 0, 0)}\n\n\n\n`,
      `${head(' 3', 0, 0)}\n\n\n\n`, `${head('+3', 0, 0)}\n\n\n\n`, '%7,1,1,3,0\n\n\n\n', '', 'x\n\n'
    ];
    for (const out of bad) assert.throws(() => tmux._parseVisiblePane(out, PIN), /row for row/, JSON.stringify(out));
  });

  it('refuses an answer for another pane or another session than the one pinned', () => {
    const rows = '\n>\n\n\n';
    assert.throws(() => tmux._parseVisiblePane(`${head(3, 0, 0, { paneId: '%8' })}${rows}`, PIN), /different pane or session/);
    assert.throws(() => tmux._parseVisiblePane(`${head(3, 0, 0, { session: 'tc-y' })}${rows}`, PIN), /different pane or session/);
    assert.throws(() => tmux._parseVisiblePane(`${head(3, 0, 0, { session: 'tc-x-longer' })}${rows}`, PIN), /different pane or session/);
    assert.throws(() => tmux._parseVisiblePane(`${head(3, 0, 0)}${rows}`, undefined), /different server/);
  });

  it('refuses an answer from another tmux server, flagged so a caller can tell it will not clear: the same pane id and session name there are another pane', () => {
    const rows = '\n>\n\n\n';
    const flagged = (fn) => assert.throws(fn, (err) => err.tcOtherServer === true && /different server/.test(err.message));
    flagged(() => tmux._parseVisiblePane(`${head(3, 0, 0, { server: '4243.1790431343' })}${rows}`, PIN));
    flagged(() => tmux._parseVisiblePane(`${head(3, 0, 0, { server: '4242.1790431344' })}${rows}`, PIN), 'same pid, started at another second');
    flagged(() => tmux._parseVisiblePane(`${head(3, 0, 0, { server: '' })}${rows}`, PIN));
    for (const none of [undefined, null, '', '4242', 4242.1]) {
      flagged(() => tmux._parseVisiblePane(`${head(3, 0, 0)}${rows}`, { ...PIN, server: none }));
    }
    // Another pane in the right server is the ordinary refusal, not this one.
    assert.throws(() => tmux._parseVisiblePane(`${head(3, 0, 0, { paneId: '%8' })}${rows}`, PIN), (err) => err.tcOtherServer !== true);
  });

  it('refuses a session that has gained a pane or a window since it was pinned', () => {
    const rows = '\n>\n\n\n';
    assert.throws(() => tmux._parseVisiblePane(`${head(3, 0, 0, { panes: 2 })}${rows}`, PIN), /no longer has exactly one pane/);
    assert.throws(() => tmux._parseVisiblePane(`${head(3, 0, 0, { windows: 2 })}${rows}`, PIN), /no longer has exactly one pane/);
  });

  it('aims BOTH subcommands at the pinned pane id, never at the session\'s current pane', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tmux.js'), 'utf8');
    const body = src.slice(src.indexOf('function visiblePane('), src.indexOf('function _parseVisiblePane('));
    const targets = [...body.matchAll(/-t \$\{([^}]+)\}/g)].map((m) => m[1]);
    assert.deepEqual(targets, ['_target(session, paneId)', '_target(session, paneId)'], 'display-message and capture-pane both take the pane id');
    assert.ok(body.includes("\\\\; capture-pane -e -p -t ") && body.indexOf('display-message -p -t ') < body.indexOf('capture-pane -e -p -t '), 'one invocation, display-message then capture-pane');
  });

  it('throws for a session that does not exist, like every other read', () => {
    assert.throws(() => tmux.visiblePane('tc-test-no-such-session-2186', '%1', SERVER), /does not exist/);
    assert.throws(() => tmux.solePaneId('tc-test-no-such-session-2186'), /does not exist/);
  });

  describe('against a real tmux session', () => {
    const name = uniqueSessionName('visible-pane-2186');
    const start = () => execFileSync('tmux', ['new-session', '-d', '-s', name, '-x', '60', '-y', '12', 'printf "\\n\\n  hello\\n> "; sleep 60']);
    const kill = () => { try { execFileSync('tmux', ['kill-session', '-t', `=${name}`]); } catch { /* already gone */ } };
    const settle = () => execFileSync('sleep', ['0.4']);
    /** The identity of the tmux server the test session lives in, as a launch would have recorded it. */
    const srv = () => execFileSync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{pid}.#{start_time}'], { encoding: 'utf8' }).trim();

    it('pins the one pane and reads it row for row, leading blank rows kept', () => {
      start();
      try {
        settle();
        const paneId = tmux.solePaneId(name);
        assert.match(paneId, /^%\d+$/);
        const pane = tmux.visiblePane(name, paneId, srv());
        assert.equal(pane.paneId, paneId);
        assert.equal(pane.height, 12);
        assert.equal(pane.rows.length, 12);
        assert.deepEqual(pane.rows.slice(0, 4).map((r) => r.replace(/\s+$/, '')), ['', '', '  hello', '>']);
        assert.equal(pane.y, 3, 'the cursor is on the fourth row, and the rows still start at the top');
      } finally {
        kill();
      }
    });

    it('a second pane is refused, whichever pane is current: nothing follows the active pane', () => {
      start();
      try {
        settle();
        const pinned = tmux.solePaneId(name);
        execFileSync('tmux', ['split-window', '-t', `=${name}:`, 'printf "OTHER PANE\\n> "; sleep 60']);
        settle();
        assert.throws(() => tmux.solePaneId(name), /does not have exactly one pane/);
        // The split made the NEW pane current. A session-relative read would now be of it.
        const current = execFileSync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{pane_id}'], { encoding: 'utf8' }).trim();
        assert.notEqual(current, pinned, 'the session\'s current pane is no longer the pinned one');
        assert.throws(() => tmux.visiblePane(name, pinned, srv()), /no longer has exactly one pane/);
        execFileSync('tmux', ['select-pane', '-t', pinned]);
        assert.throws(() => tmux.visiblePane(name, pinned, srv()), /no longer has exactly one pane/, 'and switching back does not make two panes one');
      } finally {
        kill();
      }
    });

    it('THE SERVER IS PART OF THE PIN: the same pane, asked for as another server\'s, is refused and flagged; a malformed server is refused before tmux is asked', () => {
      start();
      try {
        settle();
        const paneId = tmux.solePaneId(name);
        const [pid, started] = srv().split('.');
        assert.equal(tmux.visiblePane(name, paneId, srv()).paneId, paneId);
        for (const other of [`${Number(pid) + 1}.${started}`, `${pid}.${Number(started) - 1}`]) {
          assert.throws(() => tmux.visiblePane(name, paneId, other), (err) => err.tcOtherServer === true, other);
        }
        for (const bad of [undefined, null, '', pid, `${pid}.`, `${pid}.${started}; touch /tmp/tc-2186-should-not-exist`, 12]) {
          assert.throws(() => tmux.visiblePane(name, paneId, bad), /not a tmux server identity/, String(bad));
        }
        assert.equal(fs.existsSync('/tmp/tc-2186-should-not-exist'), false);
      } finally {
        kill();
      }
    });

    it('refuses anything that is not a pane id as the pin, before tmux is asked', () => {
      start();
      try {
        for (const bad of ['', '7', '%', '%7; touch /tmp/tc-2186-should-not-exist', `=${name}:`, '%7.1', null, 12, undefined]) {
          assert.throws(() => tmux.visiblePane(name, bad, srv()), /not a tmux pane id|different pane or session/, String(bad));
        }
        assert.equal(fs.existsSync('/tmp/tc-2186-should-not-exist'), false);
      } finally {
        kill();
      }
    });

    it('a pane id that belongs to another session is refused', () => {
      const other = `${name}-other`;
      start();
      execFileSync('tmux', ['new-session', '-d', '-s', other, 'sleep 60']);
      try {
        settle();
        const foreign = tmux.solePaneId(other);
        assert.throws(() => tmux.visiblePane(name, foreign, srv()), /different pane or session/);
      } finally {
        kill();
        try { execFileSync('tmux', ['kill-session', '-t', `=${other}`]); } catch { /* gone */ }
      }
    });

    it('REPLACEMENT: split, kill the original pane, and the session has one pane again, with a DIFFERENT id', () => {
      start();
      try {
        settle();
        const launched = tmux.solePaneId(name);
        execFileSync('tmux', ['split-window', '-t', `=${name}:`, 'printf "› Ask Codex to do anything\n"; sleep 60']);
        execFileSync('tmux', ['kill-pane', '-t', launched]);
        settle();
        const now = tmux.solePaneId(name);
        assert.match(now, /^%\d+$/, 'the session passes the one-pane check again');
        assert.notEqual(now, launched, 'but its pane is not the one the launch created: only a recorded id can tell');
        assert.throws(() => tmux.visiblePane(name, launched, srv()), /./, 'and the launch\'s own pane can no longer be read');
        assert.equal(tmux.visiblePane(name, now, srv()).paneId, now, 'while the replacement reads perfectly well');
      } finally {
        kill();
      }
    });

    it('a second window is refused too', () => {
      start();
      try {
        settle();
        const pinned = tmux.solePaneId(name);
        execFileSync('tmux', ['new-window', '-d', '-t', `=${name}:`, 'sleep 60']);
        assert.throws(() => tmux.solePaneId(name), /does not have exactly one pane/);
        assert.throws(() => tmux.visiblePane(name, pinned, srv()), /no longer has exactly one pane/);
      } finally {
        kill();
      }
    });
  });
});
