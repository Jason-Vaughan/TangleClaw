'use strict';

/**
 * The recorded-launch-command judgment lives in a module `tc` can load (#2375).
 *
 * `tc` judges the start command of its own pane. The judgment used to live only
 * in `lib/startup-control-codex.js`, which requires the store, so `tc` loaded it
 * under a wrapper that hid node's `node:sqlite` ExperimentalWarning, and kept a
 * copy of `_withoutPathFloor` because `lib/sessions.js` loads the store too.
 * These tests hold the module to being store-free, hold every caller to its one
 * definition, and keep the behaviour the removed copy was tested for.
 *
 * The store checks run in a FRESH process: this file's own requires load the
 * store, so `require.cache` here would answer about the test run, not about `tc`.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const recorded = require('../lib/recorded-launch-command');
const codex = require('../lib/startup-control-codex');
const sessions = require('../lib/sessions');

const REPO = path.join(__dirname, '..');
const LIB = path.join(REPO, 'lib');

/**
 * Run a script in a fresh node process and parse the JSON its last stdout line prints.
 * @param {string} script - Source for `node -e`.
 * @returns {{seen: object, stderr: string}}
 */
function freshProcess(script) {
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return { seen: JSON.parse(run.stdout.trim().split('\n').pop()), stderr: run.stderr };
}

describe('recorded-launch-command loads no store (#2375)', () => {
  it('requires nothing from lib/ but itself, so it can never reach lib/store.js', () => {
    const { seen } = freshProcess(`
      require(${JSON.stringify(path.join(LIB, 'recorded-launch-command.js'))});
      console.log(JSON.stringify(Object.keys(require.cache).filter((f) => f.startsWith(${JSON.stringify(LIB + path.sep)}))));
    `);
    assert.deepEqual(seen, [path.join(LIB, 'recorded-launch-command.js')]);
  });

  it('tc judges its own pane without loading the store or printing the SQLite warning', () => {
    const { seen, stderr } = freshProcess(`
      const verbs = require(${JSON.stringify(path.join(LIB, 'tc-verbs.js'))});
      const judged = verbs.judgeOwnPaneCommand({ read: 'ok', command: 'export PATH="/x/bin:$PATH"; codex' });
      console.log(JSON.stringify({
        verdict: judged.verdict,
        store: Object.keys(require.cache).includes(${JSON.stringify(path.join(LIB, 'store.js'))}),
        adapter: Object.keys(require.cache).includes(${JSON.stringify(path.join(LIB, 'startup-control-codex.js'))})
      }));
    `);
    assert.deepEqual(seen, { verdict: 'not-isolated', store: false, adapter: false });
    assert.doesNotMatch(stderr, /SQLite|ExperimentalWarning/);
  });
});

describe('every caller judges with the one definition (#2375)', () => {
  it('the Codex adapter re-exports the judgment and the helpers its launch judgment shares', () => {
    assert.equal(codex.judgeRecordedCommand, recorded.judgeRecordedCommand);
    assert.equal(codex._internal._shellWord, recorded._shellWord);
    assert.equal(codex._internal._launchesCodex, recorded._launchesCodex);
    assert.equal(codex._internal.PLAIN_ARGUMENT, recorded.PLAIN_ARGUMENT);
    assert.equal(codex._internal.SAFE_PATH, recorded.SAFE_PATH);
  });

  it('lib/sessions.js re-exports the PATH-floor unwrap', () => {
    assert.equal(sessions._withoutPathFloor, recorded._withoutPathFloor);
  });

  it('answers the judgment as the adapter always has, through the module itself', () => {
    const judge = (command, extra = {}) => recorded.judgeRecordedCommand({ engineId: 'codex', command, ...extra });
    assert.deepEqual(judge('claude --x', { engineId: 'claude' }), { applies: false });
    assert.equal(judge('codex').reasonCode, 'command_not_pinned');
    assert.equal(judge('/opt/bin/codex-wrap --no-daemon').reasonCode, 'executable_unverified');
    assert.equal(judge('/opt/bin/codex --no-daemon --no-daemon').reasonCode, 'command_unparseable');
    assert.equal(judge('/opt/bin/codex --no-daemon $(id)').reasonCode, 'command_unparseable');
    assert.equal(judge('/opt/bin/codex').startedUnisolatedByPath, true);
    assert.deepEqual(
      [judge('/opt/bin/codex --no-daemon').verdict, judge('/opt/bin/codex --no-daemon').basis],
      ['isolated', 'no-daemon']
    );
    const channel = { resolvedSocketPath: '/tmp/s.sock', enginePath: '/opt/bin/codex', engineVersion: '0.156.1' };
    const remote = '/opt/bin/codex --remote unix:///tmp/s.sock';
    assert.equal(judge(remote, { channel, nativeVerifiedVersions: ['0.156.1'] }).basis, 'native-app-server');
    assert.equal(judge(remote, { channel, nativeVerifiedVersions: [] }).reasonCode, 'native_version_unverified');
    assert.equal(judge(remote).reasonCode, 'command_unisolated');
  });
});

describe('the PATH floor comes off exactly as the launch path puts it on (#2228)', () => {
  it('takes off only the exact prefix _withPathFloor writes', () => {
    const cases = [
      ['export PATH="/x/bin:$PATH"; codex', 'codex'],
      ['export PATH="/Users/a b/bin:$PATH"; /opt/bin/codex --no-daemon', '/opt/bin/codex --no-daemon'],
      ['export PATH=":$PATH"; codex', 'codex'],
      ['export PATH="/x/bin:$PATH"; export PATH="/y:$PATH"; codex', 'export PATH="/y:$PATH"; codex'],
      ['export PATH="/x/bin:$PATH";codex', 'export PATH="/x/bin:$PATH";codex'],
      ['export PATH=/x/bin:$PATH; codex', 'export PATH=/x/bin:$PATH; codex'],
      ['export PATH="/x/`id`:$PATH"; codex', 'export PATH="/x/`id`:$PATH"; codex'],
      ['export PATH="/x/$HOME:$PATH"; codex', 'export PATH="/x/$HOME:$PATH"; codex'],
      [' export PATH="/x/bin:$PATH"; codex', ' export PATH="/x/bin:$PATH"; codex'],
      ['codex', 'codex'],
      ['', '']
    ];
    for (const [command, expected] of cases) {
      assert.equal(recorded._withoutPathFloor(command), expected, command);
    }
  });

  it('undoes what lib/sessions.js#_withPathFloor wrote', () => {
    const wrapped = sessions._withPathFloor('codex --no-daemon', '/opt/tc/bin');
    assert.equal(recorded._withoutPathFloor(wrapped), 'codex --no-daemon');
  });
});
