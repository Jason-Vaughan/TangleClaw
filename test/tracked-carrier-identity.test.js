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
    // With the project id, so the shared-docs section is actually rendered —
    // without it the shared-doc assertions below would pass on an empty section.
    const asPrivate = engines._generateCodexYaml(cfg(c), c.path, '.codex.yaml');
    const asShared = engines._generateCodexYaml(cfg(c), c.path, 'CONVENTIONS.md');
    assert.ok(asPrivate.includes(encodeURIComponent(c.name)) || asPrivate.includes(c.name),
      'the genuinely private carrier still addresses its own project');
    assert.ok(!asShared.includes(c.name) && !asShared.includes(encodeURIComponent(c.name)),
      'the same generator writing a SHARED carrier must not name the project');
    // Checking only the NAME let four other leaks through the same door: three
    // reviewers found that this generator's origin and shared-docs sinks never
    // consulted the classifier at all, so those assertions passed vacuously.
    // Assert every value the classifier is supposed to withhold.
    assert.doesNotMatch(asShared, /https?:\/\/localhost:\d+/,
      'a shared carrier must not carry this install origin, whatever generator writes it');
    assert.ok(!asShared.includes('/docs/fixture.md'),
      'nor a shared-doc install path');
    assert.doesNotMatch(asShared, /LOCKED by /,
      'nor the project holding a shared-doc lock');
    assert.ok(asPrivate.includes('/docs/fixture.md'),
      'while the genuinely private carrier keeps the path it is entitled to');
    assert.match(asPrivate, /https?:\/\/localhost:\d+/,
      'and the literal origin');
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

  it('stays byte-identical when the API ORIGIN varies too', () => {
    // The Architect's gap: varying name and root proves less than it looks,
    // because the origin is read from config rather than from the project. A
    // carrier that embedded the origin would pass a name/root-only test and
    // still differ between two installs.
    const renderAll = () => Object.fromEntries(
      Object.entries(TRACKED).map(([k, render]) => [k, render(checkouts[0])])
    );
    const before = renderAll();
    const saved = store.config.load();
    try {
      store.config.save({ ...saved, ingressMode: 'direct', httpsEnabled: false, httpsCertPath: null, httpsKeyPath: null, serverPort: 3999 });
      const afterPort = renderAll();
      store.config.save({ ...saved, ingressMode: 'direct', httpsEnabled: true, httpsCertPath: '/c.pem', httpsKeyPath: '/k.pem', serverPort: 4567 });
      const afterScheme = renderAll();
      for (const carrier of Object.keys(TRACKED)) {
        assert.equal(afterPort[carrier], before[carrier], `${carrier} changed when the port changed`);
        assert.equal(afterScheme[carrier], before[carrier], `${carrier} changed when the scheme and port changed`);
      }
    } finally {
      store.config.save(saved);
    }
  });

  it('the governed write path produces the same neutral bytes end to end', () => {
    // Not the generator in isolation: writeEngineConfig is what actually put
    // TangleClaw-Builder1 into main, through the managed-block splice.
    const claudeProfile = store.engines.get('claude');
    const written = checkouts.slice(0, 2).map((c) => {
      const res = engines.writeEngineConfig('claude', c.path, { ...on, id: c.id }, claudeProfile);
      assert.equal(res.written, true, 'the carrier should be written');
      return fs.readFileSync(res.configFilePath, 'utf8');
    });
    assert.equal(written[1], written[0], 'two checkouts wrote different bytes');
    for (const c of checkouts.slice(0, 2)) {
      assert.ok(!written[0].includes(c.name), `the written carrier names ${c.name}`);
    }
  });

  it('the capability survives the identity removal', () => {
    const md = engines._generateClaudeMd(on, checkouts[0].path);
    for (const route of ['/medusa/messages', '/medusa/read', '/medusa/send', '/medusa/roster', '/medusa/peers/']) {
      assert.ok(md.includes(route), `tracked carrier lost ${route}`);
    }
  });
});
