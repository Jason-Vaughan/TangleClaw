'use strict';

/*
 * `lib/checkout-layout.js` — where the primary checkout is, and which of its
 * worktrees a path belongs to (#798).
 *
 * The guard's own tests drive the happy paths end-to-end through a real
 * repository. These cover the answers that decide whether the guard REFUSES,
 * which is the direction that costs the operator a working session: a layout it
 * cannot read, a worktree record it cannot parse, and the shapes that must not
 * be mistaken for a worktree at all.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { initRepo } = require('./_temp-repo');
const {
  realOrSelf, locateCheckouts, linkedWorktreeRoots, landsInPrimary, OVERRIDE_FILE, OVERRIDE_ENV,
  resolveServerCheckoutRoot, describeServerRootCoupling, validateServerCheckoutRoot, SERVER_ROOT_ENV,
  renderLaunchdServerPlist, repointLaunchdServerPlist, repointSystemdServerUnit, provisionDedicatedServerCheckout, _runCli
} = require('../lib/checkout-layout');
const guardSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'guard-primary-checkout.js'), 'utf8');
const installerSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-primary-guard.js'), 'utf8');

describe('the override constants have exactly one spelling', () => {
  it('neither script re-declares them', () => {
    // Spelled twice, a rename in the guard would leave `--self-test` telling the
    // operator to delete a path that no longer exists — advice that reads
    // authoritative and does nothing. Neither script can import the other (the
    // guard attaches stdin handlers at load), so this module is the one thing
    // both already require.
    for (const [name, src] of [['guard', guardSource], ['installer', installerSource]]) {
      assert.doesNotMatch(src, /const OVERRIDE_FILE\s*=/, `${name} re-declares OVERRIDE_FILE`);
      assert.doesNotMatch(src, /const OVERRIDE_ENV\s*=/, `${name} re-declares OVERRIDE_ENV`);
      assert.match(src, /OVERRIDE_FILE/, `${name} should still use the shared constant`);
    }
    assert.equal(OVERRIDE_FILE, path.join('.prawduct', '.allow-primary-write'));
    assert.equal(OVERRIDE_ENV, 'TANGLECLAW_ALLOW_PRIMARY_WRITE');
  });
});

describe('locateCheckouts', () => {
  let base;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-layout-'))); });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('reports a real repository and its worktree, and agrees on the primary', () => {
    const primary = path.join(base, 'primary');
    fs.mkdirSync(primary);
    initRepo(primary, ['-b', 'main']);
    const git = (...a) => execFileSync('git', a, { cwd: primary, stdio: ['pipe', 'pipe', 'pipe'] });
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(primary, 'f.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const wt = path.join(primary, '.claude', 'worktrees', 'w');
    git('worktree', 'add', '-q', wt, '-b', 'b');

    assert.deepEqual(locateCheckouts(primary), { primary, isWorktree: false });
    // The same primary from either side, or the guard would compute a different
    // "live install" depending on where the session happened to start.
    assert.deepEqual(locateCheckouts(wt), { primary, isWorktree: true });
  });

  it('answers null for a directory that is not a checkout', () => {
    assert.equal(locateCheckouts(base), null);
  });

  it('answers null for a .git that is neither a directory nor a file', () => {
    const root = path.join(base, 'odd');
    fs.mkdirSync(root);
    fs.symlinkSync('/nowhere', path.join(root, '.git'));
    // A dangling symlink lstats as a link, not a file — inventing a primary from
    // it would point the guard at a path nobody serves.
    assert.equal(locateCheckouts(root), null);
  });

  it('answers null for a .git file with no gitdir line', () => {
    const root = path.join(base, 'nogitdir');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, '.git'), 'something else\n');
    assert.equal(locateCheckouts(root), null);
  });

  it('does not read a plain directory named "worktrees" as a worktree record', () => {
    // Anchored on the `.git/worktrees` PAIR. Keyed to the last `worktrees`
    // segment alone, this would report `/x/worktrees` — three components up from
    // a path that is not a git record at all — as a primary checkout.
    const root = path.join(base, 'fake');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${path.join(base, 'a', 'worktrees', 'w')}\n`);
    assert.equal(locateCheckouts(root), null);
  });
});

describe('linkedWorktreeRoots', () => {
  let base;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wtroots-'))); });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('is empty, not an error, for a repository with no worktrees', () => {
    assert.deepEqual(linkedWorktreeRoots(base), { roots: [], unreadable: [], failed: null });
  });

  it('distinguishes "no worktrees" from "could not list them"', () => {
    // ENOENT genuinely means none. Any other errno means the subtraction list is
    // UNKNOWN — and a caller handed an empty list reads every path inside every
    // nested worktree as the primary and refuses all of them. Collapsing the two
    // is a fail-CLOSED hole inside a fail-open guard, and a silent one, because
    // `unreadable` would be empty too. ENOTDIR is used rather than a chmod:
    // permission games score host plumbing and red differently under CI.
    fs.mkdirSync(path.join(base, '.git'), { recursive: true });
    fs.writeFileSync(path.join(base, '.git', 'worktrees'), 'not a directory\n');
    const out = linkedWorktreeRoots(base);
    assert.deepEqual(out.roots, []);
    assert.equal(out.failed, 'ENOTDIR', 'an unlistable directory must name why');
  });

  it('reports a record it cannot read instead of silently skipping it', () => {
    // An unsubtracted worktree makes the guard MORE likely to refuse — writes
    // inside that worktree read as writes to the primary. A silent skip would
    // present that as normal operation.
    const recs = path.join(base, '.git', 'worktrees');
    fs.mkdirSync(path.join(recs, 'good'), { recursive: true });
    fs.mkdirSync(path.join(recs, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(recs, 'good', 'gitdir'), `${path.join(base, 'wt', '.git')}\n`);
    // No `gitdir` file at all in `broken`.
    const out = linkedWorktreeRoots(base);
    assert.deepEqual(out.roots, [path.join(base, 'wt')]);
    assert.deepEqual(out.unreadable, ['broken']);
    assert.equal(out.failed, null);
  });

  it('reports an empty gitdir file as unreadable rather than as the filesystem root', () => {
    const recs = path.join(base, '.git', 'worktrees');
    fs.mkdirSync(path.join(recs, 'empty'), { recursive: true });
    fs.writeFileSync(path.join(recs, 'empty', 'gitdir'), '\n');
    assert.deepEqual(linkedWorktreeRoots(base), { roots: [], unreadable: ['empty'], failed: null });
  });
});

describe('landsInPrimary', () => {
  let base, primary, wt;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lands-')));
    primary = path.join(base, 'p');
    wt = path.join(primary, '.claude', 'worktrees', 'w');
    fs.mkdirSync(path.join(wt, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(primary, 'lib'), { recursive: true });
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('subtracts a worktree NESTED inside the primary', () => {
    // Without the subtraction every path in every worktree is lexically inside
    // the primary and the guard refuses all of them.
    assert.equal(landsInPrimary(path.join(primary, 'lib', 'a.js'), primary, [wt]), true);
    assert.equal(landsInPrimary(path.join(wt, 'lib', 'a.js'), primary, [wt]), false);
  });

  it('answers false for a path outside the primary entirely', () => {
    assert.equal(landsInPrimary(path.join(base, 'elsewhere.js'), primary, [wt]), false);
  });

  it('without allowRoot, a checkout root is not inside itself', () => {
    assert.equal(landsInPrimary(primary, primary, [wt]), false);
    assert.equal(landsInPrimary(wt, primary, [wt]), true);
  });

  it('with allowRoot, both roots answer for themselves', () => {
    // The pair that matters: the primary root must land IN the primary (a git
    // command run there is the case to refuse) and the worktree root must not
    // (that command is exactly where it belongs).
    assert.equal(landsInPrimary(primary, primary, [wt], { allowRoot: true }), true);
    assert.equal(landsInPrimary(wt, primary, [wt], { allowRoot: true }), false);
  });
});

describe('realOrSelf', () => {
  let base;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-real-'))); });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('resolves a path whose final component does not exist yet', () => {
    // The guard's targets are routinely about to be created; realpathSync alone
    // throws on them.
    fs.mkdirSync(path.join(base, 'real'));
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
    assert.equal(realOrSelf(path.join(base, 'link', 'new.js')), path.join(base, 'real', 'new.js'));
  });

  it('resolves the final component when it IS a link', () => {
    fs.writeFileSync(path.join(base, 'target.js'), '');
    fs.symlinkSync(path.join(base, 'target.js'), path.join(base, 'alias.js'));
    assert.equal(realOrSelf(path.join(base, 'alias.js')), path.join(base, 'target.js'));
  });
});

/** A directory that passes `validateServerCheckoutRoot`: a real git checkout with a `server.js`. */
function _makeValidServerCheckout(dir) {
  fs.mkdirSync(dir, { recursive: true });
  initRepo(dir, ['-b', 'main']);
  fs.writeFileSync(path.join(dir, 'server.js'), '// stand-in\n');
  return dir;
}

describe('validateServerCheckoutRoot (#1672 Round 2)', () => {
  let base;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-validate-'))); });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('passes a real checkout: exists, is a directory, has server.js, is a git checkout', () => {
    const root = _makeValidServerCheckout(path.join(base, 'ok'));
    assert.deepEqual(validateServerCheckoutRoot(root), { ok: true, reason: null });
  });

  it('fails for a path that does not exist', () => {
    assert.deepEqual(validateServerCheckoutRoot(path.join(base, 'nope')), { ok: false, reason: 'path does not exist' });
  });

  it('fails for a file, not a directory', () => {
    const aFile = path.join(base, 'a-file');
    fs.writeFileSync(aFile, 'x\n');
    assert.deepEqual(validateServerCheckoutRoot(aFile), { ok: false, reason: 'path is not a directory' });
  });

  it('fails for a directory with no server.js', () => {
    const noServer = path.join(base, 'no-server');
    fs.mkdirSync(noServer);
    initRepo(noServer, ['-b', 'main']);
    const result = validateServerCheckoutRoot(noServer);
    assert.equal(result.ok, false);
    assert.match(result.reason, /server\.js/);
  });

  it('fails for a directory with server.js but no git checkout', () => {
    const noGit = path.join(base, 'no-git');
    fs.mkdirSync(noGit);
    fs.writeFileSync(path.join(noGit, 'server.js'), '// stand-in\n');
    const result = validateServerCheckoutRoot(noGit);
    assert.equal(result.ok, false);
    assert.match(result.reason, /git checkout/);
  });
});

describe('resolveServerCheckoutRoot (#1672)', () => {
  let base;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-serverroot-'))); });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('uses the default root when no override env var is set', () => {
    assert.deepEqual(resolveServerCheckoutRoot(base, { env: {} }), { root: base, source: 'default' });
  });

  it('prefers an explicit TANGLECLAW_SERVER_ROOT override over the default, when the override validates', () => {
    const override = _makeValidServerCheckout(path.join(base, 'dedicated'));
    const result = resolveServerCheckoutRoot(path.join(base, 'ignored-default'), { env: { [SERVER_ROOT_ENV]: override } });
    assert.deepEqual(result, { root: override, source: 'override' });
  });

  it('ignores an empty or whitespace-only override and falls back to the default', () => {
    for (const bad of ['', '   ']) {
      const result = resolveServerCheckoutRoot(base, { env: { [SERVER_ROOT_ENV]: bad } });
      assert.deepEqual(result, { root: base, source: 'default' });
    }
  });

  it('reads process.env when no env option is given', () => {
    const prior = process.env[SERVER_ROOT_ENV];
    delete process.env[SERVER_ROOT_ENV];
    try {
      assert.equal(resolveServerCheckoutRoot(base).source, 'default');
    } finally {
      if (prior === undefined) delete process.env[SERVER_ROOT_ENV];
      else process.env[SERVER_ROOT_ENV] = prior;
    }
  });

  it('falls back to the default and reports invalidServerRootOverride for a nonexistent override path', () => {
    const missing = path.join(base, 'does-not-exist');
    const result = resolveServerCheckoutRoot(base, { env: { [SERVER_ROOT_ENV]: missing } });
    assert.equal(result.root, base);
    assert.equal(result.source, 'default');
    assert.equal(result.invalidServerRootOverride.requested, missing);
    assert.equal(result.invalidServerRootOverride.reason, 'path does not exist');
  });

  it('falls back to the default for an override that exists but has no server.js (not a TangleClaw checkout)', () => {
    const notAServer = path.join(base, 'plain-repo');
    fs.mkdirSync(notAServer);
    initRepo(notAServer, ['-b', 'main']);
    const result = resolveServerCheckoutRoot(base, { env: { [SERVER_ROOT_ENV]: notAServer } });
    assert.equal(result.source, 'default');
    assert.match(result.invalidServerRootOverride.reason, /server\.js/);
  });

  it('falls back to the default for an override with server.js but no git checkout', () => {
    const notAGitRepo = path.join(base, 'no-git');
    fs.mkdirSync(notAGitRepo);
    fs.writeFileSync(path.join(notAGitRepo, 'server.js'), '// stand-in\n');
    const result = resolveServerCheckoutRoot(base, { env: { [SERVER_ROOT_ENV]: notAGitRepo } });
    assert.equal(result.source, 'default');
    assert.match(result.invalidServerRootOverride.reason, /git checkout/);
  });

  it('falls back to the default for an override that is a file, not a directory', () => {
    const aFile = path.join(base, 'a-file');
    fs.writeFileSync(aFile, 'not a directory\n');
    const result = resolveServerCheckoutRoot(base, { env: { [SERVER_ROOT_ENV]: aFile } });
    assert.equal(result.source, 'default');
    assert.match(result.invalidServerRootOverride.reason, /not a directory/);
  });
});

describe('describeServerRootCoupling (#1672)', () => {
  let base;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-coupling-'))); });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  function makePrimaryWithWorktree() {
    const primary = path.join(base, 'primary');
    fs.mkdirSync(primary);
    initRepo(primary, ['-b', 'main']);
    const git = (...a) => execFileSync('git', a, { cwd: primary, stdio: ['pipe', 'pipe', 'pipe'] });
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(primary, 'f.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const wt = path.join(primary, '.claude', 'worktrees', 'w');
    git('worktree', 'add', '-q', wt, '-b', 'b');
    return { primary, wt };
  }

  // A fixed, deterministic (never-existing) plist path for every test below
  // that doesn't exercise `launchdWorkingDirectory` itself — without it,
  // these would default to reading THIS machine's real
  // ~/Library/LaunchAgents/com.tangleclaw.server.plist if one happens to be
  // installed, making the assertion depend on ambient machine state.
  // Pinned to darwin (#2933): these legacy callers never set opts.platform, and
  // the default must not silently follow whatever OS actually runs the test.
  function noPlist() { return { launchdPlistPath: path.join(base, 'no-such-plist.plist'), platform: 'darwin' }; }

  it('reports an uncoupled dedicated checkout: a primary with no linked worktrees', () => {
    const primary = path.join(base, 'dedicated');
    fs.mkdirSync(primary);
    initRepo(primary, ['-b', 'main']);
    const result = describeServerRootCoupling(primary, noPlist());
    assert.deepEqual(result, {
      checkout: { primary, isWorktree: false },
      isLinkedWorktree: false,
      hasLinkedWorktrees: false,
      linkedWorktreeCount: 0,
      coupled: false,
      launchdWorkingDirectory: null
    });
  });

  it('flags the resolved root itself being a linked worktree', () => {
    const { primary, wt } = makePrimaryWithWorktree();
    const result = describeServerRootCoupling(wt, noPlist());
    assert.deepEqual(result, {
      checkout: { primary, isWorktree: true },
      isLinkedWorktree: true,
      hasLinkedWorktrees: false,
      linkedWorktreeCount: 0,
      coupled: true,
      launchdWorkingDirectory: null
    });
  });

  it('flags a primary that has an active Builder/agent worktree linked off it, without miscounting the worktree itself', () => {
    const { primary } = makePrimaryWithWorktree();
    const result = describeServerRootCoupling(primary, noPlist());
    assert.equal(result.isLinkedWorktree, false);
    assert.equal(result.hasLinkedWorktrees, true);
    assert.equal(result.linkedWorktreeCount, 1);
    assert.equal(result.coupled, true);
  });

  it('answers null/uncoupled for a root with no recognizable git layout at all', () => {
    const root = path.join(base, 'no-git');
    fs.mkdirSync(root);
    assert.deepEqual(describeServerRootCoupling(root, noPlist()), {
      checkout: null,
      isLinkedWorktree: false,
      hasLinkedWorktrees: false,
      linkedWorktreeCount: 0,
      coupled: false,
      launchdWorkingDirectory: null
    });
  });

  it('reports launchdWorkingDirectory from an injected plist path (#1672 Round 3)', () => {
    const plistPath = path.join(base, 'fake.plist');
    fs.writeFileSync(plistPath, '<plist><dict><key>WorkingDirectory</key><string>/declared/root</string></dict></plist>');
    const primary = path.join(base, 'dedicated');
    fs.mkdirSync(primary);
    initRepo(primary, ['-b', 'main']);
    const result = describeServerRootCoupling(primary, { launchdPlistPath: plistPath, platform: 'darwin' });
    assert.equal(result.launchdWorkingDirectory, '/declared/root');
  });

  it('reports launchdWorkingDirectory as null when the plist has no WorkingDirectory key', () => {
    const plistPath = path.join(base, 'no-wd.plist');
    fs.writeFileSync(plistPath, '<plist><dict><key>Label</key><string>com.tangleclaw.server</string></dict></plist>');
    assert.equal(describeServerRootCoupling(base, { launchdPlistPath: plistPath, platform: 'darwin' }).launchdWorkingDirectory, null);
  });

  it('reports launchdWorkingDirectory as null, never throwing, for a malformed/unreadable plist', () => {
    const plistPath = path.join(base, 'a-directory-not-a-file.plist');
    fs.mkdirSync(plistPath); // exists, but readFileSync on a directory throws
    assert.doesNotThrow(() => describeServerRootCoupling(base, { launchdPlistPath: plistPath, platform: 'darwin' }));
    assert.equal(describeServerRootCoupling(base, { launchdPlistPath: plistPath, platform: 'darwin' }).launchdWorkingDirectory, null);
  });

  describe('on linux (#2933)', () => {
    it('reports launchdWorkingDirectory from an injected systemd unit path, same field name as darwin', () => {
      const unitPath = path.join(base, 'tangleclaw.service');
      fs.writeFileSync(unitPath, '[Unit]\nDescription=TangleClaw\n\n[Service]\nType=simple\nWorkingDirectory=/declared/linux-root\nExecStart=node server.js\nKillMode=process\n');
      const primary = path.join(base, 'dedicated');
      fs.mkdirSync(primary);
      initRepo(primary, ['-b', 'main']);
      const result = describeServerRootCoupling(primary, { systemdUnitPath: unitPath, platform: 'linux' });
      assert.equal(result.launchdWorkingDirectory, '/declared/linux-root');
    });

    it('reports launchdWorkingDirectory as null when the unit has no WorkingDirectory key', () => {
      const unitPath = path.join(base, 'no-wd.service');
      fs.writeFileSync(unitPath, '[Unit]\nDescription=TangleClaw\n');
      assert.equal(describeServerRootCoupling(base, { systemdUnitPath: unitPath, platform: 'linux' }).launchdWorkingDirectory, null);
    });

    it('reports launchdWorkingDirectory as null, never throwing, for a malformed/unreadable unit', () => {
      const unitPath = path.join(base, 'a-directory-not-a-file.service');
      fs.mkdirSync(unitPath);
      assert.doesNotThrow(() => describeServerRootCoupling(base, { systemdUnitPath: unitPath, platform: 'linux' }));
      assert.equal(describeServerRootCoupling(base, { systemdUnitPath: unitPath, platform: 'linux' }).launchdWorkingDirectory, null);
    });

    it('never reads the darwin plist path when platform is linux, even if one is also injected', () => {
      const plistPath = path.join(base, 'fake.plist');
      fs.writeFileSync(plistPath, '<plist><dict><key>WorkingDirectory</key><string>/darwin/only</string></dict></plist>');
      const unitPath = path.join(base, 'absent.service'); // never written
      const result = describeServerRootCoupling(base, { launchdPlistPath: plistPath, systemdUnitPath: unitPath, platform: 'linux' });
      assert.equal(result.launchdWorkingDirectory, null, 'the darwin plist must not leak into the linux read path');
    });
  });
});

/*
 * A fixture resembling `deploy/com.tangleclaw.server.plist`'s real shape
 * closely enough to prove `renderLaunchdServerPlist` rewrites exactly the
 * one key it should (`WorkingDirectory`) — inline, not read from the real
 * deploy file, so these tests stay correct even if that file's other
 * fields change for unrelated reasons.
 */
const SAMPLE_PLIST_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<plist version="1.0">',
  '<dict>',
  '\t<key>Label</key>',
  '\t<string>com.tangleclaw.server</string>',
  '\t<key>ProgramArguments</key>',
  '\t<array>',
  '\t\t<string>__NODE_PATH__</string>',
  '\t\t<string>server.js</string>',
  '\t</array>',
  '\t<key>WorkingDirectory</key>',
  '\t<string>__REPO_DIR__</string>',
  '\t<key>StandardOutPath</key>',
  '\t<string>/dev/null</string>',
  '\t<key>StandardErrorPath</key>',
  '\t<string>__HOME__/.tangleclaw/logs/server.err.log</string>',
  '</dict>',
  '</plist>',
  ''
].join('\n');

describe('renderLaunchdServerPlist (#1672 Round 3 → Round 4)', () => {
  it('rewrites WorkingDirectory and substitutes every __PLACEHOLDER__, leaving the relative server.js argument and /dev/null untouched', () => {
    const xml = renderLaunchdServerPlist('/dedicated/root', {
      templateXml: SAMPLE_PLIST_XML, nodePath: '/opt/node/bin/node', homeDir: '/Users/op', launchdPath: '/usr/bin:/bin'
    });
    assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/dedicated\/root<\/string>/);
    assert.match(xml, /<string>server\.js<\/string>/, 'the relative server.js argument must survive untouched');
    assert.match(xml, /<string>\/opt\/node\/bin\/node<\/string>/, '__NODE_PATH__ must be substituted');
    assert.match(xml, /\/Users\/op\/\.tangleclaw\/logs\/server\.err\.log/, '__HOME__ must be substituted, not left literal');
    assert.match(xml, /<string>\/dev\/null<\/string>/);
    assert.equal(/__[A-Z0-9_]+__/.test(xml), false, 'no placeholder may survive rendering');
  });

  it('defaults __NODE_PATH__/__HOME__/__LAUNCHD_PATH__ to this process\'s own values when no override is given', () => {
    const xml = renderLaunchdServerPlist('/dedicated/root', { templateXml: SAMPLE_PLIST_XML });
    assert.ok(xml.includes(`<string>${process.execPath}</string>`));
    assert.ok(xml.includes(`${require('node:os').homedir()}/.tangleclaw/logs/server.err.log`));
    assert.equal(/__[A-Z0-9_]+__/.test(xml), false);
  });

  it('XML-escapes a path containing characters meaningful to XML, for WorkingDirectory and for a substituted placeholder alike', () => {
    const xml = renderLaunchdServerPlist('/weird & <root>', { templateXml: SAMPLE_PLIST_XML, homeDir: '/weird & <home>' });
    assert.match(xml, /<string>\/weird &amp; &lt;root&gt;<\/string>/);
    assert.match(xml, /\/weird &amp; &lt;home&gt;\/\.tangleclaw/);
  });

  it('throws TypeError when templateXml is missing or empty', () => {
    assert.throws(() => renderLaunchdServerPlist('/x', {}), TypeError);
    assert.throws(() => renderLaunchdServerPlist('/x', { templateXml: '' }), TypeError);
  });

  it('throws when the template XML has no WorkingDirectory key to rewrite', () => {
    assert.throws(() => renderLaunchdServerPlist('/x', { templateXml: '<plist><dict></dict></plist>' }));
  });

  it('fails closed (#1672 Round 4) when a placeholder survives every known substitution, rather than returning broken XML', () => {
    const withUnknownPlaceholder = SAMPLE_PLIST_XML.replace('/dev/null', '__SOME_FUTURE_PLACEHOLDER__');
    assert.throws(
      () => renderLaunchdServerPlist('/dedicated/root', { templateXml: withUnknownPlaceholder }),
      /unresolved placeholder/
    );
  });
});

describe('repointLaunchdServerPlist (#1672 Round 3 → Round 4)', () => {
  let base;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-repoint-'))); });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  /** A real, valid server checkout: git-initialized, has server.js and deploy/<plist>. */
  function makeValidTarget() {
    const target = path.join(base, 'dedicated');
    fs.mkdirSync(target);
    initRepo(target, ['-b', 'main']);
    fs.writeFileSync(path.join(target, 'server.js'), '// stand-in\n');
    fs.mkdirSync(path.join(target, 'deploy'));
    fs.writeFileSync(path.join(target, 'deploy', 'com.tangleclaw.server.plist'), SAMPLE_PLIST_XML);
    return target;
  }

  it('fails closed for an invalid target checkout, touching no filesystem write at all', () => {
    const plistPath = path.join(base, 'should-not-exist.plist');
    assert.throws(() => repointLaunchdServerPlist(path.join(base, 'nope'), { plistPath }));
    assert.equal(fs.existsSync(plistPath), false, 'nothing must be written when validation fails');
  });

  it('writes the rewritten plist to plistPath, reading from the target\'s own deploy/ template when nothing is installed at plistPath yet, with no unresolved placeholders', () => {
    const target = makeValidTarget();
    const plistPath = path.join(base, 'out.plist');
    const result = repointLaunchdServerPlist(target, { plistPath, nodePath: '/opt/node', homeDir: '/home/op', launchdPath: '/bin' });
    assert.equal(result.reloaded, false);
    assert.equal(result.sourcePath, path.join(target, 'deploy', 'com.tangleclaw.server.plist'));
    assert.equal(fs.existsSync(plistPath), true);
    const written = fs.readFileSync(plistPath, 'utf8');
    assert.ok(written.includes(`<string>${target}</string>`), 'the rewritten WorkingDirectory must be present');
    assert.equal(/__[A-Z0-9_]+__/.test(written), false, 'the installed plist must carry no unresolved __*__ placeholder');
    assert.match(written, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/node<\/string>\s*<string>server\.js<\/string>/,
      'ProgramArguments must be a valid [nodePath, server.js] pair');
    assert.match(written, /<key>WorkingDirectory<\/key>\s*<string>[^<]+<\/string>/);
  });

  it('(#1672 Round 4) defaults to the ALREADY-INSTALLED plist at plistPath, not the raw template, once one exists', () => {
    const target = makeValidTarget();
    const plistPath = path.join(base, 'out.plist');
    const first = repointLaunchdServerPlist(target, { plistPath });
    assert.equal(first.sourcePath, path.join(target, 'deploy', 'com.tangleclaw.server.plist'), 'first repoint: nothing installed yet, so the template is the source');

    const second = repointLaunchdServerPlist(target, { plistPath });
    assert.equal(second.sourcePath, plistPath, 'second repoint: the now-installed, already-rendered plist is preferred over the raw template');
    assert.equal(/__[A-Z0-9_]+__/.test(fs.readFileSync(plistPath, 'utf8')), false);
  });

  it('reads from the existing plist at plistPath instead of the template when readFrom is "existing", even if the template would also have been available', () => {
    const target = makeValidTarget();
    const plistPath = path.join(base, 'existing.plist');
    // A pre-existing installed plist, deliberately different from the template
    // (a custom StandardOutPath an operator added) — must survive the rewrite.
    const existingXml = SAMPLE_PLIST_XML.replace('/dev/null', '/custom/out.log');
    fs.writeFileSync(plistPath, existingXml);
    const result = repointLaunchdServerPlist(target, { plistPath, readFrom: 'existing' });
    assert.equal(result.sourcePath, plistPath);
    assert.match(fs.readFileSync(plistPath, 'utf8'), /\/custom\/out\.log/, 'the existing custom field must survive');
    assert.equal(/__[A-Z0-9_]+__/.test(fs.readFileSync(plistPath, 'utf8')), false);
  });

  it('readFrom "template" forces the raw template even when a (different) plist is already installed at plistPath', () => {
    const target = makeValidTarget();
    const plistPath = path.join(base, 'out.plist');
    fs.writeFileSync(plistPath, SAMPLE_PLIST_XML.replace('/dev/null', '/already-installed-marker.log'));
    const result = repointLaunchdServerPlist(target, { plistPath, readFrom: 'template' });
    assert.equal(result.sourcePath, path.join(target, 'deploy', 'com.tangleclaw.server.plist'));
    assert.equal(fs.readFileSync(plistPath, 'utf8').includes('/already-installed-marker.log'), false,
      'forcing the template must overwrite, not preserve, whatever was installed before');
  });

  it('never calls execFileSync unless reload is true', () => {
    const target = makeValidTarget();
    const plistPath = path.join(base, 'out.plist');
    let called = false;
    repointLaunchdServerPlist(target, { plistPath, execFileSync: () => { called = true; } });
    assert.equal(called, false);
  });

  it('runs launchctl unload then load, through the injected execFileSync, only when reload is true', () => {
    const target = makeValidTarget();
    const plistPath = path.join(base, 'out.plist');
    const calls = [];
    const result = repointLaunchdServerPlist(target, {
      plistPath, reload: true, execFileSync: (cmd, args) => calls.push([cmd, ...args])
    });
    assert.equal(result.reloaded, true);
    assert.deepEqual(calls, [['launchctl', 'unload', plistPath], ['launchctl', 'load', plistPath]]);
  });

  it('writes atomically: no temp file is left behind on success', () => {
    const target = makeValidTarget();
    const plistPath = path.join(base, 'out.plist');
    repointLaunchdServerPlist(target, { plistPath });
    const leftovers = fs.readdirSync(base).filter((f) => f.startsWith('out.plist.tmp-'));
    assert.deepEqual(leftovers, []);
  });

  it('throws a clear error, writing nothing, when the source plist cannot be read', () => {
    const target = makeValidTarget();
    fs.rmSync(path.join(target, 'deploy', 'com.tangleclaw.server.plist'));
    const plistPath = path.join(base, 'out.plist');
    assert.throws(() => repointLaunchdServerPlist(target, { plistPath }), /could not read source plist/);
    assert.equal(fs.existsSync(plistPath), false);
  });
});

describe('repointSystemdServerUnit (#2933)', () => {
  let base;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-repoint-systemd-'))); });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  /** A real, valid server checkout: git-initialized, has server.js. No deploy/
   *  template needed — unlike the plist case, generateUnitFile builds the unit
   *  from scratch. */
  function makeValidTarget() {
    const target = path.join(base, 'dedicated');
    fs.mkdirSync(target);
    initRepo(target, ['-b', 'main']);
    fs.writeFileSync(path.join(target, 'server.js'), '// stand-in\n');
    return target;
  }

  it('fails closed for an invalid target checkout, touching no filesystem write at all', () => {
    const unitPath = path.join(base, 'should-not-exist.service');
    assert.throws(() => repointSystemdServerUnit(path.join(base, 'nope'), { unitPath }));
    assert.equal(fs.existsSync(unitPath), false, 'nothing must be written when validation fails');
  });

  it('writes a freshly generated unit to unitPath with WorkingDirectory pointed at the target, satisfying its own contract', () => {
    const target = makeValidTarget();
    const unitPath = path.join(base, 'out.service');
    const result = repointSystemdServerUnit(target, { unitPath, nodeBin: '/opt/node/bin/node' });
    assert.equal(result.reloaded, false);
    assert.equal(fs.existsSync(unitPath), true);
    const written = fs.readFileSync(unitPath, 'utf8');
    assert.match(written, new RegExp(`^WorkingDirectory=${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(written, /^ExecStart=\/opt\/node\/bin\/node .*server\.js$/m);
    assert.match(written, /^KillMode=process$/m);
  });

  it('throws, writing nothing, if the generated unit somehow failed its own contract', () => {
    // generateUnitFile cannot actually produce a contract violation given valid
    // inputs — this pins that repointSystemdServerUnit checks before writing at
    // all, by forcing verifyUnitFileContract to fail via an impossible nodeBin.
    const target = makeValidTarget();
    const unitPath = path.join(base, 'out.service');
    const linuxSystemd = require('../lib/linux-systemd');
    const real = linuxSystemd.verifyUnitFileContract;
    linuxSystemd.verifyUnitFileContract = () => ['forced failure for this test'];
    try {
      assert.throws(() => repointSystemdServerUnit(target, { unitPath }), /fails its own contract/);
      assert.equal(fs.existsSync(unitPath), false);
    } finally {
      linuxSystemd.verifyUnitFileContract = real;
    }
  });

  it('never calls execFileSync unless reload is true', () => {
    const target = makeValidTarget();
    const unitPath = path.join(base, 'out.service');
    let called = false;
    repointSystemdServerUnit(target, { unitPath, execFileSync: () => { called = true; } });
    assert.equal(called, false);
  });

  it('runs systemctl --user daemon-reload then restart tangleclaw.service, through the injected execFileSync, only when reload is true', () => {
    const target = makeValidTarget();
    const unitPath = path.join(base, 'out.service');
    const calls = [];
    const result = repointSystemdServerUnit(target, {
      unitPath, reload: true, execFileSync: (cmd, args) => calls.push([cmd, ...args])
    });
    assert.equal(result.reloaded, true);
    assert.deepEqual(calls, [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'restart', 'tangleclaw.service']
    ]);
  });

  it('writes atomically: no temp file is left behind on success', () => {
    const target = makeValidTarget();
    const unitPath = path.join(base, 'out.service');
    repointSystemdServerUnit(target, { unitPath });
    const leftovers = fs.readdirSync(base).filter((f) => f.startsWith('out.service.tmp-'));
    assert.deepEqual(leftovers, []);
  });

  it('defaults unitPath to lib/linux-systemd.js\'s own unitFilePath(), so it stays the single source of that path', () => {
    const target = makeValidTarget();
    const linuxSystemd = require('../lib/linux-systemd');
    const homeDir = base;
    const result = repointSystemdServerUnit(target, { homeDir });
    assert.equal(result.unitPath, linuxSystemd.unitFilePath(homeDir));
  });
});

describe('_runCli --repoint on linux (#2933)', () => {
  let base;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-repoint-systemd-'))); });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('dispatches --repoint to repointSystemdServerUnit when platform is linux', () => {
    const target = path.join(base, 'dedicated');
    fs.mkdirSync(target);
    initRepo(target, ['-b', 'main']);
    fs.writeFileSync(path.join(target, 'server.js'), '// stand-in\n');
    const unitPath = path.join(base, 'out.service');
    const logs = [];
    const result = _runCli(['--repoint', target, '--unit', unitPath], {
      log: (l) => logs.push(l), platform: 'linux'
    });
    assert.equal(fs.existsSync(unitPath), true);
    assert.equal(result.unitPath, unitPath);
    assert.match(logs[0], /WorkingDirectory=/);
  });
});

describe('provisionDedicatedServerCheckout (#1672 Round 3)', () => {
  let base, primary;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-provision-')));
    primary = path.join(base, 'primary');
    fs.mkdirSync(primary);
    initRepo(primary, ['-b', 'main']);
    const git = (...a) => execFileSync('git', a, { cwd: primary, stdio: ['pipe', 'pipe', 'pipe'] });
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(primary, 'f.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('provisions a linked worktree by default, sharing the primary\'s history', () => {
    const dedicated = path.join(base, 'dedicated-wt');
    const result = provisionDedicatedServerCheckout(primary, dedicated);
    assert.equal(result.mode, 'worktree');
    assert.equal(fs.existsSync(path.join(dedicated, 'f.txt')), true);
    assert.deepEqual(describeServerRootCoupling(primary, { launchdPlistPath: path.join(base, 'no-plist') }).hasLinkedWorktrees, true);
  });

  it('provisions a clone when mode is "clone"', () => {
    const dedicated = path.join(base, 'dedicated-clone');
    const result = provisionDedicatedServerCheckout(primary, dedicated, { mode: 'clone' });
    assert.equal(result.mode, 'clone');
    assert.equal(fs.existsSync(path.join(dedicated, 'f.txt')), true);
    assert.equal(fs.existsSync(path.join(dedicated, '.git')), true, 'a clone has its own .git');
  });

  it('refuses to provision over an existing path', () => {
    const dedicated = path.join(base, 'already-here');
    fs.mkdirSync(dedicated);
    assert.throws(() => provisionDedicatedServerCheckout(primary, dedicated), /refusing to provision/);
  });
});

describe('_runCli (#1672 Round 3)', () => {
  let base;
  beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-'))); });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('--repoint drives repointLaunchdServerPlist end to end, never calling the real execFileSync', () => {
    const target = path.join(base, 'dedicated');
    fs.mkdirSync(target);
    initRepo(target, ['-b', 'main']);
    fs.writeFileSync(path.join(target, 'server.js'), '// stand-in\n');
    fs.mkdirSync(path.join(target, 'deploy'));
    fs.writeFileSync(path.join(target, 'deploy', 'com.tangleclaw.server.plist'), SAMPLE_PLIST_XML);
    const plistPath = path.join(base, 'out.plist');

    const logs = [];
    const calls = [];
    const result = _runCli(['--repoint', target, '--plist', plistPath, '--reload'], {
      log: (m) => logs.push(m),
      fns: { execFileSync: (cmd, args) => calls.push([cmd, ...args]) },
      platform: 'darwin' // pinned (#2933) — exercises the launchd branch regardless of the host OS
    });
    assert.equal(result.reloaded, true);
    assert.equal(calls.length, 2);
    assert.ok(logs[0].includes(plistPath));
    assert.equal(fs.existsSync(plistPath), true);
  });

  it('--provision-dedicated drives provisionDedicatedServerCheckout end to end', () => {
    const primary = path.join(base, 'primary');
    fs.mkdirSync(primary);
    initRepo(primary, ['-b', 'main']);
    const git = (...a) => execFileSync('git', a, { cwd: primary, stdio: ['pipe', 'pipe', 'pipe'] });
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(primary, 'f.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    const dedicated = path.join(base, 'dedicated');
    const logs = [];
    const result = _runCli(['--provision-dedicated', dedicated, '--primary', primary], { log: (m) => logs.push(m) });
    assert.equal(result.mode, 'worktree');
    assert.equal(fs.existsSync(path.join(dedicated, 'f.txt')), true);
  });

  it('throws a usage error for no recognized flag', () => {
    assert.throws(() => _runCli([]), /usage: node lib\/checkout-layout\.js/);
    assert.throws(() => _runCli(['--bogus']), /usage: node lib\/checkout-layout\.js/);
  });
});
