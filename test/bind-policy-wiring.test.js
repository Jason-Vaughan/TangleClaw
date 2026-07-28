'use strict';

/*
 * #710 slice 1 — the wiring around lib/bind-policy.js.
 *
 * The policy module is tested exhaustively in bind-policy.test.js. What is
 * asserted here is that the rest of the system actually REACHES it, because a
 * correct policy nobody consults protects nothing:
 *
 *   - server.js resolves the bind through the policy rather than re-deriving it
 *     from ingressMode, which is what it did before and what would silently
 *     restore the wide default if someone "simplified" the call away.
 *   - the config key is settable through PATCH /api/config, is boolean-guarded,
 *     and forces a restart (the bind is chosen once, at listen time).
 *   - store.config.isKeyPersisted distinguishes an absent key from a defaulted
 *     one — the whole upgrade notice hangs off that distinction.
 *   - the notice reaches the browser through /api/server-info.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bindPolicy = require('../lib/bind-policy');
const serverInfo = require('../lib/server-info');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const STORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.js'), 'utf8');

describe('server.js binds through the policy, not around it', () => {
  it('calls bindPolicy.resolveBind for the listen host', () => {
    assert.match(SERVER_SRC, /bindPolicy\.resolveBind\(config\)/,
      'the bind host must come from the policy module');
  });

  it('records the legacy grace state BEFORE anything reads the binding', () => {
    // The key's absence identifies a legacy install exactly once — the next
    // config save of any kind materializes the default and erases it. So the
    // migration must run, and be persisted, ahead of resolveBind.
    // Anchored to the BOOT call specifically. There is a second
    // migrateLegacyBind() in the PATCH handler, far earlier in the file, and a
    // bare indexOf('bindPolicy.migrateLegacyBind(') silently retargets onto it —
    // which disarms this guard entirely while the assertion text still reads
    // correct. That happened; this anchor is the fix.
    const migrateAt = SERVER_SRC.indexOf('const legacyBind = bindPolicy.migrateLegacyBind(');
    const resolveAt = SERVER_SRC.indexOf('bindPolicy.resolveBind(config)');
    assert.ok(migrateAt > -1, 'the boot migration call must exist under its own name');
    assert.ok(resolveAt > migrateAt,
      'migrate must precede resolve, or the first boot narrows a legacy install');
    assert.match(SERVER_SRC, /if \(legacyBind\.migrated\)[\s\S]{0,200}?store\.config\.save\(config\)/,
      'the recorded state must be persisted, not just held in memory');
  });

  it('re-asserts the grace state in the config PATCH path too', () => {
    // If the boot-time persist ever fails (read-only disk, permissions), the key
    // is still absent when PATCH loads — and load()'s defaults merge would make
    // the next save write `false`, narrowing a remote install nobody decided
    // about. Deleting that call must not leave the suite green.
    const patchAt = SERVER_SRC.indexOf('const config = store.config.load();\n  // Re-assert the legacy grace state');
    assert.ok(patchAt > -1, 'the PATCH handler must re-assert the grace state before saving');
    const migrateAfter = SERVER_SRC.indexOf('bindPolicy.migrateLegacyBind(', patchAt);
    const allowedAfter = SERVER_SRC.indexOf('const allowedFields = [', patchAt);
    assert.ok(migrateAfter > -1 && migrateAfter < allowedAfter,
      'it must run before the patch loop, so an explicit choice in the body still wins');
  });

  it('no longer derives the bind host from ingressMode inline', () => {
    // The exact expression this change replaced. Its return would silently
    // reinstate "every interface unless Caddy", which is the vulnerability.
    assert.doesNotMatch(SERVER_SRC, /const bindHost = caddyMode \? '127\.0\.0\.1' : null/,
      'the old inline bind derivation must not come back');
  });

  it('logs the refusal when caddy mode overrides an opt-in', () => {
    assert.match(SERVER_SRC, /bind\.refusedOptIn/,
      'a refused opt-in must be surfaced, not silently dropped');
  });

  it('logs a malformed opt-in too', () => {
    // Same shape as the refusal above, same reason: the operator who typed
    // "true" as a string believes the door is open. Without this assertion the
    // whole log branch can be deleted and the suite stays green.
    assert.match(SERVER_SRC, /bind\.malformedOptIn/,
      'a malformed opt-in must be surfaced, not silently read as false');
  });

  it('publishes the narrowing notice to the browser-facing endpoint', () => {
    assert.match(SERVER_SRC, /serverInfo\.setBindNotice\(bindNotice\)/);
  });

  it('seeds the default config before deciding whether to show the notice', () => {
    // store.init() writes DEFAULT_CONFIG when the file is missing, which
    // materializes bindAllInterfaces. If the notice were computed first, every
    // brand-new install would be told its binding narrowed — it did not; the
    // install never had a wide one. The ordering is the only thing preventing
    // that, so it is pinned rather than left to reading order.
    const initAt = SERVER_SRC.indexOf('store.init()');
    const noticeAt = SERVER_SRC.indexOf('bindPolicy.describeNarrowing(');
    assert.ok(initAt > -1 && noticeAt > -1, 'both call sites should exist');
    assert.ok(initAt < noticeAt,
      'store.init() must run before the narrowing check, or fresh installs get a false notice');
  });
});

describe('PATCH /api/config accepts the opt-out setting', () => {
  it('lists bindAllInterfaces as an allowed field', () => {
    const allowed = SERVER_SRC.slice(
      SERVER_SRC.indexOf('const allowedFields = ['),
      SERVER_SRC.indexOf('];', SERVER_SRC.indexOf('const allowedFields = ['))
    );
    assert.match(allowed, /'bindAllInterfaces'/,
      'an unlisted field is silently dropped by the PATCH loop');
  });

  it('rejects a non-boolean value', () => {
    assert.match(SERVER_SRC, /key === 'bindAllInterfaces' && typeof value !== 'boolean'/);
  });

  it('marks the change as requiring a restart', () => {
    // The socket is bound once at listen time, so a live PATCH cannot move it.
    // Reporting otherwise would tell the operator they are exposed (or safe)
    // when the running process still says the opposite.
    const restartLine = SERVER_SRC.split('\n').find(
      (l) => l.includes('requiresRestart = true') && l.includes('config[key] !== storedValue')
    );
    const guard = SERVER_SRC.split('\n').find(
      (l) => l.includes("key === 'ingressMode'") && l.includes("key === 'serverPort'")
    );
    assert.ok(restartLine, 'the requiresRestart assignment should still exist');
    assert.match(guard, /key === 'bindAllInterfaces'/);
  });
});

describe('store.config.isKeyPersisted — absent key vs defaulted key', () => {
  let tmpDir;
  let store;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bind-test-'));
    store = require('../lib/store');
    store._setBasePath(tmpDir);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports false for a config file written before the key existed', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'),
      JSON.stringify({ serverPort: 3101, ingressMode: 'direct' }));
    assert.equal(store.config.isKeyPersisted('bindAllInterfaces'), false);
    // load() still hands back the default, which is exactly why the raw read
    // is needed — the merged view cannot tell these two installs apart.
    assert.equal(store.config.load().bindAllInterfaces, false);
  });

  it('reports true once the operator has stored a choice — either choice', () => {
    for (const chosen of [true, false]) {
      fs.writeFileSync(path.join(tmpDir, 'config.json'),
        JSON.stringify({ ingressMode: 'direct', bindAllInterfaces: chosen }));
      assert.equal(store.config.isKeyPersisted('bindAllInterfaces'), true,
        `an explicit ${chosen} is still a choice, and must silence the notice`);
    }
  });

  it('reports false for a malformed config rather than assuming a choice', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{ not json');
    assert.equal(store.config.isKeyPersisted('bindAllInterfaces'), false);
  });

  it('reports false when there is no config file at all', () => {
    fs.rmSync(path.join(tmpDir, 'config.json'), { force: true });
    assert.equal(store.config.isKeyPersisted('bindAllInterfaces'), false);
  });
});

describe('the default ships as loopback', () => {
  it('DEFAULT_CONFIG.bindAllInterfaces is false', () => {
    assert.match(STORE_SRC, /bindAllInterfaces: false/,
      'the shipped default must be the safe one');
  });

  it('a fresh install persists the key, so it is never placed in the grace state', () => {
    // Setup writes the defaults-merged config, so the key materializes on any
    // new install — which is what keeps the upgrade notice aimed only at
    // installs that actually changed behavior.
    const store = require('../lib/store');
    assert.equal(store.DEFAULT_CONFIG.bindAllInterfaces, false);
    assert.equal(
      bindPolicy.describeNarrowing({ ingressMode: 'direct', bindAllInterfaces: false }),
      null
    );
  });
});

describe('both shell-capable listeners follow the same opt-in', () => {
  const CUTOVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ingress-cutover.js'), 'utf8');

  it('rolls back to direct mode without reopening the terminal to the network', () => {
    // The rollback path used to fill the bind pair with `--port <n>` and no
    // interface, which binds every interface — so cutting back to direct mode
    // silently republished an unauthenticated writable shell.
    assert.match(CUTOVER_SRC, /const ttydBindAddress = '127\.0\.0\.1'/);
    assert.match(CUTOVER_SRC, /TTYD_BIND_KEY: '--interface', TTYD_BIND_VAL: ttydBindAddress/);
    assert.doesNotMatch(CUTOVER_SRC, /TTYD_BIND_KEY: '--port'/,
      'a port-only ttyd bind is a wide bind');
  });

  it('does NOT let the dashboard opt-in drag the terminal port open with it', () => {
    // ttyd is pinned unconditionally: nothing addresses it directly, so widening
    // it grants nothing the operator asked for. Coupling the two meant any path
    // that set bindAllInterfaces:true re-opened the shell on the next restart.
    assert.doesNotMatch(CUTOVER_SRC, /ttydBindAddress = config\.bindAllInterfaces/,
      'the terminal bind must not read the dashboard opt-in');
  });
});

describe('the settings toggle cannot lie about what the socket does', () => {
  const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');

  it('re-derives nothing — the frontend reads the server\'s classification', () => {
    // The structural cause of three separate defects in this chunk was two
    // copies of these rules disagreeing. There is one copy now, server-side.
    const modal = UI_SRC.slice(UI_SRC.indexOf('const bindState = c.bindState'),
      UI_SRC.indexOf('gs-section-label">Diagnostics'));
    assert.doesNotMatch(modal, /c\.bindAllInterfaces/,
      'the settings modal must not read the raw key');
    assert.doesNotMatch(modal, /c\.ingressMode === 'caddy'/,
      'nor re-test the ingress mode');
  });

  it('locks the control in caddy mode, where the server refuses the opt-in', () => {
    assert.match(UI_SRC, /const bindLockedByCaddy = !!bindState\.lockedByCaddy;/,
      'the lock is the server\'s call, not a frontend re-test of ingressMode');
    assert.match(UI_SRC, /gsBindAllInterfaces[\s\S]{0,200}?bindLockedByCaddy \? 'disabled' : ''/,
      'an editable toggle here would save a value the socket never honors');
  });

  it('omits the field from the PATCH when the control is locked', () => {
    // Sending it anyway would round-trip a value the operator could not have
    // chosen, and make the stored config disagree with the running socket.
    assert.match(UI_SRC, /if \(bindToggle && !bindToggle\.disabled\) \{/);
  });

  it('sends the bind field ONLY when the operator moved the switch', () => {
    // The regression that made this necessary: a grace-state install renders the
    // switch ON (truthfully — it IS bound wide), so posting `.checked` on every
    // save recorded an explicit opt-in the first time the operator changed their
    // theme. That silenced the exposure warning permanently and, while ttyd still
    // followed the same key, re-opened the terminal port on the next restart.
    assert.match(UI_SRC, /data-rendered="\$\{bindShowsOn \? '1' : '0'\}"/,
      'the rendered state must be recorded so the save can compare against it');
    assert.match(UI_SRC, /const renderedOn = bindToggle\.dataset\.rendered === '1';/);
    assert.match(UI_SRC, /if \(bindToggle\.checked !== renderedOn\) patch\.bindAllInterfaces = bindToggle\.checked;/,
      'an untouched switch must contribute nothing to the patch');
  });

  it('does not also set the field unconditionally in the patch literal', () => {
    // Without this, the guarded assignment above can be defeated silently:
    // re-adding bindAllInterfaces to the base literal restores the locked-mode
    // write and leaves the positive assertion perfectly green.
    const literal = UI_SRC.slice(
      UI_SRC.indexOf('const patch = {'),
      UI_SRC.indexOf('};', UI_SRC.indexOf('const patch = {'))
    );
    assert.ok(literal.length > 0, 'the patch literal should be findable');
    assert.doesNotMatch(literal, /bindAllInterfaces/,
      'the field must reach the patch only through the disabled-guarded assignment');
  });

  it('renders the toggle ON for an install still in the grace state', () => {
    // The dangerous direction of the same lie: a legacy install is still bound
    // wide on purpose, so a switch reading OFF beside "Accept connections from
    // the network" would tell the operator the door is shut while it is open.
    assert.match(UI_SRC, /const bindShowsOn = !!bindState\.wide;/,
      'the switch must follow the socket, which the server reports');
    assert.match(UI_SRC, /const bindUnchosen = bindState\.choice === 'unchosen';/);
  });

  it('gives a grace install a one-click route to a recorded "keep it open"', () => {
    // Without this the UI can only ever produce `false`: a grace install renders
    // the switch already ON, so it is never "moved" and the save omits the field
    // — while README and the CHANGELOG both advertise this screen as the way to
    // reach `true`. Toggling off, saving, then back on would work, but between
    // the two saves the install is set to narrow at the next restart, which
    // strands the remote operator the grace state exists to protect.
    assert.match(UI_SRC, /id="gsBindKeepOpen"/, 'the affordance must exist');
    assert.match(UI_SRC, /\$\{bindUnchosen && !bindLockedByCaddy \?/,
      'it must appear only for an install that has not chosen, and never when locked');
    assert.match(UI_SRC, /apiMutate\('\/api\/config', 'PATCH', \{ bindAllInterfaces: true \}\)/,
      'one deliberate click writes the choice directly — no intermediate state');
  });

  it('renders the toggle OFF whenever caddy mode has pinned loopback', () => {
    // The one combination that reads as a lie: config says true, socket says
    // loopback. The switch must follow the socket, not the stored value.
    assert.match(UI_SRC, /const bindLockedByCaddy = !!bindState\.lockedByCaddy;/,
      'the lock is the server\'s call, not a frontend re-test of ingressMode');
    assert.match(UI_SRC, /\$\{bindShowsOn \? 'checked' : ''\}/,
      'the checked attribute must derive from the effective state, not the raw config');
  });

  it('marks the locked control as disabled for assistive tech, not just visually', () => {
    assert.match(UI_SRC, /aria-disabled="true"/);
  });

  it('scopes the locked styling to an opt-in modifier, so it cannot grey out other toggles', () => {
    // `.gs-toggle-label` is shared. The wrap "Next action" toggle is rendered
    // checked AND disabled because it is mandatory, so styling on bare
    // `input:disabled` would paint a permanently-ON required control as off.
    const CSS_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    assert.match(CSS_SRC, /\.gs-toggle-label\.gs-toggle-locked \{/,
      'the locked treatment must be keyed to an explicit modifier');
    assert.doesNotMatch(CSS_SRC, /\.gs-toggle-label:has\(input:disabled\)/,
      'a blanket disabled selector leaks onto every disabled toggle in the modal');
    // Unanchored on purpose: a `^`-anchored guard is defeated by one leading
    // space, so the exact selector just removed could return indented — inside
    // a media query or a nesting block — and the guard would stay green.
    assert.doesNotMatch(CSS_SRC, /(^|\s)\.gs-toggle-label input:disabled/m,
      'the sibling rule must also be scoped to the modifier');
    assert.match(UI_SRC, /gs-toggle-label\$\{bindLockedByCaddy \? ' gs-toggle-locked' : ''\}/,
      'the modifier must actually be applied when locked');
  });

  it('still renders the mandatory wrap toggle as checked+disabled (the control that must not regress)', () => {
    assert.match(UI_SRC, /\$\{checked \? 'checked' : ''\} \$\{isNextAction \? 'disabled' : ''\}/,
      'if this shape changes, re-check that the locked styling still does not reach it');
  });
});

describe('a refused ttyd re-pin reaches the dashboard, not only the log', () => {
  it('round-trips a terminal notice through /api/server-info', () => {
    const notice = { message: 'terminal still open', setting: 'ttyd interface', severity: 'exposed' };
    serverInfo.setTtydNotice(notice);
    assert.deepEqual(serverInfo.getServerInfo().ttydNotice, notice);
    serverInfo.setTtydNotice(null);
    assert.equal(serverInfo.getServerInfo().ttydNotice, null);
  });

  it('raises it ONLY when the refusal left the job wide', () => {
    // Refusing is frequently correct and harmless — a unix-socket job is
    // unreachable regardless. Warning on every refusal would cry wolf; warning
    // on none would leave an unauthenticated shell announced only in a log file.
    assert.match(SERVER_SRC, /if \(ttydPlan\.stillWide\) \{[\s\S]{0,200}?serverInfo\.setTtydNotice\(/,
      'the notice must be gated on stillWide');
    const gateAt = SERVER_SRC.indexOf('if (ttydPlan.stillWide)');
    const refuseAt = SERVER_SRC.indexOf("ttydPlan.action === 'refuse'");
    assert.ok(refuseAt > -1 && gateAt > refuseAt,
      'and sit inside the refusal branch, not fire on a successful pin');
  });
});

describe('/api/server-info carries the notice', () => {
  it('round-trips a notice set at listen time', () => {
    const notice = { message: 'test notice', setting: 'bindAllInterfaces' };
    serverInfo.setBindNotice(notice);
    assert.deepEqual(serverInfo.getServerInfo().bindNotice, notice);
  });

  it('reports null when nothing narrowed', () => {
    serverInfo.setBindNotice(null);
    assert.equal(serverInfo.getServerInfo().bindNotice, null);
  });
});
