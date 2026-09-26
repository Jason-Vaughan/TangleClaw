'use strict';

/*
 * #1912, ADR 0020 §9: every engine's durable config tells the session to
 * report its workload, and `tc capabilities` names the verb. The guidance
 * claims only what the composition does.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const engines = require('../lib/engines');
const { workloadLine } = require('../lib/ecosystem-primer');
const { DEFAULT_PROJECT_CONFIG } = require('../lib/project-config');

describe('workload guidance (#1912)', () => {
  it('the line names the verb, every emission point, the expiries, and that silence reads UNKNOWN', () => {
    const text = workloadLine('md').join(' ');
    assert.match(text, /tc workload set/);
    for (const point of ['dispatch acceptance', 'task transition', 'external wait', 'completion', 'before wrap', 'before exit', 'before it expires']) {
      assert.match(text, new RegExp(point), point);
    }
    // Derived from the constants the server enforces, not a copy of them.
    const { EXPIRY_MS } = require('../lib/workload-compose');
    const { STATES, CLEARANCES, WAIT_KINDS } = require('../lib/workload');
    assert.match(text, new RegExp(`${EXPIRY_MS.working / 60000} min working, ${EXPIRY_MS.complete / 60000} min otherwise`));
    assert.ok(text.includes(STATES.join('|')) && text.includes(CLEARANCES.join('|')) && text.includes(WAIT_KINDS.join('|')));
    assert.match(text, /reads UNKNOWN, never available/);
  });

  it('follows a changed expiry instead of repeating a stale one', () => {
    const compose = require('../lib/workload-compose');
    const { workloadSentence } = require('../lib/ecosystem-primer');
    const original = compose.EXPIRY_MS;
    try {
      Object.defineProperty(compose, 'EXPIRY_MS', { value: { ...original, working: 45 * 60000 }, configurable: true, writable: true });
      assert.match(workloadSentence(), /45 min working/);
    } finally {
      Object.defineProperty(compose, 'EXPIRY_MS', { value: original, configurable: true, writable: true });
    }
  });

  it('the comment form is #-prefixed and carries the same sentence', () => {
    const lines = workloadLine('comment');
    assert.ok(lines.every((l) => l.startsWith('#')));
    assert.match(lines.join(' ').replace(/\s*#\s*/g, ' '), /tc workload set/);
  });

  it('every engine\'s generated config carries it', () => {
    const generated = {
      'claude-md': engines._generateClaudeMd(DEFAULT_PROJECT_CONFIG, null),
      'operational-block': engines._generateOperationalBlock(DEFAULT_PROJECT_CONFIG, null),
      'codex-yaml': engines._generateCodexYaml(DEFAULT_PROJECT_CONFIG, null),
      'aider-conf': engines._generateAiderConf(DEFAULT_PROJECT_CONFIG, null),
      'gemini-md': engines._generateGeminiMd(DEFAULT_PROJECT_CONFIG, '# GEMINI.md', null)
    };
    for (const [name, text] of Object.entries(generated)) {
      const flat = String(text).replace(/\n#\s*/g, ' ');
      assert.match(flat, /tc workload set/, `${name} tells the session to report its workload`);
    }
  });
});

describe('the workload capability (#1912)', () => {
  it('whoami reports it for a registered project, and says why not otherwise', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const http = require('node:http');
    const store = require('../lib/store');
    const { createServer } = require('../server');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-workload-cap-'));
    store._setBasePath(tmp);
    store.init();
    const dir = path.join(tmp, 'p');
    fs.mkdirSync(dir);
    const project = store.projects.create({ name: 'cap-lane', path: dir, engine: 'claude' });
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const get = (q) => new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: server.address().port, path: `/api/tc/whoami${q}` }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve(JSON.parse(raw)));
      }).on('error', reject);
    });
    try {
      const withProject = await get(`?projectId=${project.id}`);
      const cap = withProject.capabilities.find((c) => c.id === 'workload');
      assert.ok(cap, 'workload is on the roster');
      assert.equal(cap.enabled, true);
      assert.match(cap.detail, /tc workload set/);
      const without = await get('');
      const none = (without.capabilities || []).find((c) => c.id === 'workload');
      if (none) assert.equal(none.enabled, false);
    } finally {
      await new Promise((r) => server.close(r));
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
