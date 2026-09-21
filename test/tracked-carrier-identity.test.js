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
      // A real repository that ignores its engine-private carriers, which is
      // what a managed project actually looks like. Before the git-backed
      // classifier these were bare directories, and the private-carrier
      // assertions below passed on the conventional list rather than on any
      // project's real state.
      require('node:child_process').execFileSync('git', ['-C', p, 'init', '-q']);
      fs.writeFileSync(path.join(p, '.gitignore'), '.codex.yaml\n.aider.conf.yml\n');
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
    // Varying name and root proves less than it looks: the origin is read from
    // config rather than from the project, so a carrier that embedded it would
    // pass a name/root-only test and still differ between two installs.
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
      // The origin is matched on the LABELLED line generation writes, in both
      // its markdown and comment forms — not on "a URL appears somewhere".
      assert.match(owned._carriesIdentity('**TangleClaw API base URL**: `http://localhost:3102`'), /origin/);
      assert.match(owned._carriesIdentity('# TangleClaw API base URL: http://localhost:3102'), /origin/);
      assert.match(owned._carriesIdentity('GET http://h/api/sessions/TangleClaw-Builder1/medusa/roster'), /route/);
      assert.match(owned._carriesIdentity('Authorization: Bearer tc_live_abcdef123456'), /token/);
    });

    it('does not read a documentation URL as a leak', () => {
      // The reason the patterns are shaped rather than broad. The Gemini
      // generator pushes the operator's global rules INSIDE the AGENTS.md
      // managed block, and this install's rules document a MagicDNS link with a
      // host and a port as an example. A bare origin pattern reads that as a
      // leak and fires on every ordinary wrap of every antigravity project —
      // the outcome the fix brief forbids. Scoping to the block does not save
      // it, because for THIS carrier the prose is inside the block.
      const globalRulesExample = 'Published links must use the MagicDNS format '
        + '(e.g. `https://cursatory.tail123678.ts.net:8443/plans/<projectId>/<file>.md`).';
      assert.equal(owned._carriesIdentity(globalRulesExample), null);
      // And the neutral pointer the fixed carrier actually contains.
      assert.equal(owned._carriesIdentity(
        '**TangleClaw API base URL**: read it from the `TANGLECLAW_API` environment variable'
      ), null);
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
    assert.equal(owned._carriesIdentity(block), null,
      'the block is what TangleClaw owns, and it is clean');
    // Both defences are needed and neither is sufficient alone: scoping keeps
    // the operator's half of CLAUDE.md out of scope, and the shaped patterns
    // keep their prose out of scope where it sits INSIDE the block, as the
    // global rules do for AGENTS.md.
    const withGeneratedOrigin = carrier.replace(
      'Routes: `<api>/api/sessions/<project-name>/medusa/send` — resolve at run time.',
      '**TangleClaw API base URL**: `http://localhost:3102`'
    );
    assert.equal(
      owned._carriesIdentity(require('../lib/managed-block').extractManagedBlock(withGeneratedOrigin, markers)),
      'a machine-specific API origin',
      'a real generated origin inside the block is still caught'
    );
  });
});

describe('#1619 chunk 04 — the carrier a project actually tracks', () => {
  const { execFileSync } = require('node:child_process');

  /**
   * A real git repo whose `.gitignore` is the argument.
   * @param {string} ignoreBody
   * @returns {string} repo path
   */
  function repoWithIgnore(ignoreBody) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-carrier-'));
    execFileSync('git', ['-C', dir, 'init', '-q']);
    fs.writeFileSync(path.join(dir, '.gitignore'), ignoreBody);
    return dir;
  }

  it('a project that TRACKS its .codex.yaml gets no identity in it', () => {
    // The gate. `PRIVATE_ENGINE_CARRIERS` encodes THIS repo's convention, and
    // for a project that departs from it the list is simply wrong: it would
    // call a tracked file private and keep writing the project name, the
    // machine origin and — where the gate is on — a live bearer token into a
    // file destined for the repository. Only the project's own git knows.
    const tracking = repoWithIgnore('node_modules/\n');
    const ignoring = repoWithIgnore('.codex.yaml\n');

    assert.equal(engines._carrierIsCommitted(ignoring, '.codex.yaml'), false,
      'a project that ignores it keeps its private carrier private');
    assert.equal(engines._carrierIsCommitted(tracking, '.codex.yaml'), true,
      'a project that tracks it must have it treated as committed');
  });

  it('treats an unknown tracking state as committed — missing git is not a non-repository', () => {
    // This replaces a test that pinned the opposite, and the reasoning it
    // pinned was wrong: it read "git cannot answer here" as "nothing here can
    // be committed". A project that TRACKS its .codex.yaml is a repository
    // whose git is merely unavailable — break PATH and the old fallback called
    // that tracked file private and inlined the live token into it. The two
    // error directions are not comparable: one costs an API call, the other
    // puts a credential in a repository.
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-norepo-'));
    assert.equal(engines._carrierIsCommitted(notARepo, '.codex.yaml'), true,
      'git cannot answer here, so the carrier is treated as committed');
    assert.equal(engines._carrierIsCommitted(notARepo, 'CLAUDE.md'), true);
    assert.equal(engines._carrierIsCommitted(notARepo, 'SOMETHING-NEW.md'), true);
    // Only a positive "yes, ignored" makes a carrier private. The convention
    // still answers when there is no project to ask about at all.
    assert.equal(engines._carrierIsCommitted(null, '.codex.yaml'), false);
  });

  it('a carrier that is INDEXED and then ignored is still committed', () => {
    // Writing a .gitignore proves nothing about a file already in the index.
    // Git does not apply ignore rules to a
    // tracked file, so `check-ignore` answers "not ignored" and the carrier
    // lands on committed — verified here rather than assumed, because the
    // whole classifier rests on that behaviour.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-indexed-'));
    execFileSync('git', ['-C', dir, 'init', '-q']);
    fs.writeFileSync(path.join(dir, '.codex.yaml'), 'seed\n');
    execFileSync('git', ['-C', dir, 'add', '.codex.yaml']);
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed']);
    fs.writeFileSync(path.join(dir, '.gitignore'), '.codex.yaml\n');
    assert.equal(engines._carrierIsCommitted(dir, '.codex.yaml'), true,
      'a tracked carrier stays committed however the ignore file reads');
  });
});

describe('#1619 chunk 04 — a nested worktree', () => {
  const { execFileSync } = require('node:child_process');

  it('classifies by the carrier inside a linked worktree the same way', () => {
    // Parent-directory instruction loading means a worktree can sit inside
    // another checkout, and `git -C <worktree> check-ignore` must answer for
    // the worktree's own ignore rules rather than the parent's.
    const main = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wt-main-'));
    execFileSync('git', ['-C', main, 'init', '-q']);
    fs.writeFileSync(path.join(main, '.gitignore'), '.codex.yaml\n');
    fs.writeFileSync(path.join(main, 'seed.txt'), 'seed\n');
    execFileSync('git', ['-C', main, 'add', '-A']);
    execFileSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed']);

    const wt = path.join(main, 'nested-wt');
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'wt', wt]);

    assert.equal(engines._carrierIsCommitted(wt, '.codex.yaml'), false,
      'the worktree inherits the ignore rule, so its private carrier stays private');
    assert.equal(engines._carrierIsCommitted(wt, 'CLAUDE.md'), true,
      'and its tracked carrier is still treated as committed');
  });
});

describe('#1619 — the committed carrier may only point at routes that answer', () => {
  /**
   * Every `$TANGLECLAW_API/...` path the generated section names.
   * @param {string} text
   * @returns {string[]}
   */
  function routesNamed(text) {
    return [...text.matchAll(/\$TANGLECLAW_API(\/api\/[A-Za-z0-9/_<>$-]*)/g)]
      .map((m) => m[1])
      .map((r) => r.replace(/<[^>]+>|\$TANGLECLAW_PROJECT_ID/g, ':p'))
      .filter((r, i, a) => a.indexOf(r) === i);
  }

  it('names no route the server does not serve', () => {
    // A pointer is an instruction, and an instruction to a 404 is worse than
    // no instruction: the natural fallback from a 404 here was the BARE
    // `/api/shared-docs`, which is unfiltered and answers with every group's
    // documents and absolute paths across the install. The fix's own prose
    // sent the reader there, which is how a redirect became a leak.
    const section = engines._buildSharedDocsSection(
      [{ id: 'x', name: 'D', groupName: 'G', filePath: '/p/d.md', injectMode: 'reference' }],
      { committedCarrier: true }
    );
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    for (const route of routesNamed(section)) {
      // `/api/groups/:p/members` is registered as `/api/groups/:id/members`;
      // compare on the literal segments, which is what decides the match.
      const literal = route.split('/').filter((seg) => seg && !seg.startsWith(':'));
      const registered = new RegExp(`['\`"]/${literal.map((x) => x.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('/[^\'"\`]*')}`);
      assert.match(server, registered, `the carrier names ${route}, which server.js does not serve`);
    }
  });

  it('the route check rejects a route the server does not serve', () => {
    // Guard against the pin passing vacuously: the regex must actually fail on
    // the route that bypassed the guard.
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.doesNotMatch(server, /['`"]\/api\/projects\/[^'"`]*\/group['"`]/,
      'if this ever starts matching, the check below proves less than it claims');
    assert.match(server, /['`"]\/api\/groups['"`]/, 'and the route we DO name is served');
  });

  it('tells the reader to stop rather than issue the unfiltered request', () => {
    const section = engines._buildSharedDocsSection(
      [{ id: 'x', name: 'D', groupName: 'G', filePath: '/p/d.md', injectMode: 'reference' }],
      { committedCarrier: true }
    );
    assert.match(section, /ALWAYS send `groupId`/);
    assert.match(section, /say so and stop rather than issuing the bare request/);
  });
});

describe('#1626 — the carrier tells the reader to send its project binding', () => {
  const section = engines._buildSharedDocsSection(
    [{ id: 'x', name: 'D', groupName: 'G', filePath: '/p/d.md', injectMode: 'reference' }],
    { committedCarrier: true }
  );

  it('names both binding headers with the env vars that carry them', () => {
    // The server scopes shared-docs and groups answers to the project a launch
    // id resolves to; a reader told only the routes would call them unbound.
    assert.ok(section.includes('x-tangleclaw-project-id: $TANGLECLAW_PROJECT_ID'));
    assert.ok(section.includes('x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID'));
  });

  it('carries only the variable names, never a launch-time value', () => {
    // The carrier is tracked and shared by every checkout: a real launch id
    // written here would bind every reader to one session.
    assert.doesNotMatch(section, /x-tangleclaw-launch-id: (?!\$TANGLECLAW_LAUNCH_ID)/);
    assert.doesNotMatch(section, /x-tangleclaw-project-id: (?!\$TANGLECLAW_PROJECT_ID)/);
  });

  it('the static guide names the same binding, for engine-private configs', () => {
    const guide = fs.readFileSync(path.join(__dirname, '..', 'data', 'shared-docs-guide.md'), 'utf8');
    assert.match(guide, /### Identify Your Project/);
    assert.ok(guide.includes('x-tangleclaw-project-id: $TANGLECLAW_PROJECT_ID'));
    assert.ok(guide.includes('x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID'));
  });

  it('the header names match what the resolver reads', () => {
    const access = require('../lib/shared-docs-access');
    assert.ok(section.includes(access.PROJECT_HEADER));
    assert.ok(section.includes(access.LAUNCH_HEADER));
  });
});

describe('#1619 — "unclassified fails toward shared" is a property, not a construction', () => {
  const rules = {
    serviceTokenEnabled: true,
    serviceToken: 'tc_live_secret_for_test',
    serverProtocol: 'http',
    serverPort: 3102,
    medusaEnabled: true,
    medusaProjectName: 'Some Project'
  };

  // The module states this rule in its own comment, and until now it held by
  // construction — every caller happened to pass the flag. An object-shaped
  // default (`options = { committedCarrier: true }`) does not cover `{}`, which
  // is the shape a future caller is most likely to reach for.
  for (const [label, args] of [
    ['omitted', []],
    ['empty object', [{}]],
    ['explicit true', [{ committedCarrier: true }]]
  ]) {
    it(`withholds the live token when the classification is ${label}`, () => {
      const out = engines._serviceTokenAuthLines(rules, 'md', ...args).join('\n');
      assert.ok(!out.includes(rules.serviceToken), 'a live credential must not reach an unclassified carrier');
      assert.match(out, /\/api\/service-token/, 'and the fetch pointer takes its place');
    });

    it(`withholds the project name when the classification is ${label}`, () => {
      const out = engines._medusaSwitchboardLines(rules, 'md', ...args).join('\n');
      assert.ok(!out.includes(rules.medusaProjectName), 'an unclassified carrier must not be named at');
      assert.doesNotMatch(out, /https?:\/\/localhost:\d+/, 'nor carry the install origin');
    });
  }

  it('still inlines for a carrier explicitly classified private', () => {
    const out = engines._serviceTokenAuthLines(rules, 'md', { committedCarrier: false }).join('\n');
    assert.ok(out.includes(rules.serviceToken), 'the private carrier keeps what it is entitled to');
  });
});

describe('#1619 — the git probe is bounded and its failure is visible', () => {
  it('falls back to the convention when git cannot be run, rather than throwing', () => {
    // `spawnSync` REPORTS ENOENT on `error` instead of throwing, which is how a
    // host without git on PATH would have fallen back to the pre-fix hardcoded
    // list in silence. The seam lets the failure be exercised rather than
    // assumed — this host's PATH really is stale, so it is not hypothetical.
    const saved = engines._internal.checkIgnore;
    try {
      engines._internal.checkIgnore = () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); };
      // Every carrier, including the conventionally-private one: a repository
      // whose git is missing is still a repository.
      assert.equal(engines._carrierIsCommitted('/repo', '.codex.yaml'), true,
        'an unavailable git must not be read as "this file is private"');
      assert.equal(engines._carrierIsCommitted('/repo', 'CLAUDE.md'), true);
      assert.equal(engines._carrierIsCommitted('/repo', 'SOMETHING-NEW.md'), true);
    } finally {
      engines._internal.checkIgnore = saved;
    }
  });

  it('treats a timed-out probe as "git did not answer", not as "not ignored"', () => {
    // spawnSync returns status null on timeout. Reading that as 1 would call
    // every private carrier committed; reading it as 0 would call every
    // committed carrier private. It is neither — it is unknown.
    const saved = engines._internal.checkIgnore;
    try {
      engines._internal.checkIgnore = () => null;
      assert.equal(engines._carrierIsCommitted('/repo', '.codex.yaml'), true,
        'a timed-out probe is an unknown state, and unknown means committed');
      assert.equal(engines._carrierIsCommitted('/repo', 'CLAUDE.md'), true);
    } finally {
      engines._internal.checkIgnore = saved;
    }
  });
});

describe('#1619 — a locked shared doc must not change the committed carrier', () => {
  const store2 = require('../lib/store');

  it('is byte-identical across unlocked → locked → unlocked', () => {
    // Emitting a warning only WHILE a lock exists makes the shared bytes depend
    // on live state: the same
    // document unlocked and then locked produces two different files. That is
    // the churn this fix removes, one step quieter than naming the holder —
    // and a carrier that changes when someone else takes a lock is a carrier
    // the wrap can be asked to commit for a reason that is not the project's.
    const doc = { id: 'lk1', name: 'Locked Fixture', groupName: 'G', filePath: '/p/lk.md', injectMode: 'reference' };
    const realCheck = store2.documentLocks.check;
    try {
      store2.documentLocks.check = () => null;
      const unlockedBefore = engines._buildSharedDocsSection([doc], { committedCarrier: true });
      store2.documentLocks.check = () => ({ lockedByProject: 'another-project', expiresAt: '2026-09-18T23:00:00Z' });
      const whileLocked = engines._buildSharedDocsSection([doc], { committedCarrier: true });
      store2.documentLocks.check = () => null;
      const unlockedAfter = engines._buildSharedDocsSection([doc], { committedCarrier: true });

      assert.equal(whileLocked, unlockedBefore, 'taking a lock changed the committed carrier');
      assert.equal(unlockedAfter, unlockedBefore, 'releasing it changed the committed carrier');
      assert.doesNotMatch(unlockedBefore, /another-project/, 'and the holder is never named');
      assert.match(unlockedBefore, /Lock before editing/,
        'the instruction survives as unconditional prose, since it is always true');

      // The private carrier keeps live, actionable detail — that is the point
      // of the split, and a fix that blanked both sides would be a loss.
      store2.documentLocks.check = () => ({ lockedByProject: 'another-project', expiresAt: '2026-09-18T23:00:00Z' });
      const priv = engines._buildSharedDocsSection([doc], { committedCarrier: false });
      assert.match(priv, /LOCKED by another-project/, 'the private carrier still reports the live holder');
    } finally {
      store2.documentLocks.check = realCheck;
    }
  });
});
