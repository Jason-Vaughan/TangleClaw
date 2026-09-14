'use strict';

// The one derivation of "may setup finish without a login here" (#804), and the
// rule that the choice of no login is honoured only where it cannot leave the
// dashboard ungated AND reachable (#803, ADR 0009 rule 3).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decideCredential, OPT_OUT_REFUSALS } = require('../lib/setup-credential');

/** A fresh direct-mode install on loopback with no login and no choice made. */
function facts(overrides = {}) {
  return {
    authEnabled: false,
    planAction: 'refuse',
    bindWide: false,
    ingressMode: 'direct',
    ungatedRemoteSite: null,
    optOut: false,
    ...overrides
  };
}

describe('decideCredential — is a login required', () => {
  it('requires a login on a fresh install whether or not Caddy could be provisioned', () => {
    // TangleClaw's own login needs no Caddy, so `refuse` (no Caddy) and
    // `provision` answer the same. The old rule keyed on `provision` alone.
    for (const planAction of ['refuse', 'provision']) {
      const d = decideCredential(facts({ planAction }));
      assert.equal(d.required, true, planAction);
      assert.equal(d.satisfied, false, planAction);
    }
  });

  it('is satisfied once the gate is on', () => {
    const d = decideCredential(facts({ authEnabled: true }));
    assert.equal(d.satisfied, true);
    assert.equal(d.required, false);
  });

  it('is satisfied by adopting a working Caddy login', () => {
    const d = decideCredential(facts({ planAction: 'adopt', ingressMode: 'caddy', ungatedRemoteSite: false }));
    assert.equal(d.satisfied, true);
    assert.equal(d.required, false);
  });

  it('reads authEnabled as exactly true — a truthy non-boolean is not a login', () => {
    const d = decideCredential(facts({ authEnabled: 'yes' }));
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

  it('refuses it on a wide bind — never ungated AND reachable', () => {
    const d = decideCredential(facts({ bindWide: true, optOut: true }));
    assert.equal(d.optOutAllowed, false);
    assert.equal(d.optOutRefusal.code, OPT_OUT_REFUSALS.WIDE_BIND);
    assert.equal(d.required, true);
  });

  it('refuses it when the bind state is not a boolean', () => {
    const d = decideCredential(facts({ bindWide: undefined, optOut: true }));
    assert.equal(d.optOutRefusal.code, OPT_OUT_REFUSALS.WIDE_BIND);
    assert.equal(d.required, true);
  });

  it('refuses it in caddy mode when a remote site has no gate', () => {
    const d = decideCredential(facts({ ingressMode: 'caddy', ungatedRemoteSite: true, optOut: true }));
    assert.equal(d.optOutRefusal.code, OPT_OUT_REFUSALS.UNGATED_REMOTE_SITE);
    assert.match(d.optOutRefusal.reason, /beyond this machine/);
    assert.equal(d.required, true);
  });

  it('refuses it in caddy mode when the Caddyfile could not be described', () => {
    const d = decideCredential(facts({ ingressMode: 'caddy', ungatedRemoteSite: null, optOut: true }));
    assert.equal(d.optOutRefusal.code, OPT_OUT_REFUSALS.UNGATED_REMOTE_SITE);
    assert.match(d.optOutRefusal.reason, /could not read/);
    assert.equal(d.required, true);
  });

  it('honours it in caddy mode when every remote site is gated or absent', () => {
    const d = decideCredential(facts({ ingressMode: 'caddy', ungatedRemoteSite: false, optOut: true }));
    assert.equal(d.optOutAllowed, true);
    assert.equal(d.required, false);
  });

  it('ignores the Caddyfile in direct mode, where Caddy is not the front door', () => {
    const d = decideCredential(facts({ ingressMode: 'direct', ungatedRemoteSite: true, optOut: true }));
    assert.equal(d.optOutAllowed, true);
  });

  it('refuses it where an adopted Caddy login is already in force', () => {
    const d = decideCredential(facts({ planAction: 'adopt', ingressMode: 'caddy', ungatedRemoteSite: false, optOut: true }));
    assert.equal(d.optOutRefusal.code, OPT_OUT_REFUSALS.LOGIN_IN_FORCE);
    assert.equal(d.required, false, 'the adopted login satisfies setup regardless');
  });

  it('takes the choice as exactly true', () => {
    const d = decideCredential(facts({ optOut: 'true' }));
    assert.equal(d.required, true);
  });
});
