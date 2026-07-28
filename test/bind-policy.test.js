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

describe('bind-policy.resolveBind — the bind matrix', () => {
  it('binds loopback by default in direct mode (the narrowed default)', () => {
    const r = resolveBind({ ingressMode: 'direct' });
    assert.equal(r.host, LOOPBACK);
    assert.equal(r.label, LOOPBACK);
    assert.equal(r.reason, 'default');
    assert.equal(r.refusedOptIn, false);
  });

  it('binds every interface in direct mode when the operator opted in', () => {
    const r = resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: true });
    assert.equal(r.host, null, 'null host means listen() binds all interfaces');
    assert.equal(r.label, '*');
    assert.equal(r.reason, 'opt-in');
    assert.equal(r.refusedOptIn, false);
  });

  it('binds loopback in direct mode when the opt-in is explicitly false', () => {
    const r = resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: false });
    assert.equal(r.host, LOOPBACK);
    assert.equal(r.reason, 'default');
  });

  it('binds loopback in caddy mode', () => {
    const r = resolveBind({ ingressMode: 'caddy' });
    assert.equal(r.host, LOOPBACK);
    assert.equal(r.reason, 'caddy');
    assert.equal(r.refusedOptIn, false);
  });

  it('refuses the opt-in in caddy mode rather than publishing an ungated socket', () => {
    const r = resolveBind({ ingressMode: 'caddy', [OPT_IN_KEY]: true });
    assert.equal(r.host, LOOPBACK, 'caddy mode must stay behind the gate');
    assert.equal(r.reason, 'caddy');
    assert.equal(r.refusedOptIn, true, 'the override must be reported so it can be logged');
  });

  it('treats a missing ingressMode as direct, and still defaults to loopback', () => {
    assert.equal(resolveBind({}).host, LOOPBACK);
    assert.equal(resolveBind(undefined).host, LOOPBACK);
  });

  it('only accepts a real boolean true as the opt-in', () => {
    // A truthy string in a hand-edited config must not widen the bind — the
    // opt-out is a deliberate act, and "true" typed as a string is a typo.
    for (const value of ['true', 1, 'yes', {}]) {
      assert.equal(
        resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: value }).host,
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
        resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: value }).malformedOptIn,
        true,
        `${JSON.stringify(value)} should be reported as malformed`
      );
    }
  });

  it('does not call a legitimately absent or boolean key malformed', () => {
    assert.equal(resolveBind({ ingressMode: 'direct' }).malformedOptIn, false,
      'absence is the normal state for a config written before the key existed');
    assert.equal(resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: true }).malformedOptIn, false);
    assert.equal(resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: false }).malformedOptIn, false);
    assert.equal(resolveBind({ ingressMode: 'caddy', [OPT_IN_KEY]: false }).malformedOptIn, false);
  });
});

describe('bind-policy.describeNarrowing — who gets told', () => {
  it('tells a direct-mode install whose config predates the key', () => {
    const notice = describeNarrowing({ ingressMode: 'direct' }, false);
    assert.ok(notice, 'this install was binding wide and now is not');
    assert.equal(notice.setting, OPT_IN_KEY);
    assert.match(notice.message, /127\.0\.0\.1/);
    assert.match(notice.message, new RegExp(OPT_IN_KEY),
      'the notice must name the setting that restores the old behavior');
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
