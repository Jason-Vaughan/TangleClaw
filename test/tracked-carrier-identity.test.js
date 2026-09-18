'use strict';

/**
 * #1619 — a tracked instruction carrier must not carry one checkout's identity.
 *
 * The defect shipped: PR #1618 committed `TangleClaw-Builder1` into the five
 * Medusa rows of this repo's tracked `CLAUDE.md`, because generation resolved
 * the project name per checkout and the wrap classified a managed-block-only
 * carrier diff as safe maintenance and committed it without asking.
 *
 * A stale committed name that 404s is the benign case. The dangerous one is a
 * name that RESOLVES: it addresses a DIFFERENT live project, so a reader of the
 * committed bytes sends as, and reads from, another workspace's queue. Measured
 * on the host that produced this fix: the committed `TangleClaw-Builder` 404'd
 * only because Builder1 had been renamed, while `TangleClaw-Builder1` returned
 * 200.
 *
 * So the property under test is not "the name is correct" but "no name is
 * there at all" — five checkouts of one repository must produce byte-identical
 * tracked carriers, while each still addresses its own project at run time.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');
const engines = require('../lib/engines');

describe('#1619 — five checkouts, identical tracked bytes', () => {
  const checkouts = [];
  before(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1619-store-'));
    store._setBasePath(tempDir);
    store.init();
    for (let i = 1; i <= 5; i++) {
      const p = fs.mkdtempSync(path.join(os.tmpdir(), `tc-b${i}-`));
      const name = `TangleClaw-Builder${i}-${Date.now() % 100000}`;
      store.projects.create({ name, path: p, engine: 'claude' });
      checkouts.push({ name, path: p });
    }
  });

  const on = { medusaEnabled: true, rules: { core: { porthubRegistration: true } } };

  // Every generator that writes a COMMITTED carrier. `_generateOperationalBlock`
  // is the one that produced the shipped defect — a plugin-governed project's
  // tracked CLAUDE.md is spliced from it, not from `_generateClaudeMd` — so a
  // pin that reaches only the other two would leave the actual culprit free.
  const TRACKED = {
    'CLAUDE.md (ungoverned)': (c) => engines._generateClaudeMd(on, c.path),
    'CLAUDE.md (plugin-governed block)': (c) => engines._generateOperationalBlock(on, c.path),
    'AGENTS.md': (c) => engines._generateGeminiMd(on, undefined, c.path)
  };

  it('tracked carriers are byte-identical across all five', () => {
    for (const [carrier, render] of Object.entries(TRACKED)) {
      const rendered = checkouts.map(render);
      for (let i = 1; i < 5; i++) {
        assert.equal(rendered[i], rendered[0], `${carrier} differs between checkout 1 and ${i + 1}`);
      }
      for (const c of checkouts) {
        assert.ok(!rendered[0].includes(c.name), `${carrier} still names ${c.name}`);
      }
      assert.doesNotMatch(rendered[0], /https?:\/\/localhost:\d+/,
        `${carrier} still carries this machine's origin`);
    }
  });

  it('each checkout still gets its OWN identity in its private carrier', () => {
    for (const c of checkouts) {
      const priv = engines._generateCodexYaml(on, c.path);
      assert.ok(priv.includes(encodeURIComponent(c.name)) || priv.includes(c.name),
        `${c.name}: private carrier must still address its own project`);
    }
  });

  it('the capability survives the identity removal', () => {
    const md = engines._generateClaudeMd(on, checkouts[0].path);
    for (const route of ['/medusa/messages', '/medusa/read', '/medusa/send', '/medusa/roster', '/medusa/peers/']) {
      assert.ok(md.includes(route), `tracked carrier lost ${route}`);
    }
  });
});
