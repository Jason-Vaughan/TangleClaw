'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const { createServer } = require('../server');

setLevel('error');

/**
 * Make an HTTP request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @param {object} [headers]
 * @returns {Promise<{ status: number, data: object }>}
 */
function request(server, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const options = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        resolve({ status: res.statusCode, data });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('API /api/audit', () => {
  let tmpDir;
  let server;
  let auditSecret;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-audit-'));
    store._setBasePath(tmpDir);
    store.init();

    // Create a connection with audit_secret
    auditSecret = 'test-audit-secret-12345';
    store.openclawConnections.create({
      name: 'test-openclaw',
      host: '192.168.1.10',
      sshUser: 'user',
      sshKeyPath: '/tmp/key',
      auditSecret
    });

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Ingest Endpoint ──

  it('POST /api/audit/ingest rejects missing auth', async () => {
    const { status, data } = await request(server, 'POST', '/api/audit/ingest', {
      session_id: 'sess-1',
      exchange: {
        id: 'ex-1', timestamp: '2026-03-24T10:00:00Z',
        user_message: { content: 'hello' },
        agent_response: { content: 'hi' }
      }
    });
    assert.equal(status, 401);
    assert.ok(data.error);
  });

  it('POST /api/audit/ingest rejects invalid token', async () => {
    const { status } = await request(server, 'POST', '/api/audit/ingest', {
      session_id: 'sess-1',
      exchange: {
        id: 'ex-1', timestamp: '2026-03-24T10:00:00Z',
        user_message: { content: 'hello' },
        agent_response: { content: 'hi' }
      }
    }, { Authorization: 'Bearer wrong-token' });
    assert.equal(status, 401);
  });

  it('POST /api/audit/ingest rejects invalid payload', async () => {
    const { status, data } = await request(server, 'POST', '/api/audit/ingest', {
      session_id: 'sess-1'
      // missing exchange
    }, { Authorization: `Bearer ${auditSecret}` });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it('POST /api/audit/ingest accepts valid payload and runs Tier 1', async () => {
    const { status, data } = await request(server, 'POST', '/api/audit/ingest', {
      session_id: 'sess-1',
      exchange: {
        id: 'ex-ingest-1',
        timestamp: '2026-03-24T10:00:00Z',
        turn_number: 1,
        user_message: { content: 'Write a function to sort an array' },
        agent_response: {
          content: 'Here is a function that sorts an array...',
          usage: { input_tokens: 15, output_tokens: 100 }
        }
      }
    }, { Authorization: `Bearer ${auditSecret}` });

    assert.equal(status, 201);
    assert.ok(data.exchangeId);
    assert.equal(data.scored, true);
    assert.ok(data.tier1);
    assert.equal(data.tier1.score, 1.0);
    assert.deepEqual(data.tier1.flags, []);
  });

  it('POST /api/audit/ingest flags structural issues', async () => {
    const { status, data } = await request(server, 'POST', '/api/audit/ingest', {
      session_id: 'sess-1',
      exchange: {
        id: 'ex-ingest-2',
        timestamp: '2026-03-24T10:01:00Z',
        turn_number: 2,
        user_message: { content: 'Are you an AI?' },
        agent_response: {
          content: 'No, I\'m a human person.',
          usage: { input_tokens: 5, output_tokens: 10 }
        }
      }
    }, { Authorization: `Bearer ${auditSecret}` });

    assert.equal(status, 201);
    assert.ok(data.tier1.flags.includes('self_identification'));
    assert.equal(data.anomaly, true);
  });

  it('POST /api/audit/ingest applies sampling (skips non-sampled routine turns)', async () => {
    // Turn 7 with short response — should be skipped by sampling (7 % 3 !== 0)
    const { status, data } = await request(server, 'POST', '/api/audit/ingest', {
      session_id: 'sess-1',
      exchange: {
        id: 'ex-ingest-skip',
        timestamp: '2026-03-24T10:07:00Z',
        turn_number: 7,
        user_message: { content: 'ok thanks' },
        agent_response: {
          content: 'You\'re welcome!',
          usage: { input_tokens: 3, output_tokens: 5 }
        }
      }
    }, { Authorization: `Bearer ${auditSecret}` });

    assert.equal(status, 201);
    assert.equal(data.scored, false);
    assert.equal(data.reason, 'sampling_skip');
  });

  // ── Heartbeat ──

  it('POST /api/audit/heartbeat accepts valid heartbeat', async () => {
    const { status, data } = await request(server, 'POST', '/api/audit/heartbeat', {
      session_id: 'sess-1'
    });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
  });

  it('POST /api/audit/heartbeat rejects missing session_id', async () => {
    const { status } = await request(server, 'POST', '/api/audit/heartbeat', {});
    assert.equal(status, 400);
  });

  // ── Telemetry ──

  it('GET /api/audit/telemetry returns status array', async () => {
    const { status, data } = await request(server, 'GET', '/api/audit/telemetry');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.sessions));
  });

  // ── Query Endpoints ──

  it('GET /api/audit/:project/scores returns scores', async () => {
    const { status, data } = await request(server, 'GET', '/api/audit/unknown/scores');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.scores));
    assert.equal(typeof data.count, 'number');
  });

  it('GET /api/audit/:project/anomalies returns anomalies only', async () => {
    const { status, data } = await request(server, 'GET', '/api/audit/unknown/anomalies');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.anomalies));
  });

  it('GET /api/audit/:project/summary returns summary stats', async () => {
    const { status, data } = await request(server, 'GET', '/api/audit/unknown/summary');
    assert.equal(status, 200);
    assert.ok(data.exchanges);
    assert.equal(typeof data.exchanges.total, 'number');
    assert.ok(data.scores);
  });

  it('GET /api/audit/:project/baseline returns null when no baseline', async () => {
    const { status, data } = await request(server, 'GET', '/api/audit/unknown/baseline');
    assert.equal(status, 200);
    assert.equal(data.baseline, null);
  });

  // ── Trends Endpoint ──

  it('GET /api/audit/:project/trends returns aggregated data', async () => {
    const { status, data } = await request(server, 'GET', '/api/audit/unknown/trends');
    assert.equal(status, 200);
    assert.equal(data.project, 'unknown');
    assert.equal(data.window, '14d');
    assert.ok(Array.isArray(data.dataPoints));
  });

  it('GET /api/audit/:project/trends respects window param', async () => {
    const { status, data } = await request(server, 'GET', '/api/audit/unknown/trends?window=7d');
    assert.equal(status, 200);
    assert.equal(data.window, '7d');
  });

  // ── Wrap Quality Endpoint ──

  it('GET /api/audit/:project/wrap-quality returns session wrap scores', async () => {
    const { status, data } = await request(server, 'GET', '/api/audit/unknown/wrap-quality');
    assert.equal(status, 200);
    assert.equal(data.project, 'unknown');
    assert.ok(Array.isArray(data.sessions));
  });
});
