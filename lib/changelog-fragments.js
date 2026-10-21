'use strict';

/*
 * Per-car changelog fragments: `changelog.d/<issue>.<slug>.<type>.md`.
 *
 * Every pull request that lands on a shared CHANGELOG.md serializes on its
 * `[Unreleased]` block: two branches that each add an entry conflict on the
 * same lines. A fragment is one entry in its own file, named for the issue it
 * records and the Keep a Changelog subsection it belongs under, so parallel
 * work never touches the same file. The release preparation compiles the
 * fragments into `[Unreleased]` and deletes them.
 *
 * This module is the contract: it enumerates the fragment directory,
 * validates every entry against the closed filename and body grammar, and
 * compiles the accepted fragments into subsection text, deterministically.
 * It never reads or writes CHANGELOG.md itself: `spliceIntoUnreleased` is a
 * pure function over text the caller hands it, and the only directory the
 * read path ever opens is `<root>/changelog.d`, so `.prawduct/change-log.md`
 * (ADR 0011) is out of reach by construction.
 *
 * Bump derivation is deliberately absent. `lib/wrap-steps/version-bump.js`
 * owns it, decides it on the spliced text, and is the module that will
 * require this one; a require the other way would be a CommonJS cycle. The
 * two regexes that find the `[Unreleased]` block are therefore this module's
 * own constants, kept equal to `version-bump`'s by a test that reads both.
 *
 * Production requires: `node:fs`, `node:path`, `./logger`. Nothing else.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('./logger');

const log = createLogger('changelog-fragments');

/** The directory, relative to a project root, that holds fragments. */
const FRAGMENT_DIR = 'changelog.d';

/**
 * The seven fragment types, in Keep a Changelog subsection order. The order
 * is the compile order: a compiled block lists `Added` before `Fixed`.
 * `internal` is this repo's own subsection (#231): logged, never a minor bump.
 */
const TYPES = Object.freeze(['added', 'changed', 'removed', 'deprecated', 'fixed', 'security', 'internal']);

/** Slug grammar: lowercase ASCII letters, digits and hyphens, 1 to 48 of them. */
const SLUG_RE = /^[a-z0-9-]{1,48}$/;

/**
 * The closed filename grammar. A name is a fragment if and only if it matches:
 * a positive issue number with no leading zero (one name per issue), a slug,
 * a known type, `.md`. `parseFragmentName` reports which part failed; this
 * regex is the one-line statement of what passes, and a test holds the two
 * to the same verdict. The parser adds one bound the grammar cannot state:
 * the issue number must be an integer JavaScript holds exactly.
 */
const NAME_RE = /^([1-9]\d*)\.([a-z0-9-]{1,48})\.(added|changed|removed|deprecated|fixed|security|internal)\.md$/;

/** A name split into its three dot-separated parts before `.md`. */
const NAME_PARTS_RE = /^([^.]*)\.([^.]*)\.([^.]*)\.md$/;

/** The block-finding regexes, equal to `version-bump`'s by test. */
const UNRELEASED_LINE_RE = /^## \[Unreleased\]\s*$/;
const NEXT_HEADING_RE = /^## /;

/** A Keep a Changelog subsection heading inside `[Unreleased]`, as `version-bump` reads it. */
const SUBSECTION_RE = /^### (Added|Changed|Removed|Deprecated|Fixed|Security|Internal)\s*$/i;

/** An ATX heading of any level: never allowed inside a fragment body. */
const HEADING_LINE_RE = /^#{1,6} /;

/** A fenced code block opener (CommonMark allows up to three spaces of indent). */
const FENCE_OPEN_RE = /^ {0,3}(?:`{3,}|~{3,})/;

/** A Markdown list item with some text on its first line. */
const LIST_ITEM_RE = /^[-*] \S/;

/** The Keep a Changelog heading for a fragment type (`added` → `Added`). */
const HEADING_OF = Object.freeze(Object.fromEntries(TYPES.map((t) => [t, t.charAt(0).toUpperCase() + t.slice(1)])));

/**
 * Build a refusal record.
 *
 * @param {string} code - One of the documented refusal codes
 * @param {string} reason - What a contributor would need to change
 * @returns {{ok:false, code:string, reason:string}}
 */
function _refuse(code, reason) {
  return { ok: false, code, reason };
}

/**
 * Parse a fragment's basename into its issue, slug and type.
 *
 * Refusal codes, in the order they are checked: `MALFORMED_NAME` (not three
 * dot-separated parts followed by `.md`, or a path separator anywhere),
 * `BAD_ISSUE` (the first part is not a positive integer without a leading
 * zero that JavaScript can hold exactly), `BAD_SLUG` (the second part is outside `[a-z0-9-]{1,48}`),
 * `UNKNOWN_TYPE` (the third part is not one of `TYPES`).
 *
 * @param {string} basename - The filename alone, no directory
 * @returns {{ok:true, issue:number, slug:string, type:string}|{ok:false, code:string, reason:string}}
 */
function parseFragmentName(basename) {
  if (typeof basename !== 'string' || basename.length === 0) {
    return _refuse('MALFORMED_NAME', 'a fragment name is a non-empty string');
  }
  if (basename.includes('/') || basename.includes('\\')) {
    return _refuse('MALFORMED_NAME', 'a fragment name carries no path separator');
  }
  const m = NAME_PARTS_RE.exec(basename);
  if (!m) {
    return _refuse('MALFORMED_NAME', `expected <issue>.<slug>.<type>.md, got ${JSON.stringify(basename)}`);
  }
  const [, issuePart, slug, type] = m;
  if (!/^[1-9]\d*$/.test(issuePart)) {
    return _refuse('BAD_ISSUE', `issue ${JSON.stringify(issuePart)} is not a positive integer without a leading zero`);
  }
  const issue = Number(issuePart);
  if (!Number.isSafeInteger(issue) || issue < 1) {
    return _refuse('BAD_ISSUE', `issue ${JSON.stringify(issuePart)} is not a positive integer`);
  }
  if (!SLUG_RE.test(slug)) {
    return _refuse('BAD_SLUG', `slug ${JSON.stringify(slug)} is not 1 to 48 of [a-z0-9-]`);
  }
  if (!TYPES.includes(type)) {
    return _refuse('UNKNOWN_TYPE', `type ${JSON.stringify(type)} is not one of ${TYPES.join(', ')}`);
  }
  return { ok: true, issue, slug, type };
}

/**
 * Validate a fragment body against the body rule: non-empty, no heading
 * line, no fence opener, and the first non-blank line is a list item with
 * text. Continuation lines and sub-bullets are allowed.
 *
 * @param {string} body - File contents, as read
 * @returns {{ok:true}|{ok:false, code:string, reason:string}}
 */
function _validateBody(body) {
  if (typeof body !== 'string' || body.trim().length === 0) {
    return _refuse('EMPTY_BODY', 'the fragment has no entry');
  }
  const lines = body.split(/\r?\n/);
  let firstSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (HEADING_LINE_RE.test(line)) {
      return _refuse('BAD_BODY', `line ${i + 1} is a heading; a fragment holds one list entry, under no heading`);
    }
    if (FENCE_OPEN_RE.test(line)) {
      return _refuse('BAD_BODY', `line ${i + 1} opens a fenced block; a fragment holds one list entry`);
    }
    if (!firstSeen && line.trim().length > 0) {
      firstSeen = true;
      if (!LIST_ITEM_RE.test(line)) {
        return _refuse('BAD_BODY', `line ${i + 1} must start the entry with "- " or "* " followed by text`);
      }
    }
  }
  return { ok: true };
}

/**
 * Compare two fragments for the published order: numerically by issue, then
 * bytewise by slug, then by type in `TYPES` order. The three parts are the
 * whole filename, so the order is total over distinct fragments and
 * filesystem enumeration order never reaches the output.
 *
 * @param {{issue:number, slug:string, type:string}} a
 * @param {{issue:number, slug:string, type:string}} b
 * @returns {number}
 */
function _compareFragments(a, b) {
  if (a.issue !== b.issue) return a.issue - b.issue;
  if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
  return TYPES.indexOf(a.type) - TYPES.indexOf(b.type);
}

/**
 * Resolve the filesystem functions a read uses, with test overrides.
 *
 * @param {{readdirSync?:Function, lstatSync?:Function, realpathSync?:Function, readFileSync?:Function}} [override]
 * @returns {{readdirSync:Function, lstatSync:Function, realpathSync:Function, readFileSync:Function}}
 */
function _io(override) {
  const o = override || {};
  return {
    readdirSync: o.readdirSync || fs.readdirSync,
    lstatSync: o.lstatSync || fs.lstatSync,
    realpathSync: o.realpathSync || fs.realpathSync,
    readFileSync: o.readFileSync || fs.readFileSync
  };
}

/**
 * Check that the fragment directory is a real directory. A missing one is
 * not an error: a repo with nothing pending has no `changelog.d/` at all.
 *
 * @param {string} dir - `<root>/changelog.d`
 * @param {ReturnType<typeof _io>} io
 * @returns {{state:'missing'}|{state:'ok'}|{state:'refused', refusal:{path:string, code:string, reason:string}}}
 */
function _checkDirectory(dir, io) {
  let st;
  try {
    st = io.lstatSync(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'missing' };
    // ENOTDIR included: a file handed in as root (`.prawduct/change-log.md`)
    // has no `changelog.d` beneath it and is refused, never read.
    return { state: 'refused', refusal: { path: dir, code: 'NOT_A_DIRECTORY', reason: `cannot stat: ${err && err.message}` } };
  }
  if (st.isSymbolicLink()) {
    return { state: 'refused', refusal: { path: dir, code: 'SYMLINK', reason: 'the fragment directory is a symlink' } };
  }
  if (!st.isDirectory()) {
    return { state: 'refused', refusal: { path: dir, code: 'NOT_A_DIRECTORY', reason: 'the fragment directory is not a directory' } };
  }
  return { state: 'ok' };
}

/**
 * Validate one directory entry and read it when it passes.
 *
 * @param {string} dir - The fragment directory
 * @param {string} realDir - Its resolved real path
 * @param {string} name - The entry's basename as enumerated
 * @param {ReturnType<typeof _io>} io
 * @returns {{ok:true, fragment:{path:string, issue:number, slug:string, type:string, body:string}}|{ok:false, refusal:{path:string, code:string, reason:string}}}
 */
function _readEntry(dir, realDir, name, io) {
  const entryPath = path.join(dir, name);
  const refused = (code, reason) => ({ ok: false, refusal: { path: entryPath, code, reason } });

  const parsed = parseFragmentName(name);
  if (!parsed.ok) return refused(parsed.code, parsed.reason);

  let st;
  try {
    st = io.lstatSync(entryPath);
  } catch (err) {
    return refused('NOT_A_FILE', `cannot stat: ${err && err.message}`);
  }
  if (st.isSymbolicLink()) return refused('SYMLINK', 'a fragment is a regular file, not a symlink');
  if (st.isDirectory()) return refused('NOT_A_FILE', 'a fragment is a regular file, not a directory');
  if (!st.isFile()) return refused('NOT_A_FILE', 'a fragment is a regular file');

  let real;
  try {
    real = io.realpathSync(entryPath);
  } catch (err) {
    return refused('PATH_ESCAPE', `cannot resolve: ${err && err.message}`);
  }
  if (path.dirname(real) !== realDir) {
    return refused('PATH_ESCAPE', `resolves outside ${FRAGMENT_DIR}`);
  }

  let body;
  try {
    body = io.readFileSync(entryPath, 'utf8');
  } catch (err) {
    return refused('NOT_A_FILE', `cannot read: ${err && err.message}`);
  }
  const bodyCheck = _validateBody(body);
  if (!bodyCheck.ok) return refused(bodyCheck.code, bodyCheck.reason);

  return { ok: true, fragment: { path: entryPath, issue: parsed.issue, slug: parsed.slug, type: parsed.type, body } };
}

/**
 * Enumerate and validate `<root>/changelog.d`.
 *
 * Every entry is checked by name (`parseFragmentName`), by kind (a symlink,
 * a directory or any non-regular file is refused), by resolved location (a
 * real path outside the fragment directory is `PATH_ESCAPE`) and by body.
 * Any refusal makes `ok` false; the caller fails closed and `refused` names
 * each offender with its code. Accepted fragments are sorted by issue, then
 * slug, then type, after reading, so `readdirSync` order never reaches the
 * output. A
 * missing directory is `ok: true` with no fragments and `dirMissing: true`.
 *
 * The directory read is always `<root>/changelog.d`. Handing any file as
 * `root`, `.prawduct/change-log.md` included, reads nothing from it.
 *
 * @param {string} root - Project root
 * @param {{fs?:{readdirSync?:Function, lstatSync?:Function, realpathSync?:Function, readFileSync?:Function}}} [options]
 * @returns {{ok:boolean, fragments:Array<{path:string, issue:number, slug:string, type:string, body:string}>, refused:Array<{path:string, code:string, reason:string}>, dirMissing:boolean}}
 */
function readFragments(root, options) {
  const io = _io(options && options.fs);
  const result = { ok: true, fragments: [], refused: [], dirMissing: false };
  if (typeof root !== 'string' || root.length === 0) {
    result.ok = false;
    result.refused.push({ path: String(root), code: 'NOT_A_DIRECTORY', reason: 'root must be a directory path' });
    return result;
  }
  const dir = path.join(root, FRAGMENT_DIR);

  const dirCheck = _checkDirectory(dir, io);
  if (dirCheck.state === 'missing') {
    result.dirMissing = true;
    return result;
  }
  if (dirCheck.state === 'refused') {
    result.ok = false;
    result.refused.push(dirCheck.refusal);
    log.warn('fragment directory refused', { path: dirCheck.refusal.path, code: dirCheck.refusal.code });
    return result;
  }

  let realDir;
  let names;
  try {
    realDir = io.realpathSync(dir);
    names = io.readdirSync(dir);
  } catch (err) {
    result.ok = false;
    result.refused.push({ path: dir, code: 'NOT_A_DIRECTORY', reason: `cannot read: ${err && err.message}` });
    log.warn('fragment directory refused', { path: dir, code: 'NOT_A_DIRECTORY' });
    return result;
  }

  for (const name of names) {
    const entry = _readEntry(dir, realDir, String(name), io);
    if (entry.ok) {
      result.fragments.push(entry.fragment);
    } else {
      result.refused.push(entry.refusal);
      log.warn('fragment refused', { path: entry.refusal.path, code: entry.refusal.code });
    }
  }
  if (result.refused.length > 0) result.ok = false;
  result.fragments.sort(_compareFragments);
  return result;
}

/**
 * Normalize one fragment body into one entry: CRLF to LF, leading blank
 * lines and trailing whitespace removed, one trailing newline.
 *
 * @param {string} body
 * @returns {string}
 */
function _entryText(body) {
  return body.replace(/\r\n/g, '\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '') + '\n';
}

/**
 * Group accepted fragments into Keep a Changelog sections.
 *
 * Sections appear in `TYPES` order and only for types with at least one
 * fragment; entries within a section follow the published order (issue,
 * then slug), whatever order the caller passed. `bytes` is the UTF-8 length
 * of the block the sections would form on their own: each `### Heading`
 * line, its entries, and one blank line between sections.
 *
 * @param {Array<{issue:number, slug:string, type:string, body:string}>} fragments
 * @returns {{sections:Array<{heading:string, entries:string[]}>, bytes:number}}
 */
function compileFragments(fragments) {
  const byType = new Map();
  for (const f of fragments || []) {
    if (!TYPES.includes(f.type)) continue;
    if (!byType.has(f.type)) byType.set(f.type, []);
    byType.get(f.type).push(f);
  }
  const sections = [];
  for (const type of TYPES) {
    const group = byType.get(type);
    if (!group || group.length === 0) continue;
    group.sort(_compareFragments);
    sections.push({ heading: HEADING_OF[type], entries: group.map((f) => _entryText(f.body)) });
  }
  const rendered = sections.map((s) => `### ${s.heading}\n${s.entries.join('')}`).join('\n');
  return { sections, bytes: Buffer.byteLength(rendered, 'utf8') };
}

/**
 * Locate the `[Unreleased]` block in CHANGELOG text exactly as
 * `version-bump._parseUnreleased` does: the heading line, then every line
 * up to the next `## ` heading or the end of the file.
 *
 * @param {string[]} lines - The text split on `\n`
 * @returns {{startIdx:number, endIdx:number}} `startIdx` is `-1` when absent
 */
function _findUnreleased(lines) {
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (UNRELEASED_LINE_RE.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx === -1) return { startIdx, endIdx: -1 };
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (NEXT_HEADING_RE.test(lines[i])) { endIdx = i; break; }
  }
  return { startIdx, endIdx };
}

/**
 * Find the `### <Subsection>` headings in a block's lines, skipping fenced
 * code so a heading quoted inside a fence is never written into.
 *
 * @param {string[]} block
 * @returns {Array<{type:string, start:number, end:number}>} `start` is the heading's index, `end` the next heading's index or the block length
 */
function _subsectionsOf(block) {
  const found = [];
  let inFence = false;
  for (let i = 0; i < block.length; i++) {
    const line = block[i];
    if (FENCE_OPEN_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = SUBSECTION_RE.exec(line);
    if (m) found.push({ type: m[1].toLowerCase(), start: i, end: block.length });
  }
  for (let i = 0; i + 1 < found.length; i++) found[i].end = found[i + 1].start;
  return found;
}

/**
 * Append entries at the end of an existing subsection, before any blank
 * lines that separate it from what follows.
 *
 * @param {string[]} block - Mutated in place
 * @param {{start:number, end:number}} sub
 * @param {string[]} entryLines
 */
function _appendToSubsection(block, sub, entryLines) {
  let k = sub.end;
  while (k > sub.start + 1 && block[k - 1].trim() === '') k--;
  block.splice(k, 0, ...entryLines);
}

/**
 * Insert a new subsection at its Keep a Changelog position: after the last
 * existing subsection of an earlier type, else before the first of a later
 * type, else at the end of the block. One blank line separates it from
 * whatever precedes and follows it; existing lines are not rewritten.
 *
 * @param {string[]} block - Mutated in place
 * @param {string} type
 * @param {string[]} entryLines
 */
function _insertSubsection(block, type, entryLines) {
  const subs = _subsectionsOf(block);
  const rank = TYPES.indexOf(type);
  let at = block.length;
  const earlier = subs.filter((s) => TYPES.indexOf(s.type) < rank);
  const later = subs.filter((s) => TYPES.indexOf(s.type) > rank);
  if (earlier.length > 0) at = earlier[earlier.length - 1].end;
  else if (later.length > 0) at = later[0].start;
  const inserted = [`### ${HEADING_OF[type]}`, ...entryLines, ''];
  if (at === 0 || block[at - 1].trim() !== '') inserted.unshift('');
  block.splice(at, 0, ...inserted);
}

/**
 * Splice compiled sections into the `[Unreleased]` block of CHANGELOG text.
 *
 * Pure: returns new text, writes nothing. For each compiled section, the
 * entries are appended to the end of the existing `### <Heading>` subsection
 * when the block has one, or a new subsection is added at the correct Keep a
 * Changelog position among the existing ones. Every byte outside the block is
 * returned unchanged, and the block's existing lines are kept as they are.
 *
 * Calling this twice with the same sections appends them twice. Idempotence
 * belongs to the caller, which deletes a fragment once it is consumed.
 *
 * @param {string} changelogText
 * @param {{sections:Array<{heading:string, entries:string[]}>}} compiled - From `compileFragments`
 * @returns {{ok:boolean, text:string, added:number, reason?:string}} `ok` is false, with the text unchanged, when no `[Unreleased]` heading exists
 */
function spliceIntoUnreleased(changelogText, compiled) {
  const text = typeof changelogText === 'string' ? changelogText : '';
  const sections = (compiled && compiled.sections) || [];
  const lines = text.split('\n');
  const { startIdx, endIdx } = _findUnreleased(lines);
  if (startIdx === -1) {
    return { ok: false, text, added: 0, reason: 'no `## [Unreleased]` heading' };
  }
  const block = lines.slice(startIdx + 1, endIdx);
  let added = 0;
  for (const section of sections) {
    const type = String(section.heading || '').toLowerCase();
    if (!TYPES.includes(type) || !Array.isArray(section.entries) || section.entries.length === 0) continue;
    const entryLines = section.entries.flatMap((e) => _entryText(e).replace(/\n$/, '').split('\n'));
    const existing = _subsectionsOf(block).find((s) => s.type === type);
    if (existing) _appendToSubsection(block, existing, entryLines);
    else _insertSubsection(block, type, entryLines);
    added += section.entries.length;
  }
  const out = lines.slice(0, startIdx + 1).concat(block, lines.slice(endIdx));
  return { ok: true, text: out.join('\n'), added };
}

module.exports = {
  FRAGMENT_DIR,
  TYPES,
  NAME_RE,
  parseFragmentName,
  readFragments,
  compileFragments,
  spliceIntoUnreleased,
  _internal: {
    UNRELEASED_LINE_RE,
    NEXT_HEADING_RE,
    SUBSECTION_RE,
    validateBody: _validateBody,
    findUnreleased: _findUnreleased
  }
};
