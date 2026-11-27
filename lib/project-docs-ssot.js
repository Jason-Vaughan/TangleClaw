'use strict';

/**
 * v6 (#3275, V6-035 / V6-036 / V6-037, Car V665-W1-C): the canonical
 * project/fleet documentation manifest schema, its provisioning for a new
 * workspace, and the Functional Project Charter's structured schema.
 *
 * Three intake references land in this one module because they are one
 * data model, not three: V6-035 is the manifest a workspace's documents
 * live under, V6-037 is one of those documents (the Charter) with its own
 * richer internal structure, and V6-036 (the in-pane SSOT reader/index
 * view) is the UI that reads both — `public/v6-ssot-charter-view.js`'s
 * markup functions, kept in a separate file because this one has no
 * business touching the DOM.
 *
 * Scope boundary (Never silently drop a requirement): V6-035 also asks
 * for automatic provisioning "for new projects/fleets" — this module
 * exports the pure function that COMPUTES a new workspace's manifest
 * ({@link provisionDocsManifest}); wiring it into the actual
 * project-creation flow (`lib/projects.js`/`lib/fleet-provisioner.js`,
 * outside this car's envelope) is a follow-up, not claimed here.
 *
 * @module lib/project-docs-ssot
 */

/** Error for manifest/charter input that does not match this module's contract. */
class ProjectDocsSsotError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Refuse unless `cond` holds.
 * @param {boolean} cond
 * @param {string} code
 * @param {string} message
 * @returns {void}
 * @throws {ProjectDocsSsotError}
 */
function need(cond, code, message) {
  if (!cond) throw new ProjectDocsSsotError(code, message);
}

/** The manifest schema version this module reads and writes. */
const MANIFEST_SCHEMA_VERSION = 1;

/** The document kinds a manifest entry may declare. */
const DOC_KINDS = Object.freeze(['markdown', 'charter', 'directory', 'html']);

/**
 * The canonical default documents every new project/fleet gets (#3275
 * V6-035's own list: Roadmap, Master Document Registry/Index, Functional
 * Project Charter, Artifacts, Sprint Reports). `required: true` entries
 * cannot be removed by a workspace customization — see {@link
 * provisionDocsManifest}.
 * @type {ReadonlyArray<{id: string, title: string, path: string, kind: string, required: boolean}>}
 */
const DEFAULT_DOCUMENTS = Object.freeze([
  Object.freeze({ id: 'roadmap', title: 'Roadmap', path: 'ROADMAP.md', kind: 'markdown', required: true }),
  Object.freeze({ id: 'registry', title: 'Master Document Registry', path: 'PROJECT_DOCUMENTS.md', kind: 'markdown', required: true }),
  Object.freeze({ id: 'charter', title: 'Project Charter', path: 'CHARTER.md', kind: 'charter', required: true }),
  Object.freeze({ id: 'artifacts', title: 'Artifacts', path: 'docs/artifacts', kind: 'directory', required: false }),
  Object.freeze({ id: 'sprint-reports', title: 'Sprint Reports', path: 'sprint-reports', kind: 'directory', required: false })
]);

/**
 * The canonical default manifest, before any workspace customization.
 * @returns {{version: number, documents: object[]}}
 */
function defaultDocsManifest() {
  return { version: MANIFEST_SCHEMA_VERSION, documents: DEFAULT_DOCUMENTS.map((doc) => ({ ...doc })) };
}

/**
 * Validate a manifest's shape (`PROJECT_DOCUMENTS.md` / `.tangleclaw/
 * docs-manifest.json`'s parsed form) — repository-relative paths, a
 * recognized `kind`, and no duplicate `id`.
 * @param {object} manifest
 * @returns {true}
 * @throws {ProjectDocsSsotError} `MANIFEST_REQUIRED`, `MANIFEST_VERSION_INVALID`,
 *   `MANIFEST_DOCUMENTS_REQUIRED`, `DOCUMENT_ID_REQUIRED`, `DOCUMENT_ID_DUPLICATE`,
 *   `DOCUMENT_TITLE_REQUIRED`, `DOCUMENT_PATH_REQUIRED`, `DOCUMENT_PATH_INVALID`,
 *   `DOCUMENT_KIND_INVALID`.
 */
function validateDocsManifest(manifest) {
  need(manifest && typeof manifest === 'object', 'MANIFEST_REQUIRED', 'manifest must be an object');
  need(Number.isInteger(manifest.version) && manifest.version >= 1, 'MANIFEST_VERSION_INVALID', 'manifest.version must be a positive integer');
  need(Array.isArray(manifest.documents) && manifest.documents.length > 0, 'MANIFEST_DOCUMENTS_REQUIRED', 'manifest.documents must be a non-empty array');
  const seenIds = new Set();
  for (const doc of manifest.documents) {
    need(doc && typeof doc.id === 'string' && doc.id.length > 0, 'DOCUMENT_ID_REQUIRED', 'each document needs a non-empty id');
    need(!seenIds.has(doc.id), 'DOCUMENT_ID_DUPLICATE', `duplicate document id ${doc.id}`);
    seenIds.add(doc.id);
    need(typeof doc.title === 'string' && doc.title.length > 0, 'DOCUMENT_TITLE_REQUIRED', `${doc.id} needs a non-empty title`);
    need(typeof doc.path === 'string' && doc.path.length > 0, 'DOCUMENT_PATH_REQUIRED', `${doc.id} needs a non-empty path`);
    need(!doc.path.startsWith('/') && !doc.path.includes('..'), 'DOCUMENT_PATH_INVALID', `${doc.id}'s path must be repository-relative: ${doc.path}`);
    need(DOC_KINDS.includes(doc.kind), 'DOCUMENT_KIND_INVALID', `${doc.id}.kind must be one of ${DOC_KINDS.join(', ')}`);
  }
  return true;
}

/**
 * Provision a new project/fleet's documentation manifest: the canonical
 * default, with a workspace's own customizations applied on top (#3275
 * AC1's "customizable per workspace"). A `required` default document can
 * be renamed but never removed; an added document is appended after the
 * defaults, in the order given.
 * @param {{addDocuments?: object[], removeDocumentIds?: string[], renameTitles?: Object<string,string>}} [overrides]
 * @returns {{version: number, documents: object[]}} A manifest {@link validateDocsManifest} accepts.
 * @throws {ProjectDocsSsotError} `DOCUMENT_REQUIRED_CANNOT_REMOVE`, plus any {@link validateDocsManifest} refusal
 *   on the result (a malformed `addDocuments` entry surfaces that way).
 */
function provisionDocsManifest(overrides = {}) {
  const base = defaultDocsManifest();
  let documents = base.documents;

  if (Array.isArray(overrides.removeDocumentIds) && overrides.removeDocumentIds.length) {
    const required = new Set(documents.filter((doc) => doc.required).map((doc) => doc.id));
    for (const id of overrides.removeDocumentIds) {
      need(!required.has(id), 'DOCUMENT_REQUIRED_CANNOT_REMOVE', `${id} is a required default document and cannot be removed`);
    }
    documents = documents.filter((doc) => !overrides.removeDocumentIds.includes(doc.id));
  }

  if (overrides.renameTitles && typeof overrides.renameTitles === 'object') {
    documents = documents.map((doc) => (
      Object.prototype.hasOwnProperty.call(overrides.renameTitles, doc.id)
        ? { ...doc, title: String(overrides.renameTitles[doc.id]) }
        : doc
    ));
  }

  if (Array.isArray(overrides.addDocuments) && overrides.addDocuments.length) {
    documents = documents.concat(overrides.addDocuments.map((doc) => ({ required: false, ...doc })));
  }

  const manifest = { version: MANIFEST_SCHEMA_VERSION, documents };
  validateDocsManifest(manifest);
  return manifest;
}

/**
 * The Functional Project Charter's structured sections (#3275, V6-037),
 * in display order.
 * @type {ReadonlyArray<string>}
 */
const CHARTER_SECTIONS = Object.freeze(['purpose', 'stakeholders', 'resources', 'scope', 'objectives', 'responsibilities', 'instructions']);

/** Each {@link CHARTER_SECTIONS} key's Markdown heading text. */
const CHARTER_SECTION_TITLES = Object.freeze({
  purpose: 'Purpose',
  stakeholders: 'Stakeholders',
  resources: 'Resources',
  scope: 'Scope',
  objectives: 'Objectives',
  responsibilities: 'Responsibilities',
  instructions: 'Instructions'
});

/**
 * A blank charter: every section empty, every runtime link unset.
 * @returns {{sections: Object<string,string>, runtimeLinks: {fleetSettings: null, sessionRules: null, roadmap: null}}}
 */
function defaultCharter() {
  const sections = {};
  for (const key of CHARTER_SECTIONS) sections[key] = '';
  return { sections, runtimeLinks: { fleetSettings: null, sessionRules: null, roadmap: null } };
}

/**
 * Parse a `CHARTER.md`-shaped Markdown document into {@link
 * CHARTER_SECTIONS}' structured form. Recognizes each section by its own
 * `## <Title>` heading (case-insensitive); unrecognized headings and any
 * text before the first recognized one are dropped, not retained
 * anywhere this round-trips from — a charter this module writes only
 * ever carries its own seven headings (see {@link renderCharterMarkdown}).
 * @param {string} markdown
 * @returns {{sections: Object<string,string>, runtimeLinks: {fleetSettings: null, sessionRules: null, roadmap: null}}}
 * @throws {ProjectDocsSsotError} `CHARTER_MARKDOWN_REQUIRED`
 */
function parseCharterMarkdown(markdown) {
  need(typeof markdown === 'string', 'CHARTER_MARKDOWN_REQUIRED', 'markdown must be a string');
  const titleToKey = Object.fromEntries(Object.entries(CHARTER_SECTION_TITLES).map(([key, title]) => [title.toLowerCase(), key]));
  const buckets = {};
  let current = null;
  for (const line of markdown.split(/\r\n|\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = titleToKey[heading[1].trim().toLowerCase()] || null;
      if (current && !buckets[current]) buckets[current] = [];
      continue;
    }
    if (current) buckets[current].push(line);
  }
  const sections = {};
  for (const key of CHARTER_SECTIONS) sections[key] = (buckets[key] || []).join('\n').trim();
  return { sections, runtimeLinks: defaultCharter().runtimeLinks };
}

/**
 * Render a structured charter back into `CHARTER.md`-shaped Markdown:
 * one `##` heading per {@link CHARTER_SECTIONS} entry, in order, plus a
 * trailing "Linked Runtime Configuration" section naming whichever of
 * `runtimeLinks.fleetSettings`/`sessionRules`/`roadmap` are set — #3275
 * AC3's "linked cleanly to runtime rules and settings."
 * @param {{sections?: Object<string,string>, runtimeLinks?: {fleetSettings?: ?string, sessionRules?: ?string, roadmap?: ?string}}} charter
 * @returns {string} Markdown, ending in one trailing newline.
 * @throws {ProjectDocsSsotError} `CHARTER_REQUIRED`
 */
function renderCharterMarkdown(charter) {
  need(charter && typeof charter === 'object', 'CHARTER_REQUIRED', 'charter must be an object');
  const sections = charter.sections || {};
  const parts = ['# Project Charter', ''];
  for (const key of CHARTER_SECTIONS) {
    const body = String(sections[key] || '').trim();
    // An empty section writes NO placeholder text: "_Not yet documented._"
    // is a display-time fallback (public/v6-ssot-charter-view.js's own),
    // never persisted data — writing it here would make it round-trip
    // back through parseCharterMarkdown as real content.
    parts.push(`## ${CHARTER_SECTION_TITLES[key]}`, '', body, '');
  }
  const links = charter.runtimeLinks || {};
  const linkLines = [
    links.fleetSettings ? `- Fleet Settings: ${links.fleetSettings}` : null,
    links.sessionRules ? `- Session rules: ${links.sessionRules}` : null,
    links.roadmap ? `- Roadmap: ${links.roadmap}` : null
  ].filter(Boolean);
  if (linkLines.length) parts.push('## Linked Runtime Configuration', '', ...linkLines, '');
  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

module.exports = {
  ProjectDocsSsotError,
  MANIFEST_SCHEMA_VERSION,
  DOC_KINDS,
  DEFAULT_DOCUMENTS,
  defaultDocsManifest,
  validateDocsManifest,
  provisionDocsManifest,
  CHARTER_SECTIONS,
  CHARTER_SECTION_TITLES,
  defaultCharter,
  parseCharterMarkdown,
  renderCharterMarkdown
};
