'use strict';

/**
 * Rule labels (#2029).
 *
 * An operator deciding between two proposed rules has to be able to say which
 * one they mean, and the only reliable name a rule has is its database id. The
 * number an author types into a rule's text can be missing, stale or simply
 * wrong — rule #117 can open with "RULE #94" — so every surface that shows a
 * rule labels it from the id and treats the text as text.
 *
 * The browser has no bundler, so `public/api-helper.js` carries the same
 * functions (`tcRuleLabel`, `tcStripSameIdPrefix`, `tcDisplayRuleText`,
 * `tcAuthoredIdMismatch`); `test/rule-label-drift.test.js` runs both copies
 * on the same inputs.
 */

/**
 * Matches an authored "RULE #<n> — " opening, any case, any dash.
 * The id group is compared against the row's own id by the caller.
 */
const AUTHORED_PREFIX = /^\s*RULE\s*#(\d+)\s*[—–-]\s*/i;

/**
 * Normalise a rule id, refusing anything that is not a positive integer.
 * Throwing is deliberate: a renderer that reaches here without an id would
 * otherwise print an unlabelled rule, which is the defect this module ends.
 * @param {unknown} id - The rule's database id (number, or a numeric string)
 * @returns {number}
 */
function _ruleId(id) {
  const n = typeof id === 'string' && /^\d+$/.test(id.trim()) ? Number(id) : id;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new TypeError(`a rule label needs a positive integer id, got ${String(id)}`);
  }
  return n;
}

/**
 * The label a rule is known by everywhere: "Rule #<id>".
 * @param {number|string} id - The rule's database id
 * @returns {string}
 */
function ruleLabel(id) {
  return `Rule #${_ruleId(id)}`;
}

/**
 * Drop an authored "RULE #<id> — " opening when it names this same rule, so a
 * labelled line does not read "Rule #120 — RULE #120 — …". A prefix naming a
 * different id is left in place: showing the mismatch is the point.
 * @param {number|string} id - The rule's database id
 * @param {string} content - The rule's stored text
 * @returns {string} The text to display after the label (untrimmed)
 */
function stripSameIdPrefix(id, content) {
  const text = typeof content === 'string' ? content : '';
  const m = AUTHORED_PREFIX.exec(text);
  if (m && Number(m[1]) === _ruleId(id)) return text.slice(m[0].length);
  return text;
}

/**
 * A rule as one displayable string: its label, then its text.
 * The stored content is never changed by this; it only decides what is shown.
 * @param {{id: number|string, content?: string}} rule - A session_rules row
 * @returns {string}
 */
function displayRuleText(rule) {
  if (!rule || typeof rule !== 'object') throw new TypeError('displayRuleText needs a rule object');
  const label = ruleLabel(rule.id);
  const body = stripSameIdPrefix(rule.id, rule.content).trim();
  return body ? `${label} — ${body}` : label;
}

/**
 * The number a rule's text claims for itself, when it is NOT the rule's own.
 * Only a leading "RULE #<n> — " counts: a number mentioned later in the text
 * ("supersedes: RULE #97") is a reference, not a claim. Surfaces use this to
 * flag the mismatch rather than merely leave it on the page.
 * @param {{id: number|string, content?: string}} rule - A session_rules row
 * @returns {number|null} The claimed id, or null when there is no mismatch
 */
function authoredIdMismatch(rule) {
  if (!rule || typeof rule !== 'object') throw new TypeError('authoredIdMismatch needs a rule object');
  const own = _ruleId(rule.id);
  const m = AUTHORED_PREFIX.exec(typeof rule.content === 'string' ? rule.content : '');
  return m && Number(m[1]) !== own ? Number(m[1]) : null;
}

module.exports = { ruleLabel, stripSameIdPrefix, displayRuleText, authoredIdMismatch, AUTHORED_PREFIX };
