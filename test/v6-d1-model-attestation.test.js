'use strict';

// v6 Train 2 Wave 1-A (#2985, V6-12 / D1, BRIDGE-4): the
// model_selection_attestations schema (lib/store/_schema.js) plus
// lib/v6/d1-model-attestation.js, against a real node:sqlite-backed store.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const d1 = require('../lib/v6/d1-model-attestation');

let tmpDir = null;

/** @returns {import('node:sqlite').DatabaseSync} */
function freshStore() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-d1-attestation-'));
  store._setBasePath(tmpDir);
  store.init();
  return store.getDb();
}

function cleanup() {
  store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
}

function seedProject(db, name) {
  db.prepare('INSERT INTO projects (name, path, archived) VALUES (?, ?, 0)').run(name, path.join(os.tmpdir(), name));
  return db.prepare('SELECT id FROM projects WHERE name = ?').get(name).id;
}

function seedSession(db, projectId, engineId = 'claude') {
  db.prepare('INSERT INTO sessions (project_id, engine_id) VALUES (?, ?)').run(projectId, engineId);
  return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
}

describe('recordAttestation / getAttestation (#2985 deliverable 2)', () => {
  it('records a first attestation for a generation and reads it back', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'd1-record');
      const sessionId = seedSession(db, projectId);
      const res = d1.recordAttestation(db, {
        projectId, sessionId, generation: 1, engineId: 'claude',
        requestedModel: 'claude-sonnet-5', observedModel: null, source: 'unavailable', confidence: 'unavailable'
      });
      assert.equal(res.ok, true);
      assert.equal(res.code, 'RECORDED');
      const row = d1.getAttestation(db, { sessionId, generation: 1 });
      assert.equal(row.requested_model, 'claude-sonnet-5');
      assert.equal(row.observed_model, null);
      assert.equal(row.confidence, 'unavailable');
    } finally {
      cleanup();
    }
  });

  it('a second call for the SAME generation UPDATES the existing row rather than inserting a new one', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'd1-update');
      const sessionId = seedSession(db, projectId);
      d1.recordAttestation(db, {
        projectId, sessionId, generation: 1, engineId: 'claude',
        requestedModel: 'claude-sonnet-5', observedModel: null, source: 'unavailable', confidence: 'unavailable'
      });
      const second = d1.recordAttestation(db, {
        projectId, sessionId, generation: 1, engineId: 'claude',
        requestedModel: 'claude-sonnet-5', observedModel: 'claude-sonnet-5', source: 'cli-roster', confidence: 'observed'
      });
      assert.equal(second.code, 'UPDATED');
      const row = d1.getAttestation(db, { sessionId, generation: 1 });
      assert.equal(row.observed_model, 'claude-sonnet-5');
      assert.equal(row.confidence, 'observed');
      assert.equal(d1.getAttestationHistory(db, { sessionId }).length, 1, 'still exactly one row for this generation');
    } finally {
      cleanup();
    }
  });

  it('an observation-only update (requestedModel omitted) PRESERVES the original requested_model (PRR-A R1 HOLD)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'd1-preserve-requested');
      const sessionId = seedSession(db, projectId);
      d1.recordAttestation(db, {
        projectId, sessionId, generation: 1, engineId: 'claude',
        requestedModel: 'claude-sonnet-5', source: 'unavailable', confidence: 'unavailable'
      });
      const second = d1.recordAttestation(db, {
        projectId, sessionId, generation: 1, engineId: 'claude',
        observedModel: 'claude-sonnet-5', source: 'cli-roster', confidence: 'observed'
      });
      assert.equal(second.ok, true);
      const row = d1.getAttestation(db, { sessionId, generation: 1 });
      assert.equal(row.requested_model, 'claude-sonnet-5', 'the omitted requestedModel must not wipe the original');
      assert.equal(row.observed_model, 'claude-sonnet-5');
    } finally {
      cleanup();
    }
  });

  it('refuses INVALID_REQUEST when an update targets a (session_id, generation) belonging to a DIFFERENT project (PRR-A R1 HOLD)', () => {
    const db = freshStore();
    try {
      const projectA = seedProject(db, 'd1-project-a');
      const projectB = seedProject(db, 'd1-project-b');
      const sessionId = seedSession(db, projectA);
      d1.recordAttestation(db, { projectId: projectA, sessionId, generation: 1, engineId: 'claude', source: 'cli-roster', confidence: 'observed' });
      const res = d1.recordAttestation(db, { projectId: projectB, sessionId, generation: 1, engineId: 'claude', source: 'cli-roster', confidence: 'observed' });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'INVALID_REQUEST');
      assert.match(res.message, /project_id mismatch/);
    } finally {
      cleanup();
    }
  });

  it('refuses INVALID_REQUEST for an unknown source, confidence, or generation < 1', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'd1-invalid');
      const sessionId = seedSession(db, projectId);
      const base = { projectId, sessionId, generation: 1, engineId: 'claude', source: 'cli-roster', confidence: 'observed' };
      assert.equal(d1.recordAttestation(db, { ...base, source: 'made-up' }).code, 'INVALID_REQUEST');
      assert.equal(d1.recordAttestation(db, { ...base, confidence: 'made-up' }).code, 'INVALID_REQUEST');
      assert.equal(d1.recordAttestation(db, { ...base, generation: 0 }).code, 'INVALID_REQUEST');
    } finally {
      cleanup();
    }
  });

  it('refuses MODEL_MALFORMED for an invalid requested or observed model id', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'd1-malformed');
      const sessionId = seedSession(db, projectId);
      const base = { projectId, sessionId, generation: 1, engineId: 'claude', source: 'cli-roster', confidence: 'observed' };
      assert.equal(d1.recordAttestation(db, { ...base, requestedModel: '--not-a-model' }).code, 'MODEL_MALFORMED');
      assert.equal(d1.recordAttestation(db, { ...base, observedModel: '' }).code, 'MODEL_MALFORMED');
    } finally {
      cleanup();
    }
  });

  it('allows null requestedModel and observedModel (nothing known yet)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'd1-null-models');
      const sessionId = seedSession(db, projectId);
      const res = d1.recordAttestation(db, {
        projectId, sessionId, generation: 1, engineId: 'claude', source: 'unavailable', confidence: 'unavailable'
      });
      assert.equal(res.ok, true);
    } finally {
      cleanup();
    }
  });

  it('getAttestation returns null for a generation with no recorded row', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'd1-missing');
      const sessionId = seedSession(db, projectId);
      assert.equal(d1.getAttestation(db, { sessionId, generation: 1 }), null);
    } finally {
      cleanup();
    }
  });
});

describe('getAttestationHistory (#2985 — across session generations)', () => {
  it('returns every generation for a session, ordered oldest first', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'd1-history');
      const sessionId = seedSession(db, projectId);
      d1.recordAttestation(db, { projectId, sessionId, generation: 2, engineId: 'claude', source: 'cli-roster', confidence: 'observed' });
      d1.recordAttestation(db, { projectId, sessionId, generation: 1, engineId: 'claude', source: 'cli-roster', confidence: 'observed' });
      d1.recordAttestation(db, { projectId, sessionId, generation: 3, engineId: 'claude', source: 'cli-roster', confidence: 'observed' });
      const history = d1.getAttestationHistory(db, { sessionId });
      assert.deepEqual(history.map((r) => r.generation), [1, 2, 3]);
    } finally {
      cleanup();
    }
  });

  it('does not mix attestations across different sessions', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'd1-cross-session');
      const sessionA = seedSession(db, projectId);
      const sessionB = seedSession(db, projectId);
      d1.recordAttestation(db, { projectId, sessionId: sessionA, generation: 1, engineId: 'claude', source: 'cli-roster', confidence: 'observed' });
      d1.recordAttestation(db, { projectId, sessionId: sessionB, generation: 1, engineId: 'claude', source: 'cli-roster', confidence: 'observed' });
      assert.equal(d1.getAttestationHistory(db, { sessionId: sessionA }).length, 1);
      assert.equal(d1.getAttestationHistory(db, { sessionId: sessionB }).length, 1);
    } finally {
      cleanup();
    }
  });
});

describe('SOURCES (#2985)', () => {
  it('every value recordAttestation accepts for source is one of the declared SOURCES', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'd1-sources');
      const sessionId = seedSession(db, projectId);
      let generation = 1;
      for (const source of d1.SOURCES) {
        const res = d1.recordAttestation(db, { projectId, sessionId, generation, engineId: 'claude', source, confidence: 'unavailable' });
        assert.equal(res.ok, true, source);
        generation += 1;
      }
    } finally {
      cleanup();
    }
  });
});

describe('confidence vocabulary (#2985)', () => {
  // Intentionally NOT cross-imported from lib/v6/b4-telemetry-header.js
  // (Car V60-T2-W1-B, a separate, still-unmerged PR as of this car) — the
  // match is a documented design choice (see this module's own doc
  // comment), not a runtime dependency between two disjoint cars.
  it('CONFIDENCE_LEVELS is exactly observed/estimated/unavailable', () => {
    assert.deepEqual(d1.CONFIDENCE_LEVELS, ['observed', 'estimated', 'unavailable']);
  });
});
