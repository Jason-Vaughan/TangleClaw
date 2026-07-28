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
const { resolveBind, describeNarrowing, migrateLegacyBind, LOOPBACK, OPT_IN_KEY } = bindPolicy;

describe('bind-policy.resolveBind — the bind matrix', () => {
  it('binds loopback by default in direct mode (the narrowed default)', () => {
    // A FRESH install: store.init() writes DEFAULT_CONFIG, so the key is present
    // and false. An absent key is a different case entirely — see the grace block.
    const r = resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: false });
    assert.equal(r.host, LOOPBACK);
    assert.equal(r.label, LOOPBACK);
    assert.equal(r.reason, 'default');
    assert.equal(r.refusedOptIn, false);
    assert.equal(r.grace, false);
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

  it('treats a missing ingressMode as direct', () => {
    assert.equal(resolveBind({ [OPT_IN_KEY]: false }).host, LOOPBACK);
    // A wholly absent config is an unmigrated legacy install, so it gets grace
    // rather than a silent narrowing — the safe answer is the one that does not
    // strand somebody, and the loud notice is what stops it being a hiding place.
    assert.equal(resolveBind(undefined).grace, true);
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
    // `null` is deliberately excluded: it is the RECORDED "never chosen" state
    // written by migrateLegacyBind, not a hand-edit to complain about.
    for (const value of ['true', 'false', 1, 0, {}]) {
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
    assert.equal(resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: null }).malformedOptIn, false,
      'null is the recorded never-chosen state');
    assert.equal(resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: true }).malformedOptIn, false);
    assert.equal(resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: false }).malformedOptIn, false);
    assert.equal(resolveBind({ ingressMode: 'caddy', [OPT_IN_KEY]: false }).malformedOptIn, false);
  });
});

describe('bind-policy.resolveBind — the legacy grace state (ADR 0009 amendment)', () => {
  it('does NOT narrow an install recorded as never having chosen', () => {
    // This is the whole amendment. Such an install may be reached remotely on
    // exactly this binding right now, and the replacement — the credential gate
    // — exists only in caddy mode. Closing the door first strands the operator
    // with nothing to open instead.
    const r = resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: null });
    assert.equal(r.host, null, 'the wide binding is held, not closed');
    assert.equal(r.reason, 'grace');
    assert.equal(r.grace, true, 'the grace state must be reported so it can be surfaced loudly');
  });

  it('treats a not-yet-migrated config the same as a recorded one', () => {
    const r = resolveBind({ ingressMode: 'direct' });
    assert.equal(r.host, null);
    assert.equal(r.grace, true);
  });

  it('narrows the moment the operator chooses, and the choice is what clears the grace', () => {
    const r = resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: false });
    assert.equal(r.host, LOOPBACK);
    assert.equal(r.grace, false);
  });

  it('narrows when the install moves behind the gate, with the lock already in front', () => {
    // Moving to caddy mode is the safe narrowing path: Caddy fronts the socket,
    // so loopback costs the operator nothing and the gate is what they reach.
    const r = resolveBind({ ingressMode: 'caddy', [OPT_IN_KEY]: null });
    assert.equal(r.host, LOOPBACK);
    assert.equal(r.reason, 'caddy');
    assert.equal(r.grace, false, 'behind the gate there is nothing to grant grace for');
  });

  it('does not call the recorded "never chosen" value malformed', () => {
    assert.equal(resolveBind({ ingressMode: 'direct', [OPT_IN_KEY]: null }).malformedOptIn, false);
  });
});

describe('describeBindState — the caddy lock, asserted directly', () => {
  it('reports lockedByCaddy for a caddy install', () => {
    // The UI's disabled attribute and its whole locked branch hang off this
    // single boolean, and nothing asserted it was ever true.
    const s = bindPolicy.describeBindState({ ingressMode: 'caddy', [OPT_IN_KEY]: false });
    assert.equal(s.lockedByCaddy, true);
    assert.equal(s.wide, false, 'caddy pins loopback');
    assert.equal(s.refusedOptIn, false);
  });

  it('reports lockedByCaddy AND refusedOptIn when caddy overrides a stored opt-in', () => {
    const s = bindPolicy.describeBindState({ ingressMode: 'caddy', [OPT_IN_KEY]: true });
    assert.equal(s.lockedByCaddy, true);
    assert.equal(s.refusedOptIn, true, 'the override must be reportable');
    assert.equal(s.choice, 'opted-in', 'what the operator RECORDED');
    assert.equal(s.wide, false, 'what the SOCKET does — deliberately different');
  });

  it('never reports lockedByCaddy in direct mode', () => {
    for (const v of [true, false, null, undefined]) {
      assert.equal(bindPolicy.describeBindState({ ingressMode: 'direct', [OPT_IN_KEY]: v }).lockedByCaddy, false);
    }
  });
});

describe('bind-policy.migrateLegacyBind — the grace state must survive an unrelated save', () => {
  it('records null for a legacy direct install', () => {
    const cfg = { ingressMode: 'direct' };
    const r = migrateLegacyBind(cfg, false);
    assert.equal(r.migrated, true);
    assert.equal(cfg[OPT_IN_KEY], null, 'the caller persists this');
  });

  it('does nothing when the key is already recorded', () => {
    const cfg = { ingressMode: 'direct', [OPT_IN_KEY]: false };
    assert.equal(migrateLegacyBind(cfg, true).migrated, false);
    assert.equal(cfg[OPT_IN_KEY], false, 'an existing choice must never be overwritten');
  });

  it('does not grant grace to a caddy install, which never bound wide', () => {
    const cfg = { ingressMode: 'caddy' };
    assert.equal(migrateLegacyBind(cfg, false).migrated, false);
    assert.equal(cfg[OPT_IN_KEY], undefined);
  });

  it('survives the defaults-merge/whole-object-save round trip that PATCH performs', () => {
    // The bug this exists to prevent: `PATCH /api/config` loads the config
    // defaults-merged and saves the WHOLE object, so an install identified only
    // by the key's ABSENCE silently becomes `false` the first time the operator
    // changes the theme — and gets cut off on the next restart having never
    // chosen. A recorded null round-trips instead.
    const DEFAULTS = { ingressMode: 'direct', theme: 'dark', [OPT_IN_KEY]: false };

    const legacyFile = { ingressMode: 'direct', theme: 'dark' }; // pre-setting install
    const booted = { ...DEFAULTS, ...legacyFile };
    migrateLegacyBind(booted, Object.prototype.hasOwnProperty.call(legacyFile, OPT_IN_KEY));

    // Now simulate PATCH: load (defaults-merged over the SAVED file) then save.
    const savedFile = JSON.parse(JSON.stringify(booted));
    const reloaded = { ...DEFAULTS, ...savedFile };
    reloaded.theme = 'light';
    const savedAgain = JSON.parse(JSON.stringify(reloaded));

    assert.equal(savedAgain[OPT_IN_KEY], null,
      'an unrelated setting change must not end the grace period');
    assert.equal(resolveBind(savedAgain).grace, true);
    assert.equal(resolveBind(savedAgain).host, null,
      'the operator must still be reachable after changing their theme');
  });
});

describe('bind-policy.describeNarrowing — who gets told', () => {
  it('warns a direct-mode install whose config predates the key', () => {
    const notice = describeNarrowing({ ingressMode: 'direct', [OPT_IN_KEY]: null });
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
    const notice = describeNarrowing({ ingressMode: 'direct', [OPT_IN_KEY]: null });
    assert.match(notice.message, /reachable from your whole network/i);
    assert.doesNotMatch(notice.message, /now listens on 127\.0\.0\.1 only/i);
  });

  it('stays silent once the operator has set the key either way', () => {
    assert.equal(describeNarrowing({ ingressMode: 'direct', [OPT_IN_KEY]: false }), null);
    assert.equal(describeNarrowing({ ingressMode: 'direct', [OPT_IN_KEY]: true }), null);
  });

  it('stays silent for caddy mode, which already bound loopback', () => {
    assert.equal(describeNarrowing({ ingressMode: 'caddy', [OPT_IN_KEY]: null }), null);
  });

  it('points at the login gate rather than only at the way to reopen the door', () => {
    // The notice has to offer the safe way to keep remote access, or it reads
    // as "set this flag to get your dashboard back" and every affected operator
    // lands straight back in the exposed state this change exists to close.
    const notice = describeNarrowing({ ingressMode: 'direct', [OPT_IN_KEY]: null });
    assert.match(notice.message, /login gate/i);
  });
});
