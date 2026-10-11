'use strict';

/*
 * The launch identity variables (#2268): the list every launch decides, held
 * equal to the list `tc` compares between a shell and its pane, and the one
 * question asked of a launch's environment entries: which of them it leaves
 * undecided.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const launchIdentity = require('../lib/launch-identity');
const verbs = require('../lib/tc-verbs');

const { LAUNCH_IDENTITY_KEYS, undecidedIdentityKeys } = launchIdentity;

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

  it('exports the list and the one function, and nothing else', () => {
    assert.deepEqual(Object.keys(launchIdentity).sort(), ['LAUNCH_IDENTITY_KEYS', 'undecidedIdentityKeys']);
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
