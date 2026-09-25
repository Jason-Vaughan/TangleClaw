'use strict';

// #1861: what the control plane tells people must match what it does. The
// reference doc and every engine's generated guide state the shell limit
// rather than implying enforcement, and the route table carries no override
// or bypass endpoint: the only audited recovery is a named operator RELEASE or
// a new operator assignment.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const engines = require('../lib/engines');
const { controlStateLine } = require('../lib/ecosystem-primer');
const { DEFAULT_PROJECT_CONFIG } = require('../lib/project-config');

const ROOT = path.join(__dirname, '..');

describe('control-state docs and guide (#1861)', () => {
  it('the reference doc states the shell limit and names every bypass', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'control-state.md'), 'utf8');
    assert.match(doc, /Direct shell mutation remains a trust boundary/);
    for (const bypass of ['--no-verify', 'core.hooksPath', 'GIT_DIR', '`gh`', '`curl`', 'gh pr merge', 'gh release', 'git tag']) {
      assert.ok(doc.includes(bypass), `the doc names the bypass ${bypass}`);
    }
    assert.match(doc, /There is no override or bypass endpoint/);
  });

  it('the guide line claims only TangleClaw-governed refusals and says shell git/gh is not blocked', () => {
    for (const format of ['md', 'comment']) {
      const text = controlStateLine(format).join(' ').replace(/\s+#\s+/g, ' ');
      assert.match(text, /cannot block shell `git`\/`gh`/);
      assert.match(text, /tc control status/);
      assert.match(text, /wins over any earlier go-ahead/);
    }
  });

  it('every engine\'s generated config carries the "Held or stopped?" guidance', () => {
    const generated = {
      'claude-md': engines._generateClaudeMd(DEFAULT_PROJECT_CONFIG, null),
      'operational-block': engines._generateOperationalBlock(DEFAULT_PROJECT_CONFIG, null),
      'codex-yaml': engines._generateCodexYaml(DEFAULT_PROJECT_CONFIG, null),
      'aider-conf': engines._generateAiderConf(DEFAULT_PROJECT_CONFIG, null),
      'gemini-md': engines._generateGeminiMd(DEFAULT_PROJECT_CONFIG, '# GEMINI.md', null)
    };
    for (const [name, text] of Object.entries(generated)) {
      const flat = String(text).replace(/\n#\s*/g, ' ');
      assert.match(flat, /tc control status/, `${name} tells the session how to see its lane`);
      assert.match(flat, /cannot block shell `git`\/`gh`/, `${name} states the shell limit`);
    }
  });
});

describe('control routes (#1861)', () => {
  it('the route table is exactly the documented control routes, with no override or bypass endpoint', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const registered = [...src.matchAll(/controlRoute\('([A-Z]+)', '([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`).sort();
    assert.deepEqual(registered, [
      'GET /api/control/assignments',
      'GET /api/control/assignments/:id',
      'GET /api/control/check',
      'GET /api/control/mine',
      'POST /api/control/assignments',
      'POST /api/control/assignments/:id/ack',
      'POST /api/control/assignments/:id/close',
      'POST /api/control/assignments/:id/exchange-closed',
      'POST /api/control/assignments/:id/hold',
      'POST /api/control/assignments/:id/release',
      'POST /api/control/assignments/:id/stop'
    ]);
    const anyControl = [...src.matchAll(/route\('[A-Z]+', '(\/api\/control[^']*)'/g)].map((m) => m[1]);
    assert.deepEqual(anyControl, [], 'every control route goes through controlRoute');
    assert.doesNotMatch(src, /\/api\/control\/[^'"`\s]*(override|bypass|force|break-?glass)/i);
  });
});
