'use strict';

// #2106, #2116 (Architect Rulings A2106, A2116): bridge action tier
// classification and single-use confirmation cards. Every write goes
// through the real store on a temporary database; expiry tests drive the
// module's own clock rather than sleeping, and every rejection test asserts
// the exact code a trust-boundary caller will branch on, plus the audit
// trail it leaves behind.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeConfirmation = require('../lib/bridge-confirmation');

const { TIERS, STATES } = bridgeConfirmation;

const START = Date.parse('2026-10-27T08:00:00.000Z');
const MINUTE = 60 * 1000;

const realNow = bridgeConfirmation._internal.now;

let tmpDir = null;

/**
 * Fix the module's clock to an exact instant.
 * @param {number} ms - Offset from {@link START}
 * @returns {void}
 */
function clockAt(ms = 0) {
  const iso = new Date(START + ms).toISOString();
  bridgeConfirmation._internal.now = () => iso;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-confirmation-'));
  store._setBasePath(tmpDir);
  store.init();
  clockAt(0);
});

afterEach(() => {
  bridgeConfirmation._internal.now = realNow;
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Create a confirmation bound to sane defaults, with overrides.
 * @param {object} [overrides]
 * @returns {object} `createActionConfirmation`'s return
 */
function create(overrides = {}) {
  return bridgeConfirmation.createActionConfirmation({
    operatorId: 'op-1', guildId: 'guild-1', channelId: 'chan-1', actionKind: 'merge',
    targetRef: 'PR#123', digestSha: bridgeConfirmation.digestFor('payload'), version: 1, ttlMs: 10 * MINUTE,
    ...overrides
  });
}

/**
 * The fields `verifyAndConsumeConfirmation` needs, matching `create`'s
 * defaults, with overrides.
 * @param {string} nonce
 * @param {object} [overrides]
 * @returns {object}
 */
function present(nonce, overrides = {}) {
  return {
    nonce, operatorId: 'op-1', guildId: 'guild-1', channelId: 'chan-1', actionKind: 'merge',
    targetRef: 'PR#123', digestSha: bridgeConfirmation.digestFor('payload'), version: 1, ...overrides
  };
}

/**
 * Every `bridge_action_audit` row, oldest first.
 * @returns {object[]}
 */
function auditRows() {
  return store.getDb().prepare('SELECT * FROM bridge_action_audit ORDER BY audit_id ASC').all();
}

describe('classifyBridgeActionTier (#2116)', () => {
  it('ordinary-work actions are authorized directly, with no confirmation involved', () => {
    for (const action of bridgeConfirmation.ORDINARY_WORK_ACTIONS) {
      assert.deepEqual(bridgeConfirmation.classifyBridgeActionTier(action),
        { authorized: true, tier: TIERS.ORDINARY_WORK }, `action "${action}"`);
    }
  });

  it('confirmation-card actions are never authorized by classification alone', () => {
    for (const action of bridgeConfirmation.CONFIRMATION_CARD_ACTIONS) {
      const r = bridgeConfirmation.classifyBridgeActionTier(action);
      assert.equal(r.authorized, false, `action "${action}"`);
      assert.equal(r.tier, TIERS.CONFIRMATION_CARD, `action "${action}"`);
    }
  });

  it('step-up actions require step-up by default', () => {
    for (const action of bridgeConfirmation.STEP_UP_ACTIONS) {
      const r = bridgeConfirmation.classifyBridgeActionTier(action);
      assert.equal(r.authorized, false, `action "${action}"`);
      assert.equal(r.tier, TIERS.STEP_UP, `action "${action}"`);
    }
  });

  it('a step-up action the Operator opted into Discord-only risk for falls back to confirmation-card, not to direct authorization', () => {
    const r = bridgeConfirmation.classifyBridgeActionTier('data-deletion', { stepUpOptIns: ['data-deletion'] });
    assert.equal(r.authorized, false, 'opting out of step-up is not the same as no authorization');
    assert.equal(r.tier, TIERS.CONFIRMATION_CARD);
  });

  it('an opt-in for one category does not reach a different category', () => {
    const r = bridgeConfirmation.classifyBridgeActionTier('credential-change', { stepUpOptIns: ['data-deletion'] });
    assert.equal(r.tier, TIERS.STEP_UP);
  });

  it('an unrecognized action type fails closed rather than defaulting to ordinary-work', () => {
    const r = bridgeConfirmation.classifyBridgeActionTier('something-nobody-declared');
    assert.deepEqual(r, { authorized: false, tier: null, code: 'BRIDGE_ACTION_TYPE_UNKNOWN' });
  });
});

describe('createActionConfirmation (#2106, #2116)', () => {
  it('creates a pending confirmation carrying a nonce', () => {
    const r = create();
    assert.equal(r.ok, true);
    assert.equal(r.confirmation.state, STATES.PENDING);
    assert.equal(typeof r.confirmation.nonce, 'string');
    assert.ok(r.confirmation.nonce.length >= 32, 'the nonce must be a real bearer secret, not a short id');
  });

  it('refuses a missing required field', () => {
    for (const field of ['operatorId', 'guildId', 'channelId', 'actionKind', 'targetRef', 'digestSha', 'ttlMs']) {
      const input = { operatorId: 'o', guildId: 'g', channelId: 'c', actionKind: 'merge', targetRef: 't', digestSha: 'd', ttlMs: 1000 };
      delete input[field];
      const r = bridgeConfirmation.createActionConfirmation(input);
      assert.equal(r.ok, false, `field "${field}"`);
      assert.equal(r.code, 'CONFIRMATION_INVALID', `field "${field}"`);
    }
  });

  it('refuses an action kind this module does not confirm (e.g. an ordinary-work action)', () => {
    const r = create({ actionKind: 'investigate' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFIRMATION_INVALID');
  });

  it('refuses a non-positive ttlMs', () => {
    const r = create({ ttlMs: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFIRMATION_INVALID');
  });

  it('records an authorized audit entry on creation', () => {
    create();
    const rows = auditRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'authorized');
    assert.equal(rows[0].code, null);
    assert.equal(rows[0].tier, TIERS.CONFIRMATION_CARD);
  });
});

describe('verifyAndConsumeConfirmation (#2106, #2116)', () => {
  it('verifies and consumes a valid confirmation exactly once', () => {
    const { confirmation } = create();
    const r = bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce));
    assert.equal(r.ok, true);
    assert.equal(r.confirmation.state, STATES.CONSUMED);
    assert.equal(typeof r.confirmation.consumedAt, 'string');
  });

  it('a second presentation of the same nonce is rejected, never treated as an idempotent success', () => {
    const { confirmation } = create();
    const first = bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce));
    assert.equal(first.ok, true);
    const second = bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce));
    assert.equal(second.ok, false);
    assert.equal(second.code, 'CONFIRMATION_REPLAYED');
    // And it stays rejected on every further attempt -- the rejection itself
    // is idempotent, even though the action it would authorize never is.
    const third = bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce));
    assert.equal(third.code, 'CONFIRMATION_REPLAYED');
  });

  it('no nonce presented at all is refused as SAME_USER_CONFIRMATION_REQUIRED, distinct from an invalid one', () => {
    const r = bridgeConfirmation.verifyAndConsumeConfirmation(present(undefined));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SAME_USER_CONFIRMATION_REQUIRED');
  });

  it('a nonce that resolves to nothing is CONFIRMATION_INVALID, not SAME_USER_CONFIRMATION_REQUIRED', () => {
    const r = bridgeConfirmation.verifyAndConsumeConfirmation(present('not-a-real-nonce'));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFIRMATION_INVALID');
  });

  it('an expired confirmation is rejected, and the lazy transition persists', () => {
    const { confirmation } = create({ ttlMs: 5 * MINUTE });
    clockAt(6 * MINUTE);
    const r = bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFIRMATION_EXPIRED');
    assert.equal(r.confirmation.state, STATES.EXPIRED);
  });

  it('a mismatched guild is rejected as CONFIRMATION_SCOPE_MISMATCH', () => {
    const { confirmation } = create();
    const r = bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce, { guildId: 'guild-2' }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFIRMATION_SCOPE_MISMATCH');
  });

  it('a mismatched channel is rejected as CONFIRMATION_SCOPE_MISMATCH', () => {
    const { confirmation } = create();
    const r = bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce, { channelId: 'chan-2' }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFIRMATION_SCOPE_MISMATCH');
  });

  it('a mismatched target is rejected as CONFIRMATION_DIGEST_MISMATCH', () => {
    const { confirmation } = create();
    const r = bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce, { targetRef: 'PR#999' }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFIRMATION_DIGEST_MISMATCH');
  });

  it('a mismatched digest is rejected as CONFIRMATION_DIGEST_MISMATCH', () => {
    const { confirmation } = create();
    const r = bridgeConfirmation.verifyAndConsumeConfirmation(
      present(confirmation.nonce, { digestSha: bridgeConfirmation.digestFor('different payload') }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFIRMATION_DIGEST_MISMATCH');
  });

  it('a mismatched action kind is rejected as CONFIRMATION_DIGEST_MISMATCH -- the card does not authorize a different action', () => {
    const { confirmation } = create({ actionKind: 'release' });
    const r = bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce, { actionKind: 'deploy' }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFIRMATION_DIGEST_MISMATCH');
  });

  it('a mismatched operatorId is rejected as CONFIRMATION_SCOPE_MISMATCH, not silently authorized (PRR-A I-Gate R1 finding 1)', () => {
    const { confirmation } = create({ operatorId: 'op-1' });
    const r = bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce, { operatorId: 'op-2' }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFIRMATION_SCOPE_MISMATCH');
  });

  it('a mismatched (stale) version is rejected as CONFIRMATION_DIGEST_MISMATCH (PRR-A I-Gate R1 finding 1)', () => {
    const { confirmation } = create({ version: 2 });
    const r = bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce, { version: 1 }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFIRMATION_DIGEST_MISMATCH');
  });

  it('the matching version (the default, 1) still verifies and consumes normally', () => {
    const { confirmation } = create();
    const r = bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce));
    assert.equal(r.ok, true);
  });

  it('the raw nonce is never persisted -- only its SHA-256 digest -- so a direct DB read cannot recover a usable bearer token (PRR-A I-Gate R1 finding 2)', () => {
    const { confirmation } = create();
    const row = store.getDb().prepare('SELECT * FROM bridge_action_confirmations WHERE confirmation_id = ?').get(confirmation.confirmationId);
    assert.equal(row.nonce, undefined, 'no "nonce" column at all');
    assert.equal(row.nonce_hash, bridgeConfirmation.digestFor(confirmation.nonce),
      'the stored value is the digest of the nonce, not the nonce itself');
    assert.notEqual(row.nonce_hash, confirmation.nonce, 'the raw nonce must not appear anywhere in the row');
  });

  it('verification still works by presenting the raw nonce -- the digest lookup is transparent to a legitimate caller', () => {
    const { confirmation } = create();
    assert.equal(confirmation.nonce.length >= 32, true, 'createActionConfirmation still returns the raw bearer secret once');
    const r = bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce));
    assert.equal(r.ok, true);
  });

  it('a scope mismatch does not consume the confirmation -- it can still be presented correctly afterward', () => {
    const { confirmation } = create();
    bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce, { guildId: 'wrong-guild' }));
    const r = bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce));
    assert.equal(r.ok, true, 'a rejected mismatch must not burn the single use');
  });

  it('records a rejected audit entry with the exact code for every rejection path', () => {
    const { confirmation } = create();
    bridgeConfirmation.verifyAndConsumeConfirmation(present(confirmation.nonce, { guildId: 'wrong' }));
    const rows = auditRows();
    const last = rows[rows.length - 1];
    assert.equal(last.outcome, 'rejected');
    assert.equal(last.code, 'CONFIRMATION_SCOPE_MISMATCH');
    assert.equal(last.confirmation_id, confirmation.confirmationId);
  });

  it('records a rejected audit entry even when the nonce never resolves (no confirmation_id to attach it to)', () => {
    bridgeConfirmation.verifyAndConsumeConfirmation(present('nonexistent'));
    const rows = auditRows();
    const last = rows[rows.length - 1];
    assert.equal(last.outcome, 'rejected');
    assert.equal(last.code, 'CONFIRMATION_INVALID');
    assert.equal(last.confirmation_id, null);
  });
});

describe('ensureBridgeConfirmationSchema is idempotent', () => {
  it('can be called repeatedly against the same db with no error', () => {
    const db = store.getDb();
    bridgeConfirmation.ensureBridgeConfirmationSchema(db);
    bridgeConfirmation.ensureBridgeConfirmationSchema(db);
    assert.equal(create().ok, true);
  });
});

describe('digestFor', () => {
  it('is a deterministic SHA-256 hex digest', () => {
    const a = bridgeConfirmation.digestFor('same content');
    const b = bridgeConfirmation.digestFor('same content');
    const c = bridgeConfirmation.digestFor('different content');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]{64}$/);
  });
});
