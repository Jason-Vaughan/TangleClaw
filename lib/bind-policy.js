'use strict';

/**
 * Which network interfaces the TangleClaw HTTP server binds, and why.
 *
 * TangleClaw launches AI agent sessions with shell access, so an unauthenticated
 * dashboard reachable from the network is arbitrary code execution as the
 * operator, plus read access to every managed project and any credential those
 * projects hold. Binding beyond `127.0.0.1` therefore requires that something is
 * guarding the door — either the reverse-proxy gate, or an explicit and recorded
 * choice by the operator. It is never a silent consequence of a default.
 *
 * The rules, in precedence order:
 *
 * 1. **Caddy ingress mode pins loopback**, and an opt-in to a wider bind is
 *    refused rather than honored. Caddy fronts the server and holds the
 *    credential gate; binding Node to every interface as well would publish an
 *    ungated door beside the gated one — worse than direct mode, because the
 *    operator believes they are protected. The refusal is logged, never silent.
 * 2. **Direct mode with `bindAllInterfaces: true`** binds every interface. This
 *    is the deliberate opt-out, and the only way to reach a wide bind.
 * 3. **Otherwise, loopback.** The default.
 *
 * This narrowed an existing default: before this module, direct mode bound every
 * interface unconditionally. A config file that carries no `bindAllInterfaces`
 * key at all predates the key, so in direct mode it is an install that *was*
 * binding wide — detected from the key's absence, so no new persisted state is
 * required, and the signal self-clears as soon as the operator sets the key
 * either way.
 *
 * **Such an install is NOT narrowed automatically** (ADR 0009, 2026-07-28
 * amendment). Its operator may be reaching the dashboard on that wide binding
 * right now, and the thing that would replace it — the credential gate — exists
 * only in caddy mode. Closing the door first would strand them with nothing to
 * open instead. So the binding is held in a `grace` state and reported loudly
 * until either the operator chooses explicitly, or they move to caddy mode,
 * where rule 1 pins loopback with a lock already in front of it.
 *
 * The grace state is scoped to *this* listener. The terminal listener (ttyd) is
 * pinned immediately for everyone, because nothing external addresses it — see
 * lib/ttyd-bind.js. Holding back the door nobody knocks on would buy safety for
 * no one while leaving an unauthenticated shell open.
 *
 * @module lib/bind-policy
 */

/** Loopback address — the safe bind, reachable only from the machine itself. */
const LOOPBACK = '127.0.0.1';

/** Config key holding the operator's opt-in to binding every interface. */
const OPT_IN_KEY = 'bindAllInterfaces';

/**
 * Decide which host the HTTP server should bind.
 *
 * @param {object} config - Global config (as returned by `store.config.load()`).
 * @param {string} [config.ingressMode] - `'caddy'` or `'direct'`.
 * @param {boolean} [config.bindAllInterfaces] - Operator opt-in to a wide bind.
 * @returns {{host: (string|null), label: string, reason: string, refusedOptIn: boolean,
 *   malformedOptIn: boolean}}
 *   `host` is the address to pass to `server.listen()`, or `null` to bind every
 *   interface (Node's default when no host is given). `label` is how to name
 *   that binding in a log line. `reason` is one of `'caddy'`, `'opt-in'`, or
 *   `'default'`. `refusedOptIn` is true when the operator asked for a wide bind
 *   and caddy mode overrode it. `malformedOptIn` is true when the key is set to
 *   something that is not a boolean — `"true"` as a string in a hand-edited
 *   config is treated as "not opted in", which is the safe reading, but staying
 *   quiet about it would leave the file claiming one thing and the socket doing
 *   another. Both flags exist to be logged; neither changes the binding.
 */
function resolveBind(config, optInKeyPersisted) {
  const cfg = config || {};
  const raw = cfg[OPT_IN_KEY];
  const optIn = raw === true;
  // `undefined` is absence, not malformation — that is the normal state for any
  // install written before the key existed.
  const malformedOptIn = raw !== undefined && typeof raw !== 'boolean';

  if (cfg.ingressMode === 'caddy') {
    return {
      host: LOOPBACK, label: LOOPBACK, reason: 'caddy',
      refusedOptIn: optIn, malformedOptIn, grace: false
    };
  }
  if (optIn) {
    return { host: null, label: '*', reason: 'opt-in', refusedOptIn: false, malformedOptIn, grace: false };
  }
  // An install whose config predates the key was, by construction, binding every
  // interface — and in direct mode that is the binding its operator is reaching
  // it on. Narrowing it here would take a working remote dashboard away from
  // someone who has not yet been given anything to replace it with, and the
  // replacement (the credential gate) only exists in caddy mode. So the door
  // stays open, loudly, until either the operator makes the choice explicitly or
  // they move behind the gate — at which point the caddy branch above pins it
  // anyway, with a lock already in front of it. See ADR 0009's 2026-07-28
  // amendment; the terminal listener is NOT held back this way, because nothing
  // external addresses it.
  if (optInKeyPersisted === false) {
    return { host: null, label: '*', reason: 'grace', refusedOptIn: false, malformedOptIn, grace: true };
  }
  return { host: LOOPBACK, label: LOOPBACK, reason: 'default', refusedOptIn: false, malformedOptIn, grace: false };
}

/**
 * Detect an install whose binding just narrowed from every interface to loopback,
 * and describe it in one line naming the setting that restores the old behavior.
 *
 * Fires only for a direct-mode install whose persisted config predates
 * `bindAllInterfaces` — that install was binding every interface, and now is not.
 * A caddy-mode install already bound loopback, so nothing changed for it; an
 * install that has set the key either way has made its choice and is not told
 * about it again.
 *
 * @param {object} config - Global config (as returned by `store.config.load()`).
 * @param {boolean} optInKeyPersisted - Whether the config file on disk actually
 *   contains the `bindAllInterfaces` key. Must come from the raw file, not the
 *   defaults-merged config, which always has it.
 * @returns {{message: string, setting: string}|null} The notice, or `null` when
 *   this install's binding did not change.
 */
function describeNarrowing(config, optInKeyPersisted) {
  const cfg = config || {};
  if (optInKeyPersisted) return null;
  if (cfg.ingressMode === 'caddy') return null;

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

module.exports = {
  resolveBind,
  describeNarrowing,
  LOOPBACK,
  OPT_IN_KEY
};
