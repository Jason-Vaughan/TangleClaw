'use strict';

/**
 * v6.1 (#2998, V6-28 / F2, Car V61-W1-C): the deterministic code-to-doc
 * parity generator and drift detector (P22 `6daa047d7f66` §2; #533's
 * reference-table half).
 *
 * Four families of reference table are generated from the code that defines
 * them, never from prose:
 *
 * | Family           | Source                                             | Target doc                        |
 * | ---------------- | -------------------------------------------------- | --------------------------------- |
 * | `CLI`            | `tc help --json` (`lib/tc-verbs.js#renderHelpManifest`) | `docs/tc-cli-reference.md`   |
 * | `ROUTES`         | literal `route('METHOD', '/path', …)` calls        | `docs/api-reference.md`           |
 * | `PROJECT-CONFIG` | `lib/project-config.js#DEFAULT_PROJECT_CONFIG`     | `docs/configuration-reference.md` |
 * | `ENGINES`        | `data/engines/*.json`                              | `docs/engine-guide.md`            |
 *
 * Each table lives in its target doc between exact marker comments
 * (`<!-- TC-DOC-PARITY:<FAMILY>:BEGIN -->` / `END`). {@link checkParity}
 * byte-compares only what is between them, so human prose outside is never
 * touched, and reports drift as flags with a deterministic line diff. It
 * never writes a doc: a changed table is a proposed patch a maintainer
 * reviews, not a silent `--fix`.
 *
 * Fail closed throughout. Routes are found with a real lexical scan
 * ({@link tokenizeJs}: comments, strings, templates and regex literals are
 * told apart, so a `route(` inside any of them is not a route), and anything
 * the scan cannot read with certainty — an unterminated literal, a route
 * registered with computed arguments — is a flag that fails the check rather
 * than a row silently missing from a table that claims completeness. A
 * computed registration (`route(entry.method, entry.path, …)`) passes only
 * when its caller declares the routes it registers.
 *
 * Provenance is split on purpose. A generated block records its source
 * PATHS and a digest of its own rendered rows, so the bytes compared in a
 * doc change exactly when the table does — a source-file digest inside the
 * block would change on every unrelated edit to `server.js` and fail the
 * check on changes that alter no documented fact. The SHA-256 of every
 * source file read (P22 §2.2) travels in the check's result instead
 * (`sourceDigests`), for the review report and CI log.
 *
 * Exit codes follow P22: 0 clean, 1 drift or review needed, 2 an extractor
 * failed — and on 2 no block is produced at all, never a partial table.
 *
 * Library only. The CI step that runs it and the generated blocks inside the
 * four docs are separate, reviewed changes (P22 §2.3: generated blocks are
 * added only after a human reviews each target doc).
 *
 * @module lib/v6/f2-code-doc-parity
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Review-report schema id (P22 §2.2 step 7). */
const REVIEW_SCHEMA = 'tc.doc-parity-review/v1';

/** Generated-block schema id, written into every block. */
const BLOCK_SCHEMA = 'tc.doc-parity/v1';

/** The families this module generates, in report order. */
const FAMILIES = Object.freeze(['CLI', 'ROUTES', 'PROJECT-CONFIG', 'ENGINES']);

/** Each family's default target doc (P22 §2.1). */
const DEFAULT_TARGETS = Object.freeze({
  CLI: 'docs/tc-cli-reference.md',
  ROUTES: 'docs/api-reference.md',
  'PROJECT-CONFIG': 'docs/configuration-reference.md',
  ENGINES: 'docs/engine-guide.md'
});

/** Flags that fail the check (exit 1). Every other flag is informational and still reported. */
const BLOCKING_FLAGS = new Set([
  'BLOCK_DRIFT', 'MISSING_MARKER', 'DUPLICATE_MARKER', 'DYNAMIC_ROUTE_REGISTRATION',
  'DUPLICATE_ROUTE', 'MALFORMED_ROUTE', 'DYNAMIC_DEFAULT', 'TARGET_MISSING', 'ENGINE_PROFILE_FIELD_REVIEW'
]);

/** HTTP methods a literal route may name. */
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** The exact `tc help --json` entry shape this module was written against. */
const CLI_ENTRY_KEYS = ['audience', 'id', 'primed', 'subverbs', 'summary', 'usage'];

/**
 * The reviewed list of engine profile fields deliberately left out of the
 * ENGINES table, as data (see {@link extractEngines} for why it is not code).
 */
const ENGINE_OMITTED_FIELDS_FILE = 'data/doc-parity/engine-omitted-fields.json';

/** Engine profile fields projected into the ENGINES table. */
const ENGINE_PROJECTED = ['id', 'name', 'interactionModel', 'defaultLaunchMode', 'launchModes', 'capabilities'];

/** Keywords after which a `/` starts a regex literal rather than dividing. */
const REGEX_AFTER_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'
]);

/** A parity extraction failure: the source could not be read with certainty. */
class DocParityError extends Error {
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
 * SHA-256 hex of a string.
 * @param {string} text
 * @returns {string}
 */
function _sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Lexically scan JavaScript source into tokens, telling comments, strings,
 * template literals and regex literals apart from code. Never evaluates the
 * source. Throws on anything it cannot close (an unterminated string,
 * comment, template or regex), so a caller never builds on a misread file.
 *
 * Regex-vs-division follows the previous significant token: after a value
 * (identifier, number, literal, `)` or `]`) a `/` divides; anywhere else it
 * opens a regex. A regex literal may not span a line, so a misjudged `/`
 * surfaces as a failure rather than a silently swallowed stretch of code.
 *
 * @param {string} source
 * @param {string} [file] - For error messages.
 * @returns {Array<{type: 'ident'|'number'|'string'|'template'|'regex'|'punct', value: string, line: number, dynamic?: boolean}>}
 *   A template token is `dynamic` when it holds a `${…}` expression; its
 *   expression's own tokens follow it in the stream.
 * @throws {DocParityError} `EXTRACTOR_FAILED`
 */
function tokenizeJs(source, file = '<source>') {
  const tokens = [];
  const n = source.length;
  const templateStack = []; // brace depth at which each open `${` began
  let braceDepth = 0;
  let i = 0;
  let line = 1;
  const fail = (msg, at = line) => { throw new DocParityError('EXTRACTOR_FAILED', `${file}:${at}: ${msg}`); };

  /** Scan template characters from `i` until the closing backtick or a `${`. */
  const scanTemplate = (startLine) => {
    let value = '';
    while (i < n) {
      const ch = source[i];
      if (ch === '\\') { value += source.slice(i, i + 2); if (source[i + 1] === '\n') line++; i += 2; continue; }
      if (ch === '`') { i++; return { value, closed: true }; }
      if (ch === '$' && source[i + 1] === '{') { i += 2; return { value, closed: false }; }
      if (ch === '\n') line++;
      value += ch;
      i++;
    }
    return fail('unterminated template literal', startLine);
  };

  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === 'ident') return REGEX_AFTER_KEYWORDS.has(prev.value);
    if (prev.type === 'punct') return prev.value !== ')' && prev.value !== ']';
    return false;
  };

  while (i < n) {
    const c = source[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff') { i++; continue; }

    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) fail('unterminated block comment');
      for (let k = i; k < end; k++) if (source[k] === '\n') line++;
      i = end + 2;
      continue;
    }

    if (c === '\'' || c === '"') {
      const startLine = line;
      let value = '';
      i++;
      for (;;) {
        if (i >= n) fail('unterminated string', startLine);
        const ch = source[i];
        if (ch === '\\') {
          const next = source[i + 1];
          if (next === '\n') { line++; i += 2; continue; }
          const simple = { n: '\n', t: '\t', r: '\r', '\\': '\\', '\'': '\'', '"': '"' };
          value += Object.prototype.hasOwnProperty.call(simple, next) ? simple[next] : next;
          i += 2;
          continue;
        }
        if (ch === '\n') fail('unterminated string', startLine);
        if (ch === c) { i++; break; }
        value += ch;
        i++;
      }
      tokens.push({ type: 'string', value, line: startLine });
      continue;
    }

    if (c === '`') {
      const startLine = line;
      i++;
      const part = scanTemplate(startLine);
      tokens.push({ type: 'template', value: part.value, line: startLine, dynamic: !part.closed });
      if (!part.closed) templateStack.push(braceDepth);
      continue;
    }

    if (c === '}' && templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth) {
      // The `}` closing a `${` expression: resume the template it interrupted.
      templateStack.pop();
      const startLine = line;
      i++;
      const part = scanTemplate(startLine);
      if (!part.closed) templateStack.push(braceDepth);
      continue;
    }

    if (c === '/' && regexAllowed()) {
      const startLine = line;
      let inClass = false;
      let j = i + 1;
      for (;;) {
        if (j >= n || source[j] === '\n') fail('unterminated regex literal', startLine);
        const ch = source[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(source[j])) j++;
      tokens.push({ type: 'regex', value: source.slice(i, j), line: startLine });
      i = j;
      continue;
    }

    const ident = /^[A-Za-z_$][\w$]*/.exec(source.slice(i, i + 256));
    if (ident) {
      tokens.push({ type: 'ident', value: ident[0], line });
      i += ident[0].length;
      continue;
    }
    const num = /^(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)n?/.exec(source.slice(i, i + 64));
    if (num) {
      tokens.push({ type: 'number', value: num[0], line });
      i += num[0].length;
      continue;
    }

    if (c === '{') braceDepth++;
    else if (c === '}') braceDepth--;
    if (c === '=' && source[i + 1] === '>') {
      tokens.push({ type: 'punct', value: '=>', line });
      i += 2;
      continue;
    }
    tokens.push({ type: 'punct', value: c, line });
    i++;
  }
  if (templateStack.length > 0) fail('unterminated template expression');
  return tokens;
}

/**
 * The arguments of the call whose `(` is at `tokens[open]`, each as its
 * token list, split on top-level commas.
 * @param {Array<object>} tokens
 * @param {number} open
 * @returns {Array<Array<object>>}
 */
function _callArgs(tokens, open) {
  const args = [[]];
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'punct' && (t.value === '(' || t.value === '[' || t.value === '{')) {
      depth++;
      if (depth === 1) continue;
    } else if (t.type === 'punct' && (t.value === ')' || t.value === ']' || t.value === '}')) {
      depth--;
      if (depth === 0) return args;
    } else if (depth === 1 && t.type === 'punct' && t.value === ',') {
      args.push([]);
      continue;
    }
    args[args.length - 1].push(t);
  }
  return args;
}

/**
 * The value of an argument that is exactly one static string literal, or
 * null for anything computed.
 * @param {Array<object>} arg
 * @returns {string|null}
 */
function _literal(arg) {
  if (!arg || arg.length !== 1) return null;
  const t = arg[0];
  if (t.type === 'string' || (t.type === 'template' && !t.dynamic)) return t.value;
  return null;
}

/**
 * A flag record.
 * @param {string} code
 * @param {string} source
 * @param {number|null} line
 * @param {string} detail
 * @returns {{code: string, severity: string, source: string, line: number|null, detail: string}}
 */
function _flag(code, source, line, detail) {
  return { code, severity: BLOCKING_FLAGS.has(code) ? 'blocking' : 'info', source, line, detail };
}

/**
 * Find every route registration in a set of JavaScript files. A call to
 * `route(` (or to a declared registering helper) whose first two arguments
 * are literal strings is a route. One with computed arguments is a
 * `DYNAMIC_ROUTE_REGISTRATION` unless `declared` lists what it registers,
 * keyed `file:line`. A literal route with an unknown method or a path not
 * starting `/` is `MALFORMED_ROUTE`; the same method and path twice is
 * `DUPLICATE_ROUTE`.
 * @param {Array<{file: string, source: string}>} files - Repo-relative path and its text.
 * @param {{helpers?: string[], declared?: Record<string, Array<{method: string, path: string}>>}} [options]
 *   `helpers`: other function names that register a route with (method, path, …).
 * @returns {{rows: Array<{method: string, path: string, file: string}>, flags: Array<object>}}
 * @throws {DocParityError} When a file cannot be scanned.
 */
function extractRoutes(files, { helpers = [], declared = {} } = {}) {
  const callees = new Set(['route', ...helpers]);
  const found = [];
  const flags = [];
  const usedDeclarations = new Set();

  for (const { file, source } of files) {
    const tokens = tokenizeJs(source, file);
    tokens.forEach((t, k) => {
      if (t.type !== 'ident' || !callees.has(t.value)) return;
      const next = tokens[k + 1];
      const prev = tokens[k - 1];
      if (!next || next.type !== 'punct' || next.value !== '(') return;
      if (prev && ((prev.type === 'ident' && prev.value === 'function') || (prev.type === 'punct' && prev.value === '.'))) return;
      const args = _callArgs(tokens, k + 1);
      const method = _literal(args[0]);
      const routePath = _literal(args[1]);
      const where = `${file}:${t.line}`;
      if (method === null || routePath === null) {
        const list = declared[where];
        if (Array.isArray(list)) {
          usedDeclarations.add(where);
          for (const r of list) found.push({ method: String(r.method).toUpperCase(), path: String(r.path), file, line: t.line });
        } else {
          flags.push(_flag('DYNAMIC_ROUTE_REGISTRATION', file, t.line, `${t.value}() with computed method or path; declare the routes it registers`));
        }
        return;
      }
      found.push({ method: method.toUpperCase(), path: routePath, file, line: t.line });
    });
  }
  for (const where of Object.keys(declared)) {
    if (!usedDeclarations.has(where)) {
      const [file, line] = [where.slice(0, where.lastIndexOf(':')), Number(where.slice(where.lastIndexOf(':') + 1))];
      flags.push(_flag('DECLARATION_UNUSED', file, line, 'a route declaration matches no computed registration'));
    }
  }

  const seen = new Map();
  const rows = [];
  for (const r of found) {
    if (!METHODS.has(r.method) || !r.path.startsWith('/')) {
      flags.push(_flag('MALFORMED_ROUTE', r.file, r.line, `${r.method} ${r.path}`));
      continue;
    }
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) {
      flags.push(_flag('DUPLICATE_ROUTE', r.file, r.line, `${key} is also registered at ${seen.get(key)}`));
      continue;
    }
    seen.set(key, `${r.file}:${r.line}`);
    rows.push({ method: r.method, path: r.path, file: r.file });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return { rows, flags };
}

/**
 * The CLI family's rows from a `tc help --json` manifest. The manifest's
 * entry shape is pinned: a changed shape means this table would silently
 * drop or misread a field, so it fails extraction (`CLI_MANIFEST_CHANGED`).
 * @param {*} manifest - The parsed JSON array.
 * @returns {{rows: Array<{id: string, usage: string, audience: string, subverbs: string}>, flags: Array<object>}}
 * @throws {DocParityError}
 */
function extractCli(manifest) {
  if (!Array.isArray(manifest)) throw new DocParityError('CLI_MANIFEST_CHANGED', 'tc help --json did not return an array');
  const ids = new Set();
  const rows = manifest.map((v, idx) => {
    const keys = v && typeof v === 'object' ? Object.keys(v).sort() : [];
    if (keys.join(',') !== CLI_ENTRY_KEYS.join(',')) {
      throw new DocParityError('CLI_MANIFEST_CHANGED', `tc help --json entry ${idx} has fields [${keys.join(', ')}], expected [${CLI_ENTRY_KEYS.join(', ')}]`);
    }
    if (typeof v.id !== 'string' || !v.id || ids.has(v.id)) {
      throw new DocParityError('CLI_MANIFEST_CHANGED', `tc help --json entry ${idx} has a missing or repeated id`);
    }
    ids.add(v.id);
    const subverbs = Array.isArray(v.subverbs) ? v.subverbs.map((s) => (s && s.id) || '').filter(Boolean).sort() : [];
    return { id: v.id, usage: String(v.usage), audience: String(v.audience), subverbs: subverbs.join(', ') };
  });
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return { rows, flags: [] };
}

/**
 * Flatten a defaults object to sorted `key.path = canonical JSON` leaves.
 * Arrays are one leaf (never indexed); `null`, `false`, `0` and an absent key
 * stay distinct. A function, symbol, bigint or `undefined` value, or a
 * non-plain object, is a `DYNAMIC_DEFAULT`: its documented value could not be
 * stated honestly.
 * @param {object} value
 * @param {string} [source] - For flags.
 * @returns {{rows: Array<{key: string, value: string}>, flags: Array<object>}}
 */
function flattenDefaults(value, source = 'lib/project-config.js') {
  const rows = [];
  const flags = [];
  const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
    : x));
  const walk = (obj, prefix) => {
    for (const sym of Object.getOwnPropertySymbols(obj)) {
      flags.push(_flag('DYNAMIC_DEFAULT', source, null, `${prefix || '(root)'} has a symbol key ${String(sym)}`));
    }
    for (const key of Object.keys(obj).sort()) {
      const at = prefix ? `${prefix}.${key}` : key;
      // Read the descriptor, never the value, first: invoking a getter could
      // run arbitrary code and would document whatever it returned today.
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (desc.get || desc.set) {
        flags.push(_flag('DYNAMIC_DEFAULT', source, null, `${at} is an accessor property`));
        continue;
      }
      const v = desc.value;
      const t = typeof v;
      if (Array.isArray(v) && !v.every(_isJsonLeaf)) {
        flags.push(_flag('DYNAMIC_DEFAULT', source, null, `${at} is an array holding a value JSON cannot state`));
      } else if (t === 'function' || t === 'symbol' || t === 'bigint' || t === 'undefined') {
        flags.push(_flag('DYNAMIC_DEFAULT', source, null, `${at} is a ${t}`));
      } else if (v !== null && t === 'object' && !Array.isArray(v)) {
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) flags.push(_flag('DYNAMIC_DEFAULT', source, null, `${at} is not a plain object`));
        else if (Object.keys(v).length === 0) rows.push({ key: at, value: '{}' });
        else walk(v, at);
      } else {
        rows.push({ key: at, value: canonical(v) });
      }
    }
  };
  walk(value, '');
  return { rows, flags };
}

/**
 * Whether a value serializes to JSON exactly as it is: a scalar, `null`, or
 * a plain object/array of such values with no accessors. `JSON.stringify`
 * silently turns a function inside an array into `null`, so an array leaf is
 * only documented once every element passes this.
 * @param {*} v
 * @returns {boolean}
 */
function _isJsonLeaf(v) {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(_isJsonLeaf);
  if (t !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.getOwnPropertySymbols(v).length > 0) return false;
  return Object.keys(v).every((k) => {
    const d = Object.getOwnPropertyDescriptor(v, k);
    return !d.get && !d.set && _isJsonLeaf(d.value);
  });
}

/**
 * Statically check the source of a defaults object literal: the
 * `const|let|var <name> = { … }` declaration in `source` must be built only
 * from literal keys and literal values (strings, numbers, `true`/`false`/
 * `null`, non-interpolated templates, and nested object/array literals of
 * the same). A spread, computed key, shorthand property, getter/setter,
 * method, or any other expression as a value — an identifier, a call,
 * `process.env.X`, a function — is a `DYNAMIC_DEFAULT` flag with its line.
 * This complements {@link flattenDefaults}, which reads the runtime object
 * and so cannot tell a literal `false` from one computed from the
 * environment at load time.
 * @param {string} source - The module's source text.
 * @param {string} name - The declared identifier, e.g. `DEFAULT_PROJECT_CONFIG`.
 * @param {string} [file] - For flags and errors.
 * @returns {{flags: Array<object>}}
 * @throws {DocParityError} `EXTRACTOR_FAILED` when the declaration is absent or unreadable.
 */
function scanDefaultsLiteral(source, name, file = 'lib/project-config.js') {
  const t = tokenizeJs(source, file);
  const flags = [];
  const flag = (tok, detail) => flags.push(_flag('DYNAMIC_DEFAULT', file, tok ? tok.line : null, detail));
  const is = (k, type, value) => t[k] && t[k].type === type && (value === undefined || t[k].value === value);
  const isPunct = (k, value) => is(k, 'punct', value);

  let start = -1;
  for (let k = 0; k + 3 < t.length; k++) {
    if (is(k, 'ident') && ['const', 'let', 'var'].includes(t[k].value) && is(k + 1, 'ident', name)
      && isPunct(k + 2, '=') && isPunct(k + 3, '{')) {
      start = k + 3;
      break;
    }
  }
  if (start < 0) throw new DocParityError('EXTRACTOR_FAILED', `${file}: no \`${name} = { … }\` object literal declaration found`);

  /** Skip one expression from `k`, stopping at a top-level `,` or the enclosing closer. */
  const skipExpr = (k) => {
    let depth = 0;
    for (; k < t.length; k++) {
      if (t[k].type !== 'punct') continue;
      const v = t[k].value;
      if (v === '(' || v === '[' || v === '{') depth++;
      else if (v === ')' || v === ']' || v === '}') {
        if (depth === 0) return k;
        depth--;
      } else if (v === ',' && depth === 0) return k;
    }
    throw new DocParityError('EXTRACTOR_FAILED', `${file}: \`${name}\` literal is not closed`);
  };

  const isSpread = (k) => isPunct(k, '.') && isPunct(k + 1, '.') && isPunct(k + 2, '.');

  /** Parse one value at `k`; returns the index after it. */
  const value = (k, at) => {
    if (isPunct(k, '{')) return object(k, at);
    if (isPunct(k, '[')) return array(k, at);
    if (is(k, 'string') || is(k, 'number') || (is(k, 'template') && !t[k].dynamic)) return k + 1;
    if (is(k, 'ident') && ['true', 'false', 'null'].includes(t[k].value)) return k + 1;
    if (isPunct(k, '-') && is(k + 1, 'number')) return k + 2;
    flag(t[k], `${at} is not a literal value`);
    return skipExpr(k);
  };

  const array = (k, at) => {
    k++;
    let i = 0;
    while (!isPunct(k, ']')) {
      if (k >= t.length) throw new DocParityError('EXTRACTOR_FAILED', `${file}: \`${name}\` literal is not closed`);
      if (isSpread(k)) {
        flag(t[k], `${at} spreads into an array`);
        k = skipExpr(k + 3);
      } else {
        k = value(k, `${at}[${i}]`);
      }
      i++;
      if (isPunct(k, ',')) k++;
    }
    return k + 1;
  };

  const object = (k, at) => {
    k++;
    const prefix = at ? `${at}.` : '';
    while (!isPunct(k, '}')) {
      if (k >= t.length) throw new DocParityError('EXTRACTOR_FAILED', `${file}: \`${name}\` literal is not closed`);
      if (isSpread(k)) {
        flag(t[k], `${at || name} spreads another object`);
        k = skipExpr(k + 3);
      } else if (isPunct(k, '[')) {
        flag(t[k], `${at || name} has a computed key`);
        k = skipExpr(k);
      } else if (is(k, 'ident') && (t[k].value === 'get' || t[k].value === 'set')
        && (is(k + 1, 'ident') || is(k + 1, 'string')) && isPunct(k + 2, '(')) {
        flag(t[k], `${prefix}${t[k + 1].value} is a ${t[k].value}ter`);
        k = skipExpr(k);
      } else if (is(k, 'ident') && t[k].value === 'async' && !isPunct(k + 1, ':')) {
        flag(t[k], `${prefix}${t[k + 1] ? t[k + 1].value : '?'} is a method`);
        k = skipExpr(k);
      } else if (is(k, 'ident') || is(k, 'string') || is(k, 'number')) {
        const key = t[k].value;
        if (isPunct(k + 1, ':')) {
          k = value(k + 2, `${prefix}${key}`);
        } else if (isPunct(k + 1, '(')) {
          flag(t[k], `${prefix}${key} is a method`);
          k = skipExpr(k);
        } else {
          flag(t[k], `${prefix}${key} is a shorthand property`);
          k = skipExpr(k);
        }
      } else {
        flag(t[k], `${at || name} holds a property this scan cannot read`);
        k = skipExpr(k);
      }
      if (isPunct(k, ',')) k++;
    }
    return k + 1;
  };

  object(start, '');
  return { flags };
}

/**
 * One engine capability's state in words: `true`/`false`/`null` as such, an
 * object by its own `supported` flag when it has one, else `configured`.
 * @param {*} v
 * @returns {string}
 */
function _capabilityState(v) {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  if (v === null) return 'null';
  if (v && typeof v === 'object' && typeof v.supported === 'boolean') return v.supported ? 'yes' : 'no';
  return 'configured';
}

/**
 * The ENGINES family's rows from engine profile files. Each profile's `id`
 * must equal its file's basename and carry the projected fields. Only the
 * projected fields ever reach a row, so launch env, argv and install
 * commands are never published.
 *
 * A profile field that is neither projected nor in `omittedFields` is an
 * blocking `ENGINE_PROFILE_FIELD_REVIEW` flag (P22 §2.2: fail closed), so a
 * new field is a deliberate documentation-scope decision rather than
 * silently absent. Which
 * fields are deliberately left out is that reviewed decision, supplied by
 * the caller, and {@link extractRepository} reads it from
 * `data/doc-parity/engine-omitted-fields.json` rather than this module
 * naming the fields: naming a profile field here would read, to
 * `test/engine-capability-reads.test.js`'s lexical scan, as a code read of
 * that field.
 * @param {Array<{file: string, profile: object}>} profiles
 * @param {{omittedFields?: string[]}} [options]
 * @returns {{rows: Array<object>, flags: Array<object>}}
 * @throws {DocParityError} On a malformed profile.
 */
function extractEngines(profiles, { omittedFields = [] } = {}) {
  const flags = [];
  const ids = new Set();
  const rows = profiles.map(({ file, profile }) => {
    const base = path.basename(file, '.json');
    if (!profile || typeof profile !== 'object' || profile.id !== base) {
      throw new DocParityError('EXTRACTOR_FAILED', `${file}: profile id must equal "${base}"`);
    }
    if (ids.has(profile.id)) throw new DocParityError('EXTRACTOR_FAILED', `${file}: engine id ${profile.id} repeats`);
    ids.add(profile.id);
    for (const f of ['name', 'interactionModel', 'defaultLaunchMode']) {
      if (typeof profile[f] !== 'string') throw new DocParityError('EXTRACTOR_FAILED', `${file}: ${f} must be a string`);
    }
    for (const f of ['launchModes', 'capabilities']) {
      if (!profile[f] || typeof profile[f] !== 'object' || Array.isArray(profile[f])) {
        throw new DocParityError('EXTRACTOR_FAILED', `${file}: ${f} must be an object`);
      }
    }
    for (const key of Object.keys(profile).sort()) {
      if (!ENGINE_PROJECTED.includes(key) && !omittedFields.includes(key)) {
        flags.push(_flag('ENGINE_PROFILE_FIELD_REVIEW', file, null, `profile field "${key}" is neither projected nor listed as deliberately omitted`));
      }
    }
    return {
      id: profile.id,
      name: profile.name,
      interactionModel: profile.interactionModel,
      defaultLaunchMode: profile.defaultLaunchMode,
      launchModes: Object.keys(profile.launchModes).sort().join(', '),
      capabilities: Object.keys(profile.capabilities).sort().map((k) => `${k}=${_capabilityState(profile.capabilities[k])}`).join(', ')
    };
  });
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return { rows, flags };
}

/**
 * Escape a Markdown table cell: backslash, pipe and backtick are escaped and
 * a line break becomes a space, so a cell can never split or restyle a row.
 * @param {*} v
 * @returns {string}
 */
function escapeMdCell(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`').replace(/\r?\n/g, ' ');
}

/** Each family's table columns: header label and row field. */
const COLUMNS = Object.freeze({
  CLI: [['Verb', 'id'], ['Usage', 'usage'], ['Audience', 'audience'], ['Subverbs', 'subverbs']],
  ROUTES: [['Method', 'method'], ['Path', 'path'], ['Source', 'file']],
  'PROJECT-CONFIG': [['Key', 'key'], ['Default', 'value']],
  ENGINES: [['Engine', 'id'], ['Name', 'name'], ['Interaction', 'interactionModel'], ['Default mode', 'defaultLaunchMode'],
    ['Launch modes', 'launchModes'], ['Capabilities', 'capabilities']]
});

/**
 * The exact marker pair for a family.
 * @param {string} family
 * @returns {{begin: string, end: string}}
 */
function markers(family) {
  return { begin: `<!-- TC-DOC-PARITY:${family}:BEGIN -->`, end: `<!-- TC-DOC-PARITY:${family}:END -->` };
}

/**
 * Render a family's generated block, markers included, LF line endings, no
 * timestamps — the same rows always render the same bytes.
 * @param {string} family - One of {@link FAMILIES}.
 * @param {Array<object>} rows
 * @param {string[]} sources - Repo-relative source paths, listed for provenance.
 * @returns {string}
 */
function renderBlock(family, rows, sources) {
  const cols = COLUMNS[family];
  if (!cols) throw new TypeError(`unknown parity family ${family}`);
  const table = [
    `| ${cols.map(([h]) => h).join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${cols.map(([, f]) => escapeMdCell(r[f])).join(' | ')} |`)
  ].join('\n');
  const { begin, end } = markers(family);
  return [
    begin,
    `<!-- generated by lib/v6/f2-code-doc-parity.js (${BLOCK_SCHEMA}); edit the source, not this table -->`,
    `<!-- sources: ${[...sources].sort().join(', ')} -->`,
    `<!-- rows: ${rows.length}, sha256: ${_sha256(table)} -->`,
    '',
    table,
    '',
    end
  ].join('\n');
}

/**
 * A deterministic line diff between the block a doc holds and the block the
 * code generates: lines only in the doc (`-`), then lines only in the
 * generated block (`+`), each in its own order. A multiset comparison, not a
 * minimal edit script — enough to show a reviewer exactly which rows moved.
 * @param {string} actual
 * @param {string} expected
 * @returns {string[]}
 */
function _lineDiff(actual, expected) {
  const a = actual.split('\n');
  const e = expected.split('\n');
  const counts = new Map();
  for (const l of e) counts.set(l, (counts.get(l) || 0) + 1);
  const removed = [];
  for (const l of a) {
    if (counts.get(l) > 0) counts.set(l, counts.get(l) - 1);
    else removed.push(`- ${l}`);
  }
  const counts2 = new Map();
  for (const l of a) counts2.set(l, (counts2.get(l) || 0) + 1);
  const added = [];
  for (const l of e) {
    if (counts2.get(l) > 0) counts2.set(l, counts2.get(l) - 1);
    else added.push(`+ ${l}`);
  }
  return [...removed, ...added];
}

/**
 * Compare the block a doc holds for a family with the generated one. Exactly
 * one BEGIN and one END, in that order, are required; nothing outside them is
 * read. CRLF in the doc is normalized to LF before comparing.
 * @param {string} docText
 * @param {string} family
 * @param {string} expectedBlock - From {@link renderBlock}.
 * @returns {{status: 'match'|'drift'|'missing-marker'|'duplicate-marker', diff: string[]}}
 */
function compareBlock(docText, family, expectedBlock) {
  const text = String(docText).replace(/\r\n/g, '\n');
  const { begin, end } = markers(family);
  const begins = text.split(begin).length - 1;
  const ends = text.split(end).length - 1;
  if (begins > 1 || ends > 1) return { status: 'duplicate-marker', diff: [] };
  const b = text.indexOf(begin);
  const e = text.indexOf(end);
  if (b < 0 || e < 0 || e < b) return { status: 'missing-marker', diff: [] };
  const actual = text.slice(b, e + end.length);
  if (actual === expectedBlock) return { status: 'match', diff: [] };
  return { status: 'drift', diff: _lineDiff(actual, expectedBlock) };
}

/**
 * Sort flags by code, source, line — the report's own deterministic order.
 * @param {Array<object>} flags
 * @returns {Array<object>}
 */
function _sortFlags(flags) {
  return [...flags].sort((x, y) => x.code.localeCompare(y.code) || x.source.localeCompare(y.source)
    || (x.line ?? -1) - (y.line ?? -1) || x.detail.localeCompare(y.detail));
}

/**
 * Why an extraction result cannot be checked, or null when it can. Every one
 * of {@link FAMILIES} must be present with `rows` (objects), `flags` (flag
 * records) and `sources` (paths) arrays, and `sourceDigests`, when given,
 * must map each path to a SHA-256 hex digest. A result missing a family is
 * not a smaller clean result: it is an extraction that did not finish.
 * @param {*} families
 * @returns {string|null}
 */
function _invalidFamilies(families) {
  if (!families || typeof families !== 'object') return 'extraction returned no families';
  for (const family of FAMILIES) {
    const fam = families[family];
    if (!fam || typeof fam !== 'object') return `family ${family} is missing`;
    if (!Array.isArray(fam.rows) || !fam.rows.every((r) => r && typeof r === 'object')) return `family ${family} has no valid rows array`;
    if (!Array.isArray(fam.flags) || !fam.flags.every((f) => f && typeof f.code === 'string' && typeof f.severity === 'string'
      && typeof f.source === 'string' && typeof f.detail === 'string')) return `family ${family} has no valid flags array`;
    if (!Array.isArray(fam.sources) || !fam.sources.every((p) => typeof p === 'string' && p.length > 0)) return `family ${family} has no valid sources array`;
    if (fam.sourceDigests !== undefined) {
      const d = fam.sourceDigests;
      if (!d || typeof d !== 'object' || !Object.values(d).every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))) {
        return `family ${family} has malformed sourceDigests`;
      }
    }
  }
  return null;
}

/**
 * Run the parity check over already-extracted families and the target docs'
 * current text. Never writes anything: the result carries each generated
 * block and every flag, and the caller decides what to show.
 *
 * `extract` is a function so that an extractor failure anywhere aborts the
 * whole run with exit 2 and no blocks (P22: never publish a partial table).
 * The same holds for a result missing any of the four families, or carrying
 * one in the wrong shape: that is an unfinished extraction, never a smaller
 * clean one. Only a {@link DocParityError} is caught; any other error is a
 * bug and propagates.
 *
 * @param {() => Record<string, {rows: Array<object>, flags: Array<object>, sources: string[]}>} extract -
 *   Family name -> its rows, its extraction flags and its source paths.
 * @param {Record<string, string|undefined>} docs - Target doc path -> current text (undefined when absent).
 * @param {{targets?: Record<string, string>}} [options]
 * @returns {{schema: string, ok: boolean, exitCode: 0|1|2, blocks: Record<string, string>,
 *   flags: Array<object>, sourceDigests?: Record<string, string>, error?: {code: string, message: string}}}
 *   `sourceDigests` (path -> SHA-256 of the exact bytes read) is the run's
 *   provenance; a failed run (exit 2) carries none.
 */
function checkParity(extract, docs, { targets = DEFAULT_TARGETS } = {}) {
  let families;
  try {
    families = extract();
  } catch (err) {
    if (!(err instanceof DocParityError)) throw err;
    return { schema: REVIEW_SCHEMA, ok: false, exitCode: 2, blocks: {}, flags: [], error: { code: err.code, message: err.message } };
  }

  const invalid = _invalidFamilies(families);
  if (invalid) {
    return { schema: REVIEW_SCHEMA, ok: false, exitCode: 2, blocks: {}, flags: [], error: { code: 'FAMILY_INVALID', message: invalid } };
  }

  const flags = [];
  const blocks = {};
  const sourceDigests = {};
  for (const family of FAMILIES) {
    const fam = families[family];
    Object.assign(sourceDigests, fam.sourceDigests || {});
    flags.push(...fam.flags);
    const block = renderBlock(family, fam.rows, fam.sources);
    blocks[family] = block;
    const target = targets[family];
    const docText = docs[target];
    if (typeof docText !== 'string') {
      flags.push(_flag('TARGET_MISSING', target, null, `${family} table target does not exist`));
      continue;
    }
    const cmp = compareBlock(docText, family, block);
    if (cmp.status === 'missing-marker') flags.push(_flag('MISSING_MARKER', target, null, `${family} block markers absent or out of order`));
    else if (cmp.status === 'duplicate-marker') flags.push(_flag('DUPLICATE_MARKER', target, null, `${family} block markers appear more than once`));
    else if (cmp.status === 'drift') flags.push(_flag('BLOCK_DRIFT', target, null, cmp.diff.join('\n')));
  }
  const sorted = _sortFlags(flags);
  const blocking = sorted.some((f) => f.severity === 'blocking');
  const digests = Object.fromEntries(Object.keys(sourceDigests).sort().map((k) => [k, sourceDigests[k]]));
  return { schema: REVIEW_SCHEMA, ok: !blocking, exitCode: blocking ? 1 : 0, blocks, flags: sorted, sourceDigests: digests };
}

/**
 * Parse the reviewed omitted-fields file: `{schema, fields: string[]}` with
 * unique, non-empty names. Anything else is an extraction failure, never an
 * empty list (which would fail every profile for the wrong reason).
 * @param {string} text
 * @returns {string[]}
 * @throws {DocParityError}
 */
function _readOmittedFields(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new DocParityError('EXTRACTOR_FAILED', `${ENGINE_OMITTED_FIELDS_FILE}: ${err.message}`);
  }
  const fields = doc && doc.schema === 'tc.doc-parity-engine-omitted/v1' ? doc.fields : null;
  if (!Array.isArray(fields) || !fields.every((f) => typeof f === 'string' && f.length > 0) || new Set(fields).size !== fields.length) {
    throw new DocParityError('EXTRACTOR_FAILED', `${ENGINE_OMITTED_FIELDS_FILE}: expected schema tc.doc-parity-engine-omitted/v1 with a list of unique field names`);
  }
  return fields;
}

/**
 * Extract all four families from a repository checkout: route files are
 * `server.js` plus `lib/routes/*.js` (sorted, so enumeration order never
 * changes output), engine profiles are `data/engines/*.json`, defaults are
 * `DEFAULT_PROJECT_CONFIG`, and the CLI manifest is `tc help --json`'s own
 * renderer. Reads only; throws {@link DocParityError} on any source it
 * cannot read with certainty.
 * @param {string} root - Repository root.
 * @param {{routeHelpers?: string[], declaredRoutes?: Record<string, Array<{method: string, path: string}>>,
 *   engineOmittedFields?: string[],
 *   (overrides the reviewed list in `data/doc-parity/engine-omitted-fields.json`)
 *   readFile?: Function, readdir?: Function, cliManifest?: Array<object>, projectDefaults?: object}} [deps] -
 *   `cliManifest`/`projectDefaults` let a caller supply those sources instead of loading the modules.
 * @returns {Record<string, {rows: Array<object>, flags: Array<object>, sources: string[]}>}
 */
function extractRepository(root, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const readdir = deps.readdir || ((p) => fs.readdirSync(p));
  const digests = {};
  const read = (rel) => {
    let text;
    try {
      text = readFile(path.join(root, rel));
    } catch (err) {
      throw new DocParityError('EXTRACTOR_FAILED', `${rel}: ${err.message}`);
    }
    digests[rel] = _sha256(text);
    return text;
  };
  const digestsOf = (paths) => Object.fromEntries(paths.map((p) => [p, digests[p]]));
  const list = (rel, suffix) => {
    try {
      return readdir(path.join(root, rel)).filter((f) => f.endsWith(suffix)).sort().map((f) => `${rel}/${f}`);
    } catch (err) {
      throw new DocParityError('EXTRACTOR_FAILED', `${rel}: ${err.message}`);
    }
  };

  const routeFiles = ['server.js', ...list('lib/routes', '.js')];
  const routes = extractRoutes(routeFiles.map((file) => ({ file, source: read(file) })), {
    helpers: deps.routeHelpers || [],
    declared: deps.declaredRoutes || {}
  });

  const engineFiles = list('data/engines', '.json');
  const omittedFields = deps.engineOmittedFields || _readOmittedFields(read(ENGINE_OMITTED_FIELDS_FILE));
  const engineSources = deps.engineOmittedFields ? engineFiles : [...engineFiles, ENGINE_OMITTED_FIELDS_FILE];
  const engines = extractEngines(engineFiles.map((file) => {
    try {
      return { file, profile: JSON.parse(read(file)) };
    } catch (err) {
      if (err instanceof DocParityError) throw err;
      throw new DocParityError('EXTRACTOR_FAILED', `${file}: ${err.message}`);
    }
  }), { omittedFields });

  const defaults = deps.projectDefaults || require('../project-config').DEFAULT_PROJECT_CONFIG;
  const config = flattenDefaults(defaults);
  config.flags.push(...scanDefaultsLiteral(read('lib/project-config.js'), 'DEFAULT_PROJECT_CONFIG').flags);

  let manifest = deps.cliManifest;
  if (!manifest) {
    try {
      manifest = JSON.parse(require('../tc-verbs').renderHelpManifest());
    } catch (err) {
      throw new DocParityError('CLI_MANIFEST_CHANGED', `tc help --json could not be read: ${err.message}`);
    }
  }
  const cli = extractCli(manifest);
  read('lib/tc-verbs.js');

  return {
    CLI: { ...cli, sources: ['lib/tc-verbs.js'], sourceDigests: digestsOf(['lib/tc-verbs.js']) },
    ROUTES: { ...routes, sources: routeFiles, sourceDigests: digestsOf(routeFiles) },
    'PROJECT-CONFIG': { ...config, sources: ['lib/project-config.js'], sourceDigests: digestsOf(['lib/project-config.js']) },
    ENGINES: { ...engines, sources: engineSources, sourceDigests: digestsOf(engineSources) }
  };
}

module.exports = {
  REVIEW_SCHEMA,
  FAMILIES,
  DocParityError,
  tokenizeJs,
  extractRoutes,
  extractCli,
  flattenDefaults,
  scanDefaultsLiteral,
  extractEngines,
  markers,
  renderBlock,
  compareBlock,
  checkParity,
  extractRepository
};
