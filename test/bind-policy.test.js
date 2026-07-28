'use strict';

/*
 * The bind matrix is the security boundary for #710's first slice, so it is
 * asserted exhaustively rather than by example: ingress mode (caddy / direct)
 * crossed with the operator's opt-in (set true / set false / absent).
 *
 * The case that matters most is the one that reads as a contradiction — caddy
 * mode with the opt-in set. Caddy holds the credential gate, so honoring a wide
 * bind there would publish an ungated socket beside the gated one while the
 * operator believes they are protected. It must resolve to loopback AND report
 * that it overrode the request, because a silent divergence between config and
 * socket is the exact class of failure this scope exists to end.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const bindPolicy = require('../lib/bind-policy');
const { resolveBind, describeNarrowing, LOOPBACK, OPT_IN_KEY } = bindPolicy;

// `true` = the key is present in the persisted config, i.e. NOT a legacy install.
// Most cases below are about a config that has made a choice; the legacy grace
// path has its own describe block.
const CHOSEN = true;

describe('bind-policy.resolveBind — the bind matrix', () => {
  it('binds loopback by default in direct mode (the narrowed default)', () => {
    const r = resolveBind({ ingressMode: 'direct' }, CHOSEN);
    assert.equal(r.host, LOOPBACK);
    assert.equal(r.label, LOOPBACK);
    assert.equal(r.reason, 'default');
    assert.equal(r.refusedOptIn, false);
    assert.equal(r.grace, false);
  });

  it('binds every interface in direct mode when the operator opted in', () => {
    const r = resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: true }, CHOSEN);
    assert.equal(r.host, null, 'null host means listen() binds all interfaces');
    assert.equal(r.label, '*');
    assert.equal(r.reason, 'opt-in');
    assert.equal(r.refusedOptIn, false);
  });

  it('binds loopback in direct mode when the opt-in is explicitly false', () => {
    const r = resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: false }, CHOSEN);
    assert.equal(r.host, LOOPBACK);
    assert.equal(r.reason, 'default');
  });

  it('binds loopback in caddy mode', () => {
    const r = resolveBind({ ingressMode: 'caddy' }, CHOSEN);
    assert.equal(r.host, LOOPBACK);
    assert.equal(r.reason, 'caddy');
    assert.equal(r.refusedOptIn, false);
  });

  it('refuses the opt-in in caddy mode rather than publishing an ungated socket', () => {
    const r = resolveBind({ ingressMode: 'caddy', [OPT_IN_KEY]: true }, CHOSEN);
    assert.equal(r.host, LOOPBACK, 'caddy mode must stay behind the gate');
    assert.equal(r.reason, 'caddy');
    assert.equal(r.refusedOptIn, true, 'the override must be reported so it can be logged');
  });

  it('treats a missing ingressMode as direct, and still defaults to loopback', () => {
    assert.equal(resolveBind({}, CHOSEN).host, LOOPBACK);
    assert.equal(resolveBind(undefined, CHOSEN).host, LOOPBACK);
  });

  it('only accepts a real boolean true as the opt-in', () => {
    // A truthy string in a hand-edited config must not widen the bind — the
    // opt-out is a deliberate act, and "true" typed as a string is a typo.
    for (const value of ['true', 1, 'yes', {}]) {
      assert.equal(
        resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: value }, CHOSEN).host,
        LOOPBACK,
        `${JSON.stringify(value)} must not be accepted as an opt-in`
      );
    }
  });

  it('reports a malformed opt-in so it can be logged, rather than silently ignoring it', () => {
    // Treating "true" as false is the safe reading, but the operator who typed
    // it believes the door is open. A config that disagrees with the socket
    // without saying so is the failure this whole module exists to prevent.
    for (const value of ['true', 'false', 1, 0, null, {}]) {
      assert.equal(
        resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: value }, CHOSEN).malformedOptIn,
        true,
        `${JSON.stringify(value)} should be reported as malformed`
      );
    }
  });

  it('does not call a legitimately absent or boolean key malformed', () => {
    assert.equal(resolveBind({ ingressMode: 'direct' }, CHOSEN).malformedOptIn, false,
      'absence is the normal state for a config written before the key existed');
    assert.equal(resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: true }, CHOSEN).malformedOptIn, false);
    assert.equal(resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: false }, CHOSEN).malformedOptIn, false);
    assert.equal(resolveBind({ ingressMode: 'caddy', [OPT_IN_KEY]: false }, CHOSEN).malformedOptIn, false);
  });
});

describe('bind-policy.resolveBind — the legacy grace state (ADR 0009 amendment)', () => {
  const LEGACY = false; // the key is absent from the persisted config

  it('does NOT narrow an install whose config predates the key', () => {
    // This is the whole amendment. Such an install may be reached remotely on
    // exactly this binding right now, and the replacement — the credential gate
    // — exists only in caddy mode. Closing the door first strands the operator
    // with nothing to open instead.
    const r = resolveBind({ ingressMode: 'direct' }, LEGACY);
    assert.equal(r.host, null, 'the wide binding is held, not closed');
    assert.equal(r.reason, 'grace');
    assert.equal(r.grace, true, 'the grace state must be reported so it can be surfaced loudly');
  });

  it('narrows the moment the operator chooses, and the choice is what clears the grace', () => {
    const r = resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: false }, true);
    assert.equal(r.host, LOOPBACK);
    assert.equal(r.grace, false);
  });

  it('narrows when the install moves behind the gate, with the lock already in front', () => {
    // Moving to caddy mode is the safe narrowing path: Caddy fronts the socket,
    // so loopback costs the operator nothing and the gate is what they reach.
    const r = resolveBind({ ingressMode: 'caddy' }, LEGACY);
    assert.equal(r.host, LOOPBACK);
    assert.equal(r.reason, 'caddy');
    assert.equal(r.grace, false, 'behind the gate there is nothing to grant grace for');
  });

  it('never puts a FRESH install in the grace state', () => {
    // store.init() writes DEFAULT_CONFIG before the bind is resolved, so a new
    // install always has the key persisted. If that ordering ever broke, every
    // new install would ship wide open — which is the bug this scope exists to
    // fix, reintroduced through the mitigation for it.
    const r = resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: false }, true);
    assert.equal(r.host, LOOPBACK);
    assert.equal(r.grace, false);
  });
});

describe('bind-policy.describeNarrowing — who gets told', () => {
  it('warns a direct-mode install whose config predates the key', () => {
    const notice = describeNarrowing({ ingressMode: 'direct' }, false);
    assert.ok(notice, 'this install is still exposed and must be told so');
    assert.equal(notice.setting, OPT_IN_KEY);
    assert.equal(notice.severity, 'exposed');
    assert.match(notice.message, new RegExp(OPT_IN_KEY),
      'the notice must name the setting that closes the door');
  });

  it('describes the CURRENT state honestly, not a narrowing that did not happen', () => {
    // The earlier draft of this notice said "TangleClaw now listens on 127.0.0.1
    // only" — which, under the grace state, is false for exactly the population
    // that receives it. A security notice that misdescribes the machine it is
    // running on is worse than none.
    const notice = describeNarrowing({ ingressMode: 'direct' }, false);
    assert.match(notice.message, /reachable from your whole network/i);
    assert.doesNotMatch(notice.message, /now listens on 127\.0\.0\.1 only/i);
  });

  it('stays silent once the operator has set the key either way', () => {
    assert.equal(describeNarrowing({ ingressMode: 'direct' }, true), null);
    assert.equal(describeNarrowing({ ingressMode: 'direct', [OPT_IN_KEY]: true }, true), null);
  });

  it('stays silent for caddy mode, which already bound loopback', () => {
    assert.equal(describeNarrowing({ ingressMode: 'caddy' }, false), null);
  });

  it('points at the login gate rather than only at the way to reopen the door', () => {
    // The notice has to offer the safe way to keep remote access, or it reads
    // as "set this flag to get your dashboard back" and every affected operator
    // lands straight back in the exposed state this change exists to close.
    const notice = describeNarrowing({ ingressMode: 'direct' }, false);
    assert.match(notice.message, /login gate/i);
  });
});
