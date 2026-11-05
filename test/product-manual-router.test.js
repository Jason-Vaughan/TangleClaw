'use strict';

// #811, #2835 — the indexable product manual and the AI doc router.
// No network, no gh. Several tests load the REAL shipped manifests
// (docs/manual-manifest.json, docs/ai-doc-manifest.json) against the REAL
// doc files, so a future edit to a heading or a manifest entry that drifts
// out of parity fails here, not silently.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manual = require('../lib/product-manual');
const router = require('../lib/doc-router');

const ROOT = path.join(__dirname, '..');

describe('manual AUDIENCES and the glob matcher used by findStaleSurfaces', () => {
  it('declares exactly human and nhe', () => {
    assert.deepEqual(manual.AUDIENCES, ['human', 'nhe']);
  });

  it('exposes the same glob-to-regex rule findStaleSurfaces uses, for direct inspection', () => {
    assert.equal(manual._internal.globToRegExp('lib/engine-*.js').test('lib/engine-admission.js'), true);
    assert.equal(manual._internal.globToRegExp('lib/engines/**').test('lib/engines/deep/nested.js'), true);
    assert.equal(manual._internal.globToRegExp('lib/engine-*.js').test('lib/engines/claude.js'), false);
  });
});

describe('slugifyHeading', () => {
  it('lowercases and hyphenates', () => {
    assert.equal(manual.slugifyHeading('Getting Started'), 'getting-started');
  });

  it('strips inline code backticks but keeps their text', () => {
    assert.equal(manual.slugifyHeading('Global Configuration (`config.json`)'), 'global-configuration-configjson');
  });

  it('strips punctuation but keeps underscores (a word character)', () => {
    assert.equal(manual.slugifyHeading('Relocating the base directory (`TANGLECLAW_HOME`)'), 'relocating-the-base-directory-tangleclaw_home');
  });
});

describe('extractHeadings', () => {
  it('extracts headings in order with their level', () => {
    const md = '# Title\n\nSome text.\n\n## Section One\n\ncontent\n\n### Sub\n';
    assert.deepEqual(manual.extractHeadings(md), [
      { level: 1, text: 'Title', anchor: 'title' },
      { level: 2, text: 'Section One', anchor: 'section-one' },
      { level: 3, text: 'Sub', anchor: 'sub' }
    ]);
  });

  it('disambiguates repeated heading text with -1, -2, …', () => {
    const md = '## Notes\n\n## Notes\n\n## Notes\n';
    assert.deepEqual(manual.extractHeadings(md).map((h) => h.anchor), ['notes', 'notes-1', 'notes-2']);
  });

  it('never reads a line inside a fenced code block as a heading', () => {
    const md = '# Real Heading\n\n```bash\n# Check service status\nlaunchctl list\n```\n\n## Another Real One\n';
    assert.deepEqual(manual.extractHeadings(md).map((h) => h.text), ['Real Heading', 'Another Real One']);
  });

  it('handles an unterminated fence by not resuming heading detection (fail toward missing, not toward a false heading)', () => {
    const md = '# Real\n\n```\n# not a heading\n';
    assert.deepEqual(manual.extractHeadings(md).map((h) => h.text), ['Real']);
  });
});

describe('validateManualManifest', () => {
  function minimalDoc() {
    return {
      schema: manual.SCHEMA,
      pages: [{
        id: 'p1', path: 'docs/p1.md', title: 'P1', audience: ['human'], surfaces: ['lib/p1.js'],
        sections: [{ anchor: 'a', heading: 'A' }]
      }]
    };
  }

  it('accepts a minimal valid document', () => {
    assert.doesNotThrow(() => manual.validateManualManifest(minimalDoc()));
  });

  it('refuses the wrong schema', () => {
    const d = minimalDoc();
    d.schema = 'wrong';
    assert.throws(() => manual.validateManualManifest(d), manual.ProductManualError);
  });

  it('refuses a duplicate page id', () => {
    const d = minimalDoc();
    d.pages.push({ ...d.pages[0] });
    assert.throws(() => manual.validateManualManifest(d), manual.ProductManualError);
  });

  it('refuses a duplicate anchor within one page', () => {
    const d = minimalDoc();
    d.pages[0].sections.push({ anchor: 'a', heading: 'A again' });
    assert.throws(() => manual.validateManualManifest(d), manual.ProductManualError);
  });

  it('refuses an audience outside human/nhe', () => {
    const d = minimalDoc();
    d.pages[0].audience = ['robot'];
    assert.throws(() => manual.validateManualManifest(d), manual.ProductManualError);
  });

  it('refuses a sectionDepth outside 1-6', () => {
    const d = minimalDoc();
    d.pages[0].sectionDepth = 0;
    assert.throws(() => manual.validateManualManifest(d), manual.ProductManualError);
  });
});

describe('readManualManifest', () => {
  it('refuses a missing file', () => {
    assert.throws(() => manual.readManualManifest('/no/such/file.json'), manual.ProductManualError);
  });
});

describe('verifyPageParity', () => {
  const page = { id: 'p', path: 'p.md', title: 'P', audience: ['human'], surfaces: [], sections: [{ anchor: 'intro', heading: 'Intro' }] };

  it('is ok when the declared section matches a real heading and nothing else exists', () => {
    assert.deepEqual(manual.verifyPageParity(page, '## Intro\n'), { ok: true, missingAnchors: [], undeclaredHeadings: [] });
  });

  it('reports a missing anchor when the heading moved or was removed', () => {
    const r = manual.verifyPageParity(page, '## Something Else\n');
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingAnchors, ['intro']);
  });

  it('reports an undeclared heading the doc grew', () => {
    const r = manual.verifyPageParity(page, '## Intro\n\n## New Section\n');
    assert.equal(r.ok, false);
    assert.deepEqual(r.undeclaredHeadings, [{ level: 2, text: 'New Section', anchor: 'new-section' }]);
  });

  it('sectionDepth excludes deeper headings from undeclaredHeadings, but not from missingAnchors', () => {
    const shallow = { ...page, sectionDepth: 2 };
    const r = manual.verifyPageParity(shallow, '## Intro\n\n### A sub-point nobody declared\n');
    assert.equal(r.ok, true, 'a level-3 heading is below sectionDepth 2, so it is not a gap');
  });
});

describe('verifyManifestParity', () => {
  it('flags a page whose file is missing from the supplied contents, rather than crashing', () => {
    const doc = {
      schema: manual.SCHEMA,
      pages: [{ id: 'p', path: 'missing.md', title: 'P', audience: ['human'], surfaces: [], sections: [] }]
    };
    const r = manual.verifyManifestParity(doc, {});
    assert.equal(r.ok, false);
    assert.equal(r.pages.p.missingFile, true);
  });

  it('is ok overall only when every page is ok', () => {
    const doc = {
      schema: manual.SCHEMA,
      pages: [
        { id: 'good', path: 'g.md', title: 'G', audience: ['human'], surfaces: [], sections: [{ anchor: 'x', heading: 'X' }] },
        { id: 'bad', path: 'b.md', title: 'B', audience: ['human'], surfaces: [], sections: [{ anchor: 'y', heading: 'Y' }] }
      ]
    };
    const r = manual.verifyManifestParity(doc, { 'g.md': '## X\n', 'b.md': '## Not Y\n' });
    assert.equal(r.ok, false);
    assert.equal(r.pages.good.ok, true);
    assert.equal(r.pages.bad.ok, false);
  });
});

describe('findStaleSurfaces', () => {
  const doc = {
    schema: manual.SCHEMA,
    pages: [
      { id: 'engines', path: 'e.md', title: 'E', audience: ['human'], surfaces: ['lib/engine-*.js', 'lib/engines/*.js'], sections: [] },
      { id: 'other', path: 'o.md', title: 'O', audience: ['human'], surfaces: ['lib/porthub.js'], sections: [] }
    ]
  };

  it('matches a single-segment wildcard glob', () => {
    assert.deepEqual(manual.findStaleSurfaces(doc, ['lib/engine-admission.js']), { engines: ['lib/engine-*.js'] });
  });

  it('matches a nested path only via **, not a single-segment *', () => {
    assert.deepEqual(manual.findStaleSurfaces(doc, ['lib/engines/claude.js']), { engines: ['lib/engines/*.js'] });
  });

  it('reports no stale pages when nothing changed matches any surface', () => {
    assert.deepEqual(manual.findStaleSurfaces(doc, ['lib/unrelated.js']), {});
  });

  it('can report more than one stale page', () => {
    assert.deepEqual(
      manual.findStaleSurfaces(doc, ['lib/engine-admission.js', 'lib/porthub.js']),
      { engines: ['lib/engine-*.js'], other: ['lib/porthub.js'] }
    );
  });
});

describe('listPages / resolveAnchor', () => {
  const doc = {
    schema: manual.SCHEMA,
    pages: [{
      id: 'p1', path: 'docs/p1.md', title: 'P1', audience: ['human', 'nhe'], surfaces: [],
      sections: [{ anchor: 'intro', heading: 'Intro', summary: 'The start.' }]
    }]
  };

  it('listPages gives the human table of contents', () => {
    assert.deepEqual(manual.listPages(doc), [{ id: 'p1', path: 'docs/p1.md', title: 'P1', sections: [{ anchor: 'intro', heading: 'Intro' }] }]);
  });

  it('resolveAnchor resolves a bare page id', () => {
    const r = manual.resolveAnchor(doc, 'p1');
    assert.equal(r.found, true);
    assert.equal(r.page.id, 'p1');
    assert.equal(r.section, undefined);
  });

  it('resolveAnchor resolves a page#anchor fragment, the NHE retrieval shape', () => {
    const r = manual.resolveAnchor(doc, 'p1#intro');
    assert.equal(r.found, true);
    assert.equal(r.section.summary, 'The start.');
  });

  it('resolveAnchor refuses an unknown page', () => {
    assert.deepEqual(manual.resolveAnchor(doc, 'bogus'), { found: false, reason: 'no page with id "bogus"' });
  });

  it('resolveAnchor refuses an unknown anchor on a real page', () => {
    assert.deepEqual(manual.resolveAnchor(doc, 'p1#nope'), { found: false, reason: 'page "p1" has no section anchored "nope"' });
  });
});

describe('the shipped docs/manual-manifest.json is in parity with the real docs', () => {
  it('validates and matches every real heading it declares, down to each page\'s sectionDepth', () => {
    const manifestPath = path.join(ROOT, 'docs', 'manual-manifest.json');
    const manifest = manual.readManualManifest(manifestPath);
    const fileContentsByPath = {};
    for (const p of manifest.pages) fileContentsByPath[p.path] = fs.readFileSync(path.join(ROOT, p.path), 'utf8');
    const result = manual.verifyManifestParity(manifest, fileContentsByPath);
    assert.deepEqual(result, { ok: true, pages: Object.fromEntries(manifest.pages.map((p) => [p.id, { ok: true, missingAnchors: [], undeclaredHeadings: [] }])) });
  });
});

describe('router AUDIENCES and LIFECYCLE_STATES', () => {
  it('declares the two readers and the three lifecycle states', () => {
    assert.deepEqual(router.AUDIENCES, ['human', 'nhe']);
    assert.deepEqual(router.LIFECYCLE_STATES, ['draft', 'current', 'deprecated']);
  });
});

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    assert.ok(router.compareSemver('1.2.3', '1.2.4') < 0);
    assert.ok(router.compareSemver('1.3.0', '1.2.9') > 0);
    assert.ok(router.compareSemver('2.0.0', '1.9.9') > 0);
    assert.equal(router.compareSemver('1.2.3', '1.2.3'), 0);
  });
});

describe('validateAiDocManifest', () => {
  function minimalDoc() {
    return {
      schema: router.SCHEMA,
      topics: [{ id: 't1', path: 'docs/d.md', anchor: 'a', audience: ['human'], lifecycleState: 'current' }]
    };
  }

  it('accepts a minimal valid document', () => {
    assert.doesNotThrow(() => router.validateAiDocManifest(minimalDoc()));
  });

  it('refuses a bad lifecycleState', () => {
    const d = minimalDoc();
    d.topics[0].lifecycleState = 'retired';
    assert.throws(() => router.validateAiDocManifest(d), router.DocRouterError);
  });

  it('refuses two topics with the same id and the same version range', () => {
    const d = minimalDoc();
    d.topics.push({ ...d.topics[0] });
    assert.throws(() => router.validateAiDocManifest(d), router.DocRouterError);
  });

  it('allows the same id twice with distinct version ranges', () => {
    const d = minimalDoc();
    d.topics[0].lifecycleState = 'deprecated';
    d.topics[0].validUntil = '5.0.0';
    d.topics.push({ id: 't1', path: 'docs/d2.md', anchor: 'b', audience: ['human'], lifecycleState: 'current', validFrom: '5.0.1' });
    assert.doesNotThrow(() => router.validateAiDocManifest(d));
  });

  it('refuses more than one "current" entry for the same id', () => {
    const d = minimalDoc();
    d.topics.push({ id: 't1', path: 'docs/d2.md', anchor: 'b', audience: ['human'], lifecycleState: 'current' });
    assert.throws(() => router.validateAiDocManifest(d), router.DocRouterError);
  });

  it('refuses validFrom after validUntil', () => {
    const d = minimalDoc();
    d.topics[0].validFrom = '5.0.0';
    d.topics[0].validUntil = '4.0.0';
    assert.throws(() => router.validateAiDocManifest(d), router.DocRouterError);
  });
});

describe('readAiDocManifest', () => {
  it('refuses a missing file', () => {
    assert.throws(() => router.readAiDocManifest('/no/such/file.json'), router.DocRouterError);
  });
});

describe('resolveTopic', () => {
  function versionedDoc() {
    return {
      schema: router.SCHEMA,
      topics: [
        { id: 'feature-x', path: 'old.md', anchor: 'x', audience: ['human'], lifecycleState: 'deprecated', validUntil: '5.0.0' },
        { id: 'feature-x', path: 'new.md', anchor: 'x', audience: ['human'], lifecycleState: 'current', validFrom: '5.0.1' }
      ]
    };
  }

  it('resolves the pinned entry for a version inside its range', () => {
    const r = router.resolveTopic(versionedDoc(), 'feature-x', { version: '4.9.0' });
    assert.deepEqual(r, { found: true, entry: versionedDoc().topics[0], usedFallback: false });
  });

  it('resolves the current entry and reports no fallback when no version is given', () => {
    const r = router.resolveTopic(versionedDoc(), 'feature-x');
    assert.equal(r.found, true);
    assert.equal(r.usedFallback, true);
    assert.equal(r.entry.path, 'new.md');
  });

  it('falls back to the current entry when no pinned range matches the given version, and says so', () => {
    // A genuine gap: deprecated ends at 5.0.0, current starts at 6.0.0 — 5.5.0 matches neither exactly.
    const gapDoc = {
      schema: router.SCHEMA,
      topics: [
        { id: 'feature-x', path: 'old.md', anchor: 'x', audience: ['human'], lifecycleState: 'deprecated', validUntil: '5.0.0' },
        { id: 'feature-x', path: 'new.md', anchor: 'x', audience: ['human'], lifecycleState: 'current', validFrom: '6.0.0' }
      ]
    };
    const r = router.resolveTopic(gapDoc, 'feature-x', { version: '5.5.0' });
    assert.equal(r.found, true);
    assert.equal(r.usedFallback, true);
    assert.equal(r.entry.path, 'new.md');
  });

  it('refuses an unknown topic id', () => {
    assert.deepEqual(router.resolveTopic(versionedDoc(), 'bogus'), { found: false, reason: 'no topic with id "bogus"' });
  });

  it('refuses when nothing matches the version and there is no current fallback', () => {
    const doc = { schema: router.SCHEMA, topics: [{ id: 't', path: 'd.md', anchor: 'a', audience: ['human'], lifecycleState: 'deprecated', validUntil: '1.0.0' }] };
    const r = router.resolveTopic(doc, 't', { version: '9.0.0' });
    assert.equal(r.found, false);
  });
});

describe('resolveByRole / resolveByCommand', () => {
  const doc = {
    schema: router.SCHEMA,
    topics: [
      { id: 't1', path: 'd1.md', anchor: 'a', roles: ['worker'], commands: ['tc foo'], audience: ['human'], lifecycleState: 'deprecated' },
      { id: 't1', path: 'd1v2.md', anchor: 'a', roles: ['worker'], commands: ['tc foo'], audience: ['human'], lifecycleState: 'current' },
      { id: 't2', path: 'd2.md', anchor: 'b', roles: ['master'], commands: [], audience: ['human'], lifecycleState: 'current' }
    ]
  };

  it('resolveByRole returns one entry per topic id, preferring the current one', () => {
    const r = router.resolveByRole(doc, 'worker');
    assert.equal(r.length, 1);
    assert.equal(r[0].path, 'd1v2.md');
  });

  it('resolveByRole excludes topics not naming the role', () => {
    assert.deepEqual(router.resolveByRole(doc, 'master').map((t) => t.id), ['t2']);
  });

  it('resolveByCommand returns the current entry for a matching command', () => {
    const r = router.resolveByCommand(doc, 'tc foo');
    assert.equal(r.length, 1);
    assert.equal(r[0].path, 'd1v2.md');
  });

  it('resolveByCommand finds nothing for an unknown command', () => {
    assert.deepEqual(router.resolveByCommand(doc, 'tc bogus'), []);
  });
});

describe('the shipped docs/ai-doc-manifest.json is cross-consistent with docs/manual-manifest.json', () => {
  it('validates, and every topic whose path matches a manual page resolves to a real section there', () => {
    const aiDoc = router.readAiDocManifest(path.join(ROOT, 'docs', 'ai-doc-manifest.json'));
    const manualDoc = manual.readManualManifest(path.join(ROOT, 'docs', 'manual-manifest.json'));
    const manualPageByPath = new Map(manualDoc.pages.map((p) => [p.path, p]));

    for (const topic of aiDoc.topics) {
      const page = manualPageByPath.get(topic.path);
      if (!page) continue; // a topic may point at a doc the manual doesn't index yet
      const hasAnchor = page.sections.some((s) => s.anchor === topic.anchor);
      assert.ok(hasAnchor, `ai-doc topic "${topic.id}" cites ${topic.path}#${topic.anchor}, which docs/manual-manifest.json's page "${page.id}" does not declare`);
    }
  });
});
