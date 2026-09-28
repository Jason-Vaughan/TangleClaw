'use strict';

/*
 * #1901 — `ingress-cutover --dry-run` is the preflight `deploy/install.sh` runs
 * on a caddy-mode host before it changes anything. A preflight is only as good
 * as the signal it gives, and a dry run used to exit 0 while printing "would
 * REFUSE" for a hand-edited or unreadable Caddyfile, so a caller keyed on the
 * status would have gone ahead. The contract pinned here:
 *
 *   0  the real run would proceed
 *   3  the real run would REFUSE (and why, on stderr)
 *   1  the run could not be planned (e.g. `ttyd-runtime-unavailable`, typed in
 *      the result file, which is what install.sh's bootstrap keys on)
 *   2  usage error
 *
 * The real script runs in a child under a throwaway HOME, which is where the
 * store, the Caddyfile and ~/Library/LaunchAgents all resolve. A dry run
 * reaches no launchctl step; stubs on PATH fail loudly if one ever did. The one
 * seam is a `-r` preload that answers "which ttyd" for the child, because the
 * real resolver probes fixed Homebrew paths and would make the result depend on
 * the machine running the test.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CUTOVER = path.join(REPO_ROOT, 'scripts', 'ingress-cutover.js');
const { DRY_RUN_WOULD_REFUSE_EXIT } = require('../scripts/ingress-cutover');

describe('ingress-cutover --dry-run exit status (#1901)', () => {
  let root;

  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cutover-dryrun-')); });
  after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  /**
   * A fresh sandbox: a HOME, a PATH of stubs that fail if called, and a
   * preload that makes the ttyd runtime resolvable (or not).
   *
   * @param {string} name - Sandbox name.
   * @param {{runtime?: boolean}} [opts] - Whether a ttyd runtime resolves.
   * @returns {{home: string, bin: string, preload: string|null, resultFile: string, caddyfile: string}}
   */
  function sandbox(name, { runtime = true } = {}) {
    const dir = path.join(root, name);
    const home = path.join(dir, 'home');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin);
    for (const tool of ['launchctl', 'mkcert', 'caddy']) {
      fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "STUB ${tool} must not run in a dry run" >&2\nexit 99\n`);
      fs.chmodSync(path.join(bin, tool), 0o755);
    }
    let preload = null;
    if (runtime) {
      preload = path.join(dir, 'ttyd-preload.js');
      fs.writeFileSync(preload, `
        const lib = require(${JSON.stringify(path.join(REPO_ROOT, 'lib', 'ttyd-runtime'))});
        lib.resolveTtydPath = () => ({ path: ${JSON.stringify(path.join(bin, 'ttyd'))}, managed: true });
      `);
    }
    return {
      home, bin, preload,
      resultFile: path.join(dir, 'result.json'),
      caddyfile: path.join(home, '.tangleclaw', 'Caddyfile')
    };
  }

  /**
   * Run the real cutover in the sandbox.
   *
   * @param {object} box - From `sandbox`.
   * @param {string[]} args - Cutover arguments.
   * @returns {{status: number, stdout: string, stderr: string}}
   */
  function cutover(box, args) {
    const nodeArgs = box.preload ? ['-r', box.preload, CUTOVER, ...args] : [CUTOVER, ...args];
    const run = spawnSync(process.execPath, nodeArgs, {
      cwd: REPO_ROOT,
      env: { HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin` },
      encoding: 'utf8',
      timeout: 30000
    });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  }

  /**
   * Materialise the sandbox store, so the Caddyfile path exists to write into.
   *
   * @param {object} box - From `sandbox`.
   * @returns {void}
   */
  function initStore(box) {
    assert.equal(cutover(box, ['--to', 'caddy', '--dry-run']).status, 0, 'a clean sandbox previews cleanly');
    assert.ok(fs.existsSync(path.dirname(box.caddyfile)), 'the sandbox store exists');
  }

  it('pins 3 as the would-refuse status, distinct from 0, 1 and 2', () => {
    assert.equal(DRY_RUN_WOULD_REFUSE_EXIT, 3);
  });

  it('exits 0 when the real run would proceed', () => {
    const box = sandbox('clean');
    const r = cutover(box, ['--to', 'caddy', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[dry-run\] ingress cutover → caddy/);
    assert.doesNotMatch(r.stderr, /REFUSE \(dry run\)/);
  });

  it('exits 3 and names the reason for a hand-edited Caddyfile, and 0 with --force', () => {
    const box = sandbox('hand-edited');
    initStore(box);
    fs.writeFileSync(box.caddyfile, 'localhost:8443 {\n  respond "hand edit"\n}\n');
    const r = cutover(box, ['--to', 'caddy', '--dry-run']);
    assert.equal(r.status, DRY_RUN_WOULD_REFUSE_EXIT, r.stderr);
    assert.match(r.stderr, /REFUSE \(dry run\): the real cutover would refuse: the Caddyfile is hand-edited/);
    assert.equal(fs.readFileSync(box.caddyfile, 'utf8'), 'localhost:8443 {\n  respond "hand edit"\n}\n',
      'a dry run changes nothing');

    const forced = cutover(box, ['--to', 'caddy', '--dry-run', '--force']);
    assert.equal(forced.status, 0, 'with --force the real run would overwrite (after a backup), so it would proceed');
  });

  it('exits 3 and names the reason for an unreadable Caddyfile, which --force does not cover', { skip: process.getuid && process.getuid() === 0 ? 'root reads a mode-000 file' : false }, () => {
    const box = sandbox('unreadable');
    initStore(box);
    fs.writeFileSync(box.caddyfile, 'x\n');
    fs.chmodSync(box.caddyfile, 0o000);
    try {
      for (const args of [['--to', 'caddy', '--dry-run'], ['--to', 'caddy', '--dry-run', '--force']]) {
        const r = cutover(box, args);
        assert.equal(r.status, DRY_RUN_WOULD_REFUSE_EXIT, `${args.join(' ')}: ${r.stderr}`);
        assert.match(r.stderr, /REFUSE \(dry run\): the real cutover would refuse: the Caddyfile cannot be read/);
      }
    } finally {
      fs.chmodSync(box.caddyfile, 0o600);
    }
  });

  it('exits 3 and names the reason when it would replace a gated Caddyfile with an ungated one', () => {
    const box = sandbox('ungate');
    initStore(box);
    // Two users make the credential ambiguous, so the cutover cannot adopt it
    // into config, and the config has none of its own: the regenerated file
    // would drop the gate. (With one user the dry run adopts it and proceeds.)
    const hash = `$2a$14$${'a'.repeat(53)}`; // bcrypt shape: 53 characters after the cost
    fs.writeFileSync(box.caddyfile,
      `localhost:8443 {\n  basic_auth {\n    admin ${hash}\n    other ${hash}\n  }\n  reverse_proxy localhost:3102\n}\n`);
    const r = cutover(box, ['--to', 'caddy', '--dry-run']);
    assert.equal(r.status, DRY_RUN_WOULD_REFUSE_EXIT, r.stderr);
    assert.match(r.stderr, /REFUSE \(dry run\): the real cutover would refuse to replace a gated Caddyfile/);
    assert.ok(!r.stderr.includes(hash) && !r.stdout.includes(hash), 'the credential hash is never echoed');
  });

  it('says in the dry run that an unsupported manual gate will converge to the canonical config', () => {
    const box = sandbox('manual-gate');
    initStore(box);
    fs.writeFileSync(box.caddyfile,
      'localhost:8443 {\n  forward_auth 127.0.0.1:9000 {\n    uri /check\n  }\n  reverse_proxy localhost:3102\n}\n');
    const refused = cutover(box, ['--to', 'caddy', '--dry-run']);
    assert.equal(refused.status, DRY_RUN_WOULD_REFUSE_EXIT, 'a hand edit is still refused without --force');
    const forced = cutover(box, ['--to', 'caddy', '--dry-run', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout,
      /gate change: {5}the existing Caddyfile has a `forward_auth` directive this tool does not generate; the cutover converges to the canonical config/);
    assert.match(refused.stdout, /gate change:.*`forward_auth`/, 'and the refused preview names it too, before any decision');
  });

  it('exits 3 and names the reason when a --tailnet-host move would be refused', () => {
    // A fresh sandbox is in direct mode, so the tailnet validator refuses the
    // move, which is a predicted refusal like the others.
    const box = sandbox('tailnet');
    const r = cutover(box, ['--to', 'caddy', '--tailnet-host', 'nope.example.ts.net', '--dry-run']);
    assert.equal(r.status, DRY_RUN_WOULD_REFUSE_EXIT, r.stderr);
    assert.match(r.stderr, /--tailnet-host moves the site of an install already in caddy mode.*\(ingress untouched\)/);
  });

  it('exits 1 with the typed ttyd-runtime-unavailable code when no runtime resolves', () => {
    const box = sandbox('no-runtime', { runtime: false });
    const r = cutover(box, ['--to', 'caddy', '--dry-run', '--result-file', box.resultFile]);
    assert.equal(r.status, 1, 'an unplannable run is a failure (1), not a predicted refusal (3)');
    const result = JSON.parse(fs.readFileSync(box.resultFile, 'utf8'));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ttyd-runtime-unavailable',
      'install.sh keys its bootstrap on this exact code, so it must be typed, not prose');
  });

  it('exits 2 on a usage error', () => {
    const box = sandbox('usage');
    assert.equal(cutover(box, ['--dry-run']).status, 2);
  });
});
