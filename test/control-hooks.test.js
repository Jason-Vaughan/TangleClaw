'use strict';

// #1861: managed pre-commit/pre-push control hooks — defense in depth, never
// server enforcement. Real temp repos; git itself runs the hooks; the marker
// points at a stub control API on an ephemeral port. Covers: governed vs
// ungoverned checkouts, fail-closed only when governed, linked-worktree
// isolation, foreign-hook chaining (regular file and symlink) with bytes, mode,
// args, stdin, exit status and signal preserved, the collision refusal,
// rollback at every install step, fingerprint-checked uninstall, idempotent
// refresh, and a tracked core.hooksPath left UNPROTECTED and untouched.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync, spawnSync, spawn } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const hooks = require('../lib/control-hooks');
const { initRepo } = require('./_temp-repo');

let tmpDir;
let api;
let apiProc;
let answersFile;
/**
 * assignmentId → check answer the stub API gives. The stub runs in a child
 * process that reads this from a file on every request: git runs the hooks
 * through a synchronous spawn, which blocks this process's event loop, so a
 * stub served from here could never answer.
 */
const answers = {
  store: new Map(),
  set(id, v) { this.store.set(id, v); this.flush(); },
  clear() { this.store.clear(); this.flush(); },
  flush() { fs.writeFileSync(answersFile, JSON.stringify(Object.fromEntries(this.store))); }
};

const STUB_API = `
const http = require('http'); const fs = require('fs');
const file = process.argv[1];
const srv = http.createServer((req, res) => {
  const id = new URL(req.url, 'http://x').searchParams.get('assignmentId');
  let all = {}; try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const body = all[id];
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body || { code: 'ASSIGNMENT_NOT_FOUND' }));
});
srv.listen(0, '127.0.0.1', () => process.stdout.write(String(srv.address().port) + '\\n'));
`;

/**
 * A fresh repo with one commit on main.
 * @param {string} name
 * @returns {string} Path
 */
function repo(name) {
  const dir = fs.mkdtempSync(path.join(tmpDir, `${name}-`));
  initRepo(dir);
  execSync('git config user.email t@example.com && git config user.name Test && git config commit.gpgsign false', { cwd: dir, shell: '/bin/sh' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  execSync('git add a.txt && git commit --quiet -m init && git branch -M main', { cwd: dir, shell: '/bin/sh' });
  // initRepo uses an empty template, so there is no hooks directory until a test makes one.
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  return dir;
}

/**
 * Try a commit; return whether git accepted it and what it said.
 * @param {string} dir
 * @returns {{ok: boolean, stderr: string}}
 */
function tryCommit(dir) {
  fs.appendFileSync(path.join(dir, 'a.txt'), 'x\n');
  const r = spawnSync('git', ['commit', '-am', 'change'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) execSync('git checkout -- a.txt', { cwd: dir });
  return { ok: r.status === 0, stderr: r.stderr };
}

/**
 * Set what the stub API answers for an assignment.
 * @param {string} id
 * @param {string} state
 */
function setState(id, state) {
  const blocked = state === 'held' || state === 'stopped';
  answers.set(id, { assignmentId: id, state, stateGeneration: 2, blocked, code: blocked ? `CONTROL_${state.toUpperCase()}` : null });
}

/**
 * Write an executable file.
 * @param {string} file
 * @param {string} body
 * @param {number} [mode]
 */
function script(file, body, mode = 0o755) {
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
}

describe('control-hooks (#1861)', () => {
  before(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-control-hooks-')));
    answersFile = path.join(tmpDir, 'answers.json');
    answers.clear();
    apiProc = spawn(process.execPath, ['-e', STUB_API, answersFile], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise((resolve, reject) => {
      apiProc.stdout.once('data', (d) => resolve(String(d).trim()));
      apiProc.once('error', reject);
    });
    api = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    apiProc.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => answers.clear());

  describe('governed and ungoverned checkouts', () => {
    it('a HOLD or STOP blocks a commit; ACTIVE allows it; a superseded STOP still blocks', () => {
      const dir = repo('gov');
      const res = hooks.install(dir, { assignmentId: 'asg_a', api });
      assert.equal(res.protected, true);
      assert.deepEqual(res.hooks, { 'pre-commit': 'installed', 'pre-push': 'installed' });
      setState('asg_a', 'active');
      assert.equal(tryCommit(dir).ok, true);
      setState('asg_a', 'held');
      const held = tryCommit(dir);
      assert.equal(held.ok, false);
      assert.match(held.stderr, /CONTROL_HELD/);
      assert.match(held.stderr, /not enforcement/);
      setState('asg_a', 'stopped');
      assert.equal(tryCommit(dir).ok, false);
      answers.set('asg_a', { assignmentId: 'asg_a', state: 'closed', stateGeneration: 3, blocked: true, code: 'CONTROL_STOPPED' });
      assert.equal(tryCommit(dir).ok, false);
    });

    it('fails closed when TangleClaw is unreachable — only for a governed checkout', () => {
      const governed = repo('down');
      hooks.install(governed, { assignmentId: 'asg_down', api: 'http://127.0.0.1:9' });
      const r = tryCommit(governed);
      assert.equal(r.ok, false);
      assert.match(r.stderr, /fails closed/);
      const free = repo('free');
      hooks.install(free, { assignmentId: 'asg_free', api: 'http://127.0.0.1:9' });
      hooks.unmark(free);
      assert.equal(tryCommit(free).ok, true, 'no marker: the hook is a pass-through');
    });

    it('an unknown assignment (404) fails closed rather than passing', () => {
      const dir = repo('unknown');
      hooks.install(dir, { assignmentId: 'asg_gone', api });
      assert.equal(tryCommit(dir).ok, false);
    });
  });

  describe('linked worktrees', () => {
    it('a governed main checkout holds worktrees created under it, but not a registered ungoverned project sharing the clone', () => {
      const main = repo('clone');
      execSync('git worktree add -q ../wt-registered -b reg && git worktree add -q ../wt-builder -b bld', { cwd: main, shell: '/bin/sh' });
      const registered = path.join(path.dirname(main), 'wt-registered');
      const builderWt = path.join(path.dirname(main), 'wt-builder');
      hooks.install(main, { assignmentId: 'asg_main', api });
      hooks.unmark(registered);
      setState('asg_main', 'held');
      assert.equal(tryCommit(main).ok, false, 'the governed checkout is held');
      assert.equal(tryCommit(builderWt).ok, false, 'a worktree the Builder made under it is in the same lane');
      assert.equal(tryCommit(registered).ok, true, 'an ungoverned project sharing the clone is isolated');
      assert.equal(hooks.status(builderWt).governed, true);
      assert.equal(hooks.status(registered).governed, false);
    });

    it('a governed linked worktree does not govern its clone\'s main checkout', () => {
      const main = repo('clone2');
      execSync('git worktree add -q ../wt-gov -b gov', { cwd: main, shell: '/bin/sh' });
      const wt = path.join(path.dirname(main), 'wt-gov');
      hooks.install(wt, { assignmentId: 'asg_wt', api });
      setState('asg_wt', 'held');
      assert.equal(tryCommit(wt).ok, false);
      assert.equal(tryCommit(main).ok, true);
    });
  });

  describe('chaining a foreign hook', () => {
    it('a regular-file hook is kept byte-identical with its mode, runs after the check, and its exit status is its own', () => {
      const dir = repo('chain');
      const hooksDir = hooks.locate(dir).hooksDir;
      const foreign = path.join(hooksDir, 'pre-commit');
      script(foreign, '#!/bin/sh\necho ran >> "$(git rev-parse --show-toplevel)/../chain-ran"\nexit 3\n', 0o750);
      const before = hooks.fingerprint(foreign);
      const res = hooks.install(dir, { assignmentId: 'asg_c', api });
      assert.equal(res.hooks['pre-commit'], 'chained');
      assert.deepEqual(hooks.fingerprint(`${foreign}.tc-chained`), before);
      setState('asg_c', 'active');
      assert.equal(tryCommit(dir).ok, false, 'the chained hook exits 3, so git refuses');
      assert.ok(fs.existsSync(path.join(path.dirname(dir), 'chain-ran')));
      setState('asg_c', 'held');
      fs.rmSync(path.join(path.dirname(dir), 'chain-ran'));
      assert.equal(tryCommit(dir).ok, false);
      assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'chain-ran')), 'a held lane never reaches the chained hook');
    });

    it('a symlinked hook is kept as the same symlink, not dereferenced', () => {
      const dir = repo('link');
      const hooksDir = hooks.locate(dir).hooksDir;
      const real = path.join(tmpDir, `real-hook-${path.basename(dir)}`);
      script(real, '#!/bin/sh\nexit 0\n');
      fs.symlinkSync(real, path.join(hooksDir, 'pre-commit'));
      hooks.install(dir, { assignmentId: 'asg_l', api });
      const chained = hooks.fingerprint(path.join(hooksDir, 'pre-commit.tc-chained'));
      assert.equal(chained.type, 'symlink');
      assert.equal(chained.linkTarget, real);
    });

    it('pre-push arguments and stdin reach the chained hook byte-exact', () => {
      const dir = repo('push');
      const bare = fs.mkdtempSync(path.join(tmpDir, 'bare-'));
      initRepo(bare, ['--bare']);
      execSync(`git remote add origin ${bare}`, { cwd: dir, shell: '/bin/sh' });
      const hooksDir = hooks.locate(dir).hooksDir;
      const out = path.join(tmpDir, `push-seen-${path.basename(dir)}`);
      script(path.join(hooksDir, 'pre-push'), `#!/bin/sh\nprintf '%s|' "$@" > ${out}\ncat >> ${out}\nexit 0\n`);
      hooks.install(dir, { assignmentId: 'asg_p', api });
      setState('asg_p', 'active');
      execSync('git push -q origin main', { cwd: dir });
      const seen = fs.readFileSync(out, 'utf8');
      const head = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
      assert.ok(seen.startsWith(`origin|${bare}|`), seen);
      assert.match(seen, new RegExp(`refs/heads/main ${head} refs/heads/main 0{40}`));
    });

    it('the chained hook\'s signal death propagates through the dispatcher', () => {
      const dir = repo('signal');
      const hooksDir = hooks.locate(dir).hooksDir;
      script(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nkill -TERM $$\n');
      hooks.install(dir, { assignmentId: 'asg_s', api });
      hooks.unmark(dir);
      const r = spawnSync(path.join(hooksDir, 'pre-commit'), [], { cwd: dir });
      assert.equal(r.signal, 'SIGTERM');
    });

    it('an unexplained .tc-chained file is a collision: install refuses and changes nothing', () => {
      const dir = repo('collide');
      const hooksDir = hooks.locate(dir).hooksDir;
      script(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 0\n');
      script(path.join(hooksDir, 'pre-commit.tc-chained'), '#!/bin/sh\nexit 0\n# someone else\n');
      const before = [hooks.fingerprint(path.join(hooksDir, 'pre-commit')), hooks.fingerprint(path.join(hooksDir, 'pre-commit.tc-chained'))];
      assert.throws(() => hooks.install(dir, { assignmentId: 'asg_x', api }), (e) => e.code === 'CHAINED_COLLISION');
      assert.deepEqual([hooks.fingerprint(path.join(hooksDir, 'pre-commit')), hooks.fingerprint(path.join(hooksDir, 'pre-commit.tc-chained'))], before);
    });

    it('an install interrupted at any step rolls back to the original exactly', () => {
      for (const failAt of ['writeFile', 'rename:1', 'rename:2']) {
        const dir = repo(`rollback-${failAt.replace(':', '')}`);
        const hooksDir = hooks.locate(dir).hooksDir;
        const foreign = path.join(hooksDir, 'pre-commit');
        script(foreign, '#!/bin/sh\nexit 0\n# original\n', 0o700);
        const before = hooks.fingerprint(foreign);
        const orig = { ...hooks._internal };
        let renames = 0;
        hooks._internal.writeFile = (...a) => { if (failAt === 'writeFile') throw new Error('disk full'); return orig.writeFile(...a); };
        hooks._internal.rename = (...a) => {
          renames += 1;
          if (failAt === `rename:${renames}`) throw new Error('interrupted');
          return orig.rename(...a);
        };
        try {
          assert.throws(() => hooks.install(dir, { assignmentId: 'asg_r', api }), (e) => e.code === 'INSTALL_FAILED', failAt);
        } finally {
          Object.assign(hooks._internal, orig);
        }
        assert.deepEqual(hooks.fingerprint(foreign), before, `${failAt}: the original is back`);
        assert.equal(fs.existsSync(`${foreign}.tc-chained`), false, failAt);
        assert.deepEqual(fs.readdirSync(hooksDir).filter((f) => f.includes('.tc-tmp-')), [], `${failAt}: no temp left`);
      }
    });
  });

  describe('refresh and uninstall', () => {
    it('refresh is idempotent; uninstall restores a chained hook byte-for-byte and removes the sidecar', () => {
      const dir = repo('uninstall');
      const hooksDir = hooks.locate(dir).hooksDir;
      const foreign = path.join(hooksDir, 'pre-push');
      script(foreign, '#!/bin/sh\nexit 0\n# mine\n', 0o711);
      const before = hooks.fingerprint(foreign);
      hooks.install(dir, { assignmentId: 'asg_u', api });
      const again = hooks.install(dir, { assignmentId: 'asg_u', api });
      assert.deepEqual(again.hooks, { 'pre-commit': 'unchanged', 'pre-push': 'unchanged' });
      assert.deepEqual(hooks.uninstall(dir), { 'pre-commit': 'removed', 'pre-push': 'restored' });
      assert.deepEqual(hooks.fingerprint(foreign), before);
      assert.equal(fs.existsSync(path.join(hooksDir, hooks.SIDECAR_FILE)), false);
    });

    it('uninstall refuses, with recovery steps, when the chained hook was modified, and overwrites nothing', () => {
      const dir = repo('modified');
      const hooksDir = hooks.locate(dir).hooksDir;
      script(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 0\n');
      hooks.install(dir, { assignmentId: 'asg_m', api });
      fs.appendFileSync(path.join(hooksDir, 'pre-commit.tc-chained'), '# edited later\n');
      const edited = hooks.fingerprint(path.join(hooksDir, 'pre-commit.tc-chained'));
      assert.throws(() => hooks.uninstall(dir), (e) => e.code === 'CHAINED_MODIFIED' && /mv .*pre-commit\.tc-chained/.test(e.message));
      assert.deepEqual(hooks.fingerprint(path.join(hooksDir, 'pre-commit.tc-chained')), edited);
    });

    it('uninstall leaves a hook TangleClaw did not write alone', () => {
      const dir = repo('notmine');
      const hooksDir = hooks.locate(dir).hooksDir;
      script(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 0\n');
      assert.throws(() => hooks.uninstall(dir), (e) => e.code === 'NOT_OWNED');
    });
  });

  describe('tracked hooks path', () => {
    it('a core.hooksPath inside the work tree is never modified and is reported UNPROTECTED', () => {
      const dir = repo('husky');
      fs.mkdirSync(path.join(dir, '.husky'));
      script(path.join(dir, '.husky', 'pre-commit'), '#!/bin/sh\nexit 0\n');
      execSync('git add .husky && git commit -q -m husky && git config core.hooksPath .husky', { cwd: dir, shell: '/bin/sh' });
      const before = fs.readdirSync(path.join(dir, '.husky')).map((f) => [f, hooks.fingerprint(path.join(dir, '.husky', f))]);
      const res = hooks.install(dir, { assignmentId: 'asg_h', api });
      assert.equal(res.protected, false);
      assert.match(res.reason, /UNPROTECTED/);
      assert.deepEqual(fs.readdirSync(path.join(dir, '.husky')).map((f) => [f, hooks.fingerprint(path.join(dir, '.husky', f))]), before);
      assert.equal(hooks.status(dir).protected, false);
      assert.equal(execSync('git status --porcelain', { cwd: dir }).toString(), '', 'nothing tracked changed');
    });
  });
});
