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
 * unless one is in hand, or the operator has deliberately chosen none.
 *
 * The one fact the two finishing routes legitimately differ on is named as an
 * input rather than folded into another: `adoptionSupplies`. Finish adopts a
 * working hand-rolled Caddy login; Skip adopts nothing. Each caller states
 * whether its own route supplies a login that way.
 *
 * The choice of no login (ADR 0009's opt-out) is honoured only where it is a
 * true statement and cannot leave the dashboard ungated AND reachable from
 * other machines. It is refused:
 *
 * - where a login is already in hand, or a Caddy config in caddy mode carries
 *   one — choosing "no login" there would be false, because something still asks;
 * - on a wide bind (direct mode on every interface) — anyone on the network
 *   would get a shell;
 * - in caddy mode, where the Caddyfile serves a remote site with no gate, or a
 *   `localhost` site with neither a gate nor the peer guard (any machine that
 *   asks Caddy for `localhost` reaches it), or cannot be described at all —
 *   Caddy listens on every interface, and a door this cannot see is not
 *   evidence of a closed one.
 *
 * PURE — callers gather the facts; the whole table is unit-testable.
 *
 * @module lib/setup-credential
 */

/** Stable codes naming why the opt-out is not available. */
const OPT_OUT_REFUSALS = Object.freeze({
  LOGIN_IN_FORCE: 'LOGIN_IN_FORCE',
  WIDE_BIND: 'WIDE_BIND',
  UNGATED_REMOTE_SITE: 'UNGATED_REMOTE_SITE',
  UNGUARDED_LOCAL_SITE: 'UNGUARDED_LOCAL_SITE',
  DOOR_UNREAD: 'DOOR_UNREAD'
});

/**
 * Decide whether setup needs a login here, and whether choosing none is allowed.
 *
 * Every boolean fact is read as exactly `true` or `false`; anything else is not
 * evidence, and each is read in the direction that keeps a login.
 *
 * @param {object} facts
 * @param {boolean} facts.loginInHand - `config.authEnabled === true` after any
 *   credential this request supplies has been applied. On, the gate enforces.
 * @param {boolean} facts.adoptionSupplies - This route supplies a login by
 *   adopting a working Caddy config (Finish on an `adopt` plan, before or after
 *   the adoption succeeds). Skip never does.
 * @param {boolean} facts.caddyLoginInForce - Caddy mode, and the Caddyfile on
 *   disk carries at least one login.
 * @param {boolean} facts.bindWide - `bindPolicy.describeBindState(config).wide`.
 * @param {string|null} facts.ingressMode - `'caddy'` or `'direct'`.
 * @param {{ ungatedRemoteSite: boolean, unguardedLocalSite: boolean,
 *   source: string }|null} facts.door - Caddy mode only: the Caddyfile described
 *   by `lib/ingress-door.js`, or `null` when the description failed.
 * @param {boolean} facts.optOut - The request carries the operator's explicit
 *   choice of no login.
 * @returns {{ satisfied: boolean, required: boolean, optOutAllowed: boolean,
 *   optOutRefusal: ({ code: string, reason: string }|null) }}
 *   `satisfied` — a login is in hand or this route supplies one. `required` —
 *   setup must refuse to finish (`ADMIN_REQUIRED`). `optOutAllowed` — the
 *   choice of no login may be offered and honoured; when false, `optOutRefusal`
 *   names why, in one operator-facing sentence. `required` is false only when
 *   `satisfied`, or when `optOut` is set and allowed.
 */
function decideCredential(facts) {
  const f = facts || {};
  const satisfied = f.loginInHand === true || f.adoptionSupplies === true;
  const optOutRefusal = _optOutRefusal(f, satisfied);
  const optOutAllowed = optOutRefusal === null;
  const required = !satisfied && !(f.optOut === true && optOutAllowed);
  return { satisfied, required, optOutAllowed, optOutRefusal };
}

/**
 * Why the choice of no login is refused, or null when it is allowed. Checked in
 * the order a person would want to hear them: a login that already asks first,
 * then what the network could reach.
 *
 * @param {object} f - The facts given to {@link decideCredential}.
 * @param {boolean} satisfied - Whether a login is in hand or supplied.
 * @returns {{ code: string, reason: string }|null}
 */
function _optOutRefusal(f, satisfied) {
  if (satisfied || f.caddyLoginInForce !== false) {
    return {
      code: OPT_OUT_REFUSALS.LOGIN_IN_FORCE,
      reason: 'A login is already in front of TangleClaw here, so it will keep asking for a password '
        + 'whatever is chosen in setup.'
    };
  }
  if (f.bindWide !== false) {
    return {
      code: OPT_OUT_REFUSALS.WIDE_BIND,
      reason: 'TangleClaw is listening on every network interface, so without a login anyone who can reach '
        + 'this machine could run commands as you. Set a login, or turn off "bindAllInterfaces" first.'
    };
  }
  if (f.ingressMode !== 'caddy') return null;

  const door = f.door;
  if (!door || (door.source !== 'adapt' && door.source !== 'none')) {
    return {
      code: OPT_OUT_REFUSALS.DOOR_UNREAD,
      reason: 'TangleClaw could not read the Caddy config in front of it, so it cannot tell whether finishing '
        + 'without a login would leave it reachable from other machines.'
    };
  }
  if (door.ungatedRemoteSite !== false) {
    return {
      code: OPT_OUT_REFUSALS.UNGATED_REMOTE_SITE,
      reason: 'The Caddy config serves TangleClaw beyond this machine, so without a login anyone who can reach '
        + 'that address could run commands as you.'
    };
  }
  if (door.unguardedLocalSite !== false) {
    return {
      code: OPT_OUT_REFUSALS.UNGUARDED_LOCAL_SITE,
      reason: 'The Caddy config has a localhost site that other machines reach by asking for localhost, so '
        + 'without a login they could run commands as you. Run `node scripts/guard-ungated-sites.js` first.'
    };
  }
  return null;
}

module.exports = {
  decideCredential,
  OPT_OUT_REFUSALS
};
