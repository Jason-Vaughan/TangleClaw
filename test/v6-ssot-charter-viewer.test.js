'use strict';

/*
 * v6.6.5 Wave 1 (Car V665-W1-C, #3275 / V6-035, V6-036, V6-037).
 *
 * Covers both files this car bundles: `lib/project-docs-ssot.js` (the
 * manifest schema, provisioning, and Charter structured schema) and
 * `public/v6-ssot-charter-view.js` (the SSOT index/reader/Charter markup).
 * One test file, not two, specifically so the cross-module consistency
 * test at the bottom can exist at all: the public file's Charter section
 * order/titles are its own small, duplicated constants (a browser script
 * cannot `require()` the lib file), and this is where that duplication
 * gets checked against the real thing rather than trusted on sight.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ssot = require('../lib/project-docs-ssot');

const VIEW_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'v6-ssot-charter-view.js'), 'utf8');

/**
 * Loads the real public/v6-ssot-charter-view.js into a fresh vm sandbox,
 * the same pattern test/v6-b1-ui-shell.test.js uses for public/v6-shell.js.
 * @returns {object}
 */
function loadSsotView() {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(VIEW_SRC, sandbox);
  return sandbox;
}

/**
 * Assert `fn` throws a ProjectDocsSsotError with `code`.
 * @param {Function} fn
 * @param {string} code
 */
function throwsCode(fn, code) {
  assert.throws(fn, (err) => err instanceof ssot.ProjectDocsSsotError && err.code === code, code);
}

describe('defaultDocsManifest / validateDocsManifest (#3275, V6-035)', () => {
  it('the default manifest is itself valid', () => {
    assert.equal(ssot.validateDocsManifest(ssot.defaultDocsManifest()), true);
  });

  it('carries the 5 canonical documents the issue names: Roadmap, Registry, Charter, Artifacts, Sprint Reports', () => {
    const ids = ssot.defaultDocsManifest().documents.map((doc) => doc.id);
    assert.deepEqual(ids, ['roadmap', 'registry', 'charter', 'artifacts', 'sprint-reports']);
  });

  const V = ssot.MANIFEST_SCHEMA_VERSION;

  it('refuses a missing/non-integer version', () => {
    throwsCode(() => ssot.validateDocsManifest({ version: 0, documents: ssot.DEFAULT_DOCUMENTS }), 'MANIFEST_VERSION_INVALID');
    throwsCode(() => ssot.validateDocsManifest({ documents: ssot.DEFAULT_DOCUMENTS }), 'MANIFEST_VERSION_INVALID');
  });

  it('refuses an empty or missing documents array', () => {
    throwsCode(() => ssot.validateDocsManifest({ version: V, documents: [] }), 'MANIFEST_DOCUMENTS_REQUIRED');
    throwsCode(() => ssot.validateDocsManifest({ version: V }), 'MANIFEST_DOCUMENTS_REQUIRED');
  });

  it('refuses a duplicate document id', () => {
    throwsCode(() => ssot.validateDocsManifest({
      version: V, documents: [{ id: 'x', title: 'X', path: 'x.md', kind: 'markdown' }, { id: 'x', title: 'Y', path: 'y.md', kind: 'markdown' }]
    }), 'DOCUMENT_ID_DUPLICATE');
  });

  it('refuses an absolute or path-traversal document path', () => {
    throwsCode(() => ssot.validateDocsManifest({ version: V, documents: [{ id: 'x', title: 'X', path: '/etc/passwd', kind: 'markdown' }] }), 'DOCUMENT_PATH_INVALID');
    throwsCode(() => ssot.validateDocsManifest({ version: V, documents: [{ id: 'x', title: 'X', path: '../secret.md', kind: 'markdown' }] }), 'DOCUMENT_PATH_INVALID');
  });

  it('refuses an unrecognized document kind', () => {
    throwsCode(() => ssot.validateDocsManifest({ version: V, documents: [{ id: 'x', title: 'X', path: 'x.md', kind: 'video' }] }), 'DOCUMENT_KIND_INVALID');
  });

  it('accepts every real DOC_KINDS value', () => {
    for (const kind of ssot.DOC_KINDS) {
      assert.equal(ssot.validateDocsManifest({ version: V, documents: [{ id: 'x', title: 'X', path: 'x.md', kind }] }), true, kind);
    }
  });

  it('refuses a document missing its title or path', () => {
    throwsCode(() => ssot.validateDocsManifest({ version: V, documents: [{ id: 'x', path: 'x.md', kind: 'markdown' }] }), 'DOCUMENT_TITLE_REQUIRED');
    throwsCode(() => ssot.validateDocsManifest({ version: V, documents: [{ id: 'x', title: 'X', kind: 'markdown' }] }), 'DOCUMENT_PATH_REQUIRED');
  });
});

describe('provisionDocsManifest: per-workspace customization (#3275 AC1)', () => {
  it('with no overrides, provisions exactly the default manifest', () => {
    assert.deepEqual(ssot.provisionDocsManifest(), ssot.defaultDocsManifest());
  });

  it('removes a non-required document', () => {
    const manifest = ssot.provisionDocsManifest({ removeDocumentIds: ['sprint-reports'] });
    assert.ok(!manifest.documents.some((doc) => doc.id === 'sprint-reports'));
    assert.equal(ssot.validateDocsManifest(manifest), true);
  });

  it('refuses to remove a required document (roadmap, registry, charter)', () => {
    for (const id of ['roadmap', 'registry', 'charter']) {
      throwsCode(() => ssot.provisionDocsManifest({ removeDocumentIds: [id] }), 'DOCUMENT_REQUIRED_CANNOT_REMOVE');
    }
  });

  it('renames a document title without touching its id/path/kind', () => {
    const manifest = ssot.provisionDocsManifest({ renameTitles: { roadmap: 'Our Roadmap' } });
    const roadmap = manifest.documents.find((doc) => doc.id === 'roadmap');
    assert.equal(roadmap.title, 'Our Roadmap');
    assert.equal(roadmap.path, 'ROADMAP.md');
  });

  it('appends an added document, defaulting required to false', () => {
    const manifest = ssot.provisionDocsManifest({ addDocuments: [{ id: 'runbook', title: 'Runbook', path: 'RUNBOOK.md', kind: 'markdown' }] });
    const added = manifest.documents.find((doc) => doc.id === 'runbook');
    assert.ok(added);
    assert.equal(added.required, false);
    assert.equal(manifest.documents[manifest.documents.length - 1].id, 'runbook');
  });

  it('a malformed added document surfaces through the same validateDocsManifest refusal', () => {
    throwsCode(() => ssot.provisionDocsManifest({ addDocuments: [{ id: 'bad', title: 'Bad', path: 'bad.md', kind: 'nonsense' }] }), 'DOCUMENT_KIND_INVALID');
  });
});

describe('Charter structured schema (#3275, V6-037)', () => {
  it('defaultCharter has all 7 sections empty and no runtime links set', () => {
    const charter = ssot.defaultCharter();
    assert.deepEqual(Object.keys(charter.sections).sort(), [...ssot.CHARTER_SECTIONS].sort());
    for (const key of ssot.CHARTER_SECTIONS) assert.equal(charter.sections[key], '');
    assert.deepEqual(charter.runtimeLinks, { fleetSettings: null, sessionRules: null, roadmap: null });
  });

  it('renderCharterMarkdown writes one heading per section, in CHARTER_SECTIONS order', () => {
    const md = ssot.renderCharterMarkdown(ssot.defaultCharter());
    const headings = [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(headings, ssot.CHARTER_SECTIONS.map((key) => ssot.CHARTER_SECTION_TITLES[key]));
  });

  it('writes the real text for a filled section, and NO placeholder for an empty one (round-trip safety)', () => {
    const charter = ssot.defaultCharter();
    charter.sections.purpose = 'Ship the thing.';
    const md = ssot.renderCharterMarkdown(charter);
    assert.match(md, /## Purpose\n\nShip the thing\./);
    // An empty section writes nothing between its heading and the next one -- "Not yet
    // documented" is a DISPLAY-time fallback (public/v6-ssot-charter-view.js's own), never
    // persisted text, so it must never appear in the stored Markdown at all.
    assert.doesNotMatch(md, /Not yet documented/);
    assert.match(md, /## Stakeholders\n\n## Resources/);
  });

  it('includes a Linked Runtime Configuration section only when a runtime link is set (#3275 AC3)', () => {
    const noLinks = ssot.renderCharterMarkdown(ssot.defaultCharter());
    assert.doesNotMatch(noLinks, /Linked Runtime Configuration/);
    const withLinks = ssot.renderCharterMarkdown({ ...ssot.defaultCharter(), runtimeLinks: { fleetSettings: '/settings/fleet', sessionRules: null, roadmap: 'ROADMAP.md' } });
    assert.match(withLinks, /## Linked Runtime Configuration/);
    assert.match(withLinks, /Fleet Settings: \/settings\/fleet/);
    assert.match(withLinks, /Roadmap: ROADMAP\.md/);
    assert.doesNotMatch(withLinks, /Session rules:/);
  });

  it('parseCharterMarkdown round-trips through renderCharterMarkdown: same section text comes back out', () => {
    const charter = ssot.defaultCharter();
    charter.sections.purpose = 'Ship the thing.';
    charter.sections.scope = 'In: the API.\nOut: the UI.';
    const parsed = ssot.parseCharterMarkdown(ssot.renderCharterMarkdown(charter));
    assert.equal(parsed.sections.purpose, 'Ship the thing.');
    assert.equal(parsed.sections.scope, 'In: the API.\nOut: the UI.');
    assert.equal(parsed.sections.stakeholders, '');
  });

  it('ignores an unrecognized heading and any text before the first recognized one', () => {
    const parsed = ssot.parseCharterMarkdown('# Project Charter\n\nSome preamble.\n\n## Not A Real Section\n\nstray text\n\n## Purpose\n\nReal content.\n');
    assert.equal(parsed.sections.purpose, 'Real content.');
  });

  it('matches a section heading case-insensitively', () => {
    const parsed = ssot.parseCharterMarkdown('## PURPOSE\n\nUpper case heading.\n');
    assert.equal(parsed.sections.purpose, 'Upper case heading.');
  });

  it('requires markdown to be a string', () => {
    throwsCode(() => ssot.parseCharterMarkdown(null), 'CHARTER_MARKDOWN_REQUIRED');
  });
});

describe('Charter Section 0 — kaizenDispositions (#3324 AC#3)', () => {
  const ROW = { kaizenId: 'KZ-v665-01', finding: 'Reports lacked exact dispatch timestamps', disposition: 'SCHEDULED_ISSUE', reference: '#3324' };

  it('defaultCharter has an empty kaizenDispositions array', () => {
    assert.deepEqual(ssot.defaultCharter().kaizenDispositions, []);
  });

  it('exposes the 4 recognized disposition kinds', () => {
    assert.deepEqual([...ssot.KAIZEN_DISPOSITION_KINDS], ['ADOPTED_RULE', 'ADOPTED_GUARDRAIL', 'SCHEDULED_ISSUE', 'DEFERRED_WITH_RATIONALE']);
  });

  it('validateKaizenDispositions accepts a well-formed row for every recognized kind', () => {
    for (const disposition of ssot.KAIZEN_DISPOSITION_KINDS) {
      assert.equal(ssot.validateKaizenDispositions([{ ...ROW, disposition }]), true, disposition);
    }
  });

  it('validateKaizenDispositions refuses a missing kaizenId, finding, or reference, or an unrecognized disposition', () => {
    throwsCode(() => ssot.validateKaizenDispositions('nope'), 'KAIZEN_DISPOSITIONS_INVALID');
    throwsCode(() => ssot.validateKaizenDispositions([{ ...ROW, kaizenId: '' }]), 'KAIZEN_DISPOSITION_ID_REQUIRED');
    throwsCode(() => ssot.validateKaizenDispositions([{ ...ROW, finding: '' }]), 'KAIZEN_DISPOSITION_FINDING_REQUIRED');
    throwsCode(() => ssot.validateKaizenDispositions([{ ...ROW, disposition: 'BOGUS' }]), 'KAIZEN_DISPOSITION_KIND_INVALID');
    throwsCode(() => ssot.validateKaizenDispositions([{ ...ROW, reference: '' }]), 'KAIZEN_DISPOSITION_REFERENCE_REQUIRED');
  });

  it('renderCharterMarkdown writes no Section 0 heading/table when kaizenDispositions is empty', () => {
    assert.doesNotMatch(ssot.renderCharterMarkdown(ssot.defaultCharter()), /Section 0/);
  });

  it('renderCharterMarkdown writes the table, before every other section, under the real ssot.KAIZEN_SECTION_HEADING — not a hand-copied guess', () => {
    const md = ssot.renderCharterMarkdown({ ...ssot.defaultCharter(), kaizenDispositions: [ROW] });
    assert.match(md, new RegExp(`## ${ssot.KAIZEN_SECTION_HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(md, /\| KZ-v665-01 \| Reports lacked exact dispatch timestamps \| SCHEDULED_ISSUE \| #3324 \|/);
    assert.ok(md.indexOf(ssot.KAIZEN_SECTION_HEADING) < md.indexOf('## Purpose'));
  });

  it('parseCharterMarkdown round-trips kaizenDispositions through renderCharterMarkdown', () => {
    const charter = { ...ssot.defaultCharter(), kaizenDispositions: [ROW, { ...ROW, kaizenId: 'KZ-v665-02', disposition: 'ADOPTED_GUARDRAIL', reference: 'Guardrail 02' }] };
    const parsed = ssot.parseCharterMarkdown(ssot.renderCharterMarkdown(charter));
    assert.deepEqual(parsed.kaizenDispositions, charter.kaizenDispositions);
  });

  it('parseCharterMarkdown reads kaizenDispositions as [] when the document has no Section 0 table', () => {
    assert.deepEqual(ssot.parseCharterMarkdown('## Purpose\n\nShip it.\n').kaizenDispositions, []);
  });
});

describe('tcV6RenderSsotIndexMarkup / tcV6RenderSsotDocumentMarkup (#3275 AC2)', () => {
  const G = loadSsotView();
  const manifest = ssot.defaultDocsManifest();

  it('renders one row per manifest document, marking the active one', () => {
    const html = G.tcV6RenderSsotIndexMarkup(manifest, { activeDocumentId: 'charter' });
    assert.equal((html.match(/v6-ssot-index-row/g) || []).length, manifest.documents.length);
    assert.match(html, /v6-ssot-index-row is-active"[^>]*>\s*<button[^>]*data-ssot-doc="charter"[^>]*aria-current="true"/s);
  });

  it('escapes a document title containing HTML', () => {
    const html = G.tcV6RenderSsotIndexMarkup({ documents: [{ id: 'x', title: '<img onerror=alert(1)>', kind: 'markdown' }] });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
  });

  it('shows the empty state when no document is selected', () => {
    assert.match(G.tcV6RenderSsotDocumentMarkup(null), /is-empty/);
  });

  it('renders the selected document\'s title/path escaped, and its bodyHtml verbatim (trusted content)', () => {
    const html = G.tcV6RenderSsotDocumentMarkup({ id: 'roadmap', title: 'Our <Roadmap>', path: 'ROADMAP.md' }, '<p>already-rendered</p>');
    assert.match(html, /Our &lt;Roadmap&gt;/);
    assert.match(html, /<p>already-rendered<\/p>/);
  });
});

describe('tcV6RenderCharterSectionsMarkup (#3275 AC3) — cross-checked against the real lib/project-docs-ssot.js schema', () => {
  const G = loadSsotView();

  it('renders all 7 real CHARTER_SECTIONS, in the real CHARTER_SECTION_TITLES order — not a hand-copied guess', () => {
    const charter = ssot.defaultCharter();
    const html = G.tcV6RenderCharterSectionsMarkup(charter);
    const titlesInHtml = [...html.matchAll(/v6-charter-section-title">([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(titlesInHtml, ssot.CHARTER_SECTIONS.map((key) => ssot.CHARTER_SECTION_TITLES[key]));
  });

  it('renders real charter text parsed by lib/project-docs-ssot.js, escaped', () => {
    const charter = ssot.parseCharterMarkdown(ssot.renderCharterMarkdown({
      ...ssot.defaultCharter(), sections: { ...ssot.defaultCharter().sections, purpose: 'Keep <everyone> aligned.' }
    }));
    const html = G.tcV6RenderCharterSectionsMarkup(charter);
    assert.match(html, /Keep &lt;everyone&gt; aligned\./);
  });

  it('shows "Not yet documented" for an empty section', () => {
    assert.match(G.tcV6RenderCharterSectionsMarkup(ssot.defaultCharter()), /Not yet documented\./);
  });

  it('renders runtime links only when set, matching the real runtimeLinks shape', () => {
    const none = G.tcV6RenderCharterSectionsMarkup(ssot.defaultCharter());
    assert.doesNotMatch(none, /v6-charter-runtime-links/);
    const withLink = G.tcV6RenderCharterSectionsMarkup({ ...ssot.defaultCharter(), runtimeLinks: { fleetSettings: '/settings/fleet', sessionRules: null, roadmap: null } });
    assert.match(withLink, /v6-charter-runtime-links/);
    assert.match(withLink, /href="\/settings\/fleet"/);
  });

  it('allows https(s):// and relative/hash/query paths through unchanged', () => {
    for (const href of ['https://example.com/x', 'http://example.com/x', '/settings/fleet', '#charter', '?tab=charter']) {
      const html = G.tcV6RenderCharterSectionsMarkup({ ...ssot.defaultCharter(), runtimeLinks: { fleetSettings: href, sessionRules: null, roadmap: null } });
      assert.match(html, new RegExp(`href="${href.replace(/[/?#]/g, '\\$&')}"`), href);
    }
  });

  it('neutralizes a javascript:/data:/vbscript: runtime link to "#" rather than executing it (#3275 R-Gate C1, security)', () => {
    for (const unsafe of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)']) {
      const html = G.tcV6RenderCharterSectionsMarkup({ ...ssot.defaultCharter(), runtimeLinks: { fleetSettings: unsafe, sessionRules: null, roadmap: null } });
      assert.match(html, /href="#"/, unsafe);
      assert.doesNotMatch(html, /href="[^"]*(javascript|data|vbscript):/i, unsafe);
    }
  });
});

describe('tcV6RenderKaizenDispositionsMarkup (#3324 AC#3) — cross-checked against the real lib/project-docs-ssot.js schema', () => {
  const G = loadSsotView();
  const ROW = { kaizenId: 'KZ-v665-01', finding: 'Reports lacked exact dispatch timestamps', disposition: 'SCHEDULED_ISSUE', reference: '#3324' };

  it('renders "" for an empty/missing kaizenDispositions, no placeholder table', () => {
    assert.equal(G.tcV6RenderKaizenDispositionsMarkup([]), '');
    assert.equal(G.tcV6RenderKaizenDispositionsMarkup(undefined), '');
  });

  it('renders one table row per kaizenDispositions entry, escaped, with a human-readable disposition label', () => {
    const html = G.tcV6RenderKaizenDispositionsMarkup([ROW]);
    assert.match(html, /v6-kaizen-id">KZ-v665-01</);
    assert.match(html, /v6-kaizen-finding">Reports lacked exact dispatch timestamps</);
    assert.match(html, /data-disposition="SCHEDULED_ISSUE"/);
    assert.match(html, />Scheduled issue</);
    assert.match(html, /v6-kaizen-reference">#3324</);
  });

  it('escapes HTML in every cell', () => {
    const html = G.tcV6RenderKaizenDispositionsMarkup([{ ...ROW, finding: '<img onerror=alert(1)>' }]);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
  });

  it('has a human-readable label for every real ssot.KAIZEN_DISPOSITION_KINDS value — not a hand-copied guess', () => {
    for (const disposition of ssot.KAIZEN_DISPOSITION_KINDS) {
      const html = G.tcV6RenderKaizenDispositionsMarkup([{ ...ROW, disposition }]);
      // The fallback path (an unrecognized kind) renders the raw, escaped
      // disposition string in place of a label -- asserting the rendered
      // text is NOT that raw string is what actually proves a real label
      // exists for this kind, not merely that something rendered.
      assert.doesNotMatch(html, new RegExp(`>${disposition}<`), `${disposition} must not fall back to its raw string`);
    }
  });

  it('tcV6RenderCharterSectionsMarkup includes the Kaizen table, before the 7 sections, only when rows are present', () => {
    const withRows = G.tcV6RenderCharterSectionsMarkup({ ...ssot.defaultCharter(), kaizenDispositions: [ROW] });
    assert.match(withRows, /v6-charter-kaizen-dispositions/);
    assert.ok(withRows.indexOf('v6-charter-kaizen-dispositions') < withRows.indexOf('v6-charter-section-title">Purpose'));
    const withoutRows = G.tcV6RenderCharterSectionsMarkup(ssot.defaultCharter());
    assert.doesNotMatch(withoutRows, /v6-charter-kaizen-dispositions/);
  });
});

describe('tcV6MountSsotView (#3275 AC2)', () => {
  const G = loadSsotView();
  const manifest = ssot.defaultDocsManifest();

  it('combines the index and a plain document\'s bodyHtml', () => {
    const html = G.tcV6MountSsotView(null, {
      manifest, activeDocumentId: 'roadmap', activeDocument: manifest.documents[0], bodyHtml: '<p>roadmap content</p>'
    });
    assert.match(html, /v6-ssot-index/);
    assert.match(html, /<p>roadmap content<\/p>/);
  });

  it('renders the Charter document via tcV6RenderCharterSectionsMarkup instead of raw bodyHtml', () => {
    const charterDoc = manifest.documents.find((doc) => doc.id === 'charter');
    const charter = { ...ssot.defaultCharter(), sections: { ...ssot.defaultCharter().sections, purpose: 'Ship it.' } };
    const html = G.tcV6MountSsotView(null, { manifest, activeDocumentId: 'charter', activeDocument: charterDoc, charter });
    assert.match(html, /v6-charter-sections/);
    assert.match(html, /Ship it\./);
  });
});
