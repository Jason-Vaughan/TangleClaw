'use strict';

/**
 * Whether first-run setup may finish without a login, asked once.
 *
 * Setup can be finished by two routes — `POST /api/setup/complete` and the
 * wizard's Skip, `PATCH /api/config { setupComplete: true }` — and the wizard
 * decides from the same question whether to show the login step. When each
 * spelled the rule out itself, it was changed at one route and not the other,
 * and Skip became a way past the login. Every consumer asks this function and
 * branches on its answer; none re-derives it.
 *
 * TangleClaw's login is its own (a scrypt account behind `lib/auth-gate.js`),
 * so it can be enforced on every install, with or without Caddy. Whether Caddy
 * could be provisioned is therefore not part of the rule: a login is required
 * unless one is already in hand, or the operator has deliberately chosen none.
 *
 * The choice of no login (ADR 0009's opt-out) is honoured only where it cannot
 * leave the dashboard ungated AND reachable from other machines:
 *
 * - a wide bind (direct mode on every interface) refuses it — anyone on the
 *   network would get a shell;
 * - in caddy mode, a Caddyfile that serves a remote site with no gate of its own
 *   refuses it, and so does not knowing — Caddy listens on every interface, and
 *   a door this cannot see is not evidence of a closed one;
 * - a login already in force from an adopted Caddy config refuses it, because
 *   choosing "no login" there would be a false statement: Caddy still asks.
 *
 * PURE — callers gather the facts; the whole table is unit-testable.
 *
 * @module lib/setup-credential
 */

/** Stable codes naming why the opt-out is not available. */
const OPT_OUT_REFUSALS = Object.freeze({
  WIDE_BIND: 'WIDE_BIND',
  UNGATED_REMOTE_SITE: 'UNGATED_REMOTE_SITE',
  LOGIN_IN_FORCE: 'LOGIN_IN_FORCE'
});

/**
 * Decide whether setup needs a login here, and whether choosing none is allowed.
 *
 * @param {object} facts
 * @param {boolean} facts.authEnabled - `config.authEnabled === true` after any
 *   credential this request supplies has been applied. On, the gate enforces
 *   (`account-required` or `armed`), so a login is in hand.
 * @param {string|null} facts.planAction - `decideProvisioning`'s `action`.
 *   `adopt` supplies a login from a working Caddy config.
 * @param {boolean} facts.bindWide - `bindPolicy.describeBindState(config).wide`.
 * @param {string|null} facts.ingressMode - `'caddy'` or `'direct'`.
 * @param {boolean|null} facts.ungatedRemoteSite - Caddy mode only: whether the
 *   Caddyfile on disk serves a site beyond `localhost` with no gate
 *   (`lib/caddy.js#describeIngressDoor`). `null` when it could not be read,
 *   which refuses the opt-out.
 * @param {boolean} facts.optOut - The request carries the operator's explicit
 *   choice of no login. Skip never does.
 * @returns {{ satisfied: boolean, required: boolean, optOutAllowed: boolean,
 *   optOutRefusal: ({ code: string, reason: string }|null) }}
 *   `satisfied` — a login is in hand. `required` — setup must refuse to finish
 *   (`ADMIN_REQUIRED`). `optOutAllowed` — the choice of no login may be offered
 *   and honoured; when false, `optOutRefusal` names why, in one operator-facing
 *   sentence. `required` is false only when `satisfied`, or when `optOut` is set
 *   and allowed.
 */
function decideCredential(facts) {
  const f = facts || {};
  // Exactly `true`, never truthiness: an unreadable or malformed fact is not
  // evidence that a login exists.
  const satisfied = f.authEnabled === true || f.planAction === 'adopt';

  let optOutRefusal = null;
  if (f.planAction === 'adopt') {
    optOutRefusal = {
      code: OPT_OUT_REFUSALS.LOGIN_IN_FORCE,
      reason: 'A Caddy login is already in front of TangleClaw here, so it will keep asking for a password '
        + 'whatever is chosen in setup.'
    };
  } else if (f.bindWide === true || typeof f.bindWide !== 'boolean') {
    optOutRefusal = {
      code: OPT_OUT_REFUSALS.WIDE_BIND,
      reason: 'TangleClaw is listening on every network interface, so without a login anyone who can reach '
        + 'this machine could run commands as you. Set a login, or turn off "bindAllInterfaces" first.'
    };
  } else if (f.ingressMode === 'caddy' && f.ungatedRemoteSite !== false) {
    optOutRefusal = {
      code: OPT_OUT_REFUSALS.UNGATED_REMOTE_SITE,
      reason: f.ungatedRemoteSite === true
        ? 'The Caddy config serves TangleClaw beyond this machine, so without a login anyone who can reach '
          + 'that address could run commands as you.'
        : 'TangleClaw could not read the Caddy config in front of it, so it cannot tell whether finishing '
          + 'without a login would leave it reachable from other machines.'
    };
  }

  const optOutAllowed = optOutRefusal === null;
  const required = !satisfied && !(f.optOut === true && optOutAllowed);
  return { satisfied, required, optOutAllowed, optOutRefusal };
}

module.exports = {
  decideCredential,
  OPT_OUT_REFUSALS
};
