'use strict';

/**
 * Secret scanner (CC-4, #343) — flag-only detection of high-signal credential
 * patterns in text. **It never scrubs, masks, or blocks** — the Continuity
 * Contract's secret policy is "flag on detection; the operator (or assistant,
 * on request) remediates manually" (`continuity-contract.md` §"Secrets").
 *
 * The detector is deliberately a small set of HIGH-CONFIDENCE patterns rather
 * than a broad heuristic: a noisy scanner that flags every long string trains
 * the operator to ignore the badge, which defeats the purpose. Each pattern
 * matches a credential whose shape is distinctive enough that a hit is almost
 * certainly a real secret.
 *
 * **Privacy invariant:** the scanner returns the matched pattern *types* only
 * — never the matched secret value. A caller that persists or renders the
 * result (the uploads manifest, the UI badge) therefore cannot leak the
 * secret it just flagged.
 */

/**
 * High-confidence secret patterns. Each entry's `re` is matched against the
 * full text; a match contributes its `type` to the result. Patterns are
 * anchored on distinctive prefixes/structure to keep false positives low.
 * The generic assignment pattern is the only fuzzy one and requires both a
 * credential-ish key AND a long value to fire.
 * @type {Array<{ type: string, re: RegExp }>}
 */
const PATTERNS = [
  // AWS access key id (long-lived AKIA / temporary ASIA).
  { type: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  // PEM-encoded private key block (RSA/EC/OpenSSH/DSA/PGP or bare).
  { type: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  // Slack token (bot/user/app/refresh/legacy).
  { type: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  // GitHub personal access tokens (classic ghp_ and fine-grained github_pat_).
  { type: 'github-token', re: /\b(?:ghp_[0-9A-Za-z]{36}\b|github_pat_[0-9A-Za-z_]{22,})/ },
  // Google API key.
  { type: 'google-api-key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  // Generic `key = "long-value"` assignment. Requires a credential-ish key
  // and a 20+ char value so ordinary config (short ids, words) doesn't trip.
  {
    type: 'generic-secret',
    re: /(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)["']?\s*[:=]\s*["']?[0-9A-Za-z\-_/+]{20,}/i
  }
];

/**
 * Scan a block of text for high-confidence secret patterns.
 *
 * Pure (no I/O, no logging — keeps it trivially unit-testable and safe to call
 * on untrusted upload content). Returns the matched pattern **types**, never
 * the secret values, so the result is safe to persist and render.
 *
 * @param {string} text - Text to scan (e.g. the decoded contents of a text upload)
 * @returns {{ flagged: boolean, types: string[] }} `types` is de-duplicated and
 *   sorted; `flagged` is `true` iff at least one pattern matched.
 */
function scanText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { flagged: false, types: [] };
  }

  const hits = new Set();
  for (const { type, re } of PATTERNS) {
    if (re.test(text)) {
      hits.add(type);
    }
  }

  const types = Array.from(hits).sort();
  return { flagged: types.length > 0, types };
}

module.exports = { scanText, PATTERNS };
