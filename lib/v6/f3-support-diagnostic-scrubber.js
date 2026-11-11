'use strict';

/**
 * v6 (#2999, V6-29 / F3, Car V61-W1-D): the support diagnostic bundle — its
 * secret scrubber, its redaction verifier, the issue preview, and the
 * consent-gated submission bridge.
 *
 * - {@link buildBundle} assembles an ALLOWLISTED, size-bounded bundle:
 *   version, platform, mode, health/error codes, and (only when asked)
 *   scrubbed log lines. Prompts, conversation text, environment variables,
 *   configuration files and token references are never fields, so they
 *   cannot leak through it. Every string is cut to a bounded window
 *   before it is scrubbed, so an oversized input never reaches the regexes whole.
 * - {@link scrub} replaces credentials, emails, IPs, home paths, tailnet
 *   hostnames and phone numbers with placeholders. It is defense in depth:
 *   callers should log structured codes, not raw text, at the source.
 * - {@link findSecrets} is the redaction verifier: it names every detector
 *   still matching a text, and {@link buildBundle} refuses to return a
 *   bundle it reports anything in.
 * - {@link previewIssue} renders the exact issue (title, body, repo) and a
 *   SHA-256 digest of it. Building a preview performs no network call.
 * - {@link submitIssue} files the issue only with consent bound to that
 *   exact digest and repository, unexpired, for an allowlisted repository,
 *   and at most once per consent id — the caller must pass the ledger of
 *   used ids, so the guarantee cannot be skipped by omitting it. The adapter — Wave 2 wires it to G1
 *   (`lib/v6/g1-github-integration.js`) — receives only the scrubbed preview.
 *
 * Adapted from the INT Phase 5 prototype (`lib/support-bundle.js`), with
 * these departures, each covered by a test: the key/value detector now
 * matches JSON and quoted forms (`"token": "abc"`), which the prototype
 * leaked, and redacts a quoted value up to its matching quote, an
 * unquoted one to end of line, and one whose opening quote never closes
 * from that quote to end of line, so a multi-word or truncated passphrase
 * cannot leave a tail behind (PRR R1/R2 HOLDs on PR #3028); private-key blocks, JWTs, AWS, Slack and Anthropic keys,
 * Windows home paths and `*.ts.net` hostnames are scrubbed; the issue
 * body's code fence is longer than any backtick run inside it, so a log
 * line cannot close it and inject Markdown; submission requires a
 * repository allowlist and refuses a reused consent id; and an adapter
 * that throws or returns no URL is reported as a failed submission, not
 * a success.
 *
 * Wave 1 scope (Charter A624): no route, no schema, no G1 call. The
 * prototype's production note — store the preview and consent server-side
 * so neither a client digest nor an in-memory key alone proves consent —
 * is Wave 2's, with the `support/preview` and `support/submit` routes.
 *
 * @module lib/v6/f3-support-diagnostic-scrubber
 */

const crypto = require('node:crypto');

/** Bundle schema version. */
const BUNDLE_SCHEMA = 1;

/** Most log lines a bundle carries. */
const MAX_LOG_LINES = 40;

/** Longest log line kept, in characters. */
const MAX_LOG_LINE = 300;

/** Most health or error codes kept per list. */
const MAX_CODES = 30;

/** Extra characters scrubbed past a field's kept length, so a secret straddling the cut is still recognized. */
const SCRUB_MARGIN = 512;

/** How a diagnostic code must look: an upper-case identifier. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The consent scope a GitHub issue submission requires. */
const CONSENT_SCOPE = 'github-issue';

/** Key names whose value is a credential, as a regex alternation. */
const CREDENTIAL_KEYS = 'token|password|passwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|authorization';

/**
 * The secret detectors, in the order {@link scrub} applies them. Each has a
 * `name` (what {@link findSecrets} reports), a global `pattern`, and the
 * `replace` value (a string, or a function for String.prototype.replace). Order matters: whole-credential shapes run before the
 * generic key/value rule so a recognized token is named for what it is.
 */
const DETECTORS = Object.freeze([
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: '[REDACTED_PRIVATE_KEY]' },
  { name: 'url-credentials', pattern: /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, replace: '$1[REDACTED]@' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: '[REDACTED]' },
  { name: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, replace: '[REDACTED]' },
  { name: 'api-key', pattern: /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g, replace: '[REDACTED]' },
  { name: 'bearer', pattern: /\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]+=*/gi, replace: 'Bearer [REDACTED]' },
  // A credential key's value, quoted: everything up to the MATCHING quote
  // is redacted, honoring backslash escapes — including the `\"` a JSON
  // string turns an inner quote into — so a multi-word passphrase
  // (`"correct horse battery staple"`) is removed whole.
  {
    name: 'key-value-quoted',
    // Two branches. A plain quote's value may hold anything but that
    // quote (backslash escapes honored). An ESCAPED quote (`\"`, how a
    // quote appears inside JSON text) may not cross an unescaped `"`: that
    // is where the enclosing JSON string ends, and crossing it would pair
    // one string's opening `\"` with the next string's.
    pattern: new RegExp(`\\b(${CREDENTIAL_KEYS})(\\\\?["']?\\s*[:=]\\s*)(?:(["'])(?:\\\\[\\s\\S]|(?!\\3)[^\\\\\\r\\n])*\\3|\\\\(["'])(?:(?!\\\\\\4)(?:\\\\[\\s\\S]|[^\\\\\\r\\n"]))*\\\\\\4)`, 'gi'),
    replace: (match, key, sep, quote, escapedQuote) => (quote
      ? `${key}${sep}${quote}[REDACTED]${quote}`
      : `${key}${sep}\\${escapedQuote}[REDACTED]\\${escapedQuote}`)
  },
  // Opened but never closed on its line — a value cut short by truncation
  // (`password='unterminated tail`). The rule above needs the closing
  // quote and the one below skips quote-led values, so without this both
  // would pass it through. Redact from the opening quote to end of line;
  // a value that is already exactly `[REDACTED]` (to end of line or a
  // closing quote) is left alone, so scrubbed text stays stable.
  {
    name: 'key-value-unterminated',
    pattern: new RegExp(`\\b(${CREDENTIAL_KEYS})(\\\\?["']?\\s*[:=]\\s*)(\\\\?["'])(?!\\[REDACTED\\](?:[ \\t]*$|\\\\?["']))[^\\r\\n]*`, 'gim'),
    replace: '$1$2$3[REDACTED]'
  },
  // Unquoted: no boundary inside a passphrase is safe (it may contain
  // spaces, commas or `&`), so the value is redacted to the end of the
  // line — fail closed, at the cost of what followed it on that line. The
  // value must start on a non-space, or `\s*` could backtrack to zero and
  // re-match an already-redacted `[REDACTED]` as a fresh value. A value
  // that is ONLY `[REDACTED]` (to end of line or a closing quote) is
  // skipped; `[REDACTED]` with text after it is not, so a placeholder can
  // never mask a surviving tail from findSecrets.
  {
    name: 'key-value',
    pattern: new RegExp(`\\b(${CREDENTIAL_KEYS})(\\\\?["']?\\s*[:=]\\s*)(?!\\s|\\\\?["']|\\[REDACTED\\](?:[ \\t]*$|\\\\?["']))[^\\r\\n]+`, 'gim'),
    replace: '$1$2[REDACTED]'
  },
  { name: 'query-secret', pattern: /([?&](?:token|key|secret|password|access_token|sig)=)(?!\[REDACTED\])[^&#\s"']+/gi, replace: '$1[REDACTED]' },
  { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: '[EMAIL]' },
  { name: 'tailnet-host', pattern: /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net\b/gi, replace: '[TAILNET_HOST]' },
  { name: 'ipv4', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replace: '[IP]' },
  { name: 'home-path', pattern: /(?:\/(?:Users|home)\/|[A-Za-z]:\\Users\\)(?!\[HOME\])[^/\\\s"']+/g, replace: '/[HOME]' },
  { name: 'phone', pattern: /(?<![\w.-])(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}(?![\w.-])/g, replace: '[PHONE]' }
]);

/**
 * Replace every secret, identifier and personal detail {@link DETECTORS}
 * recognizes with a placeholder. Idempotent: scrubbing scrubbed text
 * changes nothing.
 * @param {*} value - Coerced to a string.
 * @returns {string}
 */
function scrub(value) {
  let text = String(value);
  for (const d of DETECTORS) text = text.replace(d.pattern, d.replace);
  return text;
}

/**
 * The redaction verifier: the names of every detector that still finds
 * something in `text`. An empty list means nothing recognizable remains.
 * @param {*} text - Coerced to a string.
 * @returns {string[]}
 */
function findSecrets(text) {
  const s = String(text);
  return DETECTORS.filter((d) => {
    d.pattern.lastIndex = 0;
    const scrubbed = s.replace(d.pattern, d.replace);
    return scrubbed !== s;
  }).map((d) => d.name);
}

/**
 * Keep up to {@link MAX_CODES} well-formed diagnostic codes.
 * @param {*} list
 * @returns {string[]}
 */
function codes(list) {
  return (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && CODE_PATTERN.test(x)).slice(0, MAX_CODES);
}

/**
 * Scrub, cut to `max`, and scrub again, one free-text field.
 * @param {*} value
 * @param {string} fallback
 * @param {number} max
 * @returns {string}
 */
function field(value, fallback, max) {
  const raw = value == null || value === '' ? fallback : String(value);
  // Scrub a bounded window wider than what is kept: cutting at `max` first
  // could leave a short token prefix no detector recognizes, while
  // scrubbing the whole input would hand the regexes unbounded text.
  // Scrub again after the cut: a cut that lands inside a credential's
  // placeholder (`password='[REDACT`) would otherwise leave a value the
  // verifier rightly refuses. The re-scrub completes it, so a kept field
  // can run past `max` by at most one placeholder.
  return scrub(scrub(raw.slice(0, max + SCRUB_MARGIN)).slice(0, max));
}

/**
 * Build an allowlisted, scrubbed diagnostic bundle.
 * @param {{version?: string, platform?: string, mode?: string, healthCodes?: string[],
 *   errorCodes?: string[], logLines?: string[]}} input - Any other field is ignored.
 * @param {{includeLogs?: boolean, now?: number}} [opts] - Logs are omitted unless asked for.
 * @returns {{schema: number, createdAt: string, version: string, platform: string, mode: string,
 *   healthCodes: string[], errorCodes: string[], logLines?: string[]}}
 * @throws {TypeError} When `input` is not an object.
 * @throws {Error} `REDACTION_INCOMPLETE` if the verifier still finds a secret (a scrubber defect).
 */
function buildBundle(input, { includeLogs = false, now = Date.now() } = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('diagnostics required');
  const bundle = {
    schema: BUNDLE_SCHEMA,
    createdAt: new Date(now).toISOString(),
    version: field(input.version, 'unknown', 80),
    platform: field(input.platform, 'unknown', 80),
    mode: field(input.mode, 'unknown', 40),
    healthCodes: codes(input.healthCodes),
    errorCodes: codes(input.errorCodes)
  };
  if (includeLogs) {
    bundle.logLines = (Array.isArray(input.logLines) ? input.logLines : [])
      .slice(0, MAX_LOG_LINES).map((line) => field(line, '', MAX_LOG_LINE));
  }
  const leftover = findSecrets(JSON.stringify(bundle));
  if (leftover.length) {
    const err = new Error('REDACTION_INCOMPLETE');
    err.code = 'REDACTION_INCOMPLETE';
    err.detectors = leftover;
    throw err;
  }
  return bundle;
}

/**
 * The SHA-256 digest that binds a preview: repository, title and body.
 * @param {string} repo
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
function previewDigest(repo, title, body) {
  return crypto.createHash('sha256').update(`${repo}\n${title}\n${body}`).digest('hex');
}

/**
 * Render the exact issue a submission would file. Pure: no network call.
 * The code fence is one backtick longer than the longest backtick run in
 * the JSON, so no bundle content can close it.
 * @param {object} bundle - From {@link buildBundle}.
 * @param {string} repo - `owner/name`.
 * @returns {{repo: string, title: string, body: string, digest: string}}
 * @throws {TypeError} On a malformed repo or bundle.
 */
function previewIssue(bundle, repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new TypeError('invalid repo');
  if (!bundle || !Array.isArray(bundle.errorCodes)) throw new TypeError('bundle required');
  const json = JSON.stringify(bundle, null, 2);
  const longestRun = Math.max(0, ...(json.match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  const body = `${fence}json\n${json}\n${fence}`;
  const title = `[Support] ${bundle.errorCodes[0] || 'DIAGNOSTIC_REPORT'}`;
  return { repo, title, body, digest: previewDigest(repo, title, body) };
}

/**
 * File a previewed issue through `adapter`, only with matching consent.
 * Refusals return `{ok: false, code}` and never call the adapter:
 * `CONSENT_REQUIRED` (missing, unapproved, wrong scope/repo/digest,
 * expired, or no id), `REPO_NOT_ALLOWED`, `PREVIEW_CHANGED` (the preview
 * no longer hashes to its digest, or is no longer fully scrubbed),
 * `CONSENT_ALREADY_USED`. An adapter failure returns `SUBMIT_FAILED`.
 * @param {{preview: {repo: string, title: string, body: string, digest: string},
 *   consent: {approved: boolean, scope: string, repo: string, bundleDigest: string, expiresAt: number, consentId: string},
 *   adapter: (issue: {repo: string, title: string, body: string, idempotencyKey: string}) => Promise<{issueUrl: string}>,
 *   allowedRepos: string[], usedConsentIds: {has: (id: string) => boolean, add: (id: string) => *},
 *   now?: number}} args
 * @returns {Promise<{ok: true, issueUrl: string}|{ok: false, code: string, error?: string}>}
 * @throws {TypeError} When `adapter` is not a function, `allowedRepos` is not an array, or
 *   `usedConsentIds` is missing (a Set works; Wave 2 supplies a durable store).
 */
async function submitIssue({ preview, consent, adapter, allowedRepos, usedConsentIds, now = Date.now() } = {}) {
  if (typeof adapter !== 'function') throw new TypeError('adapter required');
  if (!Array.isArray(allowedRepos)) throw new TypeError('allowedRepos required');
  // Required, not optional: an omitted ledger would let the same consent
  // file twice, so "at most once" holds only if every caller supplies one.
  if (!usedConsentIds || typeof usedConsentIds.has !== 'function' || typeof usedConsentIds.add !== 'function') {
    throw new TypeError('usedConsentIds required');
  }
  if (!preview || typeof preview !== 'object') return { ok: false, code: 'CONSENT_REQUIRED' };
  if (!consent || consent.approved !== true || consent.scope !== CONSENT_SCOPE
      || consent.repo !== preview.repo || consent.bundleDigest !== preview.digest
      || !Number.isFinite(consent.expiresAt) || consent.expiresAt <= now
      || typeof consent.consentId !== 'string' || !consent.consentId) {
    return { ok: false, code: 'CONSENT_REQUIRED' };
  }
  if (!allowedRepos.includes(preview.repo)) return { ok: false, code: 'REPO_NOT_ALLOWED' };
  if (typeof preview.title !== 'string' || typeof preview.body !== 'string'
      || previewDigest(preview.repo, preview.title, preview.body) !== preview.digest
      || scrub(preview.title) !== preview.title || scrub(preview.body) !== preview.body) {
    return { ok: false, code: 'PREVIEW_CHANGED' };
  }
  if (usedConsentIds.has(consent.consentId)) return { ok: false, code: 'CONSENT_ALREADY_USED' };
  usedConsentIds.add(consent.consentId);
  let result;
  try {
    result = await adapter({ repo: preview.repo, title: preview.title, body: preview.body, idempotencyKey: consent.consentId });
  } catch (error) {
    return { ok: false, code: 'SUBMIT_FAILED', error: scrub(error && error.message ? error.message : String(error)) };
  }
  if (!result || typeof result.issueUrl !== 'string' || !result.issueUrl) return { ok: false, code: 'SUBMIT_FAILED', error: 'adapter returned no issue URL' };
  return { ok: true, issueUrl: result.issueUrl };
}

module.exports = {
  BUNDLE_SCHEMA,
  MAX_LOG_LINES,
  MAX_LOG_LINE,
  MAX_CODES,
  CONSENT_SCOPE,
  DETECTORS,
  scrub,
  findSecrets,
  buildBundle,
  previewIssue,
  submitIssue
};
