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

  // Both private-format generators, because the previous version of this pin
  // exercised only the codex one — and the slip it missed was in the aider one,
  // whose shared-docs body iterated the identity-bearing rendering while its
  // guard consulted the derived selection.
  const PRIVATE_FORMAT = {
    codex: { render: (c, carrier) => engines._generateCodexYaml(cfg(c), c.path, carrier), own: '.codex.yaml' },
    aider: { render: (c, carrier) => engines._generateAiderConf(cfg(c), c.path, carrier), own: '.aider.conf.yml' }
  };

  it('classifies by the FILE, not the generator format — for EVERY private-format generator', () => {
    const c = checkouts[0];
    for (const [label, gen] of Object.entries(PRIVATE_FORMAT)) {
      const asPrivate = gen.render(c, gen.own);
      const asShared = gen.render(c, 'CONVENTIONS.md');
      // Present on the side entitled to it...
      assert.ok(asPrivate.includes('/docs/fixture.md'), `${label}: private carrier should keep the doc path`);
      assert.match(asPrivate, /https?:\/\/localhost:\d+/, `${label}: private carrier should keep the origin`);
      assert.match(asPrivate, /LOCKED by /, `${label}: private carrier should keep the lock holder`);
      // ...and absent on the side that is committed, whatever generator wrote it.
      assert.ok(!asShared.includes(c.name) && !asShared.includes(encodeURIComponent(c.name)),
        `${label}: a shared carrier must not name the project`);
      assert.doesNotMatch(asShared, /https?:\/\/localhost:\d+/,
        `${label}: a shared carrier must not carry the install origin`);
      assert.ok(!asShared.includes('/docs/fixture.md'),
        `${label}: a shared carrier must not carry a shared-doc install path`);
      assert.doesNotMatch(asShared, /LOCKED by /,
        `${label}: a shared carrier must not name the project holding a lock`);
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

describe('#1619 — a managed block is not proof that a diff is safe maintenance', () => {
  const owned = require('../lib/wrap-steps/_tc-owned-paths');

  describe('_carriesIdentity', () => {
    it('is silent on a block generated after the fix', () => {
      // The property the fix brief requires: the guard must not turn every
      // ordinary wrap into a question. A post-#1619 block carries placeholders,
      // not values, so it matches nothing.
      const neutral = [
        'Routes, with `<base>` = `<api>/api/sessions/<project-name>`:',
        'send `POST <base>/medusa/send` with `{"to": "<workspace-id>", "message": "..."}`',
        '`<api>` — the `TANGLECLAW_API` your launch exported.',
        'Fetch it from `$TANGLECLAW_API/api/service-token` and send it as `Authorization: Bearer <token>`.'
      ].join('\n');
      assert.equal(owned._carriesIdentity(neutral), null);
    });

    it('names each value a committed carrier must not hold', () => {
      assert.match(owned._carriesIdentity('base URL: http://localhost:3102'), /origin/);
      assert.match(owned._carriesIdentity('GET http://h/api/sessions/TangleClaw-Builder1/medusa/roster'), /route/);
      assert.match(owned._carriesIdentity('Authorization: Bearer tc_live_abcdef123456'), /token/);
    });

    it('does not read the token PLACEHOLDER as a live credential', () => {
      // The pointer the committed carrier is supposed to contain says
      // `Authorization: Bearer <token>`. Flagging it would fire on the fixed
      // state, which is the opposite of the intent.
      assert.equal(owned._carriesIdentity('send it as `Authorization: Bearer <token>`'), null);
    });

    it('tolerates a missing or non-string block', () => {
      assert.equal(owned._carriesIdentity(null), null);
      assert.equal(owned._carriesIdentity(''), null);
      assert.equal(owned._carriesIdentity(42), null);
    });
  });

  it('judges the BLOCK, not the whole carrier', () => {
    // Caught in development, and it would have fired on every wrap in this very
    // repo: the hand-maintained half of CLAUDE.md documents a MagicDNS link
    // with a host and a port, as an example, in the global-rules mirror. That
    // half is the operator's. Scanning it would make the guard permanent noise.
    const markers = engines.managedBlockMarkers('markdown');
    const carrier = [
      '# CLAUDE.md',
      '',
      'Hand-authored: publish plans at `https://example.tail1234.ts.net:8443/plans/<id>/f.md`.',
      '',
      markers.begin,
      'Routes: `<api>/api/sessions/<project-name>/medusa/send` — resolve at run time.',
      markers.end,
      ''
    ].join('\n');
    const block = require('../lib/managed-block').extractManagedBlock(carrier, markers);
    assert.equal(owned._carriesIdentity(carrier), 'a machine-specific API origin',
      'the whole-file read sees the operator\'s example — which is why it is not what we judge');
    assert.equal(owned._carriesIdentity(block), null,
      'the block is what TangleClaw owns, and it is clean');
  });
});
