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
      const project = store.projects.create({ name, path: p, engine: 'claude' });
      checkouts.push({ name, path: p, id: project.id });
    }

    // A shared doc, LOCKED by another project. The lock line is the churn
    // mechanism this fix removes: it names the holder and carries a wall-clock
    // expiry, so without the fix the byte-identity assertion below would fail
    // on the shared-docs section as well as on the routes. Registering one here
    // is what makes this test cover that section at all.
    const group = store.projectGroups.create({ name: `IdentityFixtureGroup ${Date.now() % 100000}` });
    for (const c of checkouts) store.projectGroups.addMember(group.id, c.id);
    const doc = store.sharedDocs.create({
      groupId: group.id,
      name: 'Fixture Doc',
      filePath: '/docs/fixture.md',
      injectIntoConfig: true,
      injectMode: 'reference'
    });
    store.documentLocks.acquire(doc.id, 999, 'a-different-project');
  });

  const on = { medusaEnabled: true, rules: { core: { porthubRegistration: true } } };

  // Every generator that writes a COMMITTED carrier. `_generateOperationalBlock`
  // is the one that produced the shipped defect — a plugin-governed project's
  // tracked CLAUDE.md is spliced from it, not from `_generateClaudeMd` — so a
  // pin that reaches only the other two would leave the actual culprit free.
  // Each checkout renders with its OWN numeric project id, so the shared-docs
  // lookup runs per checkout — the ids differ, the group does not, and the
  // bytes must still match.
  const cfg = (c) => ({ ...on, id: c.id });
  const TRACKED = {
    'CLAUDE.md (ungoverned)': (c) => engines._generateClaudeMd(cfg(c), c.path),
    'CLAUDE.md (plugin-governed block)': (c) => engines._generateOperationalBlock(cfg(c), c.path),
    'AGENTS.md': (c) => engines._generateGeminiMd(cfg(c), undefined, c.path)
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
      assert.ok(rendered[0].includes('Fixture Doc'),
        `${carrier} should still render the shared-docs section`);
      assert.doesNotMatch(rendered[0], /a-different-project/,
        `${carrier} must not name the project holding a shared-doc lock`);
    }
  });

  it('each checkout still gets its OWN identity in its private carrier', () => {
    for (const c of checkouts) {
      const priv = engines._generateCodexYaml({ ...on, id: c.id }, c.path);
      assert.ok(priv.includes(encodeURIComponent(c.name)) || priv.includes(c.name),
        `${c.name}: private carrier must still address its own project`);
    }
  });

  it('classifies by the FILE, not the generator format', () => {
    // The hazard: an operator profile pairing a shared-convention carrier with
    // a private-format generator. Before the classifier was derived, the
    // generator decided, so `CONVENTIONS.md` written by the codex generator
    // inlined the live bearer token into a tracked file. The carrier now
    // decides.
    const c = checkouts[0];
    const asPrivate = engines._generateCodexYaml(on, c.path, '.codex.yaml');
    const asShared = engines._generateCodexYaml(on, c.path, 'CONVENTIONS.md');
    assert.ok(asPrivate.includes(encodeURIComponent(c.name)) || asPrivate.includes(c.name),
      'the genuinely private carrier still addresses its own project');
    assert.ok(!asShared.includes(c.name) && !asShared.includes(encodeURIComponent(c.name)),
      'the same generator writing a SHARED carrier must not name the project');
  });

  it('an unclassified carrier fails toward shared', () => {
    // The default direction is the safety property: withholding identity from
    // a private file costs one API call, writing it into a tracked one
    // publishes it. A carrier nobody listed must land on the safe side.
    assert.equal(engines._isCommittedCarrier('SOMETHING-NEW.md'), true);
    assert.equal(engines._isCommittedCarrier(undefined), true);
    assert.equal(engines._isCommittedCarrier('.codex.yaml'), false);
    assert.equal(engines._isCommittedCarrier('.aider.conf.yml'), false);
  });

  it('the capability survives the identity removal', () => {
    const md = engines._generateClaudeMd(on, checkouts[0].path);
    for (const route of ['/medusa/messages', '/medusa/read', '/medusa/send', '/medusa/roster', '/medusa/peers/']) {
      assert.ok(md.includes(route), `tracked carrier lost ${route}`);
    }
  });
});
