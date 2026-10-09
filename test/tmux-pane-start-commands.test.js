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
    assert.equal(calls[0].args[0], 'list-panes');
    assert.ok(calls[0].args.includes('-a'));
    assert.match(calls[0].args[calls[0].args.indexOf('-F') + 1], /#\{session_name\}.*#\{pane_start_command\}/);
    assert.equal(calls[0].opts.timeout, 1234);
  });

  it('groups the panes that have a start command by session, and leaves out the ones that have none', async () => {
    fakeTmux(() => ({
      stdout: [
        'alpha\t"export PATH=\\"/x/bin:\\$PATH\\"; claude"',
        'alpha\t',
        'beta\ttop',
        'beta\t"sleep 30"',
        'gamma\t'
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
    fakeTmux(() => ({ stdout: 'alpha\t"a\\nb"\n' }));
    const read = await tmux.listPaneStartCommands();
    assert.deepEqual(read.sessions.get('alpha'), [null]);
  });

  it('splits on the first tab only, so a command holding one cannot be cut into a different command', async () => {
    fakeTmux(() => ({ stdout: 'alpha\ttop\textra\n' }));
    const read = await tmux.listPaneStartCommands();
    assert.deepEqual(read.sessions.get('alpha'), ['top\textra']);
  });

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
