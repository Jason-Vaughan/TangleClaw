'use strict';

/*
 * `tmux.listPaneStartCommands` (#2233): the command each live pane was started
 * with, read for every session in one invocation. The launch-isolation
 * inventory judges these strings, so what is under test is that a command is
 * returned exactly as it was handed to tmux or not at all, and that a tmux
 * which did not answer is never read as "no panes".
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const tmux = require('../lib/tmux');
const logger = require('../lib/logger');
const { uniqueSessionName } = require('./_tmux-session-names');

const saved = { ...tmux._async };

/**
 * Stand a function in for tmux.
 * @param {function(string[]): ({stdout: string}|{error: Error})} answer - What tmux says for these arguments
 * @returns {Array<{bin: string, args: string[], opts: object}>} The calls made
 */
function fakeTmux(answer) {
  const calls = [];
  tmux._async.execFile = (bin, args, opts, cb) => {
    calls.push({ bin, args, opts });
    const said = answer(args);
    setImmediate(() => (said.error ? cb(said.error, '') : cb(null, said.stdout)));
  };
  return calls;
}

afterEach(() => {
  Object.assign(tmux._async, saved);
  logger.setConsoleStream(null);
});

describe('tmux.unquoteStartCommand', () => {
  for (const [label, printed, expected] of [
    ['a command tmux printed bare', 'top', 'top'],
    ['a quoted command', '"claude --dangerously-skip-permissions"', 'claude --dangerously-skip-permissions'],
    ['the three characters tmux escapes inside quotes', '"export PATH=\\"/a b/bin:\\$PATH\\"; x \\\\ y"', 'export PATH="/a b/bin:$PATH"; x \\ y'],
    ['characters tmux leaves alone', '"X=\'q\' sleep 30 ~ ! `x`"', 'X=\'q\' sleep 30 ~ ! `x`'],
    ['a pane with no start command', '', '']
  ]) {
    it(`reads ${label}`, () => {
      assert.equal(tmux.unquoteStartCommand(printed), expected);
    });
  }

  for (const [label, printed] of [
    ['a line break tmux wrote as an escape', '"sleep 30 #\\nnext"'],
    ['a tab tmux wrote as an escape', '"sleep 30;\\techo x"'],
    ['an escape it does not know', '"a\\qb"'],
    ['an opening quote with no closing one', '"sleep 30'],
    ['a quote in the middle of a quoted command', '"a"b"'],
    ['a trailing backslash', '"abc\\"'],
    ['something that is not text', null]
  ]) {
    it(`answers null, never a guess, for ${label}`, () => {
      assert.equal(tmux.unquoteStartCommand(printed), null);
    });
  }
});

describe('tmux.listPaneStartCommands', () => {
  it('asks once for every pane, as arguments and with a bound on the wait', async () => {
    const calls = fakeTmux(() => ({ stdout: '' }));
    await tmux.listPaneStartCommands({ timeout: 1234 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 3), ['-u', 'list-panes', '-a'], 'UTF-8 output is asked for, whatever locale the caller has');
    const format = calls[0].args[calls[0].args.indexOf('-F') + 1];
    assert.equal(format, '#{session_name}:#{pane_start_command}');
    assert.ok(!/[\u0000-\u001f]/.test(format), 'no control character: a tmux client that is not told its output is UTF-8 prints one as an underscore');
    assert.equal(calls[0].opts.timeout, 1234);
  });

  it('groups the panes that have a start command by session, and leaves out the ones that have none', async () => {
    fakeTmux(() => ({
      stdout: [
        'alpha:"export PATH=\\"/x/bin:\\$PATH\\"; claude"',
        'alpha:',
        'beta:top',
        'beta:"sleep 30"',
        'gamma:'
      ].join('\n') + '\n'
    }));
    const read = await tmux.listPaneStartCommands();
    assert.equal(read.answered, true);
    assert.equal(read.cause, null);
    assert.deepEqual([...read.sessions.keys()].sort(), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(read.sessions.get('alpha'), ['export PATH="/x/bin:$PATH"; claude']);
    assert.deepEqual(read.sessions.get('beta'), ['top', 'sleep 30']);
    assert.deepEqual(read.sessions.get('gamma'), [], 'a session whose panes have no start command is still a live session');
  });

  it('keeps a pane whose command it could not read, as null', async () => {
    fakeTmux(() => ({ stdout: 'alpha:"a\\nb"\n' }));
    const read = await tmux.listPaneStartCommands();
    assert.deepEqual(read.sessions.get('alpha'), [null]);
  });

  it('splits on the first colon only, so a command holding one is kept whole', async () => {
    fakeTmux(() => ({ stdout: 'alpha:"codex --remote unix:///tmp/x"\n' }));
    const read = await tmux.listPaneStartCommands();
    assert.deepEqual(read.sessions.get('alpha'), ['codex --remote unix:///tmp/x']);
  });

  for (const [label, stdout] of [
    ['a line with no separator at all', 'alpha:top\nbeta_"sleep 30"\n'],
    ['a line that opens with the separator', ':top\n'],
    ['output where tmux rewrote the separator on every line', 'alpha_"claude"\nbeta_"codex"\n']
  ]) {
    it(`reads ${label} as no answer: a listing it cannot split says nothing about any session`, async () => {
      logger.setConsoleStream({ write: () => {} });
      fakeTmux(() => ({ stdout }));
      const read = await tmux.listPaneStartCommands();
      assert.deepEqual({ answered: read.answered, cause: read.cause, size: read.sessions.size }, { answered: false, cause: 'unparseable', size: 0 });
    });
  }

  for (const said of [
    'no server running on /private/tmp/tmux-501/default',
    'error connecting to /private/tmp/tmux-501/default (No such file or directory)'
  ]) {
    it(`reads "${said.split(' /')[0]}" as an answer: nothing is live`, async () => {
      fakeTmux(() => ({ error: Object.assign(new Error(`Command failed: tmux list-panes -a\n${said}\n`), { code: 1 }) }));
      const read = await tmux.listPaneStartCommands();
      assert.deepEqual({ answered: read.answered, cause: read.cause, size: read.sessions.size }, { answered: true, cause: null, size: 0 });
    });
  }

  for (const said of [
    'protocol version mismatch (client 8, server 7)',
    'error connecting to /private/tmp/tmux-501/default (Permission denied)',
    'lost server',
    ''
  ]) {
    it(`reads any other failure as no answer, never as an empty fleet: "${said}"`, async () => {
      logger.setConsoleStream({ write: () => {} });
      fakeTmux(() => ({ error: Object.assign(new Error(`Command failed: tmux list-panes -a\n${said}\n`), { code: 1 }) }));
      const read = await tmux.listPaneStartCommands();
      assert.deepEqual({ answered: read.answered, cause: read.cause, size: read.sessions.size }, { answered: false, cause: 'tmux-failed', size: 0 });
    });
  }

  it('reads a tmux it had to stop as no answer', async () => {
    logger.setConsoleStream({ write: () => {} });
    fakeTmux(() => ({ error: Object.assign(new Error('timed out'), { killed: true, signal: 'SIGKILL' }) }));
    const read = await tmux.listPaneStartCommands();
    assert.deepEqual({ answered: read.answered, cause: read.cause, size: read.sessions.size }, { answered: false, cause: 'read-timed-out', size: 0 });
  });

  it('reads a tmux that could not be run as no answer', async () => {
    fakeTmux(() => ({ error: Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }) }));
    const read = await tmux.listPaneStartCommands();
    assert.deepEqual({ answered: read.answered, cause: read.cause }, { answered: false, cause: 'tmux-not-run' });
  });
});

describe('tmux.listPaneStartCommands against a real tmux, run as the server runs it', () => {
  const { execFileSync, execFile } = require('node:child_process');
  const socket = `tc-test-panes-${process.pid}`;
  // The server runs under launchd: not in a tmux pane, and with no locale. A
  // tmux client in that state does not take its output to be UTF-8, and prints
  // every control and non-ASCII character as an underscore. A developer's
  // shell usually has a pane, a UTF-8 locale or both, so both are taken away.
  const { TMUX: _tmux, TMUX_PANE: _pane, LANG: _lang, LC_CTYPE: _ctype, ...rest } = process.env;
  const outside = { ...rest, LC_ALL: 'C' };
  let available = true;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  } catch {
    available = false;
  }

  /**
   * Run tmux on this test's own server.
   * @param {string[]} args - tmux arguments
   * @returns {string}
   */
  const onSocket = (args) => execFileSync('tmux', ['-L', socket, ...args], { env: outside, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  it('reads back each session\'s name and exact start command, and a session with none', { skip: available ? false : 'tmux is not installed here' }, async (t) => {
    const wrapped = 'export PATH="/x y/bin:$PATH"; /opt/fake/bin/codex --remote unix:///tmp/codex-daemon/abc --full-auto';
    const accented = '/Users/jos\u00e9/bin/codex --no-daemon; sleep 30';
    // Registered before anything is started, so a start that fails part way leaves no server behind.
    t.after(() => { try { onSocket(['kill-server']); } catch { /* never started, or already gone */ } });
    const first = uniqueSessionName('panes-first');
    const second = uniqueSessionName('panes-second');
    const shell = uniqueSessionName('panes-shell');
    const accent = uniqueSessionName('panes-accent');
    try {
      onSocket(['new-session', '-d', '-s', first, `${wrapped}; sleep 30`]);
      onSocket(['new-session', '-d', '-s', second, 'sleep 30']);
      onSocket(['new-session', '-d', '-s', shell]);
      onSocket(['new-session', '-d', '-s', accent, accented]);
    } catch (err) {
      t.skip(`tmux could not start a server here: ${err.message.split('\n')[0]}`);
      return;
    }
    tmux._async.execFile = (bin, args, opts, cb) => execFile(bin, ['-L', socket, ...args], { ...opts, env: outside }, cb);
    const read = await tmux.listPaneStartCommands();
    // What this tmux printed, for the failure message: its quoting has differed between versions.
    const raw = `${execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim()} printed:\n${onSocket(['-u', 'list-panes', '-a', '-F', '#{session_name}:#{pane_start_command}'])}`;
    assert.deepEqual({ answered: read.answered, cause: read.cause }, { answered: true, cause: null }, raw);
    assert.deepEqual([...read.sessions.keys()].sort(), [accent, first, second, shell].sort(), raw);
    assert.deepEqual(read.sessions.get(accent), [accented], `a character outside ASCII comes back as itself, not as an underscore. ${raw}`);
    assert.deepEqual(read.sessions.get(first), [`${wrapped}; sleep 30`], raw);
    assert.deepEqual(read.sessions.get(second), ['sleep 30'], raw);
    assert.deepEqual(read.sessions.get(shell), [], raw);
  });

  it('reads a socket with no server as an answered empty fleet', { skip: available ? false : 'tmux is not installed here' }, async () => {
    tmux._async.execFile = (bin, args, opts, cb) => execFile(bin, ['-L', `${socket}-none`, ...args], { ...opts, env: outside }, cb);
    const read = await tmux.listPaneStartCommands();
    assert.deepEqual({ answered: read.answered, cause: read.cause, size: read.sessions.size }, { answered: true, cause: null, size: 0 });
  });
});
