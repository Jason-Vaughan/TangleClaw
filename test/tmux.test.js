'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tmux = require('../lib/tmux');

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

  describe('createSession - history-limit', () => {
    const testSession = '__tc_test_histlimit__';

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
    const testSession = '__tc_test_statusbar__';

    it('should set status-left to "TangleClaw" label', () => {
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
    const testSession = '__tc_test_launchenv__';

    it('makes options.env visible to the spawned launch command (regression: #189 / Aider override)', () => {
      try {
        // The launch command writes its PROCESS env to a file. If the
        // env vars were set on the session BEFORE the command spawned,
        // the file will contain the values; if they were set after (the
        // pre-fix behavior), the file is missing them and the smoke
        // test for the Aider engine override breaks the same way it
        // did during Web-API ↔ LiteLLM integration.
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const { execSync } = require('node:child_process');

        const envDumpPath = path.join(os.tmpdir(), `tc-launchenv-${Date.now()}.txt`);
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
          execSync('sleep 0.5');

          assert.ok(fs.existsSync(envDumpPath), `Expected env dump file at ${envDumpPath}`);
          const dumped = fs.readFileSync(envDumpPath, 'utf8');
          assert.match(dumped, /OPENAI_API_KEY=sk-test-launchenv-pin/,
            `Launch command must inherit OPENAI_API_KEY from options.env. Got:\n${dumped}`);
          assert.match(dumped, /OPENAI_API_BASE=http:\/\/example\.test:4000/,
            `Launch command must inherit OPENAI_API_BASE from options.env. Got:\n${dumped}`);
        } finally {
          try { fs.unlinkSync(envDumpPath); } catch (_) {}
        }
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('escapes values containing shell metacharacters in env injection', () => {
      try {
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const { execSync } = require('node:child_process');

        // Values with spaces, quotes, $, and ; would break a naive
        // unescaped `-e KEY=VAL` concatenation. _escapeArg wraps in
        // single quotes and escapes embedded quotes, so the value
        // reaches the child process byte-intact.
        const tricky = `a b'c$d;e"f`;
        const envDumpPath = path.join(os.tmpdir(), `tc-launchenv-tricky-${Date.now()}.txt`);
        try {
          const command = `sh -c 'printf "TRICKY=%s\\n" "$TRICKY" > ${envDumpPath}; exec sleep 5'`;
          tmux.createSession(testSession, {
            command,
            env: { TRICKY: tricky }
          });
          execSync('sleep 0.5');

          assert.ok(fs.existsSync(envDumpPath));
          const dumped = fs.readFileSync(envDumpPath, 'utf8');
          assert.equal(dumped.trim(), `TRICKY=${tricky}`,
            `Tricky env value must reach the child byte-intact. Got: ${dumped.trim()}`);
        } finally {
          try { fs.unlinkSync(envDumpPath); } catch (_) {}
        }
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  describe('capturePane - full mode', () => {
    const testSession = '__tc_test_fullcap__';

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
      const testSession = '__tc_test_altscreen__';
      try {
        tmux.createSession(testSession, { command: 'exec bash' });
        assert.equal(tmux.isAlternateScreen(testSession), false);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  describe('capturePane - alternate screen handling', () => {
    const testSession = '__tc_test_altcap__';

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
        const { execSync } = require('node:child_process');
        execSync('sleep 0.5');
        const capture = tmux.capturePane(testSession, { full: true });
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

  describe('sendKeys - behavioral', () => {
    const testSession = '__tc_test_sendkeys__';
    const { execSync } = require('node:child_process');

    function captureContent(session) {
      // Small delay so the shell finishes processing before we capture
      execSync('sleep 0.4');
      const cap = tmux.capturePane(session, { full: true });
      return cap.lines.join('\n');
    }

    it('should deliver simple text and execute it when enter:true (default)', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash --norc --noprofile' });
        tmux.sendKeys(testSession, 'echo hello-from-send-keys');
        const content = captureContent(testSession);
        assert.ok(
          content.includes('hello-from-send-keys'),
          `Expected output to contain echoed string, got: ${content.slice(0, 200)}`
        );
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should NOT execute the line when enter:false', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash --norc --noprofile' });
        // Use a marker that would only appear in OUTPUT (not the prompt) if executed
        tmux.sendKeys(testSession, 'echo not-executed-marker', { enter: false });
        execSync('sleep 0.4');
        const cap = tmux.capturePane(testSession, { full: true });
        const content = cap.lines.join('\n');
        // The text is on the prompt line; with no Enter, only the literal command appears once.
        // After Enter we'd see two occurrences (command + echoed output).
        const occurrences = (content.match(/not-executed-marker/g) || []).length;
        assert.equal(occurrences, 1,
          `Expected exactly 1 occurrence of marker (command on prompt only, not executed), got ${occurrences}: ${content.slice(0, 200)}`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should preserve single quotes in delivered text', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash --norc --noprofile' });
        // Single quotes are the trickiest case for shell escaping
        tmux.sendKeys(testSession, `echo "it's working"`);
        const content = captureContent(testSession);
        assert.ok(
          content.includes("it's working"),
          `Expected single-quoted content to be preserved, got: ${content.slice(0, 200)}`
        );
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should preserve special shell characters ($, `, \\)', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash --norc --noprofile' });
        // Send a literal string with characters that would normally be interpreted
        tmux.sendKeys(testSession, `echo 'a$b\`c\\d'`);
        const content = captureContent(testSession);
        assert.ok(
          content.includes('a$b`c\\d'),
          `Expected special chars preserved literally, got: ${content.slice(0, 200)}`
        );
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });

    it('should deliver large multi-line payloads (>4KB) intact', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash --norc --noprofile' });
        // Build a heredoc that echoes a large unique marker after a long preamble
        // This catches the original 3.11.0 regression where large payloads truncated.
        const filler = 'x'.repeat(4500);
        const marker = 'large-payload-marker-end';
        tmux.sendKeys(testSession, `echo '${filler}' > /dev/null && echo ${marker}`);
        const content = captureContent(testSession);
        assert.ok(
          content.includes(marker),
          `Expected large payload to execute fully and reach marker, got tail: ${content.slice(-300)}`
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
    const testSession = '__tc_test_rawkey__';
    const { execSync } = require('node:child_process');

    it('should throw for non-existent session', () => {
      assert.throws(
        () => tmux.sendRawKey('__nonexistent_test_session__', 'Enter'),
        /does not exist/
      );
    });

    it('should send Enter as a raw key (executes pending command)', () => {
      try {
        tmux.createSession(testSession, { command: 'exec bash --norc --noprofile' });
        // Stage a command without executing it
        tmux.sendKeys(testSession, 'echo raw-enter-marker', { enter: false });
        execSync('sleep 0.3');
        // Now send Enter via sendRawKey to execute it
        tmux.sendRawKey(testSession, 'Enter');
        execSync('sleep 0.4');
        const cap = tmux.capturePane(testSession, { full: true });
        const content = cap.lines.join('\n');
        // After Enter, the marker should appear at least twice (typed + echoed output)
        const occurrences = (content.match(/raw-enter-marker/g) || []).length;
        assert.ok(occurrences >= 2,
          `Expected marker to appear at least twice after Enter, got ${occurrences}: ${content.slice(0, 200)}`);
      } finally {
        try { tmux.killSession(testSession); } catch (_) {}
      }
    });
  });

  describe('killSession - success path', () => {
    const testSession = '__tc_test_killsuccess__';

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
    const base = '__tc_test_prefix__';
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
        assert.match(before, /hasSession\(|probeSession\(/,
          `${name}() must establish the session exists BEFORE display-message — `
          + 'that command answers for the attached client instead of failing');
      }
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
      // 21 since #968 added `sessionCreatedAt`, which reads a live session's start
      // time so a caller can tell whether that session predates a file it only
      // reads at launch. Bumping this number is the acknowledgement the tripwire
      // asks for — it fired correctly, and the `_target` loop below already
      // confirmed the new site is wrapped.
      assert.equal(targets.length, 21, `expected 21 -t sites in lib/tmux.js, found ${targets.length}`);
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
