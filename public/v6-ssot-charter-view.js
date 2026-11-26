'use strict';
/* ── TangleClaw — v6 Dedicated SSOT document reader & index view (#3275, V6-036 / V6-037) ── */
/*
 * Car V665-W1-C. Pure markup functions for the SSOT index (one row per
 * `lib/project-docs-ssot.js` manifest document) and the reader pane that
 * shows the selected one, plus a read-only renderer for the Functional
 * Project Charter's structured sections (V6-037).
 *
 * NOT YET MOUNTED into `public/v6-shell.js`'s central pane (#3275 R-Gate
 * scope note): that file is outside this car's envelope (concurrent Wave
 * 1 cars touch it for #3260/#3261/#3277), so a later car's own 2-line
 * integration is `tcV6MountSsotView(doc, {...})`'s return value assigned
 * into the pane's root, the same pattern `public/sprint-wave-ui.js`'s
 * own not-yet-mounted view helpers already follow.
 *
 * Markdown -> HTML conversion is explicitly NOT this file's job: no
 * Markdown renderer exists anywhere in this repo yet (checked before
 * writing this), and building one is its own undertaking, not a
 * byproduct of a documentation-manifest car. `tcV6RenderSsotDocumentMarkup`
 * takes already-rendered, trusted HTML for a `markdown`/`html`-kind
 * document; only the `charter` kind renders its own content, because that
 * content is this module's own structured data, not parsed Markdown.
 *
 * Security: every dynamic value that is NOT already-rendered document
 * HTML is escaped before it reaches a template string (document titles/
 * ids/paths, charter section text) — the same `escapeHtml`-everywhere
 * discipline `public/v6-shell.js` documents at its own top.
 */

(function (global) {
  /**
   * Escape a value for safe interpolation into an HTML template string.
   * `null`/`undefined` become `''`, never the literal text "null"/"undefined".
   * @param {*} value
   * @returns {string}
   */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * The SSOT index: one row per manifest document (#3275 AC2's "index
   * view"), as a clickable control a page wires its own click handler to.
   * @param {{documents?: Array<{id: string, title: string, kind: string}>}|null} manifest
   * @param {{activeDocumentId?: string|null}} [opts]
   * @returns {string} HTML.
   */
  function tcV6RenderSsotIndexMarkup(manifest, opts) {
    const activeId = (opts && opts.activeDocumentId) || null;
    const documents = manifest && Array.isArray(manifest.documents) ? manifest.documents : [];
    const rows = documents.map((doc) => {
      const isActive = doc && doc.id === activeId;
      return `<li class="v6-ssot-index-row${isActive ? ' is-active' : ''}">`
        + `<button type="button" class="v6-ssot-index-link" data-ssot-doc="${escapeHtml(doc && doc.id)}" `
        + `aria-current="${isActive ? 'true' : 'false'}">`
        + `<span class="v6-ssot-index-title">${escapeHtml(doc && doc.title)}</span>`
        + `<span class="v6-ssot-index-kind">${escapeHtml(doc && doc.kind)}</span>`
        + '</button></li>';
    }).join('');
    return `<nav class="v6-ssot-index" aria-label="Project documents"><ul>${rows}</ul></nav>`;
  }

  /**
   * The reader pane chrome around one document's content. `bodyHtml` is
   * already-rendered, trusted HTML this function does not itself escape
   * or sanitize — see this file's own top comment for why no Markdown
   * conversion happens here.
   * @param {{id: string, title: string, path: string}|null} doc
   * @param {string} [bodyHtml]
   * @returns {string} HTML.
   */
  function tcV6RenderSsotDocumentMarkup(doc, bodyHtml) {
    if (!doc) return '<div class="v6-ssot-document is-empty">Select a document to view it here.</div>';
    return `<article class="v6-ssot-document" data-ssot-doc="${escapeHtml(doc.id)}">`
      + `<header class="v6-ssot-document-header"><h3 class="v6-ssot-document-title">${escapeHtml(doc.title)}</h3>`
      + `<span class="v6-ssot-document-path">${escapeHtml(doc.path)}</span></header>`
      + `<div class="v6-ssot-document-body">${bodyHtml || '<p class="v6-ssot-document-empty">No content yet.</p>'}</div>`
      + '</article>';
  }

  /** {@link tcV6RenderCharterSectionsMarkup}'s section order and heading text — kept in sync with `lib/project-docs-ssot.js`'s own CHARTER_SECTIONS/CHARTER_SECTION_TITLES by the shared test fixture, not by requiring that file from the browser. */
  const CHARTER_SECTION_ORDER = Object.freeze(['purpose', 'stakeholders', 'resources', 'scope', 'objectives', 'responsibilities', 'instructions']);
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
   * Whether `value` is a safe `href` for a runtime link (#3275 R-Gate C1,
   * security): an absolute `http(s)://` URL, or a relative/hash/query
   * path starting with `/`, `#`, or `?`. Escaping alone does not stop a
   * `javascript:`/`data:`/`vbscript:` scheme from executing on click —
   * HTML-attribute escaping protects against breaking OUT of the
   * attribute, never against the scheme the browser then dereferences.
   * @param {string} value
   * @returns {boolean}
   */
  function _tcV6IsSafeRuntimeLinkHref(value) {
    return /^https?:\/\//i.test(value) || /^[/#?]/.test(value);
  }

  /**
   * Read-only rendering of the Functional Project Charter's seven
   * structured sections (#3275 AC3), plus whichever runtime links
   * (`fleetSettings`/`sessionRules`/`roadmap`) are set. An unsafe scheme
   * (see {@link _tcV6IsSafeRuntimeLinkHref}) is neutralized to `#` rather
   * than rejected outright, so a malformed link degrades to inert instead
   * of hiding the whole runtime-links list.
   * @param {{sections?: Object<string,string>, runtimeLinks?: {fleetSettings?: ?string, sessionRules?: ?string, roadmap?: ?string}}|null} charter
   * @returns {string} HTML.
   */
  function tcV6RenderCharterSectionsMarkup(charter) {
    const sections = (charter && charter.sections) || {};
    const body = CHARTER_SECTION_ORDER.map((key) => {
      const text = String(sections[key] || '').trim();
      return `<section class="v6-charter-section" data-charter-section="${key}">`
        + `<h4 class="v6-charter-section-title">${escapeHtml(CHARTER_SECTION_TITLES[key])}</h4>`
        + `<p class="v6-charter-section-body">${text ? escapeHtml(text) : '<em>Not yet documented.</em>'}</p>`
        + '</section>';
    }).join('');
    const links = (charter && charter.runtimeLinks) || {};
    const linkItems = ['fleetSettings', 'sessionRules', 'roadmap']
      .filter((key) => links[key])
      .map((key) => {
        const raw = String(links[key]);
        const href = _tcV6IsSafeRuntimeLinkHref(raw) ? raw : '#';
        return `<li><a href="${escapeHtml(href)}">${escapeHtml(CHARTER_SECTION_TITLES[key] || key)}</a></li>`;
      })
      .join('');
    const linksMarkup = linkItems ? `<ul class="v6-charter-runtime-links">${linkItems}</ul>` : '';
    return `<div class="v6-charter-sections">${body}${linksMarkup}</div>`;
  }

  /**
   * Mounts a minimal, self-contained SSOT index + reader (#3275 AC2) —
   * NOT yet wired into `public/v6-shell.js`'s central pane; see this
   * file's own top comment for the integration point a later car uses.
   * @param {object} doc - `document`, or `test/_mini-dom.js`'s stand-in (unused directly; kept
   *   for signature parity with this repo's other `tcV6Create*`/`tcV6Mount*` functions, which
   *   take it to attach listeners — this one is a pure markup function with none yet to attach).
   * @param {{manifest?: object|null, activeDocumentId?: string|null, activeDocument?: object|null,
   *   bodyHtml?: string, charter?: object|null}} [opts]
   * @returns {string} HTML for the whole SSOT view (index + reader pane).
   */
  function tcV6MountSsotView(doc, opts) {
    const o = opts || {};
    const index = tcV6RenderSsotIndexMarkup(o.manifest, { activeDocumentId: o.activeDocumentId });
    const isCharter = Boolean(o.activeDocument && o.activeDocument.kind === 'charter');
    const bodyHtml = isCharter ? tcV6RenderCharterSectionsMarkup(o.charter) : o.bodyHtml;
    return `<div class="v6-ssot-view">${index}${tcV6RenderSsotDocumentMarkup(o.activeDocument, bodyHtml)}</div>`;
  }

  global.tcV6RenderSsotIndexMarkup = tcV6RenderSsotIndexMarkup;
  global.tcV6RenderSsotDocumentMarkup = tcV6RenderSsotDocumentMarkup;
  global.tcV6RenderCharterSectionsMarkup = tcV6RenderCharterSectionsMarkup;
  global.tcV6MountSsotView = tcV6MountSsotView;
})(typeof window !== 'undefined' ? window : globalThis);
