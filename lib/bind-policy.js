'use strict';

/**
 * Which network interfaces the TangleClaw HTTP server binds, and why.
 *
 * TangleClaw launches AI agent sessions with shell access, so an unauthenticated
 * dashboard reachable from the network is arbitrary code execution as the
 * operator, plus read access to every managed project and any credential those
 * projects hold. Binding beyond `127.0.0.1` therefore requires that something is
 * guarding the door — TangleClaw's own login, the reverse-proxy gate, or an
 * explicit and recorded choice by the operator. It is never a silent consequence
 * of a default.
 *
 * The rules, in precedence order:
 *
 * 1. **Caddy ingress mode pins loopback**, and an opt-in to a wider bind is
 *    refused rather than honored. Caddy is the front door and already listens
 *    on every interface, so a second, plain-HTTP listener beside it buys no
 *    reach and costs two things: it carries passwords and session cookies
 *    unencrypted, and a stored opt-in is invisible in this mode (#1055), so
 *    honouring it would open that listener from a choice made in an earlier
 *    session. The refusal is logged, never silent, and the stored value is
 *    reported as `choice` so the settings UI can name it.
 * 2. **Direct mode with `bindAllInterfaces: true`** binds every interface. This
 *    is the deliberate opt-out, and the only way to reach a wide bind.
 * 3. **Otherwise, loopback.** The default.
 *
 * This narrowed an existing default: before this module, direct mode bound every
 * interface unconditionally. A config file that carries no `bindAllInterfaces`
 * key predates the setting, so in direct mode it is an install that *was* binding
 * wide. That absence is a one-shot signal — the next whole-object config save
 * destroys it — so `migrateLegacyBind()` converts it to an explicit `null` at
 * boot, and every later decision reads that value rather than the file.
 *
 * **Such an install is NOT narrowed automatically** (ADR 0009, 2026-07-28
 * amendment). Its operator may be reaching the dashboard on that wide binding
 * right now. Closing the door first would strand them. So the binding is held in
 * a `grace` state and reported loudly until the operator chooses explicitly,
 * moves to caddy mode (where rule 1 pins loopback), or puts TangleClaw's own
 * login in front of it — once that login guards the door, a wide bind is no
 * longer an unguarded one and is not reported as exposed.
 *
 * The grace state is scoped to *this* listener. The terminal listener (ttyd) is
 * pinned immediately for everyone, because nothing external addresses it — see
 * lib/ttyd-bind.js. Holding back the door nobody knocks on would buy safety for
 * no one while leaving an unauthenticated shell open.
 *
 * @module lib/bind-policy
 */

const authGate = require('./auth-gate');

/** Loopback address — the safe bind, reachable only from the machine itself. */
const LOOPBACK = '127.0.0.1';

/** Config key holding the operator's opt-in to binding every interface. */
const OPT_IN_KEY = 'bindAllInterfaces';

/**
 * THE single classification of an install's network-binding state.
 *
 * Every consumer reads its answer from here — the socket, the boot warnings, the
 * dashboard notice, and the settings UI (via `bindState` on `GET /api/config`).
 * Nothing re-tests the raw config fields, because each independent copy of these
 * predicates has produced a defect: a switch reading "closed" over an open
 * socket, an unrelated Save recording a choice nobody made, and a terminal port
 * re-opened by a setting that should never have reached it.
 *
 * @param {object} config - Global config (as returned by `store.config.load()`).
 * @param {string} [config.ingressMode] - `'caddy'` or `'direct'`.
 * @param {boolean|null} [config.bindAllInterfaces] - The operator's recorded choice.
 * @param {string|null} [gateState] - TangleClaw's gate state
 *   (`lib/auth-gate.js#resolveGateState`). Changes no binding; it decides only
 *   whether a wide bind is `guarded`.
 * @returns {{setting: string, choice: string, reason: string, wide: boolean,
 *   grace: boolean, guarded: boolean, lockedByCaddy: boolean, refusedOptIn: boolean,
 *   malformedOptIn: boolean}}
 *   `choice` is what the operator has RECORDED (`'opted-in'` / `'closed'` /
 *   `'unchosen'`); `wide` is the binding that CONFIG resolves to, which is not
 *   always the same — caddy mode overrides an opt-in, and an unchosen install
 *   stays wide deliberately. Precisely: `wide` is what the socket will be after
 *   the next restart, and what it already is unless the setting changed since
 *   boot. It is not read from the live listener, so between saving a new value
 *   and restarting it describes the intent rather than the socket — which is why
 *   the setting is flagged `requiresRestart` and the UI says so. `reason` is one of `'caddy'`, `'opt-in'`, `'grace'`, `'default'`.
 *   `refusedOptIn` and `malformedOptIn` exist to be logged; neither changes the
 *   binding. `guarded` is whether TangleClaw's own login guards the door
 *   (`authGate.guardsTheDoor`), which is what makes a wide bind a guarded one.
 *   In caddy mode `choice` is the stored value the locked switch does not show,
 *   and what applies on leaving caddy mode (#1055).
 */
function describeBindState(config, gateState = null) {
  const cfg = config || {};
  const raw = cfg[OPT_IN_KEY];

  // THE predicates. Every consumer — the socket, the boot warnings, the notice,
  // the settings UI — reads them from here. They used to be re-derived at each
  // site, and every disagreement between two copies became a defect: a switch
  // showing "closed" over an open socket, a save recording a choice nobody made,
  // a terminal port re-opened by a setting that should not have reached it.
  const optIn = raw === true;
  // `null` is the recorded "never chosen" state written by migrateLegacyBind();
  // `undefined` is a config not yet migrated. Neither is malformed. Anything
  // else non-boolean is a hand-edit worth complaining about.
  const unchosen = raw === null || raw === undefined;
  const malformedOptIn = !unchosen && typeof raw !== 'boolean';
  const lockedByCaddy = cfg.ingressMode === 'caddy';

  let choice = 'closed';
  if (unchosen) choice = 'unchosen';
  else if (optIn) choice = 'opted-in';

  // What the SOCKET does, which is not always what the config says: caddy mode
  // overrides an opt-in, and an unchosen install stays wide on purpose.
  let reason = 'default';
  let wide = false;
  if (lockedByCaddy) reason = 'caddy';
  else if (optIn) { reason = 'opt-in'; wide = true; }
  else if (unchosen) {
    // An install whose config predates the key was, by construction, binding
    // every interface — and in direct mode that is the binding its operator is
    // reaching it on. Narrowing it would take a working remote dashboard from
    // someone who may be using it right now. So the door stays open, loudly
    // unless TangleClaw's own login guards it (`describeNarrowing`), until the
    // operator chooses or moves behind Caddy.
    // See ADR 0009's 2026-07-28 amendment. The terminal listener is NOT held
    // back this way — nothing external addresses it (lib/ttyd-bind.js).
    reason = 'grace';
    wide = true;
  }

  return {
    setting: OPT_IN_KEY,
    choice,
    reason,
    wide,
    grace: reason === 'grace',
    guarded: authGate.guardsTheDoor(gateState),
    lockedByCaddy,
    // The operator asked for a wide bind and caddy mode overrode it.
    refusedOptIn: lockedByCaddy && optIn,
    malformedOptIn
  };
}

/**
 * The host to hand `server.listen()`, derived from the shared classification.
 *
 * @param {object} config - Global config.
 * @returns {{host: (string|null), label: string, reason: string, grace: boolean,
 *   refusedOptIn: boolean, malformedOptIn: boolean}} `host` is the address to
 *   bind, or `null` for every interface (Node's default when no host is given).
 *   `label` names that binding in a log line.
 */
function resolveBind(config) {
  const s = describeBindState(config);
  return {
    host: s.wide ? null : LOOPBACK,
    label: s.wide ? '*' : LOOPBACK,
    reason: s.reason,
    refusedOptIn: s.refusedOptIn,
    malformedOptIn: s.malformedOptIn,
    grace: s.grace
  };
}

/**
 * Describe an install that is STILL bound to every interface with no password,
 * naming the setting that resolves it.
 *
 * Fires only for a direct-mode install that has never chosen (`null`, or a config
 * not yet migrated) — which is exactly the population still bound wide — AND
 * whose own login does not guard the door. A caddy-mode install is pinned to
 * loopback, an install that has set the key either way has decided, and an
 * install whose login is armed is not reachable "with no password"; none is
 * warned. Telling a guarded install it has no password is the false alarm that
 * teaches an operator to ignore this notice.
 *
 * This describes a LIVE exposure, not an upgrade note about something that
 * already happened. The distinction matters: an earlier draft announced that
 * TangleClaw "now listens on 127.0.0.1 only", which was false for precisely the
 * installs receiving it.
 *
 * @param {object} config - Global config (as returned by `store.config.load()`).
 * @param {string|null} [gateState] - TangleClaw's gate state. Omitted, the
 *   install is treated as unguarded, so the warning is never lost to a caller
 *   that did not ask.
 * @returns {{message: string, setting: string, severity: string}|null} The notice,
 *   or `null` when this install is not in the exposed grace state.
 */
function describeNarrowing(config, gateState = null) {
  // Reads the shared classification rather than re-testing the raw key. When
  // this had its own copy of the predicate, the notice and the socket could
  // disagree about whether an install was exposed.
  const state = describeBindState(config, gateState);
  if (!state.grace || state.guarded) return null;

  return {
    setting: OPT_IN_KEY,
    severity: 'exposed',
    message: 'This dashboard is reachable from your whole network with no password, and it can open '
      + 'terminal sessions — so anyone who can reach this machine can run commands as you. New '
      + 'installs listen on 127.0.0.1 only; yours predates that setting, and TangleClaw has NOT '
      + 'closed it automatically because that would take away the remote access you are using right '
      + 'now. Two ways to fix it, and the first is better: set up the login gate, which keeps remote '
      + `access behind a password. Or set "${OPT_IN_KEY}": false to close the door entirely, leaving `
      + 'the dashboard reachable only from this machine.'
  };
}

/**
 * Record "this install predates the setting and has never chosen" as an explicit
 * persisted value, once.
 *
 * The grace state cannot be inferred from the key being *absent*, even though
 * absence is what identifies a legacy install in the first place. `load()`
 * merges `DEFAULT_CONFIG` and `save()` writes the whole object, so the first
 * write of any unrelated setting — a theme change, a wizard step, a token
 * rotation — materializes `bindAllInterfaces: false` and would silently end the
 * grace period. The operator would then be cut off on the next restart having
 * never made a choice, which is precisely the blackout the grace state exists to
 * prevent, reached by changing the colour scheme.
 *
 * Writing `null` — a value distinct from both `true` and `false` — survives that
 * round-trip, because a whole-object save preserves it. The config API only
 * accepts booleans, so `null` can never be reached from the outside; it means
 * exactly one thing, and only this function writes it.
 *
 * @param {object} config - Global config (defaults-merged).
 * @param {boolean} keyPersisted - Whether the config FILE carries the key.
 * @returns {{migrated: boolean, reason: string, value: (null|undefined)}} `migrated`
 *   true means the caller must persist `config` — this function does not write.
 */
function migrateLegacyBind(config, keyPersisted) {
  const cfg = config || {};
  if (keyPersisted) return { migrated: false, reason: 'already-recorded', value: undefined };
  if (cfg.ingressMode === 'caddy') {
    // Caddy mode was already loopback, so there is no prior wide binding to
    // grandfather and nothing to grant grace for.
    return { migrated: false, reason: 'caddy-mode-never-bound-wide', value: undefined };
  }
  cfg[OPT_IN_KEY] = null;
  return { migrated: true, reason: 'legacy-direct-install', value: null };
}

module.exports = {
  describeBindState,
  resolveBind,
  describeNarrowing,
  migrateLegacyBind,
  LOOPBACK,
  OPT_IN_KEY
};
