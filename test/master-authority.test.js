'use strict';

/*
 * Project Master's lifecycle-authority gate and scoped API token (#2132,
 * #966), unified on one canonical axis per Architect Ruling A491-W1B-R2:
 * `config.master.accessLevel` (the existing 3-tier #755 field) is the only
 * stored value; the binary `toggleState` `#2132` asks for is derived from
 * it deterministically, never stored as a second, independently-settable
 * field that could disagree with the first.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const serviceToken = require('../lib/service-token');
const masterAuthority = require('../lib/master-authority');

describe('lib/master-authority.js', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-authority-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('TOKEN_PREFIX / generateToken', () => {
    it('generates a high-entropy token under tc_master_, distinct from the fleet service-token prefix', () => {
      assert.equal(masterAuthority.TOKEN_PREFIX, 'tc_master_');
      assert.notEqual(masterAuthority.TOKEN_PREFIX, serviceToken.TOKEN_PREFIX);
      const token = masterAuthority.generateToken();
      assert.ok(token.startsWith('tc_master_'));
      assert.ok(token.length > 40, 'should be high-entropy, not a short literal');
    });

    it('generates a different token on every call', () => {
      assert.notEqual(masterAuthority.generateToken(), masterAuthority.generateToken());
    });
  });

  describe('LIFECYCLE_ACTIONS / isLifecycleAction (#2132 criterion 6)', () => {
    it('covers exactly the table from the issue', () => {
      assert.deepEqual([...masterAuthority.LIFECYCLE_ACTIONS], [
        'register', 'provision',
        'launch', 'relaunch', 'rebind',
        'stop', 'kill',
        'clear', 'wrap', 'drain', 'retire',
        'lease-issue', 'lease-release'
      ]);
    });

    it('is closed — never widens to an action outside the table, and bridge writes stay exempt', () => {
      assert.equal(masterAuthority.isLifecycleAction('register'), true);
      assert.equal(masterAuthority.isLifecycleAction('delete-everything'), false);
      assert.equal(masterAuthority.isLifecycleAction('tc-bridge-write'), false);
    });

    it('rejects malformed input rather than throwing', () => {
      for (const bad of [null, undefined, 42, ['launch']]) assert.equal(masterAuthority.isLifecycleAction(bad), false);
    });
  });

  describe('toggleStateFor (Ruling A491-W1B-R2 mapping)', () => {
    it('maps write to read-write, and both read-only and suggest to read-only', () => {
      assert.equal(masterAuthority.toggleStateFor('write'), 'read-write');
      assert.equal(masterAuthority.toggleStateFor('read-only'), 'read-only');
      assert.equal(masterAuthority.toggleStateFor('suggest'), 'read-only');
    });

    it('fails closed for an unrecognized value', () => {
      assert.equal(masterAuthority.toggleStateFor('bogus'), 'read-only');
      assert.equal(masterAuthority.toggleStateFor(undefined), 'read-only');
    });
  });

  describe('getAuthorityState', () => {
    it('defaults to read-only / read-only / generation 0 for a fresh config', () => {
      const config = store.config.load();
      assert.deepEqual(masterAuthority.getAuthorityState(config), {
        accessLevel: 'read-only', toggleState: 'read-only', generation: 0, updatedAt: null, updatedBy: null
      });
    });

    it('fails closed for malformed or absent config.master, never throwing', () => {
      assert.equal(masterAuthority.getAuthorityState(null).toggleState, 'read-only');
      assert.equal(masterAuthority.getAuthorityState({}).toggleState, 'read-only');
      assert.equal(masterAuthority.getAuthorityState({ master: 'not-an-object' }).toggleState, 'read-only');
      assert.equal(masterAuthority.getAuthorityState({ master: { accessLevel: 'nonsense-tier' } }).toggleState, 'read-only');
    });

    it('reads a negative or non-integer lifecycleGeneration as 0 rather than trusting it', () => {
      assert.equal(masterAuthority.getAuthorityState({ master: { lifecycleGeneration: -1 } }).generation, 0);
      assert.equal(masterAuthority.getAuthorityState({ master: { lifecycleGeneration: 1.5 } }).generation, 0);
      assert.equal(masterAuthority.getAuthorityState({ master: { lifecycleGeneration: 'nope' } }).generation, 0);
    });

    it('refuses to treat accessLevel=write as read-write when no transition was ever recorded (PRR-B BLOCKING C1/C5)', () => {
      // The pre-#966 PATCH /api/config can already set accessLevel: 'write'
      // directly, with no lifecycleGeneration write at all -- exactly the
      // legacy write path that bypasses applyOperatorAuthorityChange's
      // audited generation tracking entirely.
      assert.equal(masterAuthority.getAuthorityState({ master: { accessLevel: 'write' } }).toggleState, 'read-only');
      assert.equal(masterAuthority.getAuthorityState({ master: { accessLevel: 'write', lifecycleGeneration: 0 } }).toggleState, 'read-only');
      assert.equal(masterAuthority.getAuthorityState({ master: { accessLevel: 'write', lifecycleGeneration: -1 } }).toggleState, 'read-only');
      assert.equal(masterAuthority.getAuthorityState({ master: { accessLevel: 'write', lifecycleGeneration: 'nope' } }).toggleState, 'read-only');
    });

    it('grants read-write only once a COMPLETE transition has been recorded — generation alone is not enough (PRR-B BLOCKING C1/C5, round 2)', () => {
      // A positive lifecycleGeneration with no lifecycleUpdatedAt/By is
      // exactly as unverified as no generation at all: there is still no
      // actual evidence of who made the change or when.
      assert.equal(masterAuthority.getAuthorityState({ master: { accessLevel: 'write', lifecycleGeneration: 1 } }).toggleState, 'read-only');
      assert.equal(masterAuthority.getAuthorityState({ master: { accessLevel: 'write', lifecycleGeneration: 1, lifecycleUpdatedAt: '2026-01-01T00:00:00.000Z' } }).toggleState, 'read-only', 'missing updatedBy alone must still refuse');
      assert.equal(masterAuthority.getAuthorityState({ master: { accessLevel: 'write', lifecycleGeneration: 1, lifecycleUpdatedBy: 'operator:x' } }).toggleState, 'read-only', 'missing updatedAt alone must still refuse');
      assert.equal(masterAuthority.getAuthorityState({ master: { accessLevel: 'write', lifecycleGeneration: 1, lifecycleUpdatedAt: '', lifecycleUpdatedBy: 'operator:x' } }).toggleState, 'read-only', 'a blank updatedAt must still refuse');

      const config = store.config.load();
      const result = masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'write', actor: 'operator:jason' });
      assert.equal(result.toggleState, 'read-write', 'a real transition through the audited path sets all three fields together');
    });

    it('evaluateLifecycleCall refuses a lifecycle action against an incomplete transition record, even with a valid token', () => {
      const config = { master: { accessLevel: 'write', lifecycleGeneration: 1, apiTokenEnabled: true, apiToken: 'tc_master_incomplete' } };
      const result = masterAuthority.evaluateLifecycleCall(config, { headers: { authorization: 'Bearer tc_master_incomplete' }, action: 'launch' });
      assert.equal(result.allowed, false);
      assert.equal(result.code, 'AUTHORITY_READ_ONLY');
    });

    it('evaluateLifecycleCall refuses a lifecycle action against a legacy write with no recorded generation', () => {
      const config = { master: { accessLevel: 'write', apiTokenEnabled: true, apiToken: 'tc_master_legacy' } };
      const result = masterAuthority.evaluateLifecycleCall(config, { headers: { authorization: 'Bearer tc_master_legacy' }, action: 'launch' });
      assert.equal(result.allowed, false);
      assert.equal(result.code, 'AUTHORITY_READ_ONLY');
    });
  });

  describe('applyOperatorAuthorityChange (#2132 criteria 1, 2, 4)', () => {
    it('accepts a 3-tier accessLevel and advances the generation by exactly 1', () => {
      const config = store.config.load();
      const result = masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'write', actor: 'operator:jason' });
      assert.equal(result.accessLevel, 'write');
      assert.equal(result.toggleState, 'read-write');
      assert.equal(result.generation, 1);
      assert.equal(result.updatedBy, 'operator:jason');
      assert.equal(config.master.accessLevel, 'write', 'must mutate the passed config in place');
    });

    it('accepts the binary toggleState and maps it to the right accessLevel', () => {
      const config = store.config.load();
      const toWrite = masterAuthority.applyOperatorAuthorityChange(config, { toggleState: 'read-write', actor: 'x' });
      assert.equal(toWrite.accessLevel, 'write');
      const toReadOnly = masterAuthority.applyOperatorAuthorityChange(config, { toggleState: 'read-only', actor: 'x' });
      assert.equal(toReadOnly.accessLevel, 'read-only', 'read-only toggle maps to read-only, never suggest');
      assert.equal(toReadOnly.generation, 2, 'a second transition advances the generation again');
    });

    it('accepts accessLevel and toggleState together when they agree', () => {
      const config = store.config.load();
      const result = masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'write', toggleState: 'read-write', actor: 'x' });
      assert.equal(result.accessLevel, 'write');
    });

    it('refuses when accessLevel and toggleState disagree, rather than picking one', () => {
      const config = store.config.load();
      assert.throws(
        () => masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'read-only', toggleState: 'read-write', actor: 'x' }),
        /AUTHORITY_BAD_REQUEST|disagree/
      );
      assert.equal(masterAuthority.getAuthorityState(config).generation, 0, 'a refused change must not advance the generation');
    });

    it('accepts accessLevel=suggest with toggleState=read-only — both derive to read-only, so they agree (PRR-B WARNING C1)', () => {
      // The naive fix compares accessLevel against a mapping that only
      // knows 'write'/'read-only', which would wrongly flag this pair as
      // contradictory: 'suggest' is a third value that ALSO derives to
      // read-only, same as the literal 'read-only' accessLevel does.
      const config = store.config.load();
      const result = masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'suggest', toggleState: 'read-only', actor: 'x' });
      assert.equal(result.accessLevel, 'suggest');
      assert.equal(result.toggleState, 'read-only');
    });

    it('still refuses accessLevel=suggest with toggleState=read-write — suggest never derives to read-write', () => {
      const config = store.config.load();
      assert.throws(
        () => masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'suggest', toggleState: 'read-write', actor: 'x' }),
        /disagree/
      );
    });

    it('refuses an unrecognized accessLevel', () => {
      const config = store.config.load();
      assert.throws(() => masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'bogus', actor: 'x' }));
    });

    it('refuses with neither accessLevel nor toggleState given', () => {
      const config = store.config.load();
      assert.throws(() => masterAuthority.applyOperatorAuthorityChange(config, { actor: 'x' }));
    });

    describe('generation repair semantics (PRR-B WARNING C1, round 2)', () => {
      it('refuses rather than silently repairing a corrupted existing generation, to avoid regressing below history', () => {
        for (const corrupted of ['not-a-number', -1, 1.5, NaN, {}, []]) {
          const config = { master: { accessLevel: 'write', lifecycleGeneration: corrupted } };
          assert.throws(
            () => masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'write', actor: 'x' }),
            /corrupted/,
            `expected a refusal for lifecycleGeneration=${JSON.stringify(corrupted)}`
          );
        }
      });

      it('advances from a genuinely absent generation at 0, not from a guessed value', () => {
        const config = {};
        const result = masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'write', actor: 'x' });
        assert.equal(result.generation, 1);
      });

      it('advances from a VALID prior generation even when the record was otherwise incomplete (no updatedAt/updatedBy) — a real number is not corruption', () => {
        const config = { master: { accessLevel: 'write', lifecycleGeneration: 5 } };
        const result = masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'write', actor: 'operator:x' });
        assert.equal(result.generation, 6, 'must continue from 5, never reset to 1');
      });
    });

    it('requires actor — an authority change with no recorded "who" is the gap this closes', () => {
      const config = store.config.load();
      assert.throws(() => masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'write' }));
      assert.throws(() => masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'write', actor: '' }));
      assert.throws(() => masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'write', actor: '   ' }));
    });

    it('records exactly one audit receipt per transition, carrying the new generation', () => {
      const config = store.config.load();
      masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'write', actor: 'operator:jason' });
      const entries = store.activity.query({ eventType: 'master.lifecycle-authority-decision' });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].detail.action, 'operator-authority-change');
      assert.equal(entries[0].detail.decision, 'allow');
      assert.equal(entries[0].detail.generation, 1);
      assert.equal(entries[0].detail.toggleState, 'read-write');
    });
  });

  describe('ensureApiTokenWhenEnabled', () => {
    it('generates a token when enabled with none set, and never overwrites an existing one', () => {
      const config = { master: { apiTokenEnabled: true } };
      assert.equal(masterAuthority.ensureApiTokenWhenEnabled(config), true);
      const first = config.master.apiToken;
      assert.ok(first.startsWith('tc_master_'));
      assert.equal(masterAuthority.ensureApiTokenWhenEnabled(config), false);
      assert.equal(config.master.apiToken, first);
    });

    it('does nothing when the gate is not enabled, or config.master is malformed', () => {
      assert.equal(masterAuthority.ensureApiTokenWhenEnabled({ master: { apiTokenEnabled: false } }), false);
      assert.equal(masterAuthority.ensureApiTokenWhenEnabled(null), false);
      assert.equal(masterAuthority.ensureApiTokenWhenEnabled({}), false);
      assert.equal(masterAuthority.ensureApiTokenWhenEnabled({ master: null }), false);
    });

    it('treats a truthy non-boolean apiTokenEnabled as disabled (PRR-B WARNING C5)', () => {
      const config = { master: { apiTokenEnabled: 'false' } };
      assert.equal(masterAuthority.ensureApiTokenWhenEnabled(config), false);
      assert.equal(config.master.apiToken, undefined);
    });

    it('replaces a malformed non-string apiToken rather than treating it as already set', () => {
      const config = { master: { apiTokenEnabled: true, apiToken: 123 } };
      assert.equal(masterAuthority.ensureApiTokenWhenEnabled(config), true);
      assert.equal(typeof config.master.apiToken, 'string');
      assert.ok(config.master.apiToken.startsWith('tc_master_'));
    });
  });

  describe('validateApiToken', () => {
    const TOKEN = 'tc_master_abc123';

    it('refuses when the gate is disabled — never an open-by-default fallback (unlike the fleet service-token gate)', () => {
      const result = masterAuthority.validateApiToken({ authorization: `Bearer ${TOKEN}` }, { master: { apiTokenEnabled: false } });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'MASTER_API_TOKEN_DISABLED');
      assert.equal(result.status, 403);
    });

    it('refuses with 500 when enabled but misconfigured', () => {
      const result = masterAuthority.validateApiToken({ authorization: `Bearer ${TOKEN}` }, { master: { apiTokenEnabled: true } });
      assert.equal(result.code, 'MASTER_API_TOKEN_MISCONFIGURED');
      assert.equal(result.status, 500);
    });

    it('refuses a missing or malformed Authorization header', () => {
      const cfg = { master: { apiTokenEnabled: true, apiToken: TOKEN } };
      assert.equal(masterAuthority.validateApiToken({}, cfg).code, 'UNAUTHORIZED');
      assert.equal(masterAuthority.validateApiToken({ authorization: `Basic ${TOKEN}` }, cfg).code, 'UNAUTHORIZED');
    });

    it('refuses the wrong token, including one of the same length (no timing oracle)', () => {
      const wrongSameLength = 'tc_master_zzz999';
      assert.equal(wrongSameLength.length, TOKEN.length);
      const result = masterAuthority.validateApiToken(
        { authorization: `Bearer ${wrongSameLength}` },
        { master: { apiTokenEnabled: true, apiToken: TOKEN } }
      );
      assert.equal(result.code, 'INVALID_MASTER_API_TOKEN');
      assert.equal(result.status, 401);
    });

    it('accepts the correct token', () => {
      const result = masterAuthority.validateApiToken({ authorization: `Bearer ${TOKEN}` }, { master: { apiTokenEnabled: true, apiToken: TOKEN } });
      assert.deepEqual(result, { ok: true });
    });

    it('is safe against a missing config.master', () => {
      assert.equal(masterAuthority.validateApiToken({ authorization: `Bearer ${TOKEN}` }, {}).code, 'MASTER_API_TOKEN_DISABLED');
    });

    it('treats a truthy non-boolean apiTokenEnabled as disabled, never activating the gate (PRR-B WARNING C5)', () => {
      const result = masterAuthority.validateApiToken(
        { authorization: `Bearer ${TOKEN}` },
        { master: { apiTokenEnabled: 'false', apiToken: TOKEN } }
      );
      assert.equal(result.code, 'MASTER_API_TOKEN_DISABLED');
    });

    it('refuses cleanly, never throwing, when apiToken is a malformed non-string value', () => {
      for (const malformed of [123, {}, [], true]) {
        assert.doesNotThrow(() => masterAuthority.validateApiToken(
          { authorization: `Bearer ${TOKEN}` },
          { master: { apiTokenEnabled: true, apiToken: malformed } }
        ));
        const result = masterAuthority.validateApiToken(
          { authorization: `Bearer ${TOKEN}` },
          { master: { apiTokenEnabled: true, apiToken: malformed } }
        );
        assert.equal(result.code, 'MASTER_API_TOKEN_MISCONFIGURED');
      }
    });
  });

  describe('evaluateLifecycleCall (#2132 criteria 3, 5, 6; #966) — the single entry point', () => {
    function enabledConfig() {
      const config = store.config.load();
      masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'write', actor: 'operator:jason' });
      config.master.apiTokenEnabled = true;
      masterAuthority.ensureApiTokenWhenEnabled(config);
      return config;
    }

    function bearer(config) {
      return { authorization: `Bearer ${config.master.apiToken}` };
    }

    it('allows a gated action when the token is valid, the toggle is read-write, and the action is allowlisted', () => {
      const config = enabledConfig();
      const result = masterAuthority.evaluateLifecycleCall(config, { headers: bearer(config), action: 'launch' });
      assert.equal(result.allowed, true);
      assert.equal(result.status, 200);
      assert.equal(result.code, null);
    });

    it('refuses an action outside the allowlist before even checking the token', () => {
      const config = enabledConfig();
      const result = masterAuthority.evaluateLifecycleCall(config, { headers: { authorization: 'Bearer totally-wrong' }, action: 'delete-everything' });
      assert.equal(result.allowed, false);
      assert.equal(result.code, 'AUTHORITY_ACTION_NOT_ALLOWLISTED');
    });

    it('refuses an invalid token even for an allowlisted action', () => {
      const config = enabledConfig();
      const result = masterAuthority.evaluateLifecycleCall(config, { headers: { authorization: 'Bearer wrong' }, action: 'launch' });
      assert.equal(result.allowed, false);
      assert.equal(result.code, 'INVALID_MASTER_API_TOKEN');
    });

    it('refuses when the token gate itself is disabled', () => {
      const config = store.config.load();
      masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'write', actor: 'x' });
      const result = masterAuthority.evaluateLifecycleCall(config, { headers: {}, action: 'launch' });
      assert.equal(result.allowed, false);
      assert.equal(result.code, 'MASTER_API_TOKEN_DISABLED');
    });

    it('refuses a stale/mismatched expectedGeneration outright, never "close enough"', () => {
      const config = enabledConfig();
      const current = masterAuthority.getAuthorityState(config).generation;
      const result = masterAuthority.evaluateLifecycleCall(config, { headers: bearer(config), action: 'launch', expectedGeneration: current - 1 });
      assert.equal(result.allowed, false);
      assert.equal(result.code, 'AUTHORITY_GENERATION_STALE');
    });

    it('allows when expectedGeneration matches exactly', () => {
      const config = enabledConfig();
      const current = masterAuthority.getAuthorityState(config).generation;
      const result = masterAuthority.evaluateLifecycleCall(config, { headers: bearer(config), action: 'launch', expectedGeneration: current });
      assert.equal(result.allowed, true);
    });

    it('does not require expectedGeneration at all — "re-check fresh state" is equally valid', () => {
      const config = enabledConfig();
      const result = masterAuthority.evaluateLifecycleCall(config, { headers: bearer(config), action: 'launch' });
      assert.equal(result.allowed, true);
    });

    it('fails closed when accessLevel is read-only, even with a perfectly valid token', () => {
      const config = store.config.load();
      config.master = config.master || {};
      config.master.apiTokenEnabled = true;
      masterAuthority.ensureApiTokenWhenEnabled(config);
      // accessLevel never set to write — stays at its read-only default.
      const result = masterAuthority.evaluateLifecycleCall(config, { headers: bearer(config), action: 'launch' });
      assert.equal(result.allowed, false);
      assert.equal(result.code, 'AUTHORITY_READ_ONLY');
    });

    it('fails closed when accessLevel is suggest — suggest never grants fleet-lifecycle mutation', () => {
      const config = store.config.load();
      masterAuthority.applyOperatorAuthorityChange(config, { accessLevel: 'suggest', actor: 'x' });
      config.master.apiTokenEnabled = true;
      masterAuthority.ensureApiTokenWhenEnabled(config);
      const result = masterAuthority.evaluateLifecycleCall(config, { headers: bearer(config), action: 'launch' });
      assert.equal(result.allowed, false);
      assert.equal(result.code, 'AUTHORITY_READ_ONLY');
    });

    it('a flip back to read-only takes effect on the very next call, with no separate cache to invalidate', () => {
      const config = enabledConfig();
      assert.equal(masterAuthority.evaluateLifecycleCall(config, { headers: bearer(config), action: 'launch' }).allowed, true);
      masterAuthority.applyOperatorAuthorityChange(config, { toggleState: 'read-only', actor: 'operator:jason' });
      assert.equal(masterAuthority.evaluateLifecycleCall(config, { headers: bearer(config), action: 'launch' }).allowed, false);
    });

    it('writes exactly one audit receipt per call, never one per sub-check', () => {
      const config = enabledConfig();
      masterAuthority.evaluateLifecycleCall(config, { headers: bearer(config), action: 'launch' });
      const entries = store.activity.query({ eventType: 'master.lifecycle-authority-decision' });
      // One for the operator transition in enabledConfig(), one for this call.
      assert.equal(entries.length, 2);
      const callEntry = entries.find((e) => e.detail.action === 'launch');
      assert.ok(callEntry);
      assert.equal(callEntry.detail.decision, 'allow');
      assert.equal(callEntry.detail.generation, 1);
    });

    it('audits a refusal too, carrying the reason', () => {
      const config = enabledConfig();
      masterAuthority.evaluateLifecycleCall(config, { headers: { authorization: 'Bearer wrong' }, action: 'launch' });
      const entries = store.activity.query({ eventType: 'master.lifecycle-authority-decision' });
      const refusal = entries.find((e) => e.detail.decision === 'refuse' && e.detail.action === 'launch');
      assert.ok(refusal);
      assert.equal(refusal.detail.reason, 'INVALID_MASTER_API_TOKEN');
    });
  });
});
