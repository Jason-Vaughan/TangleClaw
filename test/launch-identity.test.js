'use strict';

/*
 * The launch identity variables (#2268): the list every launch decides, held
 * equal to the list `tc` compares between a shell and its pane, and the one
 * question asked of a launch's environment entries: which of them it leaves
 * undecided. And the report made once at server start of any that tmux's
 * global environment holds, run here against a stubbed read.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const launchIdentity = require('../lib/launch-identity');
const verbs = require('../lib/tc-verbs');

const { LAUNCH_IDENTITY_KEYS, undecidedIdentityKeys, reportGlobalIdentity } = launchIdentity;

describe('launch identity variables (#2268)', () => {
  it('are the variables tc compares between a shell and its pane, in the same order', () => {
    // Two lists, one fact. A variable tc compares and no launch decides is the
    // defect; a variable a launch decides and tc ignores is a check that lapsed.
    assert.deepEqual([...LAUNCH_IDENTITY_KEYS], [...verbs.PANE_IDENTITY_KEYS]);
  });

  it('cannot be changed by a caller', () => {
    assert.ok(Object.isFrozen(LAUNCH_IDENTITY_KEYS));
    assert.throws(() => { LAUNCH_IDENTITY_KEYS.push('TANGLECLAW_OTHER'); }, TypeError);
  });

  it('exports the list and the two functions, and nothing else', () => {
    assert.deepEqual(Object.keys(launchIdentity).sort(), ['LAUNCH_IDENTITY_KEYS', 'reportGlobalIdentity', 'undecidedIdentityKeys']);
  });
});

describe('undecidedIdentityKeys (#2268)', () => {
  it('names what a project launch leaves undecided: the role, and the workspace id with the switchboard off', () => {
    assert.deepEqual(
      undecidedIdentityKeys({ TANGLECLAW_LAUNCH_ID: 'L-1', TANGLECLAW_PROJECT_ID: '14', PATH: '/usr/bin' }),
      ['TANGLECLAW_ROLE', 'TANGLECLAW_WORKSPACE_ID']
    );
    assert.deepEqual(
      undecidedIdentityKeys({ TANGLECLAW_LAUNCH_ID: 'L-1', TANGLECLAW_PROJECT_ID: '14', TANGLECLAW_WORKSPACE_ID: 'p-1234' }),
      ['TANGLECLAW_ROLE']
    );
  });

  it('names what a Project Master launch leaves undecided: the project id', () => {
    assert.deepEqual(
      undecidedIdentityKeys({ TANGLECLAW_LAUNCH_ID: 'L-m', TANGLECLAW_ROLE: 'master', TANGLECLAW_WORKSPACE_ID: 'master-1234' }),
      ['TANGLECLAW_PROJECT_ID']
    );
  });

  it('names none when every one is given', () => {
    assert.deepEqual(
      undecidedIdentityKeys({ TANGLECLAW_LAUNCH_ID: 'L', TANGLECLAW_PROJECT_ID: 14, TANGLECLAW_ROLE: 'r', TANGLECLAW_WORKSPACE_ID: 'w' }),
      [],
      'a number is a value: the project id is given as one'
    );
  });

  it('names all of them for a launch that gives no entries at all', () => {
    for (const env of [undefined, null, {}, 'TANGLECLAW_ROLE=master', 7]) {
      assert.deepEqual(undecidedIdentityKeys(env), [...LAUNCH_IDENTITY_KEYS], `for ${JSON.stringify(env)}`);
    }
  });

  it('reads an empty, null or undefined value as not given', () => {
    assert.deepEqual(
      undecidedIdentityKeys({ TANGLECLAW_LAUNCH_ID: '', TANGLECLAW_PROJECT_ID: null, TANGLECLAW_ROLE: undefined, TANGLECLAW_WORKSPACE_ID: 'w' }),
      ['TANGLECLAW_LAUNCH_ID', 'TANGLECLAW_PROJECT_ID', 'TANGLECLAW_ROLE']
    );
  });

  it('reads zero and a blank as values: only the empty string is empty', () => {
    assert.deepEqual(
      undecidedIdentityKeys({ TANGLECLAW_LAUNCH_ID: 'L', TANGLECLAW_PROJECT_ID: 0, TANGLECLAW_ROLE: ' ', TANGLECLAW_WORKSPACE_ID: 'w' }),
      []
    );
  });

  it('answers in the list\'s order whatever order the entries came in', () => {
    assert.deepEqual(undecidedIdentityKeys({ TANGLECLAW_WORKSPACE_ID: 'w', TANGLECLAW_LAUNCH_ID: 'L' }), ['TANGLECLAW_PROJECT_ID', 'TANGLECLAW_ROLE']);
  });
});

describe('reportGlobalIdentity (#2268)', () => {
  const AT = new Date('2026-10-11T22:00:00.000Z');
  // Shaped like a launch id. No stubbed read below returns it in `present`,
  // which holds names; it is planted beside them to show nothing carries it.
  const SECRET = 'L-3f9c2b7e-0d41-4c7a-9b1e-secret';

  /**
   * Run the report with a stubbed read, and collect what it logged and set.
   * @param {function(): *} read - Stands for `tmux.readGlobalIdentityKeys`
   * @returns {{notice: *, returned: *, warnings: Array<{message: string, meta: *}>, sets: number, reads: number}}
   */
  function run(read) {
    const seen = { notice: undefined, warnings: [], sets: 0, reads: 0 };
    seen.returned = reportGlobalIdentity({
      read: () => { seen.reads += 1; return read(); },
      log: { warn: (message, meta) => seen.warnings.push({ message, meta }) },
      setNotice: (notice) => { seen.sets += 1; seen.notice = notice; },
      now: () => AT
    });
    return seen;
  }

  it('logs one warning and sets one notice naming each variable and the command that removes it', () => {
    const seen = run(() => ({ present: ['TANGLECLAW_ROLE', 'TANGLECLAW_LAUNCH_ID'], answered: true, cause: null }));
    assert.equal(seen.reads, 1, 'the environment is read once');
    assert.equal(seen.warnings.length, 1);
    assert.equal(seen.sets, 1);
    assert.deepEqual(seen.notice.variables, ['TANGLECLAW_LAUNCH_ID', 'TANGLECLAW_ROLE'], 'in the list\'s order');
    assert.deepEqual(seen.notice.removeCommands, [
      'tmux set-environment -g -u TANGLECLAW_LAUNCH_ID',
      'tmux set-environment -g -u TANGLECLAW_ROLE'
    ]);
    assert.equal(seen.notice.state, 'found');
    assert.equal(seen.notice.observedAt, '2026-10-11T22:00:00.000Z');
    for (const text of [seen.notice.message, JSON.stringify(seen.warnings[0])]) {
      for (const expected of [...seen.notice.variables, ...seen.notice.removeCommands]) {
        assert.ok(text.includes(expected), `"${expected}" is named in ${text}`);
      }
    }
    assert.match(seen.notice.message, /No pane TangleClaw launches inherits them/);
    assert.match(seen.notice.message, /read once, when the server started/);
    assert.deepEqual(seen.returned, seen.notice);
  });

  it('carries no value, whatever the read hands back beside the names', () => {
    const seen = run(() => ({
      present: ['TANGLECLAW_LAUNCH_ID', SECRET, `TANGLECLAW_LAUNCH_ID=${SECRET}`],
      values: { TANGLECLAW_LAUNCH_ID: SECRET },
      answered: true,
      cause: null
    }));
    assert.deepEqual(seen.notice.variables, ['TANGLECLAW_LAUNCH_ID']);
    assert.ok(!JSON.stringify(seen).includes(SECRET), 'neither the notice nor the warning holds the value');
  });

  for (const [label, read] of [
    ['the environment holds none', () => ({ present: [], answered: true, cause: null })],
    ['there is no tmux server', () => ({ present: [], answered: true, cause: null })],
    ['it holds only variables that are not identity', () => ({ present: ['TANGLECLAW_PORT', 'PATH'], answered: true, cause: null })]
  ]) {
    it(`logs nothing and sets a null notice when ${label}`, () => {
      const seen = run(read);
      assert.deepEqual(seen.warnings, []);
      assert.equal(seen.sets, 1, 'the notice is set, to null: an earlier one must not outlive this read');
      assert.equal(seen.notice, null);
      assert.equal(seen.returned, null);
    });
  }

  it('says "could not check", and never "none", for a read tmux did not answer', () => {
    const seen = run(() => ({ present: [], answered: false, cause: 'read-timed-out' }));
    assert.equal(seen.notice.state, 'could-not-check');
    assert.deepEqual(seen.notice.variables, []);
    assert.deepEqual(seen.notice.removeCommands, []);
    assert.equal(seen.notice.observedAt, '2026-10-11T22:00:00.000Z');
    assert.match(seen.notice.message, /could not check/);
    assert.equal(seen.warnings.length, 1);
    assert.deepEqual(seen.warnings[0].meta, { cause: 'read-timed-out' });
  });

  for (const [label, read] of [
    ['nothing', () => undefined],
    ['null', () => null],
    ['an answer with no "answered"', () => ({ present: ['TANGLECLAW_ROLE'] })]
  ]) {
    it(`does not take ${label} from the read for a clean answer`, () => {
      const seen = run(read);
      assert.equal(seen.notice.state, 'could-not-check');
      assert.equal(seen.warnings.length, 1);
    });
  }

  it('does not let a read that throws escape, and reports it as not checked without the error\'s text', () => {
    const seen = run(() => { throw Object.assign(new Error(`Command failed: TANGLECLAW_LAUNCH_ID=${SECRET}`), { code: 'EBOOM' }); });
    assert.equal(seen.notice.state, 'could-not-check');
    assert.match(seen.notice.message, /could not check/);
    assert.equal(seen.warnings.length, 1);
    assert.deepEqual(seen.warnings[0].meta, { error: 'Error', code: 'EBOOM' });
    assert.ok(!JSON.stringify(seen).includes(SECRET));
  });

  it('does not let a logger or a setter that throws escape either', () => {
    const boom = () => { throw new Error('no'); };
    const found = () => ({ present: ['TANGLECLAW_ROLE'], answered: true, cause: null });
    assert.doesNotThrow(() => reportGlobalIdentity({ read: found, log: { warn: boom }, setNotice: () => {} }));
    assert.doesNotThrow(() => reportGlobalIdentity({ read: found, log: { warn: () => {} }, setNotice: boom }));
    assert.doesNotThrow(() => reportGlobalIdentity({ read: boom, log: { warn: boom }, setNotice: boom }));
  });

  it('stamps the notice with the time of the read when no clock is given', () => {
    const before = Date.now();
    const notice = reportGlobalIdentity({ read: () => ({ present: ['TANGLECLAW_ROLE'], answered: true, cause: null }), log: { warn: () => {} }, setNotice: () => {} });
    const at = new Date(notice.observedAt).getTime();
    assert.ok(at >= before && at <= Date.now());
  });
});
