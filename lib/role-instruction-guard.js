'use strict';

/**
 * Ask before forwarding an instruction likely sent to the wrong role
 * (#2397, Architect Ruling A2397) — core engine, `v5.60.0` Car 60-A Slice
 * 1.
 *
 * A pure classifier: {@link evaluateRoleInstruction} takes an outbound
 * instruction's text and its intended target role as plain data and
 * returns either a forward-it verdict or a structured hold-for-
 * confirmation verdict — nothing here reads a session store, sends a
 * message, or touches a route. Wiring this into the shared message-
 * dispatch routes (`server.js`, `lib/routes/*.js`) and the composer UI
 * (`public/app.js`) is Slice 2, deliberately deferred so Car 60-A stays
 * 100% file-disjoint from this wave's other `v5.60.0` cars.
 *
 * The detector is deterministic keyword/pattern matching against a fixed
 * role-responsibility table, not a model call — the same "never a
 * paraphrase that could silently change meaning" discipline
 * `lib/rules-compress-preview.js` follows for its own text transform:
 * a false positive here costs the sender one confirmation click; a false
 * negative (an undetected real mismatch, forwarded) is the thing #2397
 * exists to reduce, so the match list is written to err toward catching
 * more, not fewer, of the named example cases
 * ("code-implementation/commit instructions to a Coordinator-only `pm` or
 * read-only `advisor`/`reviewer`", "merge/release execution commands to a
 * non-integrator builder lane").
 *
 * @module lib/role-instruction-guard
 */

const crypto = require('node:crypto');

/**
 * Every intent this module can detect in instruction text, and the
 * deterministic patterns that detect it. Intentionally generous
 * (case-insensitive, whole-word where that matters) — see this module's
 * own docstring for why a false positive is the safer failure direction.
 * @type {Readonly<Record<string, RegExp[]>>}
 */
const INTENT_PATTERNS = Object.freeze({
  'code-implementation': [/\bimplement(ing)?\b/i, /\bwrite (the |some )?code\b/i, /\bedit (the |this )?file\b/i, /\bfix (the |this )?bug\b/i],
  commit: [/\bcommit (the|this|your)\b/i, /\bgit commit\b/i],
  merge: [/\bmerge (the |this )?(pr|pull request|branch)\b/i, /\bgh pr merge\b/i],
  release: [/\b(cut|ship|publish)\s+(a\s+)?release\b/i, /\btag v?\d/i],
  deploy: [/\bdeploy\b/i, /\brestart (the )?(live )?server\b/i]
});

/**
 * A role's own responsibility signature: which intents it never normally
 * receives. `disallowedIntents: []` means the role may receive anything —
 * a coordinating/execution role with no narrower scope of its own.
 *
 * A scoping decision (#2397's own ruling names two EXAMPLE mismatches —
 * coordinator/read-only roles receiving implementation commands,
 * non-integrator builders receiving merge/release commands — without
 * enumerating a full role table): this is this repo's own fleet role
 * vocabulary (the same roles `lib/team-templates.js#LANE_CLASSES` names
 * for `#2395`, extended here with the two explicitly-named read-only
 * roles the ruling's examples require, `advisor` and `reviewer`).
 * @type {Readonly<Record<string, {disallowedIntents: string[]}>>}
 */
const ROLE_RESPONSIBILITIES = Object.freeze({
  pm: Object.freeze({ disallowedIntents: Object.freeze(['code-implementation', 'commit', 'merge', 'release', 'deploy']) }),
  advisor: Object.freeze({ disallowedIntents: Object.freeze(['code-implementation', 'commit', 'merge', 'release', 'deploy']) }),
  reviewer: Object.freeze({ disallowedIntents: Object.freeze(['code-implementation', 'commit', 'merge', 'release', 'deploy']) }),
  builder: Object.freeze({ disallowedIntents: Object.freeze(['merge', 'release', 'deploy']) }),
  integrator: Object.freeze({ disallowedIntents: Object.freeze([]) }),
  architect: Object.freeze({ disallowedIntents: Object.freeze([]) }),
  observer: Object.freeze({ disallowedIntents: Object.freeze(['code-implementation', 'commit', 'merge', 'release', 'deploy']) })
});

/**
 * A refusal, in the one shape this module always answers with.
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message, extra) {
  return { ok: false, code, message, ...(extra || {}) };
}

/**
 * Every intent detected in `text`, deterministically.
 * @param {string} text
 * @returns {string[]}
 */
function detectIntents(text) {
  const found = [];
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    if (patterns.some((re) => re.test(text))) found.push(intent);
  }
  return found;
}

/**
 * A SHA-256 hex digest over the exact instruction text — what
 * `confirmRoleOverride` must equal to be accepted as the explicit override
 * this exact instruction was confirmed against (#2397's "an explicit
 * override bound to the instruction digest").
 * @param {string} text
 * @returns {string}
 */
function instructionDigest(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * From `availableRoles`, the first one (in the order given) whose
 * responsibility signature does not disallow any of `mismatchedIntents` —
 * a candidate the sender could redirect to instead. `null` when none
 * qualifies or none were given; the caller decides what to do with that.
 * @param {string[]} mismatchedIntents
 * @param {string[]|undefined} availableRoles
 * @returns {string|null}
 */
function _suggestRole(mismatchedIntents, availableRoles) {
  if (!Array.isArray(availableRoles)) return null;
  for (const role of availableRoles) {
    const responsibility = ROLE_RESPONSIBILITIES[role];
    if (responsibility && !mismatchedIntents.some((i) => responsibility.disallowedIntents.includes(i))) {
      return role;
    }
  }
  return null;
}

/**
 * Evaluate an outbound instruction against its target role's own
 * responsibility signature (#2397). A detected mismatch with no valid
 * override returns a structured hold verdict the caller must act on
 * (present it to the sender) rather than silently forwarding or silently
 * blocking.
 * @param {object} input
 * @param {string} input.text - The instruction being sent
 * @param {string} input.targetRole - Must be a key of {@link ROLE_RESPONSIBILITIES}
 * @param {string} input.targetSessionId - Carried through unchanged, for the
 *   caller's own display/audit — this module makes no decision based on it
 * @param {string[]} [input.availableRoles] - Candidate roles for
 *   {@link _suggestRole}'s suggestion
 * @param {string} [input.confirmRoleOverride] - Must equal
 *   `instructionDigest(input.text)` to be accepted; anything else (wrong
 *   digest, absent) is treated as no override at all
 * @returns {{ok: true, result: {forwarded: true, detectedIntents: string[], overridden: boolean}}
 *   |{ok: false, code: 'ROLE_INSTRUCTION_MISMATCH_CONFIRM_REQUIRED', detectedIntent: string,
 *      targetRole: string, suggestedRole: (string|null), reason: string, confirmationDigest: string}
 *   |{ok: false, code: string, message: string}}
 */
function evaluateRoleInstruction(input) {
  if (!input || typeof input !== 'object') {
    return _refuse('ROLE_GUARD_INVALID', 'input must be an object.');
  }
  if (typeof input.text !== 'string' || !input.text) {
    return _refuse('ROLE_GUARD_INVALID', 'input.text must be a non-empty string.');
  }
  if (typeof input.targetSessionId !== 'string' || !input.targetSessionId) {
    return _refuse('ROLE_GUARD_INVALID', 'input.targetSessionId is required.');
  }
  const responsibility = ROLE_RESPONSIBILITIES[input.targetRole];
  if (!responsibility) {
    return _refuse('ROLE_GUARD_INVALID',
      `"${input.targetRole}" is not a recognized target role (expected one of ${Object.keys(ROLE_RESPONSIBILITIES).join(', ')}).`);
  }

  const detectedIntents = detectIntents(input.text);
  const mismatchedIntents = detectedIntents.filter((i) => responsibility.disallowedIntents.includes(i));
  const digest = instructionDigest(input.text);

  if (mismatchedIntents.length === 0) {
    return { ok: true, result: { forwarded: true, detectedIntents, overridden: false } };
  }
  if (input.confirmRoleOverride === digest) {
    return { ok: true, result: { forwarded: true, detectedIntents, overridden: true } };
  }

  return _refuse('ROLE_INSTRUCTION_MISMATCH_CONFIRM_REQUIRED',
    `This instruction looks like it was meant for a different role than "${input.targetRole}".`,
    {
      detectedIntent: mismatchedIntents[0],
      targetRole: input.targetRole,
      suggestedRole: _suggestRole(mismatchedIntents, input.availableRoles),
      reason: `"${input.targetRole}" does not normally receive ${mismatchedIntents.join(', ')} instructions.`,
      confirmationDigest: digest
    });
}

module.exports = {
  INTENT_PATTERNS,
  ROLE_RESPONSIBILITIES,
  detectIntents,
  instructionDigest,
  evaluateRoleInstruction
};
