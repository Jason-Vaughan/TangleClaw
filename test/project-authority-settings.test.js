'use strict';

/*
 * `lib/project-authority-settings.js` — the #1982 configuration-authority
 * audit (Ruling A491-W1D-R3).
 *
 * `launchSequence.recoveryMode`'s own resolution/discrepancy behavior is
 * already pinned by `test/project-recovery-state.test.js` through
 * `resolveRecoveryMode` directly; this file does not re-test that. It tests
 * what THIS module adds: that `recoveryMode` delegates to `resolveRecoveryMode`
 * verbatim (no second resolver, no duplicated schema), that every OTHER
 * setting is classified `project-owned` and read straight through, and that
 * the classification itself matches `server.js`'s real admission logic —
 * verified against the live code before writing this module (#1982), not
 * assumed from the issue or a dispatch's example list.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const pas = require('../lib/project-authority-settings');
const projectConfig = require('../lib/project-config');

const PINNED = { pinnedMode: 'operator', pinnedAt: '2026-10-06 00:00:00', pinnedBy: 'operator' };
const CHOSEN_ADVISORY = { pinnedMode: null, pinnedAt: '2026-10-06 00:00:00', pinnedBy: 'operator' };

describe('lib/project-authority-settings — AUTHORITY_TIERS and OPERATOR_AUTHORITY_SETTINGS (#1982)', () => {
  it('classifies launchSequence.recoveryMode, and only it, as operator-pinned', () => {
    const pinnedKeys = Object.entries(pas.OPERATOR_AUTHORITY_SETTINGS)
      .filter(([, entry]) => entry.tier === pas.AUTHORITY_TIERS.OPERATOR_PINNED)
      .map(([key]) => key);
    assert.deepEqual(pinnedKeys, ['launchSequence.recoveryMode']);
  });

  it('classifies every other DEFAULT_PROJECT_CONFIG top-level setting as project-owned — verified against server.js, which gates only a rename and recoveryMode to the operator', () => {
    const topLevelKeys = Object.keys(projectConfig.DEFAULT_PROJECT_CONFIG).filter((k) => k !== 'rules' && k !== 'launchSequence');
    for (const key of topLevelKeys) {
      assert.equal(pas.authorityTierOf(key), pas.AUTHORITY_TIERS.PROJECT_OWNED, `${key} must be classified project-owned`);
    }
  });

  it('covers every DEFAULT_PROJECT_CONFIG top-level setting plus the launchSequence siblings and rules.extensions — nothing silently unaudited', () => {
    const topLevelKeys = Object.keys(projectConfig.DEFAULT_PROJECT_CONFIG).filter((k) => k !== 'rules' && k !== 'launchSequence');
    const covered = new Set(Object.keys(pas.OPERATOR_AUTHORITY_SETTINGS));
    for (const key of topLevelKeys) assert.ok(covered.has(key), `${key} must appear in OPERATOR_AUTHORITY_SETTINGS`);
    for (const key of ['launchSequence.pasteRules', 'launchSequence.unreadyWindowMinutes', 'launchSequence.recoveryMode', 'rules.extensions']) {
      assert.ok(covered.has(key), `${key} must appear in OPERATOR_AUTHORITY_SETTINGS`);
    }
  });

  it('acceptFolderTrust, defaultLaunchMode, showLaunchModePicker, and releaseMode are project-owned, not operator-gated — correcting a dispatch assumption against the real admission logic', () => {
    // These four were initially named "operator-PATCH-gated" in a dispatch;
    // server.js's PATCH /api/projects/:name admits every one of them through
    // ownProjectCaller, the same as any other project-owned setting. Only a
    // rename and launchSequence.recoveryMode go through operatorProjectCaller.
    for (const key of ['acceptFolderTrust', 'defaultLaunchMode', 'showLaunchModePicker', 'releaseMode']) {
      assert.equal(pas.authorityTierOf(key), pas.AUTHORITY_TIERS.PROJECT_OWNED, key);
    }
  });

  it('authorityTierOf returns null for a key this audit does not cover', () => {
    assert.equal(pas.authorityTierOf('not-a-real-setting'), null);
    assert.equal(pas.authorityTierOf('rules.core'), null, 'rules.core is framework-forced, not a settings tier — see the module doc comment');
  });
});

describe('lib/project-authority-settings — resolveProjectAuthoritySettings (#1982)', () => {
  it('delegates launchSequence.recoveryMode to resolveRecoveryMode verbatim — no second resolver, no duplicated schema', () => {
    const projConfig = { launchSequence: { recoveryMode: 'operator' } };
    const resolved = pas.resolveProjectAuthoritySettings(projConfig, PINNED, {});
    const direct = projectConfig.resolveRecoveryMode(projConfig, PINNED, {});
    assert.deepEqual(
      { value: resolved['launchSequence.recoveryMode'].value, source: resolved['launchSequence.recoveryMode'].source },
      { value: direct.mode, source: direct.source }
    );
  });

  it('reads a project-owned setting straight from the loaded config, with no authority resolution of its own', () => {
    const projConfig = { acceptFolderTrust: true, releaseMode: 'agent' };
    const resolved = pas.resolveProjectAuthoritySettings(projConfig, null, {});
    assert.deepEqual(resolved.acceptFolderTrust, { tier: pas.AUTHORITY_TIERS.PROJECT_OWNED, value: true });
    assert.deepEqual(resolved.releaseMode, { tier: pas.AUTHORITY_TIERS.PROJECT_OWNED, value: 'agent' });
  });

  it('reads a project-owned launchSequence sibling (pasteRules) by its nested path, distinct from recoveryMode', () => {
    const projConfig = { launchSequence: { pasteRules: 'paste', recoveryMode: 'operator' } };
    const resolved = pas.resolveProjectAuthoritySettings(projConfig, PINNED, {});
    assert.deepEqual(resolved['launchSequence.pasteRules'], { tier: pas.AUTHORITY_TIERS.PROJECT_OWNED, value: 'paste' });
  });

  it('a missing or malformed projConfig resolves project-owned settings to undefined rather than throwing', () => {
    assert.doesNotThrow(() => pas.resolveProjectAuthoritySettings(null, null, {}));
    assert.doesNotThrow(() => pas.resolveProjectAuthoritySettings(undefined, null, {}));
    const resolved = pas.resolveProjectAuthoritySettings(null, null, {});
    assert.equal(resolved.acceptFolderTrust.value, undefined);
  });
});

describe('lib/project-authority-settings — detectAuthorityDiscrepancy (#1982)', () => {
  it('reports no discrepancy when the file agrees with the pin', () => {
    assert.deepEqual(pas.detectAuthorityDiscrepancy({ launchSequence: { recoveryMode: 'operator' } }, PINNED, {}), []);
  });

  it('reports no discrepancy at all when no decision is on record — nothing for an unpinned file to disagree with', () => {
    assert.deepEqual(pas.detectAuthorityDiscrepancy({}, null, {}), []);
    assert.deepEqual(pas.detectAuthorityDiscrepancy({ launchSequence: { recoveryMode: 'advisory' } }, null, {}), []);
  });

  it('reports the recoveryMode discrepancy resolveRecoveryMode itself would report — never invents its own wording', () => {
    const projConfig = { launchSequence: { recoveryMode: 'advisory' } };
    const discrepancies = pas.detectAuthorityDiscrepancy(projConfig, PINNED, {});
    const direct = projectConfig.resolveRecoveryMode(projConfig, PINNED, {});
    assert.deepEqual(discrepancies, [direct.discrepancy]);
    assert.equal(discrepancies.length, 1);
  });

  it('a project-owned setting never produces a discrepancy — there is no operator decision for it to disagree with', () => {
    const discrepancies = pas.detectAuthorityDiscrepancy({ acceptFolderTrust: true, releaseMode: 'agent' }, null, {});
    assert.deepEqual(discrepancies, []);
  });

  it('reflects a chosen-advisory pin disagreeing with a stale operator-mode file, same as resolveRecoveryMode would', () => {
    const projConfig = { launchSequence: { recoveryMode: 'operator' } };
    const discrepancies = pas.detectAuthorityDiscrepancy(projConfig, CHOSEN_ADVISORY, {});
    const direct = projectConfig.resolveRecoveryMode(projConfig, CHOSEN_ADVISORY, {});
    assert.deepEqual(discrepancies, [direct.discrepancy]);
  });
});
