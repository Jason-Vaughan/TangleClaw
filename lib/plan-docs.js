'use strict';

/*
 * Served plan / design docs (#542).
 *
 * The global rule "make plans openable from anywhere" names a goal only Claude
 * Code could reach (Artifacts). Every other engine writes a plan to
 * `.tangleclaw/plans/<file>.md` and has nowhere to hand the operator a link.
 * This module is the floor every engine gets: TangleClaw renders the file at
 * `/plans/<projectId>/<file>.md` behind the same perimeter as the dashboard.
 *
 * Two properties carry the module:
 *
 *   1. ONLY A BASENAME IS ADDRESSABLE. A plan is named by its file name and
 *      nothing else — no directories, no `..`, no encoded separators — and the
 *      name resolves by REAL path, so a symlink that points out of the plans
 *      directory is refused even though its name looked fine. `archive/` is a
 *      subdirectory and so is unreachable by construction; a request for an
 *      archived plan is told it was archived rather than "not found".
 *   2. ESCAPE FIRST. The Markdown is authored by a session and served as a
 *      page, so every character passes through `escHtml` before any mark is
 *      applied — the same contract `public/next-markdown.js` holds for the
 *      dashboard's "Next action". The block renderer here is a superset of
 *      that one (headings, fences, tables, nested lists, task boxes,
 *      blockquotes, links) because a plan uses them all; the inline escaping
 *      is shared, not re-derived. Raw HTML in the source never survives.
 *
 * Links are the one deliberate addition over the dashboard renderer: a plan
 * cites issues and sibling plans. `href` is restricted to http(s), mailto,
 * fragments and relative paths, so an escaping slip cannot become a live
 * `javascript:` link. Bare URLs are not autolinked, for the same reason the
 * dashboard declines to.
 *
 * The plans directory is the wrap step's, imported rather than re-declared,
 * so the location a wrap reads and the location this serves cannot drift.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_PLANS_DIR, LEGACY_PLANS_DIR } = require('./wrap-steps/priming-roll');
const { escHtml } = require('../public/next-markdown');

/** Subdirectory a shipped plan is moved to; never served, always reported. */
const ARCHIVE_SUBDIR = 'archive';

/**
 * The only shape a plan name may take: a leading alphanumeric, then
 * alphanumerics, dots, hyphens and underscores, ending in `.md`. No separators
 * of any kind, so a directory can never be named; length-capped so a
 * pathological name cannot reach the filesystem.
 */
const PLAN_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.md$/;

/** Schemes an `href` in a rendered plan may carry. Anything else is text. */
const SAFE_HREF_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Whether a caller-supplied plan name is one this module will look up.
 *
 * The `..` check is redundant with the regex (a dot may not follow a dot into
 * a separator, and separators are refused outright) and kept anyway: the
 * traversal refusal is the contract, and a future loosening of the regex must
 * not silently take it with it.
 *
 * @param {*} file - The name as it arrived (already URL-decoded by the caller).
 * @returns {boolean}
 */
function isValidPlanFileName(file) {
  if (typeof file !== 'string') return false;
  if (file.includes('..')) return false;
  return PLAN_FILE_RE.test(file);
}

/**
 * The directories a project's plans may live in, in lookup order.
 *
 * @param {string} projectPath - Absolute project root.
 * @returns {Array<{dir: string, relative: string, legacy: boolean}>}
 */
function plansDirCandidates(projectPath) {
  return [
    { dir: path.join(projectPath, DEFAULT_PLANS_DIR), relative: DEFAULT_PLANS_DIR, legacy: false },
    { dir: path.join(projectPath, LEGACY_PLANS_DIR), relative: LEGACY_PLANS_DIR, legacy: true }
  ];
}

/**
 * Resolve a directory to its real path, or null when it is absent or not a
 * directory. A worktree's `.tangleclaw/plans` is commonly a symlink to the
 * primary checkout's, which is why containment below is measured against the
 * REAL directory rather than the path as written.
 *
 * @param {string} dir - Directory path as written.
 * @returns {string|null}
 */
function _realDir(dir) {
  try {
    const real = fs.realpathSync(dir);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Resolve `candidate` and accept it only when it is a regular file sitting
 * DIRECTLY inside `realDir` once every symlink is followed. A symlink to a
 * sibling in the same directory passes; one to anywhere else — a parent, a
 * subdirectory, another project, `/etc` — does not.
 *
 * @param {string} realDir - Real path of the plans directory.
 * @param {string} candidate - Path of the file as written.
 * @returns {{real: string, stat: fs.Stats}|null}
 */
function _regularFileWithin(realDir, candidate) {
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  if (path.dirname(real) !== realDir) return null;
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return null;
  }
  return stat.isFile() ? { real, stat } : null;
}

/**
 * Describe one served plan file.
 *
 * @param {string} file - Plan file name.
 * @param {{relative: string, legacy: boolean}} candidate - The directory it was found in.
 * @param {{real: string, stat: fs.Stats}} hit - Its resolved file.
 * @returns {{file: string, path: string, relative: string, legacy: boolean, modifiedAt: string, size: number}}
 */
function _describe(file, candidate, hit) {
  return {
    file,
    path: hit.real,
    relative: path.posix.join(candidate.relative, file),
    legacy: candidate.legacy,
    modifiedAt: hit.stat.mtime.toISOString(),
    size: hit.stat.size
  };
}

/**
 * Find the plan a name refers to.
 *
 * Lookup order is the wrap step's: TangleClaw's own directory first, the
 * legacy engine-owned one second. An `archived` verdict means the name exists
 * under `archive/` in one of them and nowhere servable — the honest answer to
 * "where did my link go" after a chunk ships.
 *
 * @param {string} projectPath - Absolute project root.
 * @param {*} file - Caller-supplied plan name.
 * @returns {{status: 'invalid'}|{status: 'absent'}|{status: 'archived'}|{status: 'ok', file: string, path: string, relative: string, legacy: boolean, modifiedAt: string, size: number}}
 */
function resolvePlanFile(projectPath, file) {
  if (!isValidPlanFileName(file)) return { status: 'invalid' };
  let archived = false;
  for (const candidate of plansDirCandidates(projectPath)) {
    const realDir = _realDir(candidate.dir);
    if (!realDir) continue;
    const hit = _regularFileWithin(realDir, path.join(candidate.dir, file));
    if (hit) return { status: 'ok', ..._describe(file, candidate, hit) };
    const archiveDir = _realDir(path.join(candidate.dir, ARCHIVE_SUBDIR));
    if (archiveDir && _regularFileWithin(archiveDir, path.join(candidate.dir, ARCHIVE_SUBDIR, file))) {
      archived = true;
    }
  }
  return { status: archived ? 'archived' : 'absent' };
}

/**
 * Every servable plan in a project, sorted by name within each directory,
 * TangleClaw's directory first. A legacy file shadowed by a same-named file in
 * the TangleClaw directory is omitted, because `resolvePlanFile` could never
 * reach it — the listing promises only links that answer. Entries are exactly
 * what `resolvePlanFile` would accept, so the two cannot disagree about a
 * symlink or a directory named `x.md`.
 *
 * @param {string} projectPath - Absolute project root.
 * @returns {Array<{file: string, path: string, relative: string, legacy: boolean, modifiedAt: string, size: number}>}
 */
function listPlans(projectPath) {
  const out = [];
  const seen = new Set();
  for (const candidate of plansDirCandidates(projectPath)) {
    const realDir = _realDir(candidate.dir);
    if (!realDir) continue;
    let names;
    try {
      names = fs.readdirSync(candidate.dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (seen.has(name) || !isValidPlanFileName(name)) continue;
      const hit = _regularFileWithin(realDir, path.join(candidate.dir, name));
      if (!hit) continue;
      seen.add(name);
      out.push(_describe(name, candidate, hit));
    }
  }
  return out;
}

// ── Markdown rendering ──

/**
 * Whether an `href` written in a plan may be emitted as a live link.
 *
 * Fragments and relative paths are allowed (a sibling plan linked as
 * `./other.md` resolves to its own served page); absolute URLs must carry an
 * allowlisted scheme. The value is already HTML-escaped, which is fine: a
 * scheme is letters and a colon, and neither is touched by escaping.
 *
 * @param {string} href - Escaped href text.
 * @returns {boolean}
 */
function _isSafeHref(href) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    const scheme = href.slice(0, href.indexOf(':') + 1).toLowerCase();
    return SAFE_HREF_SCHEMES.has(scheme);
  }
  // No scheme: a fragment or a path. Refuse a protocol-relative `//host`,
  // which a browser would treat as an absolute URL to another origin.
  return !href.startsWith('//');
}

/**
 * Render inline marks onto one line of raw Markdown text.
 *
 * Escapes FIRST, then applies every mark in ONE alternating pass, left to
 * right — so a code span swallows its own content and a `**` or `[` inside it
 * stays literal, exactly as the dashboard renderer argues. Order of the
 * alternatives decides ties at a position: code, then bold, strike, link,
 * italic.
 *
 * @param {string} raw - Unescaped source text.
 * @returns {string} HTML for the line.
 */
function renderInline(raw) {
  const escaped = escHtml(raw);
  return escaped.replace(
    // Underscore emphasis only at word boundaries, so `snake_case_names`
    // stay literal; asterisk emphasis is intra-word by convention.
    /`([^`]+)`|\*\*([^*]+)\*\*|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s](?:[^*]*[^*\s])?)\*|(?<![A-Za-z0-9])_([^_\s](?:[^_]*[^_\s])?)_(?![A-Za-z0-9])/g,
    (match, code, bold, strike, linkText, href, star, under) => {
      if (code !== undefined) return `<code>${code}</code>`;
      if (bold !== undefined) return `<strong>${bold}</strong>`;
      if (strike !== undefined) return `<del>${strike}</del>`;
      if (linkText !== undefined) {
        // An unsafe href is shown as the author wrote it (escaped), so the
        // reader can see what was refused rather than a silently broken link.
        return _isSafeHref(href)
          ? `<a href="${href}">${linkText}</a>`
          : match;
      }
      const em = star !== undefined ? star : under;
      return `<em>${em}</em>`;
    }
  );
}

/**
 * A heading's anchor id: lowercase, alphanumerics, hyphens for everything
 * else, deduplicated with a counter so two "Notes" headings both link.
 *
 * @param {string} text - Raw heading text.
 * @param {Map<string, number>} used - Ids already emitted in this document.
 * @returns {string}
 */
function _slug(text, used) {
  const base = text.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  const n = used.get(base) || 0;
  used.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

/** A fenced-code opener: three or more backticks or tildes, optional info string. */
const FENCE_RE = /^(`{3,}|~{3,})\s*([^\s`]*)/;
/** A list item: indent, marker (`-`, `*`, `+`, `1.`, `1)`), then text. */
const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
/** A GFM table separator row: pipes, dashes, optional alignment colons. */
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** A thematic break: three or more of one of `-`, `*`, `_`. */
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Split a table row on unescaped pipes, dropping the outer empties a leading
 * and trailing `|` produce.
 *
 * @param {string} line - One table row.
 * @returns {string[]} Cell texts, trimmed, `\|` unescaped.
 */
function _splitRow(line) {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());
  return cells;
}

/**
 * Render a GFM table from its rows.
 *
 * @param {string} header - Header row.
 * @param {string} separator - Alignment row.
 * @param {string[]} rows - Body rows.
 * @returns {string} A `<table>` inside a horizontally scrolling container.
 */
function _renderTable(header, separator, rows) {
  const aligns = _splitRow(separator).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return ' style="text-align:center"';
    if (right) return ' style="text-align:right"';
    return '';
  });
  /**
   * One cell, carrying its column's alignment.
   * @param {'th'|'td'} tag - Cell element.
   * @param {string} text - Raw cell text.
   * @param {number} i - Column index.
   * @returns {string}
   */
  const cell = (tag, text, i) => `<${tag}${aligns[i] || ''}>${renderInline(text)}</${tag}>`;
  const head = _splitRow(header).map((t, i) => cell('th', t, i)).join('');
  const body = rows.map((r) => `<tr>${_splitRow(r).map((t, i) => cell('td', t, i)).join('')}</tr>`).join('');
  return `<div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * Render one list item's text, turning a leading `[ ]` / `[x]` into a
 * disabled checkbox so a plan's status roster reads as it does on GitHub.
 *
 * @param {string} text - Item text after the marker.
 * @returns {string}
 */
function _renderItemText(text) {
  const task = text.match(/^\[([ xX])\]\s+(.*)$/);
  if (!task) return renderInline(text);
  const checked = task[1] !== ' ' ? ' checked' : '';
  return `<input type="checkbox" disabled${checked}> ${renderInline(task[2])}`;
}

/**
 * Render a run of list lines (items plus their indented continuations) into
 * nested `<ul>`/`<ol>` by indentation depth.
 *
 * Items are first flattened to `{indent, ordered, text}`; a continuation line
 * joins the preceding item's text. Nesting then follows indent with a stack,
 * so `- a` / `  - b` / `- c` renders b inside a. Mixed markers at one depth
 * keep the list type they opened with.
 *
 * @param {string[]} lines - The list block's source lines.
 * @returns {string}
 */
function _renderList(lines) {
  const items = [];
  for (const line of lines) {
    const m = line.match(LIST_ITEM_RE);
    if (m) {
      items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
    } else if (items.length && line.trim()) {
      items[items.length - 1].text += ' ' + line.trim();
    }
  }
  const out = [];
  const stack = [];
  /**
   * Close the innermost open list (its last item included).
   * @returns {void}
   */
  const close = () => {
    const top = stack.pop();
    out.push(`</li></${top.tag}>`);
  };
  for (const item of items) {
    const tag = item.ordered ? 'ol' : 'ul';
    while (stack.length && item.indent < stack[stack.length - 1].indent) close();
    if (stack.length && item.indent === stack[stack.length - 1].indent) {
      if (stack[stack.length - 1].tag === tag) {
        out.push(`</li><li>${_renderItemText(item.text)}`);
        continue;
      }
      // Same depth, other kind: `1.` after `-` starts a new list, not a
      // fourth bullet.
      close();
    }
    stack.push({ indent: item.indent, tag });
    out.push(`<${tag}><li>${_renderItemText(item.text)}`);
  }
  while (stack.length) close();
  return out.join('');
}

/**
 * Whether a line belongs to a list block already in progress: another item,
 * an indented continuation, or a blank that is followed by one of those.
 *
 * @param {string[]} lines - All source lines.
 * @param {number} i - Index of the line to classify.
 * @returns {boolean}
 */
function _continuesList(lines, i) {
  const line = lines[i];
  if (LIST_ITEM_RE.test(line)) return true;
  if (line.trim() && /^\s{2,}/.test(line)) return true;
  if (line.trim()) return false;
  // Blank: look past it. A following item or continuation keeps the list
  // open (a "loose" list); anything else ends it.
  const next = lines.slice(i + 1).find((l) => l.trim());
  return next !== undefined && (LIST_ITEM_RE.test(next) || /^\s{2,}/.test(next));
}

/**
 * Render a Markdown body to HTML fragments.
 *
 * Block constructs: YAML front matter (shown collapsed), fenced code, ATX
 * headings (with anchor ids), thematic breaks, GFM tables, blockquotes,
 * nested ordered/unordered lists with task boxes, and paragraphs. Single-line
 * HTML comments are dropped (managed-block markers are plumbing, not
 * content); every other line of raw HTML is escaped and shown as text.
 *
 * @param {string} markdown - Plan source.
 * @returns {string} HTML, safe to place in a document body.
 */
function renderPlanBody(markdown) {
  const lines = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const ids = new Map();
  let i = 0;

  // Front matter: an opening `---` on line 1, closed by the next `---`.
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      out.push(`<details class="frontmatter"><summary>Front matter</summary><pre>${escHtml(lines.slice(1, end).join('\n'))}</pre></details>`);
      i = end + 1;
    }
  }

  let paragraph = [];
  /**
   * Emit the paragraph lines gathered so far, if any, as one `<p>`.
   * @returns {void}
   */
  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.map(renderInline).join(' ')}</p>`);
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { flushParagraph(); i += 1; continue; }
    if (/^<!--.*-->\s*$/.test(line)) { i += 1; continue; }

    const fence = line.match(FENCE_RE);
    if (fence) {
      flushParagraph();
      const marker = fence[1];
      const info = fence[2];
      const body = [];
      /**
       * A closing fence: the same character as the opener, at least as long,
       * and nothing else on the line.
       * @param {string} l - Candidate line.
       * @returns {boolean}
       */
      const closes = (l) => {
        const m = l.match(/^(`{3,}|~{3,})\s*$/);
        return !!m && m[1][0] === marker[0] && m[1].length >= marker.length;
      };
      i += 1;
      while (i < lines.length && !closes(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or end of input)
      const cls = info ? ` class="language-${escHtml(info)}"` : '';
      out.push(`<pre><code${cls}>${escHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      out.push(`<h${level} id="${_slug(heading[2], ids)}">${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      flushParagraph();
      out.push('<hr>');
      i += 1;
      continue;
    }

    if (line.trim().startsWith('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      flushParagraph();
      const header = line;
      const separator = lines[i + 1];
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i]);
        i += 1;
      }
      out.push(_renderTable(header, separator, rows));
      continue;
    }

    if (line.startsWith('>')) {
      flushParagraph();
      const quoted = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoted.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderPlanBody(quoted.join('\n'))}</blockquote>`);
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      flushParagraph();
      const block = [];
      while (i < lines.length && _continuesList(lines, i)) {
        block.push(lines[i]);
        i += 1;
      }
      out.push(_renderList(block));
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();
  return out.join('\n');
}

/**
 * The first H1 in a plan, or null. Used as the page title so a tab reads as
 * the plan's own name rather than its file name.
 *
 * @param {string} markdown - Plan source.
 * @returns {string|null}
 */
function planTitle(markdown) {
  const m = String(markdown == null ? '' : markdown).match(/^#\s+(.+?)\s*#*\s*$/m);
  return m ? m[1].replace(/`/g, '').trim() : null;
}

/**
 * Page chrome shared by the rendered plan and the error pages: one stylesheet
 * with light tokens on `:root` and a dark override under
 * `prefers-color-scheme`, so the page follows the viewer's theme with no
 * script. Wide content — tables and code — scrolls inside its own container;
 * the page body never scrolls sideways on a phone.
 */
const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#fafaf8;--fg:#1f2328;--muted:#59636e;--border:#d8dde3;--code-bg:#eef1f4;--link:#0a5bd3;--accent:#6b3fa0;--surface:#ffffff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e8eb;--muted:#9aa4b0;--border:#2b313a;--code-bg:#1a1f27;--link:#7cb2ff;--accent:#c9a7ff;--surface:#161a21}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
header.plan-bar{display:flex;flex-wrap:wrap;gap:.4rem 1rem;align-items:baseline;padding:.75rem 1.25rem;border-bottom:1px solid var(--border);background:var(--surface);font-size:.85rem;color:var(--muted)}
header.plan-bar a{color:var(--accent);text-decoration:none;font-weight:600}
header.plan-bar code{font-size:.8rem}
main.plan{max-width:52rem;margin:0 auto;padding:1.5rem 1.25rem 4rem;overflow-wrap:anywhere}
main.plan h1,main.plan h2,main.plan h3,main.plan h4{line-height:1.25;margin:1.6em 0 .6em}
main.plan h1{font-size:1.9rem;margin-top:.4em}
main.plan h2{font-size:1.45rem;border-bottom:1px solid var(--border);padding-bottom:.25em}
main.plan h3{font-size:1.15rem}
main.plan a{color:var(--link)}
main.plan code{background:var(--code-bg);border-radius:4px;padding:.1em .35em;font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
main.plan pre{background:var(--code-bg);border:1px solid var(--border);border-radius:6px;padding:.9rem 1rem;overflow-x:auto;line-height:1.45}
main.plan pre code{background:none;padding:0;font-size:.85rem}
main.plan blockquote{margin:1em 0;padding:.2em 1em;border-left:4px solid var(--accent);color:var(--muted)}
main.plan .table-scroll{overflow-x:auto;margin:1em 0;-webkit-overflow-scrolling:touch}
main.plan table{border-collapse:collapse;min-width:100%;font-size:.92rem}
main.plan th,main.plan td{border:1px solid var(--border);padding:.4em .7em;vertical-align:top;text-align:left}
main.plan th{background:var(--code-bg)}
main.plan ul,main.plan ol{padding-left:1.5em}
main.plan li{margin:.2em 0}
main.plan input[type=checkbox]{margin:0 .35em 0 0;vertical-align:-.1em}
main.plan hr{border:0;border-top:1px solid var(--border);margin:2em 0}
main.plan img{max-width:100%}
details.frontmatter{font-size:.85rem;color:var(--muted);margin-bottom:1em}
details.frontmatter pre{margin:.5em 0 0}
main.plan.message p{font-size:1.05rem}
`;

/**
 * Wrap rendered body HTML in the full page document.
 *
 * @param {object} page - Page fields.
 * @param {string} page.title - Document title (escaped here).
 * @param {string} page.bar - Header-bar HTML (already escaped by the caller).
 * @param {string} page.body - Main HTML.
 * @param {string} [page.mainClass] - Extra class on `<main>`.
 * @returns {string}
 */
function _document({ title, bar, body, mainClass }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<header class="plan-bar">${bar}</header>
<main class="plan${mainClass ? ' ' + mainClass : ''}">
${body}
</main>
</body>
</html>
`;
}

/**
 * Render a plan as a complete, theme-aware HTML page.
 *
 * @param {object} plan - What to render.
 * @param {{id: number, name: string}} plan.project - Owning project.
 * @param {string} plan.file - Plan file name.
 * @param {string} plan.relative - Project-relative path of the file.
 * @param {string} plan.modifiedAt - ISO mtime.
 * @param {string} plan.markdown - Plan source.
 * @returns {string} The HTML document.
 */
function renderPlanPage({ project, file, relative, modifiedAt, markdown }) {
  const title = planTitle(markdown) || file;
  const bar = `<a href="/">TangleClaw</a>`
    + `<span>${escHtml(project.name)}</span>`
    + `<code>${escHtml(relative)}</code>`
    + `<span>updated <time datetime="${escHtml(modifiedAt)}">${escHtml(modifiedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC'))}</time></span>`;
  return _document({
    title: `${title} · ${project.name} · TangleClaw`,
    bar,
    body: renderPlanBody(markdown)
  });
}

/**
 * A plain HTML message page, for the refusals a browser lands on: a plan that
 * was archived, one that never existed, a name that is not a plan name.
 *
 * @param {object} msg - Message fields.
 * @param {string} msg.title - Short title (also the heading).
 * @param {string} msg.message - One or two sentences saying what happened and what to do.
 * @returns {string} The HTML document.
 */
function renderMessagePage({ title, message }) {
  return _document({
    title: `${title} · TangleClaw`,
    bar: `<a href="/">TangleClaw</a><span>Plan documents</span>`,
    body: `<h1>${escHtml(title)}</h1>\n<p>${escHtml(message)}</p>`,
    mainClass: 'message'
  });
}

module.exports = {
  isValidPlanFileName,
  plansDirCandidates,
  resolvePlanFile,
  listPlans,
  renderInline,
  renderPlanBody,
  planTitle,
  renderPlanPage,
  renderMessagePage,
  ARCHIVE_SUBDIR,
  PLAN_FILE_RE
};
