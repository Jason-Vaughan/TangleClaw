'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const modelStatus = require('../lib/model-status');

describe('model-status', () => {
  afterEach(() => {
    modelStatus._reset();
  });

  describe('_parseAtlassian', () => {
    it('parses operational status by component id', () => {
      const json = {
        components: [
          { id: 'abc123', name: 'Claude Code', status: 'operational' }
        ],
        status: { indicator: 'none', description: 'All Systems Operational' }
      };
      const result = modelStatus._parseAtlassian(json, { componentId: 'abc123', componentName: 'Claude Code' });
      assert.equal(result.status, 'operational');
      assert.equal(result.message, null);
    });

    it('finds component by name when id is null', () => {
      const json = {
        components: [
          { id: 'xyz', name: 'Codex', status: 'operational' }
        ],
        status: { indicator: 'none' }
      };
      const result = modelStatus._parseAtlassian(json, { componentId: null, componentName: 'Codex' });
      assert.equal(result.status, 'operational');
    });

    it('maps degraded_performance to degraded', () => {
      const json = {
        components: [
          { id: 'abc', name: 'Test', status: 'degraded_performance' }
        ],
        status: { indicator: 'minor' }
      };
      const result = modelStatus._parseAtlassian(json, { componentId: 'abc' });
      assert.equal(result.status, 'degraded');
      assert.equal(result.message, 'degraded performance');
    });

    it('maps partial_outage correctly', () => {
      const json = {
        components: [
          { id: 'abc', name: 'Test', status: 'partial_outage' }
        ],
        status: { indicator: 'major' }
      };
      const result = modelStatus._parseAtlassian(json, { componentId: 'abc' });
      assert.equal(result.status, 'partial_outage');
    });

    it('maps major_outage correctly', () => {
      const json = {
        components: [
          { id: 'abc', name: 'Test', status: 'major_outage' }
        ],
        status: { indicator: 'critical' }
      };
      const result = modelStatus._parseAtlassian(json, { componentId: 'abc' });
      assert.equal(result.status, 'major_outage');
    });

    it('falls back to page-level indicator when component not found', () => {
      const json = {
        components: [],
        status: { indicator: 'minor', description: 'Minor System Degradation' }
      };
      const result = modelStatus._parseAtlassian(json, { componentId: 'missing', componentName: 'Missing' });
      assert.equal(result.status, 'degraded');
      assert.equal(result.message, 'Minor System Degradation');
    });

    it('falls back to page-level critical indicator', () => {
      const json = {
        components: [],
        status: { indicator: 'critical', description: 'Major System Outage' }
      };
      const result = modelStatus._parseAtlassian(json, { componentId: 'missing' });
      assert.equal(result.status, 'major_outage');
    });

    it('returns unknown for empty/malformed JSON', () => {
      const result = modelStatus._parseAtlassian({}, { componentId: 'x' });
      assert.equal(result.status, 'unknown');
    });
  });

  describe('_parseGoogleIncidents', () => {
    it('returns operational when no active incidents', () => {
      const result = modelStatus._parseGoogleIncidents([], { productName: 'Gemini' });
      assert.equal(result.status, 'operational');
      assert.equal(result.message, null);
    });

    it('detects active incidents by product name', () => {
      const json = [
        {
          severity: 'medium',
          external_desc: 'Gemini API latency',
          affected_products: [{ title: 'Vertex Gemini API' }],
          most_recent_update: { status: 'ONGOING' }
        }
      ];
      const result = modelStatus._parseGoogleIncidents(json, { productName: 'Gemini' });
      assert.equal(result.status, 'partial_outage');
      assert.equal(result.message, 'Gemini API latency');
    });

    it('ignores resolved incidents', () => {
      const json = [
        {
          severity: 'high',
          external_desc: 'Resolved issue',
          affected_products: [{ title: 'Gemini CLI' }],
          most_recent_update: { status: 'RESOLVED' }
        }
      ];
      const result = modelStatus._parseGoogleIncidents(json, { productName: 'Gemini' });
      assert.equal(result.status, 'operational');
    });

    it('ignores incidents with end date', () => {
      const json = [
        {
          severity: 'high',
          external_desc: 'Past issue',
          affected_products: [{ title: 'Gemini' }],
          end: '2026-01-01T00:00:00Z',
          most_recent_update: { status: 'ONGOING' }
        }
      ];
      const result = modelStatus._parseGoogleIncidents(json, { productName: 'Gemini' });
      assert.equal(result.status, 'operational');
    });

    it('maps severity to status correctly', () => {
      const mkIncident = (severity) => [{
        severity,
        affected_products: [{ title: 'Gemini' }],
        most_recent_update: { status: 'ONGOING' }
      }];

      assert.equal(
        modelStatus._parseGoogleIncidents(mkIncident('low'), { productName: 'Gemini' }).status,
        'degraded'
      );
      assert.equal(
        modelStatus._parseGoogleIncidents(mkIncident('medium'), { productName: 'Gemini' }).status,
        'partial_outage'
      );
      assert.equal(
        modelStatus._parseGoogleIncidents(mkIncident('high'), { productName: 'Gemini' }).status,
        'major_outage'
      );
    });

    it('returns operational for unrelated product incidents', () => {
      const json = [
        {
          severity: 'high',
          affected_products: [{ title: 'Cloud Storage' }],
          most_recent_update: { status: 'ONGOING' }
        }
      ];
      const result = modelStatus._parseGoogleIncidents(json, { productName: 'Gemini' });
      assert.equal(result.status, 'operational');
    });

    it('returns unknown for non-array input', () => {
      const result = modelStatus._parseGoogleIncidents({}, { productName: 'Gemini' });
      assert.equal(result.status, 'unknown');
    });

    it('uses worst severity when multiple active incidents', () => {
      const json = [
        {
          severity: 'low',
          affected_products: [{ title: 'Gemini API' }],
          most_recent_update: { status: 'ONGOING' }
        },
        {
          severity: 'high',
          external_desc: 'Major Gemini outage',
          affected_products: [{ title: 'Gemini CLI' }],
          most_recent_update: { status: 'ONGOING' }
        }
      ];
      const result = modelStatus._parseGoogleIncidents(json, { productName: 'Gemini' });
      assert.equal(result.status, 'major_outage');
    });
  });

  describe('getStatus / getEngineStatus', () => {
    it('returns empty object initially', () => {
      assert.deepEqual(modelStatus.getStatus(), {});
    });

    it('getEngineStatus returns null for unknown engine', () => {
      assert.equal(modelStatus.getEngineStatus('nonexistent'), null);
    });
  });

  describe('startMonitor / stopMonitor', () => {
    it('starts and stops without error', () => {
      modelStatus.startMonitor([], 999999);
      modelStatus.stopMonitor();
    });

    it('handles double-start without leaking timers', () => {
      modelStatus.startMonitor([], 999999);
      modelStatus.startMonitor([], 888888);
      modelStatus.stopMonitor();
    });

    it('is idempotent on stop', () => {
      modelStatus.stopMonitor();
      modelStatus.stopMonitor();
    });
  });

  describe('_reset', () => {
    it('clears cache and stops timer', () => {
      modelStatus.startMonitor([], 999999);
      modelStatus._reset();
      assert.deepEqual(modelStatus.getStatus(), {});
    });
  });
});
