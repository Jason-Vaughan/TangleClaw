'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const e1 = require('../lib/v6/e1-doc-planes-context-compiler');

// v6 (#1151, V6-13 / E1 & E3, Car V60-T2-W1-C): the 4-plane classifier, the
// write-boundary guard, the budgeted context-assembly compiler, the SSOT
// index generator/validator, and the two sprint/wave tracker helpers.

describe('classifyPlane (#1151)', () => {
  it('classifies product-plane paths', () => {
    assert.equal(e1.classifyPlane('README.md'), 'product');
    assert.equal(e1.classifyPlane('docs/product/intro.md'), 'product');
    assert.equal(e1.classifyPlane('docs/getting-started.md'), 'product');
    assert.equal(e1.classifyPlane('docs/security.md'), 'product');
  });

  it('classifies maintainer-plane paths', () => {
    assert.equal(e1.classifyPlane('CLAUDE.md'), 'maintainer');
    assert.equal(e1.classifyPlane('docs/adr/0001-foo.md'), 'maintainer');
    assert.equal(e1.classifyPlane('docs/architecture/overview.md'), 'maintainer');
    assert.equal(e1.classifyPlane('docs/v6-documentation-planes.md'), 'maintainer');
  });

  it('classifies operational-memory-plane paths', () => {
    assert.equal(e1.classifyPlane('.tangleclaw/memories/MEMORY.md'), 'operational-memory');
    assert.equal(e1.classifyPlane('.tangleclaw/handoff/notes.md'), 'operational-memory');
    assert.equal(e1.classifyPlane('.prawduct/.handoff-notes.md'), 'operational-memory');
    assert.equal(e1.classifyPlane('changelog.d/1151.added.md'), 'operational-memory');
    assert.equal(e1.classifyPlane('CHANGELOG.md'), 'operational-memory');
    assert.equal(e1.classifyPlane('FEATURES.md'), 'operational-memory');
  });

  it('classifies any archive/ segment as historical-archive, even under docs/ or .tangleclaw/plans/', () => {
    assert.equal(e1.classifyPlane('docs/adr/archive/0022-retired.md'), 'historical-archive');
    assert.equal(e1.classifyPlane('.tangleclaw/plans/archive/old-plan.md'), 'historical-archive');
    assert.equal(e1.classifyPlane('archive/ancient.md'), 'historical-archive');
  });

  it('defaults an unrecognized path to operational-memory, the least authoritative plane', () => {
    assert.equal(e1.classifyPlane('some/unknown/path.txt'), 'operational-memory');
    assert.equal(e1.classifyPlane('random.md'), 'operational-memory');
  });

  it('every plane this module returns is one of the declared PLANES', () => {
    for (const p of ['README.md', 'CLAUDE.md', '.tangleclaw/memories/x.md', 'archive/x.md', 'unknown.txt']) {
      assert.ok(e1.PLANES.includes(e1.classifyPlane(p)), p);
    }
  });

  it('normalizes an absolute path against root to the same classification as its repo-relative form', () => {
    assert.equal(e1.classifyPlane('/repo/README.md', { root: '/repo' }), 'product');
    assert.equal(e1.classifyPlane('README.md'), e1.classifyPlane('/repo/README.md', { root: '/repo' }));
  });

  it('collapses a ".." segment BEFORE classifying, so a path that merely looks archived resolves to what it really is (PRR-A R1 HOLD)', () => {
    assert.equal(e1.classifyPlane('archive/../README.md'), 'product');
    assert.equal(e1.classifyPlane('docs/../README.md'), 'product');
    assert.equal(e1.classifyPlane('docs/adr/archive/../0001-foo.md'), 'maintainer');
  });

  it('defaults to operational-memory for a path that still escapes root after normalization', () => {
    assert.equal(e1.classifyPlane('../README.md'), 'operational-memory');
    assert.equal(e1.classifyPlane('..'), 'operational-memory');
  });
});

describe('checkWriteBoundary (#1151)', () => {
  it('refuses a write to a Plane 1 (product) path with no grant', () => {
    const res = e1.checkWriteBoundary('README.md');
    assert.equal(res.allowed, false);
    assert.equal(res.plane, 'product');
    assert.equal(res.code, 'DOC_AUTHORING_GRANT_REQUIRED');
  });

  it('refuses a write to a Plane 2 (maintainer) path with no grant', () => {
    const res = e1.checkWriteBoundary('docs/adr/0001-foo.md');
    assert.equal(res.allowed, false);
    assert.equal(res.code, 'DOC_AUTHORING_GRANT_REQUIRED');
  });

  it('allows a Plane 1 write when the grant names that exact path', () => {
    const res = e1.checkWriteBoundary('README.md', { grant: { path: 'README.md', grantedBy: 'operator' } });
    assert.equal(res.allowed, true);
    assert.equal(res.plane, 'product');
  });

  it('refuses a Plane 2 write when the grant names a DIFFERENT path', () => {
    const res = e1.checkWriteBoundary('docs/adr/0001-foo.md', { grant: { path: 'docs/adr/0002-bar.md' } });
    assert.equal(res.allowed, false);
    assert.equal(res.code, 'DOC_AUTHORING_GRANT_REQUIRED');
  });

  it('always allows a write to Plane 3 or Plane 4 paths, grant or no grant', () => {
    assert.equal(e1.checkWriteBoundary('.tangleclaw/memories/MEMORY.md').allowed, true);
    assert.equal(e1.checkWriteBoundary('archive/old.md').allowed, true);
  });

  it('refuses archive/../README.md as Plane 1 (product), not historical-archive (PRR-A R1 HOLD)', () => {
    const res = e1.checkWriteBoundary('archive/../README.md');
    assert.equal(res.allowed, false);
    assert.equal(res.plane, 'product');
    assert.equal(res.code, 'DOC_AUTHORING_GRANT_REQUIRED');
  });

  it('refuses docs/../README.md the same way', () => {
    const res = e1.checkWriteBoundary('docs/../README.md');
    assert.equal(res.allowed, false);
    assert.equal(res.plane, 'product');
  });

  it('refuses a path that still escapes root with PATH_TRAVERSAL_DENIED, plane null', () => {
    const res = e1.checkWriteBoundary('../README.md');
    assert.equal(res.allowed, false);
    assert.equal(res.plane, null);
    assert.equal(res.code, 'PATH_TRAVERSAL_DENIED');
  });

  it('a grant naming the CANONICAL path still admits a traversal-shaped but in-root target', () => {
    const res = e1.checkWriteBoundary('archive/../README.md', { grant: { path: 'README.md' } });
    assert.equal(res.allowed, true);
    assert.equal(res.plane, 'product');
  });

  it('a grant whose own path escapes root never admits anything', () => {
    const res = e1.checkWriteBoundary('README.md', { grant: { path: '../README.md' } });
    assert.equal(res.allowed, false);
    assert.equal(res.code, 'DOC_AUTHORING_GRANT_REQUIRED');
  });
});

describe('compileContextBundle (#1151)', () => {
  function readFileFrom(map) {
    return (p) => {
      if (!(p in map)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return map[p];
    };
  }

  it('includes every path when the budget is unbounded', () => {
    const files = { 'README.md': 'hello world', 'CLAUDE.md': 'rules rules rules' };
    const res = e1.compileContextBundle(Object.keys(files), { readFile: readFileFrom(files) });
    assert.equal(res.included.length, 2);
    assert.equal(res.excluded.length, 0);
    assert.equal(res.manifest.includedCount, 2);
  });

  it('excludes historical-archive paths by default', () => {
    const files = { 'README.md': 'hi', 'archive/old.md': 'stale' };
    const res = e1.compileContextBundle(Object.keys(files), { readFile: readFileFrom(files) });
    assert.deepEqual(res.included.map((i) => i.path), ['README.md']);
    assert.equal(res.excluded.length, 1);
    assert.equal(res.excluded[0].path, 'archive/old.md');
    assert.match(res.excluded[0].reason, /historical-archive/);
  });

  it('includes historical-archive paths when includeHistoricalArchive is true', () => {
    const files = { 'archive/old.md': 'stale' };
    const res = e1.compileContextBundle(Object.keys(files), { readFile: readFileFrom(files), includeHistoricalArchive: true });
    assert.equal(res.included.length, 1);
    assert.equal(res.excluded.length, 0);
  });

  it('excludes an unreadable path with a reason, rather than throwing', () => {
    const res = e1.compileContextBundle(['missing.md'], { readFile: readFileFrom({}) });
    assert.equal(res.included.length, 0);
    assert.equal(res.excluded.length, 1);
    assert.match(res.excluded[0].reason, /unreadable/);
  });

  it('skips an over-budget path but still includes a smaller later one (first-come, not first-fit-stop)', () => {
    const files = { big: 'x'.repeat(4000), small: 'y' };
    const res = e1.compileContextBundle(['big', 'small'], { readFile: readFileFrom(files), tokenBudget: 10 });
    assert.deepEqual(res.included.map((i) => i.path), ['small']);
    assert.equal(res.excluded[0].path, 'big');
    assert.match(res.excluded[0].reason, /budget/);
  });

  it('produces the same manifest sha256 for the same inputs, and a different one when content changes', () => {
    const files = { 'README.md': 'hello' };
    const res1 = e1.compileContextBundle(['README.md'], { readFile: readFileFrom(files) });
    const res2 = e1.compileContextBundle(['README.md'], { readFile: readFileFrom(files) });
    assert.equal(res1.manifest.sha256, res2.manifest.sha256);
    const res3 = e1.compileContextBundle(['README.md'], { readFile: readFileFrom({ 'README.md': 'goodbye' }) });
    assert.notEqual(res1.manifest.sha256, res3.manifest.sha256);
  });
});

describe('syncSsotIndex / validateSsotIndex (#1151)', () => {
  let tempDir;

  function freshRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-e1-ssot-'));
    fs.writeFileSync(path.join(root, 'README.md'), 'product doc');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'maintainer doc');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'architecture.md'), 'maintainer doc 2');
    fs.mkdirSync(path.join(root, 'changelog.d'), { recursive: true });
    fs.writeFileSync(path.join(root, 'changelog.d', '1.added.md'), 'operational memory, never indexed');
    return root;
  }

  it('indexes only Plane 1/Plane 2 documents, sorted by path, with a matching sha256', () => {
    tempDir = freshRoot();
    const { index, writtenTo } = e1.syncSsotIndex(tempDir);
    assert.equal(writtenTo, '.tangleclaw/ssot-index.json');
    const paths = index.entries.map((e) => e.path);
    assert.deepEqual(paths, [...paths].sort());
    assert.ok(paths.includes('README.md'));
    assert.ok(paths.includes('CLAUDE.md'));
    assert.ok(paths.includes('docs/architecture.md'));
    assert.ok(!paths.includes('changelog.d/1.added.md'), 'operational-memory must not be indexed');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('validates clean right after a sync', () => {
    tempDir = freshRoot();
    e1.syncSsotIndex(tempDir);
    const res = e1.validateSsotIndex(tempDir);
    assert.equal(res.ok, true);
    assert.deepEqual(res.issues, []);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('404s with INDEX_MISSING when no index has ever been synced', () => {
    tempDir = freshRoot();
    const res = e1.validateSsotIndex(tempDir);
    assert.equal(res.ok, false);
    assert.deepEqual(res.issues, [{ code: 'INDEX_MISSING', path: '.tangleclaw/ssot-index.json' }]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports INDEX_MALFORMED for unparseable JSON', () => {
    tempDir = freshRoot();
    fs.mkdirSync(path.join(tempDir, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.tangleclaw', 'ssot-index.json'), 'not json {');
    const res = e1.validateSsotIndex(tempDir);
    assert.equal(res.ok, false);
    assert.deepEqual(res.issues, [{ code: 'INDEX_MALFORMED', path: '.tangleclaw/ssot-index.json' }]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports ENTRY_STALE when an indexed document drifts after sync', () => {
    tempDir = freshRoot();
    e1.syncSsotIndex(tempDir);
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'edited after sync');
    const res = e1.validateSsotIndex(tempDir);
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => i.code === 'ENTRY_STALE' && i.path === 'README.md'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports ENTRY_GONE when an indexed document is deleted after sync', () => {
    tempDir = freshRoot();
    e1.syncSsotIndex(tempDir);
    fs.rmSync(path.join(tempDir, 'docs', 'architecture.md'));
    const res = e1.validateSsotIndex(tempDir);
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => i.code === 'ENTRY_GONE' && i.path === 'docs/architecture.md'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports ENTRY_UNINDEXED when a new canonical document appears after sync', () => {
    tempDir = freshRoot();
    e1.syncSsotIndex(tempDir);
    fs.writeFileSync(path.join(tempDir, 'docs', 'new-doc.md'), 'new maintainer doc');
    const res = e1.validateSsotIndex(tempDir);
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => i.code === 'ENTRY_UNINDEXED' && i.path === 'docs/new-doc.md'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports ENTRY_STALE when an entry\'s recorded plane is tampered, even though its sha256 is untouched (PRR-A R1 HOLD)', () => {
    tempDir = freshRoot();
    e1.syncSsotIndex(tempDir);
    const indexAbs = path.join(tempDir, '.tangleclaw', 'ssot-index.json');
    const index = JSON.parse(fs.readFileSync(indexAbs, 'utf8'));
    const readme = index.entries.find((e) => e.path === 'README.md');
    readme.plane = 'historical-archive';
    fs.writeFileSync(indexAbs, JSON.stringify(index, null, 2));
    const res = e1.validateSsotIndex(tempDir);
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => i.code === 'ENTRY_STALE' && i.path === 'README.md'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports ENTRY_STALE when an entry\'s recorded byte count is tampered, even though its sha256 field is left alone', () => {
    tempDir = freshRoot();
    e1.syncSsotIndex(tempDir);
    const indexAbs = path.join(tempDir, '.tangleclaw', 'ssot-index.json');
    const index = JSON.parse(fs.readFileSync(indexAbs, 'utf8'));
    const readme = index.entries.find((e) => e.path === 'README.md');
    readme.bytes = 1;
    fs.writeFileSync(indexAbs, JSON.stringify(index, null, 2));
    const res = e1.validateSsotIndex(tempDir);
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => i.code === 'ENTRY_STALE' && i.path === 'README.md'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports INDEX_MALFORMED for a duplicate entry.path row', () => {
    tempDir = freshRoot();
    e1.syncSsotIndex(tempDir);
    const indexAbs = path.join(tempDir, '.tangleclaw', 'ssot-index.json');
    const index = JSON.parse(fs.readFileSync(indexAbs, 'utf8'));
    const readme = index.entries.find((e) => e.path === 'README.md');
    index.entries.push({ ...readme });
    fs.writeFileSync(indexAbs, JSON.stringify(index, null, 2));
    const res = e1.validateSsotIndex(tempDir);
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => i.code === 'INDEX_MALFORMED' && i.path === 'README.md'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports INDEX_MALFORMED for a non-canonical entry.path', () => {
    tempDir = freshRoot();
    e1.syncSsotIndex(tempDir);
    const indexAbs = path.join(tempDir, '.tangleclaw', 'ssot-index.json');
    const index = JSON.parse(fs.readFileSync(indexAbs, 'utf8'));
    const readme = index.entries.find((e) => e.path === 'README.md');
    readme.path = './README.md';
    fs.writeFileSync(indexAbs, JSON.stringify(index, null, 2));
    const res = e1.validateSsotIndex(tempDir);
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => i.code === 'INDEX_MALFORMED' && i.path === './README.md'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports INDEX_MALFORMED for an entry.path that escapes root', () => {
    tempDir = freshRoot();
    e1.syncSsotIndex(tempDir);
    const indexAbs = path.join(tempDir, '.tangleclaw', 'ssot-index.json');
    const index = JSON.parse(fs.readFileSync(indexAbs, 'utf8'));
    const readme = index.entries.find((e) => e.path === 'README.md');
    readme.path = '../README.md';
    fs.writeFileSync(indexAbs, JSON.stringify(index, null, 2));
    const res = e1.validateSsotIndex(tempDir);
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => i.code === 'INDEX_MALFORMED' && i.path === '../README.md'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('respects a custom indexPath', () => {
    tempDir = freshRoot();
    const { writtenTo } = e1.syncSsotIndex(tempDir, { indexPath: 'custom/index.json' });
    assert.equal(writtenTo, 'custom/index.json');
    assert.ok(fs.existsSync(path.join(tempDir, 'custom', 'index.json')));
    const res = e1.validateSsotIndex(tempDir, { indexPath: 'custom/index.json' });
    assert.equal(res.ok, true);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('checkCarDependencyAdmission (#1151)', () => {
  it('admits a car with no declared dependencies', () => {
    const res = e1.checkCarDependencyAdmission({ id: 'V60-T2-W1-C' });
    assert.equal(res.admitted, true);
    assert.deepEqual(res.blockedBy, []);
  });

  it('blocks a car whose dependencies have not completed', () => {
    const res = e1.checkCarDependencyAdmission(
      { id: 'V60-T2-W2-ROUTES', dependsOn: ['V60-T2-W1-A', 'V60-T2-W1-B'] },
      { completedCarIds: ['V60-T2-W1-A'] }
    );
    assert.equal(res.admitted, false);
    assert.deepEqual(res.blockedBy, ['V60-T2-W1-B']);
  });

  it('admits a car once every dependency has completed, accepting a Set or an array', () => {
    const car = { id: 'V60-T2-W2-ROUTES', dependsOn: ['V60-T2-W1-A', 'V60-T2-W1-B'] };
    const withArray = e1.checkCarDependencyAdmission(car, { completedCarIds: ['V60-T2-W1-A', 'V60-T2-W1-B'] });
    assert.equal(withArray.admitted, true);
    const withSet = e1.checkCarDependencyAdmission(car, { completedCarIds: new Set(['V60-T2-W1-A', 'V60-T2-W1-B']) });
    assert.equal(withSet.admitted, true);
  });
});

describe('evaluateWebhookStateAdvance (#1151)', () => {
  it('advances queued -> dispatched on car.dispatched', () => {
    const res = e1.evaluateWebhookStateAdvance({ type: 'car.dispatched' }, 'queued');
    assert.equal(res.nextState, 'dispatched');
    assert.equal(res.advanced, true);
  });

  it('advances dispatched -> in-review -> merged along the happy path', () => {
    const r1 = e1.evaluateWebhookStateAdvance({ type: 'review.requested' }, 'dispatched');
    assert.equal(r1.nextState, 'in-review');
    const r2 = e1.evaluateWebhookStateAdvance({ type: 'review.approved' }, r1.nextState);
    assert.equal(r2.nextState, 'merged');
  });

  it('advances dispatched or in-review to failed on ci.failure, and failed is re-dispatchable', () => {
    assert.equal(e1.evaluateWebhookStateAdvance({ type: 'ci.failure' }, 'dispatched').nextState, 'failed');
    assert.equal(e1.evaluateWebhookStateAdvance({ type: 'ci.failure' }, 'in-review').nextState, 'failed');
    assert.equal(e1.evaluateWebhookStateAdvance({ type: 'car.dispatched' }, 'failed').nextState, 'dispatched');
  });

  it('sends in-review back to dispatched on review.changes-requested', () => {
    const res = e1.evaluateWebhookStateAdvance({ type: 'review.changes-requested' }, 'in-review');
    assert.equal(res.nextState, 'dispatched');
  });

  it('holds (advanced: false) for an event with no edge from the current state', () => {
    const res = e1.evaluateWebhookStateAdvance({ type: 'review.approved' }, 'queued');
    assert.equal(res.advanced, false);
    assert.equal(res.nextState, 'queued');
  });

  it('holds for an unrecognized current state, rather than throwing', () => {
    const res = e1.evaluateWebhookStateAdvance({ type: 'car.dispatched' }, 'not-a-real-state');
    assert.equal(res.advanced, false);
    assert.equal(res.nextState, 'not-a-real-state');
  });

  it('merged is terminal: no transition table entry advances it further', () => {
    const res = e1.evaluateWebhookStateAdvance({ type: 'car.dispatched' }, 'merged');
    assert.equal(res.advanced, false);
  });

  it('every state this module can advance to is one of the declared WEBHOOK_TRACKER_STATES', () => {
    assert.ok(e1.WEBHOOK_TRACKER_STATES.includes('queued'));
    assert.ok(e1.WEBHOOK_TRACKER_STATES.includes('failed'));
    const res = e1.evaluateWebhookStateAdvance({ type: 'car.dispatched' }, 'queued');
    assert.ok(e1.WEBHOOK_TRACKER_STATES.includes(res.nextState));
  });
});
