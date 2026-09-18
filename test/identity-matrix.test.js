'use strict';

/**
 * #1619 — the bounded matrix the Architect's ruling specifies.
 *
 * Six runtime-data classes × four diff routes into `judge`, plus the supported
 * syntaxes and the ignored-to-indexed migration, asserted end to end through
 * `judge` → `classify` → `stageable`.
 *
 * **Bodies come from the real generator, not from copied prose.** That is the
 * ruling's mandatory half: an emitter change that alters what a private carrier
 * holds must fail this file, and it must fail without anyone remembering to
 * update a hand-typed fixture here. Where a class has no generator of its own
 * (the API origin line, the switchboard routes) the body is produced by calling
 * the generator that writes it.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const store = require('../lib/store');
const engines = require('../lib/engines');
const ownership = require('../lib/wrap-steps/_file-ownership');
const tcOwned = require('../lib/wrap-steps/_tc-owned-paths');

const MARK = { begin: '<!-- BEGIN:tangleclaw -->', end: '<!-- END:tangleclaw -->' };

/** Everything this file creates under the system temp directory, removed in `after`. */
const TEMP_ROOTS = [];

/** Bodies a legacy or older-server carrier holds, each from the code that writes it. */
function generatedBodies() {
  const rules = {
    serverProtocol: 'http',
    serverPort: 3102,
    serviceTokenEnabled: true,
    serviceToken: 'tc_live_matrix_secret',
    medusaEnabled: true,
    medusaProjectName: 'Some Other Project'
  };
  const inlineFile = path.join(os.tmpdir(), `tc-matrix-inline-${process.pid}.md`);
  fs.writeFileSync(inlineFile, '# Doc\nGET /api/health\n');
  TEMP_ROOTS.push(inlineFile);
  // A file that EXISTS on disk, so the rendering carries the install PATH and
  // not the "(file not found)" marker. Without that, the path class is caught
  // by the existence-check pattern instead and this fixture proves nothing
  // about the path — which a mutation check found it doing.
  const refFile = path.join(os.tmpdir(), `tc-matrix-ref-${process.pid}.md`);
  fs.writeFileSync(refFile, '# Ref\n');
  TEMP_ROOTS.push(refFile);
  const docs = [
    { id: 'r', name: 'Ref Doc', groupName: 'G', filePath: refFile, injectMode: 'reference' }
  ];
  // And one that does not, so the existence check has a fixture of its own.
  const missingDocs = [
    { id: 'm', name: 'Missing Doc', groupName: 'G', filePath: '/nope/does-not-exist.md', injectMode: 'reference' }
  ];
  const inlineDocs = [
    { id: 'i', name: 'Inline Doc', groupName: 'G', filePath: inlineFile, injectMode: 'inline' }
  ];

  const realCheck = store.documentLocks.check;
  store.documentLocks.check = () => ({ lockedByProject: 'another-project', expiresAt: '2026-09-18T23:00:00Z' });
  const locked = engines._buildSharedDocsSection(docs, { committedCarrier: false });
  store.documentLocks.check = () => null;
  const refPath = engines._buildSharedDocsSection(docs, { committedCarrier: false });
  const inline = engines._buildSharedDocsSection(inlineDocs, { committedCarrier: false });
  store.documentLocks.check = realCheck;

  return {
    'project name in a session route': engines._medusaSwitchboardLines(rules, 'md', { committedCarrier: false }).join('\n'),
    'machine API origin': engines._apiOriginDiscoveryLines('md', rules).join('\n'),
    'live bearer token': engines._serviceTokenAuthLines(rules, 'md', { committedCarrier: false }).join('\n'),
    'shared-document install path': refPath,
    'per-machine file-existence check': engines._buildSharedDocsSection(missingDocs, { committedCarrier: false }),
    'shared-document lock holder': locked,
    'inline shared-document body': inline
  };
}

/**
 * What current generation writes into a committed carrier — the silent case.
 *
 * This is the ASSEMBLED operational block, not a hand-picked set of emitter
 * line-sets. The distinction is not cosmetic: the assembled block also carries
 * the PortHub and shared-docs guides, and the inline-body check fired on the
 * shared-docs guide's own fenced examples — a defect that reached this repo's
 * live carrier and would have asked on every wrap, while a three-emitter
 * fixture stayed green. A counter-case that is not what generation writes
 * cannot prove generation is silent.
 *
 * @param {string} projectPath - A registered project's root.
 * @param {object} projectConfig - Its config.
 * @returns {string}
 */
function neutralBody(projectPath, projectConfig) {
  return engines._generateOperationalBlock(projectConfig, projectPath, 'CLAUDE.md');
}

const carrier = (body, prose = 'Operator notes.') =>
  `# Project\n\n${prose}\n\n${MARK.begin}\n${body}\n${MARK.end}\n`;

/**
 * @param {{file?:string, head:string|null, work:string}} spec
 * @returns {string} repo root
 */
function repoWith(spec) {
  const file = spec.file || 'CLAUDE.md';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-matrix-'));
  TEMP_ROOTS.push(dir);
  execFileSync('git', ['-C', dir, 'init', '-q']);
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  if (spec.head !== null) fs.writeFileSync(path.join(dir, file), spec.head);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed']);
  fs.writeFileSync(path.join(dir, file), spec.work);
  return dir;
}

const scopeFor = (root) => ({
  snapshotApplies: true,
  baseline: { dirty: { paths: [], truncated: false } },
  startedAtMs: 1000,
  workToplevel: root
});

const classifyOne = (root, file = 'CLAUDE.md') =>
  ownership.classify(scopeFor(root), [{ path: file, deleted: false }], {});

describe('#1619 matrix — six data classes × four routes, judge → classify → stageable', () => {
  let BODIES;
  let NEUTRAL;
  let neutralRoot;
  let neutralConfig;
  let tmpStore;

  before(() => {
    tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-matrix-store-'));
    TEMP_ROOTS.push(tmpStore);
    store._setBasePath(tmpStore);
    store.init();
    BODIES = generatedBodies();
    // A real registered project, so the assembled block is the one a real
    // carrier receives — guides included.
    neutralRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-matrix-proj-'));
    TEMP_ROOTS.push(neutralRoot);
    const project = store.projects.create({ name: `Matrix ${Date.now() % 100000}`, path: neutralRoot, engine: 'claude' });
    neutralConfig = { id: project.id, medusaEnabled: true, rules: { core: { porthubRegistration: true } } };
    NEUTRAL = neutralBody(neutralRoot, neutralConfig);
  });

  it('every class is recognised in output the generator itself produced', () => {
    // The coupling the ruling requires. If an emitter stops writing one of
    // these shapes, or starts writing a new one, this fails here — without
    // anyone having to remember a copied string in a fixture.
    for (const [label, body] of Object.entries(BODIES)) {
      assert.ok(tcOwned._carriesIdentity(body), `generator output for ${label} is not recognised as identity`);
    }
  });

  it('a document name containing an asterisk does not let its body escape', () => {
    // Narrow, and closed while the regex was open anyway: `**a*b**` is what the
    // renderer writes for a document named `a*b`, and a no-asterisk character
    // class rejects it — so the body beneath would have gone unnoticed.
    assert.equal(
      tcOwned._carriesIdentity('## Shared Documents\n\n### G\n\n**a*b**\n\n```\nbody\n```\n'),
      'an embedded shared-document body'
    );
  });

  it('every renderer that writes a machine path is covered — and a new one fails here', () => {
    // The sixth time on this change that a fix closed the site it was shown and
    // left the class. `tildeHomePath` is the only way a machine path reaches a
    // carrier, so its call sites in the renderer ARE the class — enumerate them
    // and the guard's coverage becomes checkable instead of remembered.
    const enginesSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'engines.js'), 'utf8');
    const callSites = (enginesSrc.match(/tildeHomePath\(/g) || []).length;
    assert.equal(callSites, 3,
      `lib/engines.js has ${callSites} tildeHomePath call sites; this test knows 3. `
      + 'A new one renders a machine path into a carrier: add a fixture below and a '
      + 'pattern in _IDENTITY_PATTERNS, then update this count.');

    // All three, as the renderer actually writes them.
    const unreadable = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-unreadable-'));
    TEMP_ROOTS.push(unreadable);
    // The reference fixture points at a file that EXISTS. With a missing one the
    // rendering also carries `(⚠️ file not found)`, so two patterns could
    // satisfy the assertion and the case would be right only by the order they
    // happen to sit in — the same trap `generatedBodies()` above was corrected
    // for, and the one this test was written to close.
    const refFile = path.join(os.tmpdir(), `tc-cover-ref-${process.pid}.md`);
    fs.writeFileSync(refFile, '# Ref\n');
    TEMP_ROOTS.push(refFile);
    const cases = {
      'reference line': { id: 'r', name: 'Ref', groupName: 'G', filePath: refFile, injectMode: 'reference' },
      'inline, file missing': { id: 'm', name: 'Missing', groupName: 'G', filePath: '/nope/gone.md', injectMode: 'inline' },
      'inline, unreadable': { id: 'u', name: 'Unreadable', groupName: 'G', filePath: unreadable, injectMode: 'inline' }
    };
    // Each case asserts the branch it MEANT to reach, not just that something
    // was caught. The unreadable fixture relies on `readFileSync` throwing on a
    // directory; where that does not throw, the contents land inside a fence
    // and the embedded-body check would satisfy the assertion for the wrong
    // reason — the trap this file's own comment above records, and one I would
    // otherwise have walked into while quoting it.
    // Each case names the marker that proves it reached ITS branch, and the
    // exact class the guard must return — `assert.ok` would accept any pattern
    // matching for any reason, which is how a case comes to be right by
    // accident.
    const expected = {
      'reference line': { marker: '`', klass: 'a shared-document install path' },
      'inline, file missing': { marker: 'File not found', klass: 'a shared-document path in a read-failure notice' },
      'inline, unreadable': { marker: 'Failed to read', klass: 'a shared-document path in a read-failure notice' }
    };
    for (const [label, doc] of Object.entries(cases)) {
      const body = engines._buildSharedDocsSection([doc], { committedCarrier: false });
      assert.ok(body.includes(doc.filePath) || body.includes('~/'),
        `${label}: fixture should actually render a path, or it proves nothing`);
      assert.ok(body.includes(expected[label].marker),
        `${label}: fixture did not reach the branch it names — it proves nothing about that branch`);
      assert.equal(tcOwned._carriesIdentity(body), expected[label].klass,
        `${label}: the guard must catch this for the reason this case exists`);
    }
  });

  it('an asterisk in a document name defeats neither name-matching pattern', () => {
    // Two patterns match a bold document name, and I widened one and left the
    // other — the same partial sweep that has cost this branch more than any
    // other mistake. Both are asserted here, together, so the pair cannot drift
    // apart again.
    assert.equal(
      tcOwned._carriesIdentity('- **a*b**: `/Users/someone/Docs/ref.md` — d'),
      'a shared-document install path',
      'the reference line: an asterisk in the name must not hide the install path'
    );
    assert.equal(
      tcOwned._carriesIdentity('## Shared Documents\n\n### G\n\n**a*b**\n\n```\nbody\n```\n'),
      'an embedded shared-document body',
      'the inline body: same name, same requirement'
    );
  });

  it('each pattern earns its place — including the two real output never emits alone', () => {
    // Four of the six classes are independently reachable from generator
    // output: removing any one of their patterns fails the matrix above.
    // Two are NOT — the lock line and the file-existence marker are only ever
    // emitted alongside the install path, so the path pattern catches the same
    // rendering and a mutation to either passes the matrix. That is a fact
    // about the emitter, not evidence the patterns are redundant: a future
    // rendering could carry one without the other, and defence that only works
    // when two signals coincide is not defence. They are asserted here at the
    // pattern level, which is the honest place for a check that generator
    // output cannot isolate.
    assert.match(
      tcOwned._carriesIdentity('- **Doc**: `/Users/someone/x.md` ⚠️ LOCKED by other-project (expires 2026-01-01T00:00:00Z)'),
      /path|lock/
    );
    assert.equal(
      tcOwned._carriesIdentity('⚠️ LOCKED by other-project (expires 2026-01-01T00:00:00Z)'),
      'the project holding a shared-document lock',
      'a lock line with no path must still be caught'
    );
    assert.equal(
      tcOwned._carriesIdentity('- **Doc** — a description (⚠️ file not found)'),
      'a per-machine file-existence check',
      'an existence marker with no path must still be caught'
    );
  });

  for (const route of ['block-only', 'compound', 'no-HEAD', 'malformed']) {
    it(`every class is withheld from staging via the ${route} route`, () => {
      for (const [label, body] of Object.entries(BODIES)) {
        let root;
        if (route === 'block-only') {
          root = repoWith({ head: carrier('neutral'), work: carrier(body) });
        } else if (route === 'compound') {
          root = repoWith({ head: carrier('neutral'), work: carrier(body, 'Operator notes, edited.') });
        } else if (route === 'no-HEAD') {
          root = repoWith({ head: null, work: carrier(body) });
        } else {
          // A BEGIN with no END: the region cannot be extracted at all, so the
          // contents cannot be verified. The Architect reproduced this one
          // reaching `owned` and being staged.
          root = repoWith({ head: carrier('neutral'), work: `# Project\n\n${MARK.begin}\n${body}\n` });
        }
        const c = classifyOne(root);
        assert.ok(!c.stageable.includes('CLAUDE.md'), `${label} via ${route} was stageable`);
        assert.ok(!c.owned.includes('CLAUDE.md'), `${label} via ${route} fell through to owned`);
        const asked = c.foreign.find((f) => f.path === 'CLAUDE.md');
        assert.ok(asked, `${label} via ${route} was not put to the operator`);
        assert.equal(asked.reason, 'carries-identity');
      }
    });
  }

  it('a neutral generated update still stages silently, on every supported markdown carrier', () => {
    // The counter-property, and the one the brief is strictest about: a guard
    // that asks on an ordinary wrap is a failed guard.
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'CONVENTIONS.md']) {
      const root = repoWith({ file, head: carrier('older neutral text'), work: carrier(NEUTRAL) });
      const c = classifyOne(root, file);
      assert.ok(c.stageable.includes(file), `${file}: a neutral regenerated block must stage without asking`);
      assert.ok(!c.foreign.some((f) => f.path === file), `${file}: and must not be put to the operator`);
    }
  });

  it('an authored policy example is not mistaken for identity', () => {
    // The operator's own half, and their own prose INSIDE the block for the
    // carriers where the generator splices global rules in. This repo's rules
    // document a MagicDNS link with a host and a port.
    const authored = 'Publish plans at `https://example.tail1234.ts.net:8443/plans/<id>/f.md`, never a local path.';
    const root = repoWith({
      head: carrier(`older text\n${authored}`),
      work: carrier(`${NEUTRAL}\n${authored}`)
    });
    const c = classifyOne(root);
    assert.ok(c.stageable.includes('CLAUDE.md'), 'an authored example must not block the wrap');
  });

  it('an ordinary file sharing a carrier name is left alone', () => {
    // No TangleClaw region, no provenance: not ours to refuse.
    const root = repoWith({ head: '# Notes\n\nmine\n', work: '# Notes\n\nmine, edited\n' });
    const c = classifyOne(root);
    assert.ok(!c.foreign.some((f) => f.path === 'CLAUDE.md' && f.reason === 'carries-identity'),
      'a human file with no TC region must not be refused as carrying identity');
  });

  it('a legacy whole-file generated carrier is judged whole', () => {
    // Pre-managed-block provenance: TangleClaw wrote the entire file, so the
    // entire file is ours to judge.
    const head = `# GEMINI.md — ${engines.GENERATED_HEADER_MARK}\n\nolder neutral text\n`;
    const work = `# GEMINI.md — ${engines.GENERATED_HEADER_MARK}\n\n${BODIES['machine API origin']}\n`;
    const root = repoWith({ file: 'GEMINI.md', head, work });
    const c = classifyOne(root, 'GEMINI.md');
    assert.ok(!c.stageable.includes('GEMINI.md'), 'a generated whole-file carrier carrying an origin must not stage');
    assert.equal(c.foreign.find((f) => f.path === 'GEMINI.md').reason, 'carries-identity');
  });

  it('the ignored-to-indexed migration: a private carrier newly tracked is withheld', () => {
    // Generation classified it private and wrote the live values into it; the
    // project then tracks it. There is no HEAD copy, and its content is exactly
    // what a private carrier holds.
    const root = repoWith({ file: 'CONVENTIONS.md', head: null, work: carrier(BODIES['live bearer token']) });
    const c = classifyOne(root, 'CONVENTIONS.md');
    assert.ok(!c.stageable.includes('CONVENTIONS.md'), 'a newly-tracked private carrier must not stage its token');
    assert.equal(c.foreign.find((f) => f.path === 'CONVENTIONS.md').reason, 'carries-identity');
  });

  it('an explicit operator Include still stages, and stays distinct from silent staging', () => {
    const root = repoWith({ head: carrier('neutral'), work: carrier(BODIES['machine API origin']) });
    const silent = classifyOne(root);
    assert.ok(!silent.stageable.includes('CLAUDE.md'), 'not staged on its own');
    const included = ownership.classify(scopeFor(root), [{ path: 'CLAUDE.md', deleted: false }], {
      decisions: { 'CLAUDE.md': 'include' }
    });
    assert.ok(included.stageable.includes('CLAUDE.md'), 'an explicit Include is the operator overriding, and still works');
  });

  after(() => {
    // Every temp root this file created, not just the store: each case builds a
    // git repo, and two fixture documents live in the system temp directory.
    for (const dir of TEMP_ROOTS) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});
