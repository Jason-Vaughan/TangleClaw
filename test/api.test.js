'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const BASE = 'http://localhost:3101';

function fetch(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('API: GET /api/templates', () => {
  it('returns 200 with array of templates', async () => {
    const res = await fetch('/api/templates');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 4);
  });

  it('blank is first template', async () => {
    const res = await fetch('/api/templates');
    assert.equal(res.body[0].id, 'blank');
  });
});

describe('API: GET /api/templates/:id', () => {
  it('returns 200 with template detail', async () => {
    const res = await fetch('/api/templates/node');
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 'node');
    assert.ok(Array.isArray(res.body.files));
  });

  it('returns 404 for nonexistent template', async () => {
    const res = await fetch('/api/templates/nonexistent');
    assert.equal(res.status, 404);
  });
});

describe('API: GET /api/projects', () => {
  it('returns 200 with array of projects', async () => {
    const res = await fetch('/api/projects');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length > 0);
  });

  it('first entry is root Projects Directory', async () => {
    const res = await fetch('/api/projects');
    assert.equal(res.body[0].isRoot, true);
    assert.equal(res.body[0].name, 'Projects Directory');
  });
});

describe('API: GET /api/system', () => {
  it('returns 200 with system stats', async () => {
    const res = await fetch('/api/system');
    assert.equal(res.status, 200);
    assert.ok(res.body.cpu);
    assert.ok(res.body.memory);
    assert.ok(res.body.disk);
  });
});

describe('API: POST /api/projects (validation)', () => {
  it('rejects invalid project name', async () => {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad name!' }),
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  it('rejects empty body', async () => {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

describe('API: POST /api/projects (create + cleanup)', () => {
  const testName = '_tc_api_test_' + Date.now();

  after(async () => {
    // Clean up
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(require('os').homedir(), 'Documents', 'Projects', testName);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates project and returns 201', async () => {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: testName, template: 'node', gitInit: true }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, testName);
  });
});
