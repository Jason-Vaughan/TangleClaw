'use strict';

/*
 * #1904 — a private temp root for an engine's native sockets.
 *
 * Claude refuses a socket directory that another local user could tamper with,
 * so a `/tmp` without its sticky bit switched native messaging off in every
 * pane TangleClaw launched. These tests pin the root TangleClaw hands over
 * instead: provisioned 0700, vetted the way the engine vets it, never handed
 * over when it fails, and never repaired by changing a directory TangleClaw
 * does not own.
 *
 * Real directories carry every state an ordinary user can create (0777, 1777,
 * 0770, symlinks, a long path). A root-owned or foreign-owned directory cannot
 * be made without privileges, so those go through the module's seams.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tempRoot = require('../lib/engine-temp-root');

const CLAUDE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'claude.json'), 'utf8'));

/**
 * A profile carrying Claude's declaration and the given launch env.
 * @param {object} [launchEnv] - `launch.env` for the profile.
 * @returns {object} Profile.
 */
function claudeProfile(launchEnv = {}) {
  return { id: 'claude', capabilities: { privateTempRoot: { ...CLAUDE.capabilities.privateTempRoot } }, launch: { env: launchEnv } };
}

/**
 * The permission bits of a path, sticky bit included.
 * @param {string} p - Path.
 * @returns {number} Mode bits.
 */
function modeOf(p) {
  return fs.lstatSync(p).mode & 0o7777;
}

/*
 * Real-filesystem fixtures live under /tmp, not os.tmpdir(). The socket path is
 * capped at 103 bytes and macOS's per-user temp directory
 * (/private/var/folders/<..>/T/) is already too long to fit, which the module
 * correctly refuses. On a host whose own /tmp is unsafe (the host #1904
 * describes), every fixture would inherit that ancestor as the first failure,
 * so the real-filesystem cases skip there and the seam-driven cases below still
 * cover the logic.
 */
const FIXTURE_ROOT = fs.realpathSync('/tmp');
const HOST_TMP_UNSAFE = tempRoot.vetAncestry(FIXTURE_ROOT, tempRoot._defaultDeps());
const realFs = HOST_TMP_UNSAFE
  ? { skip: `this host's ${HOST_TMP_UNSAFE.path} is ${HOST_TMP_UNSAFE.problem}, so it would be every fixture's first failure` }
  : {};

let scratch;

beforeEach(() => {
  if (HOST_TMP_UNSAFE) return;
  scratch = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'tctr-'));
});

afterEach(() => {
  if (!scratch) return;
  fs.chmodSync(scratch, 0o700);
  fs.rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe('Claude declares a private temp root (#1904)', () => {
  it('names the variable, the socket suffix and the byte cap the binary uses', () => {
    const decl = tempRoot.declaration(CLAUDE);
    assert.ok(decl, 'claude.json must declare capabilities.privateTempRoot');
    assert.equal(decl.env, 'CLAUDE_CODE_TMPDIR');
    assert.equal(decl.maxSocketPathBytes, 103);
    assert.match(decl.socketSuffix, /^cc-socks\/\d+\.sock$/);
    assert.equal(decl.defaultRoot, '/tmp');
  });

  it('ignores a declaration missing a field it needs, rather than guessing', () => {
    assert.equal(tempRoot.declaration({ capabilities: { privateTempRoot: { env: 'X_TMP', socketSuffix: 's.sock' } } }), null);
    assert.equal(tempRoot.declaration({ capabilities: { privateTempRoot: { env: 'lower case', socketSuffix: 's', maxSocketPathBytes: 10 } } }), null);
    assert.equal(tempRoot.declaration({ capabilities: {} }), null);
    assert.equal(tempRoot.declaration(null), null);
  });
});

describe('resolve — the root is provisioned and handed over', realFs, () => {
  it('creates <base>/run/claude-tmp at 0700 and exports its real path', () => {
    const base = path.join(scratch, 'home');
    fs.mkdirSync(base, { mode: 0o700 });
    const r = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile(), baseDir: base, env: {} });
    assert.equal(r.state, 'applied', JSON.stringify(r));
    assert.equal(r.dir, path.join(base, 'run', 'claude-tmp'));
    assert.deepEqual(r.env, { CLAUDE_CODE_TMPDIR: r.dir });
    assert.equal(modeOf(r.dir), 0o700);
  });

  it('is idempotent across launches', () => {
    const base = path.join(scratch, 'home');
    fs.mkdirSync(base, { mode: 0o700 });
    const first = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile(), baseDir: base, env: {} });
    const second = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile(), baseDir: base, env: {} });
    assert.equal(second.state, 'applied');
    assert.equal(second.dir, first.dir);
  });

  it('tightens its own leaf back to 0700 when an older run left it wider', () => {
    const base = path.join(scratch, 'home');
    fs.mkdirSync(path.join(base, 'run', 'claude-tmp'), { recursive: true });
    fs.chmodSync(path.join(base, 'run', 'claude-tmp'), 0o755);
    const r = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile(), baseDir: base, env: {} });
    assert.equal(r.state, 'applied');
    assert.equal(modeOf(r.dir), 0o700);
  });

  it('works under a sticky 1777 shared ancestor, the normal /tmp shape', () => {
    const shared = path.join(scratch, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o1777);
    const r = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile(), baseDir: path.join(shared, 'base'), env: {} });
    assert.equal(r.state, 'applied', JSON.stringify(r));
    assert.equal(modeOf(shared), 0o1777, 'the shared ancestor is untouched');
  });

  it('does nothing for an engine that declares no root', () => {
    const base = path.join(scratch, 'home');
    fs.mkdirSync(base);
    const r = tempRoot.resolve({ engineId: 'aider', profile: { capabilities: {} }, baseDir: base, env: {} });
    assert.deepEqual(r, { state: 'not-declared', env: {} });
    assert.equal(fs.existsSync(path.join(base, 'run')), false, 'nothing is created');
  });
});

describe('resolve — the operator\'s own setting wins', realFs, () => {
  it('provisions nothing when the profile\'s launch.env names the variable', () => {
    const base = path.join(scratch, 'home');
    fs.mkdirSync(base);
    const r = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile({ CLAUDE_CODE_TMPDIR: '/opt/mine' }), baseDir: base, env: {} });
    assert.equal(r.state, 'operator-set');
    assert.deepEqual(r.env, {});
    assert.equal(fs.existsSync(path.join(base, 'run')), false);
  });

  it('provisions nothing when TangleClaw\'s own environment names it', () => {
    const base = path.join(scratch, 'home');
    fs.mkdirSync(base);
    const r = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile(), baseDir: base, env: { CLAUDE_CODE_TMPDIR: '/opt/mine' } });
    assert.equal(r.state, 'operator-set');
    assert.deepEqual(r.env, {});
  });
});

describe('resolve — an unsafe root fails closed, and nothing outside TangleClaw is repaired', realFs, () => {
  it('refuses a 0777 ancestor without the sticky bit, names it, and leaves its mode alone', () => {
    const shared = path.join(scratch, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o777);
    const r = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile(), baseDir: path.join(shared, 'base'), env: {} });
    assert.equal(r.state, 'refused');
    assert.deepEqual(r.env, {}, 'an unvetted root is never handed to the engine');
    assert.equal(r.failure.path, shared);
    assert.equal(r.failure.problem, 'world-writable');
    assert.match(r.remediation, new RegExp(`chmod \\+t ${shared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(r.remediation, /sudo/, 'the operator owns this directory, so no sudo');
    assert.equal(modeOf(shared), 0o777, 'TangleClaw never changes a directory it does not own');
  });

  it('refuses a group-writable ancestor without the sticky bit', () => {
    const shared = path.join(scratch, 'team');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o770);
    const r = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile(), baseDir: path.join(shared, 'base'), env: {} });
    assert.equal(r.state, 'refused');
    assert.equal(r.failure.problem, 'group-writable');
    assert.match(r.remediation, /chmod g-w/);
    assert.equal(modeOf(shared), 0o770);
  });

  it('refuses a symlinked leaf and does not follow it', () => {
    const base = path.join(scratch, 'home');
    const elsewhere = path.join(scratch, 'elsewhere');
    fs.mkdirSync(path.join(base, 'run'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(elsewhere, { mode: 0o755 });
    fs.symlinkSync(elsewhere, path.join(base, 'run', 'claude-tmp'));
    const r = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile(), baseDir: base, env: {} });
    assert.equal(r.state, 'refused');
    assert.equal(r.failure.problem, 'symlink');
    assert.equal(r.failure.path, path.join(base, 'run', 'claude-tmp'));
    assert.equal(modeOf(elsewhere), 0o755, 'the link target is not tightened');
  });

  it('refuses a symlinked run directory before creating anything through it', () => {
    const base = path.join(scratch, 'home');
    const elsewhere = path.join(scratch, 'elsewhere');
    fs.mkdirSync(base);
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(base, 'run'));
    const r = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile(), baseDir: base, env: {} });
    assert.equal(r.state, 'refused');
    assert.equal(r.failure.problem, 'symlink');
    assert.equal(fs.existsSync(path.join(elsewhere, 'claude-tmp')), false, 'no leaf appears in the link target');
  });

  it('refuses a root whose socket path would exceed the Unix-socket cap', () => {
    // Deep enough that <root>/cc-socks/<widest pid>.sock passes 103 bytes.
    let base = scratch;
    while (Buffer.byteLength(path.join(base, 'run', 'claude-tmp', 'cc-socks', '4194304.sock')) <= 103) {
      base = path.join(base, 'deeper-directory');
    }
    const r = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile(), baseDir: base, env: {} });
    assert.equal(r.state, 'refused');
    assert.equal(r.failure.problem, 'too-long');
    assert.ok(r.failure.bytes > 103);
    assert.match(r.remediation, /TANGLECLAW_HOME/);
    assert.deepEqual(r.env, {});
  });

  it('accepts a root exactly at the cap', (t) => {
    // Pad one directory name so the socket path lands on 103 bytes exactly.
    const probe = path.join(scratch, 'X', 'run', 'claude-tmp', 'cc-socks', '4194304.sock');
    const pad = 103 - Buffer.byteLength(probe) + 1;
    if (pad < 1) {
      t.skip(`the fixture root alone is already ${Buffer.byteLength(probe) - 1} bytes on this host`);
      return;
    }
    const base = path.join(scratch, 'X'.repeat(pad));
    const r = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile(), baseDir: base, env: {} });
    assert.equal(Buffer.byteLength(path.join(base, 'run', 'claude-tmp', 'cc-socks', '4194304.sock')), 103);
    assert.equal(r.state, 'applied', JSON.stringify(r));
  });

  it('refuses a relative base directory instead of creating state under the cwd', () => {
    const r = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile(), baseDir: '.tangleclaw', env: {} });
    assert.equal(r.state, 'refused');
    assert.deepEqual(r.env, {});
  });
});

/**
 * Seams over a fake tree, for ownership states an ordinary user cannot create.
 * Every path not in `tree` is a root-owned 0755 directory.
 * @param {object} tree - `{ path: {uid, mode, link?} }`.
 * @param {object} [opts] - `{uid, realpaths}`.
 * @returns {object} Deps for `resolve` and `vetAncestry`.
 */
function fakeDeps(tree, { uid = 501, realpaths = {} } = {}) {
  const chmods = [];
  const stat = (p) => {
    const e = tree[p] || { uid: 0, mode: 0o755 };
    return {
      uid: e.uid,
      mode: e.mode | (e.link ? 0o120000 : 0o040000),
      isDirectory: () => !e.link && !e.file,
      isSymbolicLink: () => !!e.link
    };
  };
  return {
    uid,
    chmods,
    lstat: stat,
    realpath: (p) => realpaths[p] || p,
    mkdir: () => {},
    chmod: (p, m) => { chmods.push([p, m]); }
  };
}

describe('the default root is judged too, so a refusal says whether the engine will manage alone', () => {
  it('names a root-owned 0777 /private/tmp and gives a sudo fix it does not run', () => {
    const deps = fakeDeps({
      '/private/tmp': { uid: 0, mode: 0o777 },
      '/Users/op': { uid: 501, mode: 0o755 },
      '/Users/op/.tangleclaw': { uid: 777, mode: 0o700 },
      '/Users/op/.tangleclaw/run': { uid: 501, mode: 0o700 },
      '/Users/op/.tangleclaw/run/claude-tmp': { uid: 501, mode: 0o700 }
    }, { realpaths: { '/tmp': '/private/tmp' } });
    const r = tempRoot.resolve({ engineId: 'claude', profile: claudeProfile(), baseDir: '/Users/op/.tangleclaw', env: {}, deps });
    assert.equal(r.state, 'refused');
    assert.equal(r.failure.problem, 'foreign-owner');
    assert.equal(r.failure.path, '/Users/op/.tangleclaw');
    assert.equal(r.defaultRoot.path, '/private/tmp');
    assert.equal(r.defaultRoot.failure.problem, 'world-writable');
    assert.equal(r.defaultRoot.remediation.includes('sudo chmod +t /private/tmp'), true, r.defaultRoot.remediation);
    assert.deepEqual(deps.chmods, [], 'TangleClaw changes no mode outside its own leaf');
  });

  it('reports a sticky 1777 /private/tmp as usable', () => {
    const deps = fakeDeps({ '/private/tmp': { uid: 0, mode: 0o1777 } }, { realpaths: { '/tmp': '/private/tmp' } });
    const verdict = tempRoot.checkDefaultRoot(CLAUDE.capabilities.privateTempRoot, {}, deps);
    assert.equal(verdict.path, '/private/tmp');
    assert.equal(verdict.failure, null);
    assert.equal(verdict.remediation, null);
  });

  it('judges XDG_RUNTIME_DIR instead of /tmp when it is set, as the engine does', () => {
    const deps = fakeDeps({ '/run/user/501': { uid: 501, mode: 0o700 }, '/tmp': { uid: 0, mode: 0o777 } });
    const verdict = tempRoot.checkDefaultRoot(CLAUDE.capabilities.privateTempRoot, { XDG_RUNTIME_DIR: '/run/user/501' }, deps);
    assert.equal(verdict.path, '/run/user/501');
    assert.equal(verdict.failure, null);
  });
});

describe('vetAncestry mirrors the engine\'s rule', () => {
  it('accepts root- and self-owned components, and sticky shared ones', () => {
    const deps = fakeDeps({ '/a': { uid: 0, mode: 0o1777 }, '/a/b': { uid: 501, mode: 0o700 } });
    assert.equal(tempRoot.vetAncestry('/a/b', deps), null);
  });

  it('names the HIGHEST failing ancestor, the one the operator has to fix', () => {
    const deps = fakeDeps({ '/a': { uid: 0, mode: 0o777 }, '/a/b': { uid: 501, mode: 0o777 } });
    assert.equal(tempRoot.vetAncestry('/a/b', deps).path, '/a');
  });

  it('refuses a component owned by another user', () => {
    const deps = fakeDeps({ '/a': { uid: 502, mode: 0o755 } });
    const f = tempRoot.vetAncestry('/a/b', deps);
    assert.equal(f.problem, 'foreign-owner');
    assert.equal(f.uid, 502);
  });

  it('refuses a component that is not a directory', () => {
    const deps = fakeDeps({ '/a': { uid: 501, mode: 0o644, file: true } });
    assert.equal(tempRoot.vetAncestry('/a/b', deps).problem, 'not-directory');
  });

  it('reports an unreadable component instead of throwing', () => {
    const deps = fakeDeps({});
    deps.lstat = (p) => {
      if (p === '/a') { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
      return { uid: 0, mode: 0o040755, isDirectory: () => true, isSymbolicLink: () => false };
    };
    const f = tempRoot.vetAncestry('/a/b', deps);
    assert.equal(f.problem, 'unreadable');
    assert.equal(f.code, 'EACCES');
  });
});
