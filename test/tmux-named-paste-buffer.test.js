'use strict';

/*
 * sendKeys delivers through a tmux buffer named for one send (#2173).
 *
 * tmux buffers belong to the server, which every session, test run and
 * operator on a host shares. With no name, `load-buffer` creates "the newest
 * buffer" and `paste-buffer` takes whichever is newest when it runs, so a load
 * by another process between the two pastes the wrong text into the pane.
 *
 * Two kinds of test here, and neither touches the host's own tmux server:
 *
 * - A recording `tmux` on PATH, for what the commands are: their names, their
 *   order, what happens when one fails. A stub of `_exec` would assert the
 *   model under test; a real executable is run by the real code path.
 * - A real tmux server private to this file, for what tmux does with them:
 *   which pane a paste reaches, what is left on the server afterwards.
 *
 * The private server needs BOTH halves of its isolation. tmux prefers the
 * socket named in `TMUX`, which every pane exports, over `TMUX_TMPDIR`; with
 * `TMUX` left set, this file would be driving the server the suite was started
 * from. And the directory has to be short: a unix socket path has a length
 * limit that a nested temp directory exceeds.
 */

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setLevel, setConsoleStream } = require('../lib/logger');
const { uniqueSessionName } = require('./_tmux-session-names');

setLevel('error');

const tmux = require('../lib/tmux');

const BUFFER_NAME = /^tc-send-[0-9a-f]{32}$/;

// ── A recording tmux on PATH ──

/**
 * Put a `tmux` at the front of PATH that records each call and returns a
 * restore function plus readers for what it recorded.
 *
 * Every verb exits 0 unless `fail` names it. `load-buffer` also records the
 * file it was handed: its path, mode and contents, taken while the file still
 * exists. `file.text` is the most recent load's, so read it before the next send.
 *
 * @param {object} [behaviour] - How the fake answers
 * @param {string[]} [behaviour.fail] - Verbs that exit 1 with a tmux-like message
 * @param {string[]} [behaviour.stall] - Verbs that never answer
 * @returns {{calls: () => Array<{verb: string, argv: string[], file?: object}>, restore: () => void}}
 */
function installRecordingTmux(behaviour = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rec-tmux-2173-'));
  const logFile = path.join(dir, 'calls.tsv');
  const verbs = (list) => (list && list.length ? list.join('|') : '-');
  // A shell script, not a node one: sendKeys makes several tmux calls and each
  // would pay an interpreter start. Arguments are recorded tab-separated, one
  // call per line; none of the arguments under test holds a tab or a newline.
  fs.writeFileSync(path.join(dir, 'tmux'), [
    '#!/bin/sh',
    `log='${logFile}'`,
    'verb="$1"',
    'if [ "$verb" = load-buffer ]; then',
    '  for last; do :; done',
    // GNU first: its `stat -f` is a different command that prints a filesystem
    // report, so the BSD spelling can only be the fallback.
    '  mode=$(stat -c %a "$last" 2>/dev/null || stat -f %Lp "$last")',
    `  cp "$last" '${dir}/loaded'`,
    '  printf \'@file\\t%s\\t%s\\n\' "$last" "$mode" >> "$log"',
    'fi',
    'printf \'%s\\t\' "$@" >> "$log"; printf \'\\n\' >> "$log"',
    'case "$verb" in',
    `  ${verbs(behaviour.stall)}) exec sleep 60 ;;`,
    `  ${verbs(behaviour.fail)}) echo "fake tmux: $verb refused" >&2; exit 1 ;;`,
    'esac',
    'exit 0'
  ].join('\n') + '\n', { mode: 0o755 });
  const realPath = process.env.PATH;
  process.env.PATH = `${dir}:${realPath}`;
  return {
    calls: () => {
      if (!fs.existsSync(logFile)) return [];
      const out = [];
      let file = null;
      for (const line of fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)) {
        const fields = line.split('\t');
        if (fields[0] === '@file') {
          file = { path: fields[1], mode: parseInt(fields[2], 8), text: fs.readFileSync(path.join(dir, 'loaded'), 'utf8') };
          continue;
        }
        const argv = fields.slice(0, -1);
        out.push(file ? { verb: argv[0], argv, file } : { verb: argv[0], argv });
        file = null;
      }
      return out;
    },
    restore: () => {
      process.env.PATH = realPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * The value that follows `-b` in a recorded call.
 * @param {{argv: string[]}} call - One recorded call
 * @returns {string|undefined} The buffer name, or undefined when the call named none
 */
function bufferOf(call) {
  const at = call.argv.indexOf('-b');
  return at === -1 ? undefined : call.argv[at + 1];
}

/**
 * The recorded calls for one verb.
 * @param {Array<{verb: string}>} calls - Recorded calls
 * @param {string} verb - tmux verb
 * @returns {Array<object>} The matching calls, in order
 */
function only(calls, verb) {
  return calls.filter((c) => c.verb === verb);
}

describe('sendKeys binds its load and its paste to one buffer name (#2173)', () => {
  let fake = null;
  afterEach(() => {
    if (fake) fake.restore();
    fake = null;
    setConsoleStream(null);
    setLevel('error');
  });

  it('gives both commands the same name, and a different one on every send', () => {
    fake = installRecordingTmux();
    tmux.sendKeys('some-session', 'first', { enterDelay: 1 });
    tmux.sendKeys('some-session', 'second', { enterDelay: 1 });

    const calls = fake.calls();
    const loads = only(calls, 'load-buffer');
    const pastes = only(calls, 'paste-buffer');
    assert.equal(loads.length, 2);
    assert.equal(pastes.length, 2);
    // THE MUTATION THIS CATCHES: either command losing its `-b`, or the two
    // being handed different names. Each alone restores the unnamed race.
    for (const i of [0, 1]) {
      assert.match(bufferOf(loads[i]), BUFFER_NAME, 'the load names its buffer');
      assert.equal(bufferOf(pastes[i]), bufferOf(loads[i]), 'the paste takes the buffer this send loaded');
    }
    assert.notEqual(bufferOf(loads[0]), bufferOf(loads[1]), 'a name is drawn per send, not per process');
  });

  it('keeps the paste flags and the exact target: -p, then -t, then -d, then the name', () => {
    fake = installRecordingTmux();
    tmux.sendKeys('some-session', 'text', { enterDelay: 1 });
    const [paste] = only(fake.calls(), 'paste-buffer');
    assert.deepEqual(paste.argv, ['paste-buffer', '-p', '-t', '=some-session:', '-d', '-b', bufferOf(paste)]);
  });

  it('clears the prompt before the load and sends Enter after the paste', () => {
    fake = installRecordingTmux();
    tmux.sendKeys('some-session', 'text', { enterDelay: 1 });
    const verbs = fake.calls().map((c) => (c.verb === 'send-keys' ? `send-keys ${c.argv[c.argv.length - 1]}` : c.verb));
    const clear = verbs.indexOf('send-keys C-u');
    const load = verbs.indexOf('load-buffer');
    const paste = verbs.indexOf('paste-buffer');
    const enter = verbs.indexOf('send-keys Enter');
    assert.ok(clear !== -1 && clear < load, `the prompt is cleared before the load, got: ${verbs.join(', ')}`);
    assert.ok(load < paste && paste < enter, `load, paste, Enter in that order, got: ${verbs.join(', ')}`);
    assert.equal(enter, verbs.length - 1, 'Enter is the last thing sent');
  });

  it('sends no Enter when enter is false', () => {
    fake = installRecordingTmux();
    tmux.sendKeys('some-session', 'text', { enter: false });
    const calls = fake.calls();
    assert.equal(only(calls, 'paste-buffer').length, 1);
    assert.ok(!calls.some((c) => c.verb === 'send-keys' && c.argv.includes('Enter')));
  });

  it('hands tmux the text in a private file named for the send, and removes it', () => {
    fake = installRecordingTmux();
    tmux.sendKeys('some-session', 'line one\nline two', { enterDelay: 1 });
    const [load] = only(fake.calls(), 'load-buffer');
    const token = bufferOf(load).slice('tc-send-'.length);
    assert.equal(load.file.path, path.join(os.tmpdir(), `tangleclaw-paste-${token}.tmp`),
      'the file carries the send\'s own token, not the process id');
    assert.equal(load.file.mode, 0o600, 'the file holds a prompt; only this user may read it');
    assert.equal(load.file.text, 'line one\nline two');
    assert.ok(!fs.existsSync(load.file.path), 'the file is removed once tmux has read it');
  });

  it('refuses a path that already exists, and leaves that file alone', () => {
    // The file is created exclusively. Exercised through the load step with
    // the random source pinned, because a real collision cannot be arranged.
    const crypto = require('node:crypto');
    const realRandomBytes = crypto.randomBytes;
    const fixed = Buffer.alloc(16, 0xab);
    const squatted = path.join(os.tmpdir(), `tangleclaw-paste-${fixed.toString('hex')}.tmp`);
    fake = installRecordingTmux();
    fs.writeFileSync(squatted, 'not ours');
    crypto.randomBytes = () => fixed;
    try {
      assert.throws(() => tmux._loadPasteBuffer('ours'), /EEXIST/);
      assert.equal(fs.readFileSync(squatted, 'utf8'), 'not ours', 'a file this send did not create is not written to');
      assert.ok(fs.existsSync(squatted), 'and is not removed');
      assert.equal(only(fake.calls(), 'load-buffer').length, 0, 'nothing is loaded from a file that is not ours');
    } finally {
      crypto.randomBytes = realRandomBytes;
      fs.rmSync(squatted, { force: true });
    }
  });

  it('refuses empty text before touching the prompt, and sends nothing', () => {
    fake = installRecordingTmux();
    assert.throws(() => tmux.sendKeys('some-session', ''), /empty text/);
    // THE MUTATION THIS CATCHES: the check moved below the prompt clear. tmux
    // loads an empty file without error and creates no buffer, so a send that
    // got as far as the paste would have nothing of its own to deliver.
    assert.deepEqual(fake.calls().filter((c) => c.verb !== 'has-session'), [],
      'no clear, no load, no paste, no Enter');
  });

  it('delivers whitespace as given: it is text, not an empty send', () => {
    fake = installRecordingTmux();
    tmux.sendKeys('some-session', ' \n', { enterDelay: 1 });
    const calls = fake.calls();
    assert.equal(only(calls, 'load-buffer')[0].file.text, ' \n');
    assert.equal(only(calls, 'paste-buffer').length, 1);
  });

  it('deletes exactly its own buffer when the paste fails, and reports the paste failure', () => {
    fake = installRecordingTmux({ fail: ['paste-buffer'] });
    assert.throws(() => tmux.sendKeys('some-session', 'text', { enterDelay: 1 }), /paste-buffer/,
      'the error is the paste\'s own, not the cleanup\'s');
    const calls = fake.calls();
    const [load] = only(calls, 'load-buffer');
    const pastes = only(calls, 'paste-buffer');
    const deletes = only(calls, 'delete-buffer');
    // THE MUTATION THIS CATCHES: a retry against the unnamed buffer. One paste
    // is attempted; a second would deliver the operator's copy or another
    // sender's text.
    assert.equal(pastes.length, 1, 'the paste is attempted once and never retried');
    assert.deepEqual(deletes.map((d) => d.argv), [['delete-buffer', '-b', bufferOf(load)]],
      'one delete, of the one name this send loaded');
    assert.ok(!calls.some((c) => c.verb === 'send-keys' && c.argv.includes('Enter')),
      'no Enter follows a paste that failed');
  });

  it('deletes its own buffer when the load fails, and never pastes', () => {
    fake = installRecordingTmux({ fail: ['load-buffer'] });
    assert.throws(() => tmux.sendKeys('some-session', 'text', { enterDelay: 1 }), /load-buffer/);
    const calls = fake.calls();
    const [load] = only(calls, 'load-buffer');
    assert.deepEqual(only(calls, 'delete-buffer').map((d) => d.argv), [['delete-buffer', '-b', bufferOf(load)]]);
    assert.equal(only(calls, 'paste-buffer').length, 0);
    assert.ok(!fs.existsSync(load.file.path), 'the file is removed on the failure path too');
  });

  it('deletes its own buffer when the load times out, and reports the timeout', () => {
    // A load that timed out may still have reached the server, so the name is
    // deleted although nothing confirmed it was created.
    fake = installRecordingTmux({ stall: ['load-buffer'] });
    assert.throws(() => tmux.sendKeys('some-session', 'text', { enterDelay: 1 }),
      (err) => err.tcTimedOut === true && /timed out/.test(err.message));
    const calls = fake.calls();
    const [load] = only(calls, 'load-buffer');
    assert.deepEqual(only(calls, 'delete-buffer').map((d) => d.argv), [['delete-buffer', '-b', bufferOf(load)]]);
    assert.equal(only(calls, 'paste-buffer').length, 0);
  });

  it('a cleanup that itself fails does not replace the error being reported', () => {
    fake = installRecordingTmux({ fail: ['paste-buffer', 'delete-buffer'] });
    assert.throws(() => tmux.sendKeys('some-session', 'text', { enterDelay: 1 }), /paste-buffer/);
  });

  it('puts the text in no command, no error and no log line', () => {
    const marker = 'PAYLOAD-MARKER-2173';
    const logged = [];
    setLevel('debug');
    setConsoleStream({ write: (chunk) => { logged.push(String(chunk)); return true; } });

    fake = installRecordingTmux();
    tmux.sendKeys('some-session', marker, { enterDelay: 1 });
    const okCalls = fake.calls();
    fake.restore();

    fake = installRecordingTmux({ fail: ['paste-buffer'] });
    let thrown = null;
    try { tmux.sendKeys('some-session', marker, { enterDelay: 1 }); } catch (err) { thrown = err; }
    const failCalls = fake.calls();

    assert.ok(thrown, 'the failing send throws');
    assert.ok(!`${thrown.message}\n${thrown.stack}`.includes(marker), 'the error does not carry the text');
    for (const call of [...okCalls, ...failCalls]) {
      assert.ok(!call.argv.join(' ').includes(marker), `the text is on no command line, got: ${call.verb}`);
    }
    assert.ok(logged.length > 0, 'the send logs something at debug, so an empty log is not what passes this');
    assert.ok(!logged.join('').includes(marker), 'no log line carries the text');
  });

  it('names the buffer in both command strings from one variable (source pin)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tmux.js'), 'utf8');
    assert.match(source, /tmux load-buffer -b \$\{_escapeArg\(bufferName\)\} /,
      'the load must name its buffer, shell-escaped');
    assert.match(source, /tmux paste-buffer -p -t \$\{_target\(session\)\} -d -b \$\{_escapeArg\(bufferName\)\}/,
      'the paste must name the same buffer, shell-escaped, after the flags #75 and #438 pin');
    assert.doesNotMatch(source, /tmux load-buffer \$\{/, 'no load without a name');
    assert.doesNotMatch(source, /tmux paste-buffer[^`\n]*-d`/, 'no paste without a name');
  });
});

// ── A real tmux server, private to this file ──

describe('named delivery buffers on a real tmux server (#2173)', () => {
  const saved = { TMUX: process.env.TMUX, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
  let root = null;
  // The private server's socket, set only once tmux has been seen answering
  // from it. Teardown stops the server at this path and no other.
  let privateSocket = null;

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
   * Start a pane that writes the first `lines` lines it receives to a file,
   * then signals a tmux channel. The test blocks on that channel, so nothing
   * here waits a fixed time; tmux keeps a signal sent before the wait.
   *
   * @param {string} label - What the pane is for
   * @param {number} lines - How many lines to take
   * @returns {{name: string, received: () => string}} The session, and a reader that blocks until the lines arrived
   */
  function startReader(label, lines) {
    const name = uniqueSessionName(label);
    const out = path.join(root, `${name}.out`);
    const channel = `done-${name}`;
    assert.ok(privateSocket, 'the private tmux server was not established; refusing to start a session');
    execFileSync('tmux', ['-S', privateSocket, 'new-session', '-d', '-s', name, '-x', '200', '-y', '50',
      `head -n ${lines} > '${out}'; tmux wait-for -S '${channel}'; exec sleep 600`], { timeout: 10000 });
    return {
      name,
      received: () => {
        t(['wait-for', channel]);
        return fs.readFileSync(out, 'utf8');
      }
    };
  }

  /**
   * The names of the buffers on the private server.
   * @returns {string[]} Buffer names, newest first
   */
  function bufferNames() {
    return t(['list-buffers', '-F', '#{buffer_name}']).split('\n').filter(Boolean);
  }

  before(() => {
    root = fs.mkdtempSync('/tmp/tc-2173-');
    delete process.env.TMUX;
    process.env.TMUX_TMPDIR = root;
    // Proven before any test relies on it: the server this process reaches is
    // the one under `root`. A pane on the host's own server would otherwise
    // receive this file's pastes.
    // `-f /dev/null`: this call starts the server, and the operator's own
    // tmux config, hooks and plugins have no place in it.
    const probe = uniqueSessionName('isolation-probe');
    execFileSync('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', probe, 'exec sleep 600'], { timeout: 10000 });
    const socket = execFileSync('tmux', ['display-message', '-p', '-t', `=${probe}:`, '#{socket_path}'],
      { encoding: 'utf8', timeout: 10000 }).trim();
    if (!fs.realpathSync(socket).startsWith(fs.realpathSync(root) + path.sep)) {
      // Not ours. Take back the one session just started there, by its exact
      // name, and stop: nothing below may run against that server.
      try { execFileSync('tmux', ['kill-session', '-t', `=${probe}`], { timeout: 10000, stdio: 'ignore' }); } catch (_) { /* gone */ }
      assert.fail(`the test server must be private to this file, but tmux answered from ${socket}`);
    }
    privateSocket = socket;
  });

  after(() => {
    // Only a server proven private is stopped, and by its socket path. `after`
    // runs even when `before` threw, and a bare kill-server at that point
    // would go to whichever server the environment names.
    if (privateSocket) {
      try { t(['kill-server']); } catch (_) { /* already gone */ }
    }
    if (saved.TMUX === undefined) delete process.env.TMUX; else process.env.TMUX = saved.TMUX;
    if (saved.TMUX_TMPDIR === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = saved.TMUX_TMPDIR;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    if (!privateSocket) return;
    for (const leftover of bufferNames()) t(['delete-buffer', '-b', leftover]);
  });

  for (const order of [['a', 'b'], ['b', 'a']]) {
    it(`two senders that both load before either pastes each reach their own pane (paste order ${order.join(', ')})`, () => {
      // The order is set by the calls below, so the interleaving that the
      // unnamed form loses is the one that always runs here.
      const panes = { a: startReader('interleave-a', 1), b: startReader('interleave-b', 1) };
      const names = { a: tmux._loadPasteBuffer('text for pane A\n'), b: tmux._loadPasteBuffer('text for pane B\n') };
      assert.notEqual(names.a, names.b);

      for (const who of order) tmux._pasteNamedBuffer(panes[who].name, names[who]);

      assert.equal(panes.a.received(), 'text for pane A\n');
      assert.equal(panes.b.received(), 'text for pane B\n');
      assert.deepEqual(bufferNames(), [], 'both buffers are deleted by their own paste');
    });
  }

  it('delivers a multi-line send line by line, with Enter ending the last line', () => {
    const pane = startReader('multiline', 3);
    tmux.sendKeys(pane.name, 'first line\nsecond line\nthird line', { enterDelay: 1 });
    assert.equal(pane.received(), 'first line\nsecond line\nthird line\n');
  });

  it('leaves the operator\'s copied text as the newest buffer, and no buffer of its own', () => {
    const pane = startReader('deletion', 1);
    t(['set-buffer', 'what the operator copied']);
    tmux.sendKeys(pane.name, 'a delivery', { enterDelay: 1 });
    assert.equal(pane.received(), 'a delivery\n');
    assert.deepEqual(bufferNames().filter((n) => n.startsWith('tc-send-')), [], 'the delivery buffer is gone');
    assert.deepEqual(tmux.readNewestBuffer(), { ok: true, text: 'what the operator copied' },
      'the Copy button still reads the operator\'s selection (#438)');
  });

  it('a delivery buffer is never the newest one while it exists', () => {
    // Between the load and the paste the buffer is on the server. An unnamed
    // read must still see the operator's copy, not the delivery in flight.
    t(['set-buffer', 'what the operator copied']);
    const inFlight = tmux._loadPasteBuffer('a delivery in flight');
    try {
      assert.ok(bufferNames().includes(inFlight));
      assert.equal(tmux.readNewestBuffer().text, 'what the operator copied');
    } finally {
      t(['delete-buffer', '-b', inFlight]);
    }
  });

  it('a paste that fails removes its buffer and pastes nothing in its place', () => {
    const pane = startReader('failure', 1);
    t(['set-buffer', 'what the operator copied']);
    const undelivered = tmux._loadPasteBuffer('never delivered');
    const gone = uniqueSessionName('no-such-session');

    assert.throws(() => tmux._pasteNamedBuffer(gone, undelivered));

    assert.deepEqual(bufferNames().filter((n) => n.startsWith('tc-send-')), [], 'the failed send\'s buffer is deleted');
    assert.equal(tmux.readNewestBuffer().text, 'what the operator copied', 'the operator\'s buffer is untouched');
    // The pane has received nothing: the next thing sent is the first line it sees.
    tmux.sendKeys(pane.name, 'the only line', { enterDelay: 1 });
    assert.equal(pane.received(), 'the only line\n');
  });

  it('an empty send leaves the pane and the operator\'s buffer as they were', () => {
    // tmux creates no buffer from an empty file, so a paste that named none
    // would take, and delete, the operator's.
    const pane = startReader('empty', 1);
    t(['set-buffer', 'what the operator copied']);

    assert.throws(() => tmux.sendKeys(pane.name, ''), /empty text/);

    assert.equal(tmux.readNewestBuffer().text, 'what the operator copied');
    tmux.sendKeys(pane.name, 'the only line', { enterDelay: 1 });
    assert.equal(pane.received(), 'the only line\n');
  });
});
