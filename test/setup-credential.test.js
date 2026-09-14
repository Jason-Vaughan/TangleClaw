'use strict';

// The one derivation of "may setup finish without a login here" (#804), and the
// rule that the choice of no login is honoured only where it is true and cannot
// leave the dashboard ungated AND reachable (#803, ADR 0009 rule 3).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decideCredential, OPT_OUT_REFUSALS } = require('../lib/setup-credential');

/** A door Caddy's own parser read, with nothing reachable ungated. */
const CLOSED_DOOR = Object.freeze({ ungatedRemoteSite: false, unguardedLocalSite: false, source: 'adapt' });

/** A fresh direct-mode install on loopback with no login and no choice made. */
function facts(overrides = {}) {
  return {
    loginInHand: false,
    adoptionSupplies: false,
    caddyLoginInForce: false,
    bindWide: false,
    ingressMode: 'direct',
    door: null,
    optOut: false,
    ...overrides
  };
}

/** The same install in caddy mode, behind a given door. */
function caddyFacts(door, overrides = {}) {
  return facts({ ingressMode: 'caddy', door, ...overrides });
}

describe('decideCredential — is a login required', () => {
  it('requires a login on a fresh install', () => {
    const d = decideCredential(facts());
    assert.equal(d.required, true);
    assert.equal(d.satisfied, false);
  });

  it('is satisfied once a login is in hand', () => {
    const d = decideCredential(facts({ loginInHand: true }));
    assert.equal(d.satisfied, true);
    assert.equal(d.required, false);
  });

  it('is satisfied when this route adopts a working Caddy login', () => {
    const d = decideCredential(caddyFacts(CLOSED_DOOR, { adoptionSupplies: true, caddyLoginInForce: true }));
    assert.equal(d.satisfied, true);
    assert.equal(d.required, false);
  });

  it('a Caddy login on disk that this route does not adopt supplies nothing — Skip\'s case', () => {
    const d = decideCredential(caddyFacts(CLOSED_DOOR, { caddyLoginInForce: true }));
    assert.equal(d.satisfied, false);
    assert.equal(d.required, true);
  });

  it('reads loginInHand as exactly true — a truthy non-boolean is not a login', () => {
    const d = decideCredential(facts({ loginInHand: 'yes' }));
    assert.equal(d.satisfied, false);
    assert.equal(d.required, true);
  });

  it('with no facts at all, requires a login and refuses the opt-out', () => {
    const d = decideCredential(undefined);
    assert.equal(d.required, true);
    assert.equal(d.optOutAllowed, false);
  });
});

describe('decideCredential — the choice of no login', () => {
  it('honours it on a loopback direct-mode install', () => {
    const d = decideCredential(facts({ optOut: true }));
    assert.equal(d.optOutAllowed, true);
    assert.equal(d.optOutRefusal, null);
    assert.equal(d.required, false);
  });

  it('is offered even when not chosen, so the wizard can show it', () => {
    const d = decideCredential(facts());
    assert.equal(d.optOutAllowed, true);
    assert.equal(d.required, true, 'offering the choice does not make it');
  });

  it('refuses it where a login is already in hand — the choice would be false', () => {
    const d = decideCredential(facts({ loginInHand: true, optOut: true }));
    assert.equal(d.optOutRefusal.code, OPT_OUT_REFUSALS.LOGIN_IN_FORCE);
  });

  it('refuses it where a Caddy config carries a login, adopted or not', () => {
    for (const adoptionSupplies of [true, false]) {
      const d = decideCredential(caddyFacts(CLOSED_DOOR, { caddyLoginInForce: true, adoptionSupplies, optOut: true }));
      assert.equal(d.optOutRefusal.code, OPT_OUT_REFUSALS.LOGIN_IN_FORCE, `adoptionSupplies=${adoptionSupplies}`);
    }
  });

  it('refuses it when whether Caddy carries a login is unknown', () => {
    const d = decideCredential(caddyFacts(CLOSED_DOOR, { caddyLoginInForce: undefined, optOut: true }));
    assert.equal(d.optOutRefusal.code, OPT_OUT_REFUSALS.LOGIN_IN_FORCE);
  });

  it('refuses it on a wide bind — never ungated AND reachable', () => {
    const d = decideCredential(facts({ bindWide: true, optOut: true }));
    assert.equal(d.optOutRefusal.code, OPT_OUT_REFUSALS.WIDE_BIND);
    assert.equal(d.required, true);
  });

  it('refuses it when the bind state is not a boolean', () => {
    const d = decideCredential(facts({ bindWide: undefined, optOut: true }));
    assert.equal(d.optOutRefusal.code, OPT_OUT_REFUSALS.WIDE_BIND);
  });

  it('refuses it in caddy mode when a remote site has no gate', () => {
    const d = decideCredential(caddyFacts({ ...CLOSED_DOOR, ungatedRemoteSite: true }, { optOut: true }));
    assert.equal(d.optOutRefusal.code, OPT_OUT_REFUSALS.UNGATED_REMOTE_SITE);
    assert.equal(d.required, true);
  });

  it('refuses it in caddy mode when a localhost site has neither a gate nor the peer guard', () => {
    // Local in name only: Caddy listens on every interface and picks the site by
    // the host a client asks for, so any machine asking for localhost gets in.
    const d = decideCredential(caddyFacts({ ...CLOSED_DOOR, unguardedLocalSite: true }, { optOut: true }));
    assert.equal(d.optOutRefusal.code, OPT_OUT_REFUSALS.UNGUARDED_LOCAL_SITE);
    assert.match(d.optOutRefusal.reason, /guard-ungated-sites/);
    assert.equal(d.required, true);
  });

  it('refuses it in caddy mode when the door could not be described', () => {
    for (const door of [null, { ...CLOSED_DOOR, source: 'unread' }, { ...CLOSED_DOOR, source: 'import' }]) {
      const d = decideCredential(caddyFacts(door, { optOut: true }));
      assert.equal(d.optOutRefusal.code, OPT_OUT_REFUSALS.DOOR_UNREAD, JSON.stringify(door));
      assert.match(d.optOutRefusal.reason, /could not read/);
    }
  });

  it('honours it in caddy mode behind a door Caddy read as closed, or with no Caddyfile', () => {
    for (const source of ['adapt', 'none']) {
      const d = decideCredential(caddyFacts({ ...CLOSED_DOOR, source }, { optOut: true }));
      assert.equal(d.optOutAllowed, true, source);
      assert.equal(d.required, false, source);
    }
  });

  it('ignores the door in direct mode, where Caddy is not the front door', () => {
    const d = decideCredential(facts({ door: { ungatedRemoteSite: true, unguardedLocalSite: true, source: 'unread' }, optOut: true }));
    assert.equal(d.optOutAllowed, true);
  });

  it('takes the choice as exactly true', () => {
    const d = decideCredential(facts({ optOut: 'true' }));
    assert.equal(d.required, true);
  });
});
