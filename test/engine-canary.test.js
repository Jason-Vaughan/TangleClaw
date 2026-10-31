'use strict';

/*
 * The shared engine compatibility canary gate (#1897): state resolution from
 * capability probes, evidence persistence, and the explicit operator
 * override — never silently treating `unknown` as `verified`.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const canary = require('../lib/engine-canary');
const canaryRoutes = require('../lib/routes/engines-canary');
const { matchRoute } = require('../lib/routes/_kernel');
const authGate = require('../lib/auth-gate');

/**
 * A response double that captures what a route wrote, without a real socket
 * — the "small" tier's whole point.
 * @returns {{res: object, status: () => number, json: () => object}}
 */
function mockRes() {
  let status;
  let json;
  const res = {
    writeHead(code) { status = code; },
    end(body) { json = body ? JSON.parse(body) : undefined; }
  };
  return { res, status: () => status, json: () => json };
}

/**
 * The reason a candidate evidence document is refused, or null when it
 * validates.
 * @param {object} doc - Candidate.
 * @returns {string|null}
 */
function refusal(doc) {
  try {
    canary.validateEvidenceDoc(doc);
    return null;
  } catch (err) {
    assert.ok(err instanceof canary.CanaryError, `unexpected ${err}`);
    return err.message;
  }
}

/**
 * A minimal valid evidence document for a `verified` build.
 * @param {object} [overrides] - Fields to override.
 * @returns {object}
 */
function verifiedDoc(overrides = {}) {
  return {
    schema: canary.SCHEMA,
    engine: { id: 'codex', executablePath: '/usr/local/bin/codex', version: '0.157.1', buildFingerprint: 'abc123' },
    contractRevision: 1,
    capabilities: [
      { id: 'identity', result: 'pass' },
      { id: 'startup-injection', result: 'pass' }
    ],
    state: canary.STATES.VERIFIED,
    verifiedAt: 1_700_000_000_000,
    tangleclawVersion: 'v5.50.0',
    platform: 'darwin-arm64',
    ...overrides
  };
}

describe('lib/routes/engines-canary — registration and the operator-auth floor', () => {
  before(() => canaryRoutes.register());

  it('registers the read, list and override routes', () => {
    assert.ok(matchRoute('GET', '/api/engines/codex/canary/build-1'));
    assert.ok(matchRoute('GET', '/api/engines/codex/canary'));
    assert.ok(matchRoute('POST', '/api/engines/codex/canary/build-1/override'));
  });

  it('refuses an unauthenticated read on an armed install with 401, before it ever touches the evidence store', () => {
    const match = matchRoute('GET', '/api/engines/codex/canary/build-1');
    const { res, status, json } = mockRes();
    match.handler({ tcGateState: authGate.GATE_STATES.ARMED }, res, match.params);
    assert.equal(status(), 401);
    assert.equal(json().code, 'UNAUTHENTICATED');
  });

  it('refuses an unauthenticated list read on an armed install with 401', () => {
    const match = matchRoute('GET', '/api/engines/codex/canary');
    const { res, status } = mockRes();
    match.handler({ tcGateState: authGate.GATE_STATES.ARMED }, res, match.params);
    assert.equal(status(), 401);
  });

  it('refuses an unauthenticated override write on an armed install with 401, and records nothing', () => {
    const match = matchRoute('POST', '/api/engines/codex/canary/build-1/override');
    const { res, status } = mockRes();
    match.handler({ tcGateState: authGate.GATE_STATES.ARMED }, res, match.params, { acknowledgedRisk: true });
    assert.equal(status(), 401);
  });
});

describe('resolveCanaryState', () => {
  it('resolves verified when every required capability passed', () => {
    const r = canary.resolveCanaryState({
      capabilities: [{ id: 'identity', result: 'pass' }, { id: 'hooks', result: 'pass' }],
      requiredCapabilityIds: ['identity', 'hooks']
    });
    assert.equal(r.state, canary.STATES.VERIFIED);
    assert.deepEqual(r.failedCapabilityIds, []);
    assert.deepEqual(r.missingCapabilityIds, []);
  });

  it('resolves unknown when a required capability never ran, even if everything that DID run passed', () => {
    const r = canary.resolveCanaryState({
      capabilities: [{ id: 'identity', result: 'pass' }],
      requiredCapabilityIds: ['identity', 'hooks']
    });
    assert.equal(r.state, canary.STATES.UNKNOWN);
    assert.deepEqual(r.missingCapabilityIds, ['hooks']);
  });

  it('never resolves verified from an empty probe set against required capabilities', () => {
    const r = canary.resolveCanaryState({ capabilities: [], requiredCapabilityIds: ['identity'] });
    assert.equal(r.state, canary.STATES.UNKNOWN);
  });

  it('resolves incompatible when a required capability failed and no fallback is declared', () => {
    const r = canary.resolveCanaryState({
      capabilities: [{ id: 'identity', result: 'pass' }, { id: 'hooks', result: 'fail' }],
      requiredCapabilityIds: ['identity', 'hooks']
    });
    assert.equal(r.state, canary.STATES.INCOMPATIBLE);
    assert.deepEqual(r.failedCapabilityIds, ['hooks']);
  });

  it('resolves degraded when a required capability failed but a verified fallback is declared and nothing is missing', () => {
    const r = canary.resolveCanaryState({
      capabilities: [{ id: 'identity', result: 'pass' }, { id: 'hooks', result: 'fail' }],
      requiredCapabilityIds: ['identity', 'hooks'],
      degradedFallback: { version: '0.157.0', note: 'last build with working hooks' }
    });
    assert.equal(r.state, canary.STATES.DEGRADED);
  });

  it('prefers incompatible over degraded when a capability is both failed and missing cannot clear a fallback', () => {
    const r = canary.resolveCanaryState({
      capabilities: [{ id: 'identity', result: 'fail' }],
      requiredCapabilityIds: ['identity', 'hooks'],
      degradedFallback: { version: '0.157.0', note: 'fallback' }
    });
    // "hooks" never ran at all, so even with a failure elsewhere and a
    // fallback declared, a missing probe must not be waved through as degraded.
    assert.equal(r.state, canary.STATES.INCOMPATIBLE);
  });
});

describe('contract constants', () => {
  it('CAPABILITY_RESULTS names exactly the three probe outcomes', () => {
    assert.deepEqual(canary.CAPABILITY_RESULTS, ['pass', 'fail', 'not-applicable']);
  });

  it('evidenceEngineDir is the parent of every evidencePath for that engine', () => {
    const dir = canary.evidenceEngineDir('/base', 'codex');
    const file = canary.evidencePath('/base', 'codex', 'build-1');
    assert.equal(path.dirname(file), dir);
  });

  it('rejects a capabilities array longer than MAX_CAPABILITIES', () => {
    const capabilities = Array.from({ length: canary.MAX_CAPABILITIES + 1 }, (_, i) => ({ id: `cap-${i}`, result: 'pass' }));
    assert.match(refusal(verifiedDoc({ capabilities })), /at most \d+ entries/);
  });

  it('refuses to write a document whose JSON exceeds MAX_BYTES, even though each field alone validates', () => {
    const capabilities = Array.from({ length: canary.MAX_CAPABILITIES }, (_, i) => ({
      id: `capability-id-${i}`,
      result: 'pass',
      detail: 'd'.repeat(500)
    }));
    const doc = verifiedDoc({ capabilities });
    assert.equal(refusal(doc), null, 'the document is schema-valid on its own terms');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-canary-oversize-'));
    try {
      const file = canary.evidencePath(dir, 'codex', 'oversize');
      assert.throws(() => canary.writeEvidence(file, doc), (err) => err instanceof canary.CanaryError && new RegExp(String(canary.MAX_BYTES)).test(err.message));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validateOverride (standalone)', () => {
  function validOverride(overrides = {}) {
    return {
      schema: canary.OVERRIDE_SCHEMA,
      actor: 'jason',
      acknowledgedRisk: true,
      reason: 'accepted the risk for this launch',
      lastVerifiedVersion: '0.157.0',
      rollbackCommand: 'npm install -g codex@0.157.0',
      at: 1,
      ...overrides
    };
  }

  it('accepts a complete override record', () => {
    assert.doesNotThrow(() => canary.validateOverride(validOverride()));
  });

  it('rejects a reason that is blank', () => {
    assert.throws(() => canary.validateOverride(validOverride({ reason: '   ' })), canary.CanaryError);
  });

  it('accepts a null lastVerifiedVersion (no prior verified build exists yet)', () => {
    assert.doesNotThrow(() => canary.validateOverride(validOverride({ lastVerifiedVersion: null })));
  });
});

describe('validateEvidenceDoc', () => {
  it('accepts a minimal verified document', () => {
    assert.equal(refusal(verifiedDoc()), null);
  });

  it('rejects an unknown schema tag', () => {
    assert.match(refusal(verifiedDoc({ schema: 'wrong' })), /schema/);
  });

  it('rejects an unknown top-level key', () => {
    assert.match(refusal(verifiedDoc({ bogus: 1 })), /unknown key/);
  });

  it('rejects a state outside the four named states', () => {
    assert.match(refusal(verifiedDoc({ state: 'maybe' })), /state must be one of/);
  });

  it('requires degradedFallback when state is degraded', () => {
    assert.match(refusal(verifiedDoc({ state: canary.STATES.DEGRADED })), /degradedFallback is required/);
  });

  it('rejects degradedFallback present on a non-degraded state', () => {
    assert.match(
      refusal(verifiedDoc({ degradedFallback: { version: '1', note: '' } })),
      /degradedFallback may only be set/
    );
  });

  it('rejects a capability result outside the three named results', () => {
    assert.match(
      refusal(verifiedDoc({ capabilities: [{ id: 'identity', result: 'maybe' }] })),
      /result must be one of/
    );
  });

  it('rejects an engine identifier unsafe as a path segment', () => {
    assert.match(
      refusal(verifiedDoc({ engine: { ...verifiedDoc().engine, id: '../etc' } })),
      /id must be/
    );
  });

  it('rejects an embedded override missing acknowledgedRisk', () => {
    const doc = verifiedDoc({
      override: {
        schema: canary.OVERRIDE_SCHEMA,
        actor: 'jason',
        acknowledgedRisk: false,
        reason: 'needed it',
        lastVerifiedVersion: null,
        rollbackCommand: '',
        at: 1
      }
    });
    assert.match(refusal(doc), /acknowledgedRisk must be true/);
  });
});

describe('evidence persistence', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-canary-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reports missing for a build nothing has recorded yet', () => {
    const file = canary.evidencePath(dir, 'codex', 'neverseen');
    const read = canary.readEvidence(file);
    assert.equal(read.status, canary.READ_STATUS.MISSING);
  });

  it('round-trips a written document', () => {
    const file = canary.evidencePath(dir, 'codex', 'build-1');
    canary.writeEvidence(file, verifiedDoc());
    const read = canary.readEvidence(file);
    assert.equal(read.status, canary.READ_STATUS.OK);
    assert.equal(read.doc.engine.buildFingerprint, 'abc123');
  });

  it('refuses to write a document that fails validation, and never creates the file', () => {
    const file = canary.evidencePath(dir, 'codex', 'build-bad');
    assert.throws(() => canary.writeEvidence(file, verifiedDoc({ state: 'nope' })), canary.CanaryError);
    assert.equal(fs.existsSync(file), false);
  });

  it('reports invalid for a file that is not valid JSON', () => {
    const file = canary.evidencePath(dir, 'codex', 'corrupt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const read = canary.readEvidence(file);
    assert.equal(read.status, canary.READ_STATUS.INVALID);
  });

  it('lists every recorded build for an engine, newest first, and nothing for an engine with none', () => {
    const edir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-canary-list-'));
    try {
      canary.writeEvidence(canary.evidencePath(edir, 'codex', 'older'), verifiedDoc({ verifiedAt: 1 }));
      canary.writeEvidence(canary.evidencePath(edir, 'codex', 'newer'), verifiedDoc({ verifiedAt: 2 }));
      const rows = canary.listEvidenceForEngine(edir, 'codex');
      assert.deepEqual(rows.map((r) => r.buildFingerprint), ['newer', 'older']);
      assert.deepEqual(canary.listEvidenceForEngine(edir, 'claude'), []);
    } finally {
      fs.rmSync(edir, { recursive: true, force: true });
    }
  });
});

describe('applyOverride', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-canary-override-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('refuses to override a build with no recorded evidence', () => {
    const file = canary.evidencePath(dir, 'codex', 'never-ran');
    assert.throws(
      () => canary.applyOverride(file, {
        actor: 'jason', acknowledgedRisk: true, reason: 'because', lastVerifiedVersion: null, rollbackCommand: ''
      }),
      canary.CanaryError
    );
  });

  it('refuses an override missing a required field', () => {
    const file = canary.evidencePath(dir, 'codex', 'incompatible-1');
    canary.writeEvidence(file, verifiedDoc({
      state: canary.STATES.INCOMPATIBLE,
      capabilities: [{ id: 'identity', result: 'fail' }]
    }));
    assert.throws(
      () => canary.applyOverride(file, { actor: 'jason', acknowledgedRisk: true, rollbackCommand: '' }),
      canary.CanaryError
    );
  });

  it('records a valid override without altering the resolved state', () => {
    const file = canary.evidencePath(dir, 'codex', 'incompatible-2');
    canary.writeEvidence(file, verifiedDoc({
      state: canary.STATES.INCOMPATIBLE,
      capabilities: [{ id: 'identity', result: 'fail' }]
    }));
    const updated = canary.applyOverride(file, {
      actor: 'jason',
      acknowledgedRisk: true,
      reason: 'rolling forward anyway, watching for the known issue',
      lastVerifiedVersion: '0.157.0',
      rollbackCommand: 'npm install -g codex@0.157.0'
    }, { now: 1_700_000_500_000 });
    assert.equal(updated.state, canary.STATES.INCOMPATIBLE, 'the override never changes the resolved state');
    assert.equal(canary.isOverridden(updated), true);
    assert.equal(updated.override.actor, 'jason');
    assert.equal(updated.override.at, 1_700_000_500_000);

    const read = canary.readEvidence(file);
    assert.equal(canary.isOverridden(read.doc), true);
  });
});

describe('decideLaunchGate', () => {
  it('allows a verified build with no override', () => {
    const r = canary.decideLaunchGate({ evidenceDoc: verifiedDoc() });
    assert.equal(r.allowed, true);
    assert.equal(r.overridden, false);
    assert.equal(r.refusal, null);
  });

  it('allows a degraded build with no override', () => {
    const doc = verifiedDoc({ state: canary.STATES.DEGRADED, degradedFallback: { version: '1', note: '' } });
    const r = canary.decideLaunchGate({ evidenceDoc: doc });
    assert.equal(r.allowed, true);
  });

  it('refuses an unknown build with no override, and never calls it verified', () => {
    const doc = verifiedDoc({ state: canary.STATES.UNKNOWN, capabilities: [] });
    const r = canary.decideLaunchGate({ evidenceDoc: doc });
    assert.equal(r.allowed, false);
    assert.equal(r.state, canary.STATES.UNKNOWN);
    assert.ok(r.refusal);
  });

  it('refuses an incompatible build and names the failed capabilities and rollback', () => {
    const doc = verifiedDoc({ state: canary.STATES.INCOMPATIBLE, capabilities: [{ id: 'hooks', result: 'fail' }] });
    const lastVerified = verifiedDoc({ engine: { ...verifiedDoc().engine, version: '0.157.0' } });
    const r = canary.decideLaunchGate({ evidenceDoc: doc, lastVerifiedEvidence: lastVerified });
    assert.equal(r.allowed, false);
    assert.deepEqual(r.refusal.failedCapabilityIds, ['hooks']);
    assert.equal(r.refusal.latestVerifiedVersion, '0.157.0');
    assert.equal(r.refusal.detectedVersion, doc.engine.version);
  });

  it('allows an incompatible build once it carries a recorded override, and still reports it as overridden', () => {
    const doc = verifiedDoc({
      state: canary.STATES.INCOMPATIBLE,
      capabilities: [{ id: 'hooks', result: 'fail' }],
      override: {
        schema: canary.OVERRIDE_SCHEMA,
        actor: 'jason',
        acknowledgedRisk: true,
        reason: 'accepted',
        lastVerifiedVersion: '0.157.0',
        rollbackCommand: 'npm install -g codex@0.157.0',
        at: 1
      }
    });
    const r = canary.decideLaunchGate({ evidenceDoc: doc });
    assert.equal(r.allowed, true);
    assert.equal(r.overridden, true);
    assert.equal(r.state, canary.STATES.INCOMPATIBLE, 'the state stays truthful even once overridden');
  });
});
