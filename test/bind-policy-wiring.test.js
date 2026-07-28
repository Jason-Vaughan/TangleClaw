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

  it('a fresh install persists the key, so it is never told its bind narrowed', () => {
    // Setup writes the defaults-merged config, so the key materializes on any
    // new install — which is what keeps the upgrade notice aimed only at
    // installs that actually changed behavior.
    const store = require('../lib/store');
    assert.equal(store.DEFAULT_CONFIG.bindAllInterfaces, false);
    assert.equal(
      bindPolicy.describeNarrowing({ ingressMode: 'direct' }, true),
      null
    );
  });
});

describe('the settings toggle cannot lie about what the socket does', () => {
  const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');

  it('locks the control in caddy mode, where the server refuses the opt-in', () => {
    assert.match(UI_SRC, /const bindLockedByCaddy = c\.ingressMode === 'caddy'/);
    assert.match(UI_SRC, /gsBindAllInterfaces[\s\S]{0,200}?bindLockedByCaddy \? 'disabled' : ''/,
      'an editable toggle here would save a value the socket never honors');
  });

  it('omits the field from the PATCH when the control is locked', () => {
    // Sending it anyway would round-trip a value the operator could not have
    // chosen, and make the stored config disagree with the running socket.
    assert.match(UI_SRC, /if \(bindToggle && !bindToggle\.disabled\) \{\s*patch\.bindAllInterfaces = bindToggle\.checked;/);
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

  it('renders the toggle OFF whenever caddy mode has pinned loopback', () => {
    // The one combination that reads as a lie: config says true, socket says
    // loopback. The switch must follow the socket, not the stored value.
    assert.match(UI_SRC, /const bindShowsOn = c\.bindAllInterfaces === true && !bindLockedByCaddy/);
    assert.match(UI_SRC, /\$\{bindShowsOn \? 'checked' : ''\}/,
      'the checked attribute must derive from the effective state, not the raw config');
  });

  it('marks the locked control as disabled for assistive tech, not just visually', () => {
    assert.match(UI_SRC, /aria-disabled="true"/);
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
