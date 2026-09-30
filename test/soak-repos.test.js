'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repos = require('../lib/soak/repos');
const cli = require('../scripts/soak');

/**
 * Run git outside the module, with the caller's environment, for assertions.
 * @param {string} cwd - Working directory
 * @param {string[]} args - Git arguments
 * @returns {string} Trimmed stdout
 */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

/**
 * A writable that collects what is written.
 * @returns {{write: (s: string) => void, text: () => string}} Sink
 */
function sink() {
  let buf = '';
  return { write: (s) => { buf += s; }, text: () => buf };
}

/**
 * Run the CLI with collected output.
 * @param {string[]} argv - Arguments
 * @returns {Promise<{code: number, out: string, err: string}>} Result
 */
async function run(argv) {
  const stdout = sink();
  const stderr = sink();
  const code = await cli.main(argv, { stdout, stderr, env: {}, onStopSignal: () => {} });
  return { code, out: stdout.text(), err: stderr.text() };
}

/**
 * Every file under a directory, relative, sorted, with its contents, so two
 * trees can be compared for "nothing changed".
 * @param {string} dir - Directory
 * @returns {string[]} `path:size:mtimeMs` lines
 */
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out.push(`${path.relative(dir, p)}:${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

describe('soak repos: seed', () => {
  it('computes the same seed SHA for a name every time, and a different one per name', () => {
    assert.equal(repos.expectedSeedSha('soak-a'), repos.expectedSeedSha('soak-a'));
    assert.notEqual(repos.expectedSeedSha('soak-a'), repos.expectedSeedSha('soak-b'));
    assert.match(repos.expectedSeedSha('soak-a'), /^[0-9a-f]{40}$/);
  });

  it('seeds a synthetic marker, a changelog, and a project config naming the stub engine', () => {
    const files = Object.fromEntries(repos.seedFiles('soak-a').map((f) => [f.path, f.content]));
    assert.deepEqual(JSON.parse(files['.soak-synthetic.json']).name, 'soak-a');
    assert.equal(JSON.parse(files['.soak-synthetic.json']).schema, repos.SCHEMA);
    assert.equal(JSON.parse(files['.tangleclaw/project.json']).engine, 'soak-stub');
    assert.ok(files['CHANGELOG.md'].includes('## [Unreleased]'));
  });
});

describe('soak repos: ensureRepos', () => {
  let tmp;
  let root;
  let origins;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-repos-'));
    root = path.join(tmp, 'projects');
    origins = path.join(tmp, 'origins');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates each repo with a local bare origin whose seed commit matches the independent computation', () => {
    const result = repos.ensureRepos({ root, origins });
    assert.deepEqual(result.repos.map((r) => r.name), ['soak-a', 'soak-b', 'soak-c']);
    for (const r of result.repos) {
      assert.equal(r.status, 'created');
      assert.equal(r.seedSha, repos.expectedSeedSha(r.name));
      assert.equal(r.head, r.seedSha);
      assert.equal(r.pristine, true);
      assert.equal(r.workPath, path.join(root, r.name));
      assert.equal(r.originPath, path.join(origins, `${r.name}.git`));
      assert.equal(git(r.workPath, ['rev-parse', 'HEAD']), r.seedSha);
      assert.equal(git(r.originPath, ['rev-parse', 'refs/heads/main']), r.seedSha);
      assert.equal(git(r.originPath, ['rev-parse', '--is-bare-repository']), 'true');
      assert.equal(git(r.workPath, ['remote', 'get-url', 'origin']), r.originPath);
      assert.equal(git(r.workPath, ['rev-parse', '--abbrev-ref', '@{upstream}']), 'origin/main');
      assert.equal(git(r.workPath, ['config', 'soak.owner']), `${repos.SCHEMA}:${r.name}`);
      assert.equal(git(r.originPath, ['config', 'soak.owner']), `${repos.SCHEMA}:${r.name}`);
      assert.equal(git(r.workPath, ['status', '--porcelain']), '');
    }
    assert.match(result.digest, /^[0-9a-f]{64}$/);
    assert.equal(result.schema, repos.SCHEMA);
  });

  it('gives identical seed SHAs and digest in two independent roots', () => {
    const a = repos.ensureRepos({ root, origins });
    const b = repos.ensureRepos({ root: path.join(tmp, 'p2'), origins: path.join(tmp, 'o2') });
    assert.deepEqual(a.repos.map((r) => r.seedSha), b.repos.map((r) => r.seedSha));
    assert.equal(a.digest, b.digest);
  });

  it('is idempotent: a second run reports present and changes nothing on disk', () => {
    repos.ensureRepos({ root, origins });
    const before = snapshot(tmp);
    const again = repos.ensureRepos({ root, origins });
    assert.deepEqual(again.repos.map((r) => r.status), ['present', 'present', 'present']);
    assert.deepEqual(snapshot(tmp), before);
  });

  it('honours a custom project list, and the digest names the set', () => {
    const one = repos.ensureRepos({ root, origins, projects: ['soak-x'] });
    assert.deepEqual(one.repos.map((r) => r.name), ['soak-x']);
    const three = repos.ensureRepos({ root: path.join(tmp, 'p2'), origins: path.join(tmp, 'o2') });
    assert.notEqual(one.digest, three.digest);
  });

  it('refuses a non-synthetic, duplicate or empty project list', () => {
    for (const projects of [['real-project'], ['soak-a', 'soak-a'], [], ['soak-A']]) {
      assert.throws(() => repos.ensureRepos({ root, origins, projects }), (e) => e.code === repos.REFUSAL.BAD_PROJECTS);
    }
    assert.equal(fs.existsSync(root), false);
  });

  it('refuses relative, identical or nested roots', () => {
    const bad = [
      { root: 'projects', origins },
      { root, origins: 'origins' },
      { root, origins: root },
      { root, origins: path.join(root, 'origins') },
      { root: path.join(origins, 'projects'), origins }
    ];
    for (const opts of bad) {
      assert.throws(() => repos.ensureRepos(opts), (e) => e.code === repos.REFUSAL.BAD_ROOTS, JSON.stringify(opts));
    }
  });

  it('refuses a root that is a file', () => {
    fs.writeFileSync(path.join(tmp, 'file'), 'x');
    assert.throws(() => repos.ensureRepos({ root: path.join(tmp, 'file'), origins }), (e) => e.code === repos.REFUSAL.BAD_ROOTS);
  });

  it('refuses a foreign directory at a repo path, and creates nothing for any repo', () => {
    fs.mkdirSync(path.join(root, 'soak-b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'soak-b', 'mine.txt'), 'operator data');
    assert.throws(() => repos.ensureRepos({ root, origins }), (e) => {
      assert.equal(e.code, repos.REFUSAL.NOT_OWNED);
      assert.equal(e.details.path, path.join(root, 'soak-b'));
      return true;
    });
    assert.equal(fs.existsSync(path.join(root, 'soak-a')), false);
    assert.equal(fs.existsSync(path.join(origins, 'soak-a.git')), false);
    assert.equal(fs.readFileSync(path.join(root, 'soak-b', 'mine.txt'), 'utf8'), 'operator data');
  });

  it('refuses a symlink at a repo path, even one pointing at an owned repo, and a dangling one', () => {
    repos.ensureRepos({ root: path.join(tmp, 'real'), origins, projects: ['soak-a'] });
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(path.join(tmp, 'real', 'soak-a'), path.join(root, 'soak-a'));
    assert.throws(() => repos.ensureRepos({ root, origins, projects: ['soak-a'] }), (e) => e.code === repos.REFUSAL.NOT_OWNED && /symlink/.test(e.details.found));
    fs.symlinkSync(path.join(tmp, 'nowhere'), path.join(root, 'soak-b'));
    assert.throws(() => repos.ensureRepos({ root, origins, projects: ['soak-b'] }), (e) => e.code === repos.REFUSAL.NOT_OWNED && /dangling/.test(e.details.found));
  });

  it('refuses an empty directory at a repo path', () => {
    fs.mkdirSync(path.join(origins, 'soak-a.git'), { recursive: true });
    assert.throws(() => repos.ensureRepos({ root, origins }), (e) => e.code === repos.REFUSAL.NOT_OWNED);
  });

  it('refuses a plain directory that only looks like a repo because the root sits inside another repo', () => {
    git(tmp, ['init', '-q']);
    fs.mkdirSync(path.join(root, 'soak-a'), { recursive: true });
    assert.throws(() => repos.ensureRepos({ root, origins }), (e) => e.code === repos.REFUSAL.NOT_OWNED);
  });

  it('refuses a repo whose ownership marker is wrong or missing', () => {
    repos.ensureRepos({ root, origins });
    git(path.join(root, 'soak-a'), ['config', 'soak.owner', 'someone-else']);
    assert.throws(() => repos.ensureRepos({ root, origins }), (e) => e.code === repos.REFUSAL.NOT_OWNED);
    git(path.join(root, 'soak-a'), ['config', '--unset', 'soak.owner']);
    assert.throws(() => repos.ensureRepos({ root, origins }), (e) => e.code === repos.REFUSAL.NOT_OWNED);
  });

  it('refuses an origin whose ownership marker is wrong', () => {
    repos.ensureRepos({ root, origins });
    git(path.join(origins, 'soak-c.git'), ['config', 'soak.owner', `${repos.SCHEMA}:soak-a`]);
    assert.throws(() => repos.ensureRepos({ root, origins }), (e) => e.code === repos.REFUSAL.NOT_OWNED);
  });

  it('refuses a work repo whose origin remote points anywhere but its local bare origin', () => {
    repos.ensureRepos({ root, origins });
    git(path.join(root, 'soak-a'), ['remote', 'set-url', 'origin', 'https://example.invalid/soak-a.git']);
    assert.throws(() => repos.ensureRepos({ root, origins }), (e) => e.code === repos.REFUSAL.NOT_OWNED);
  });

  it('refuses a marked repo that does not contain the seed commit', () => {
    const work = path.join(root, 'soak-a');
    fs.mkdirSync(work, { recursive: true });
    git(work, ['init', '-q', '-b', 'main']);
    git(work, ['config', 'soak.owner', `${repos.SCHEMA}:soak-a`]);
    assert.throws(() => repos.ensureRepos({ root, origins, projects: ['soak-a'] }), (e) => e.code === repos.REFUSAL.NOT_OWNED);
  });

  it('refuses a work repo that is owned while its origin is missing', () => {
    repos.ensureRepos({ root, origins });
    fs.rmSync(path.join(origins, 'soak-b.git'), { recursive: true, force: true });
    assert.throws(() => repos.ensureRepos({ root, origins }), (e) => e.code === repos.REFUSAL.NOT_OWNED);
  });

  it('rebuilds a missing work repo from its owned origin, keeping the origin history', () => {
    repos.ensureRepos({ root, origins, projects: ['soak-a'] });
    const work = path.join(root, 'soak-a');
    fs.writeFileSync(path.join(work, 'later.txt'), 'x');
    git(work, ['add', 'later.txt']);
    git(work, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'later']);
    git(work, ['push', '-q', 'origin', 'main']);
    const later = git(work, ['rev-parse', 'HEAD']);
    fs.rmSync(work, { recursive: true, force: true });

    const result = repos.ensureRepos({ root, origins, projects: ['soak-a'] });
    assert.equal(result.repos[0].status, 'created');
    assert.equal(result.repos[0].head, later);
    assert.equal(result.repos[0].pristine, false);
    assert.equal(git(work, ['config', 'soak.owner']), `${repos.SCHEMA}:soak-a`);
    assert.equal(git(work, ['remote', 'get-url', 'origin']), path.join(origins, 'soak-a.git'));
    assert.equal(repos.ensureRepos({ root, origins, projects: ['soak-a'] }).repos[0].status, 'present');
  });

  it('reports pristine false once the repo moves past its seed, and still owns it', () => {
    repos.ensureRepos({ root, origins, projects: ['soak-a'] });
    const work = path.join(root, 'soak-a');
    fs.writeFileSync(path.join(work, 'later.txt'), 'x');
    git(work, ['add', 'later.txt']);
    git(work, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'later']);
    const r = repos.ensureRepos({ root, origins, projects: ['soak-a'] }).repos[0];
    assert.equal(r.status, 'present');
    assert.equal(r.pristine, false);
    assert.equal(r.seedSha, repos.expectedSeedSha('soak-a'));
  });

  it('is not affected by the caller\'s git environment or identity', () => {
    const saved = { ...process.env };
    try {
      process.env.GIT_AUTHOR_NAME = 'Someone Else';
      process.env.GIT_AUTHOR_DATE = '2001-01-01T00:00:00Z';
      process.env.GIT_COMMITTER_EMAIL = 'x@y';
      process.env.GIT_DIR = path.join(tmp, 'nowhere');
      const r = repos.ensureRepos({ root, origins, projects: ['soak-a'] }).repos[0];
      assert.equal(r.head, repos.expectedSeedSha('soak-a'));
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('leaves no staging directories behind after a successful run', () => {
    repos.ensureRepos({ root, origins });
    assert.deepEqual(fs.readdirSync(root).sort(), ['soak-a', 'soak-b', 'soak-c']);
    assert.deepEqual(fs.readdirSync(origins).sort(), ['soak-a.git', 'soak-b.git', 'soak-c.git']);
  });
});

describe('soak repos: failures mid-build', () => {
  let tmp;
  let root;
  let origins;
  let savedPath;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-repos-fail-'));
    root = path.join(tmp, 'projects');
    origins = path.join(tmp, 'origins');
    // A git wrapper first on PATH makes one step misbehave; everything else
    // reaches the real git. The module strips only GIT_* from the environment,
    // so SOAK_TEST_* reaches the wrapper.
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), [
      '#!/bin/sh',
      'case "$SOAK_TEST_GIT_MODE:$*" in',
      '  seed:*"rev-parse HEAD") case "$(pwd -P)" in *.soak-staging-*) echo 0000000000000000000000000000000000000000; exit 0;; esac;;',
      '  failcommit:*" commit "*) echo "simulated commit failure" >&2; exit 1;;',
      `  race:*"--set-upstream-to=origin/main main") "${realGit}" "$@" || exit $?; mkdir -p "$SOAK_TEST_RACE_PATH"; [ -n "$SOAK_TEST_RACE_EMPTY" ] || echo x > "$SOAK_TEST_RACE_PATH/foreign"; exit 0;;`,
      'esac',
      `exec "${realGit}" "$@"`
    ].join('\n'), { mode: 0o755 });
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    delete process.env.SOAK_TEST_GIT_MODE;
    delete process.env.SOAK_TEST_RACE_PATH;
    delete process.env.SOAK_TEST_RACE_EMPTY;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Names left in a directory, or [] when it does not exist.
   * @param {string} dir - Directory
   * @returns {string[]} Sorted names
   */
  const left = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

  it('refuses a commit that differs from the computed seed, leaving nothing behind', () => {
    process.env.SOAK_TEST_GIT_MODE = 'seed';
    assert.throws(() => repos.ensureRepos({ root, origins, projects: ['soak-a'] }), (e) => {
      assert.equal(e.code, repos.REFUSAL.SEED_MISMATCH);
      assert.equal(e.details.expected, repos.expectedSeedSha('soak-a'));
      return true;
    });
    assert.deepEqual(left(root), []);
    assert.deepEqual(left(origins), []);
  });

  it('reports a git failure and removes its staging directory', () => {
    process.env.SOAK_TEST_GIT_MODE = 'failcommit';
    assert.throws(() => repos.ensureRepos({ root, origins, projects: ['soak-a'] }), (e) => {
      assert.equal(e.code, repos.REFUSAL.GIT_FAILED);
      assert.match(e.details.stderr, /simulated commit failure/);
      return true;
    });
    assert.deepEqual(left(root), []);
    assert.deepEqual(left(origins), []);
  });

  it('refuses to replace a path that appeared after inspection, and the next run refuses it too', () => {
    process.env.SOAK_TEST_GIT_MODE = 'race';
    process.env.SOAK_TEST_RACE_PATH = path.join(root, 'soak-a');
    assert.throws(() => repos.ensureRepos({ root, origins, projects: ['soak-a'] }), (e) => {
      assert.equal(e.code, repos.REFUSAL.NOT_OWNED);
      assert.equal(e.details.path, path.join(root, 'soak-a'));
      return true;
    });
    assert.equal(fs.readFileSync(path.join(root, 'soak-a', 'foreign'), 'utf8'), 'x\n');
    assert.deepEqual(left(root), ['soak-a']);
    delete process.env.SOAK_TEST_GIT_MODE;
    assert.throws(() => repos.ensureRepos({ root, origins, projects: ['soak-a'] }), (e) => e.code === repos.REFUSAL.NOT_OWNED);
  });
  it('refuses to replace even an empty directory that appeared after inspection', () => {
    process.env.SOAK_TEST_GIT_MODE = 'race';
    process.env.SOAK_TEST_RACE_EMPTY = '1';
    process.env.SOAK_TEST_RACE_PATH = path.join(root, 'soak-a');
    assert.throws(() => repos.ensureRepos({ root, origins, projects: ['soak-a'] }), (e) => e.code === repos.REFUSAL.NOT_OWNED && /before rename/.test(e.details.found));
    assert.deepEqual(left(path.join(root, 'soak-a')), []);
    assert.deepEqual(left(root), ['soak-a']);
  });
});

describe('soak repos: no network', () => {
  it('loads only local-filesystem and process modules, never a network one', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'soak', 'repos.js'), 'utf8');
    const required = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
    assert.deepEqual(required, ['./schedule', 'node:child_process', 'node:crypto', 'node:fs', 'node:path']);
  });

  it('names no remote URL: every git remote it can set is the local origin path', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'soak', 'repos.js'), 'utf8');
    assert.doesNotMatch(src, /https?:\/\/|ssh:\/\/|git@|git:\/\//);
    assert.deepEqual([...src.matchAll(/'remote', 'add', 'origin', (\w+)\]/g)].map((m) => m[1]), ['originPath']);
  });
});

describe('soak repos: CLI', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-repos-cli-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the repos and prints the result as JSON', async () => {
    const { code, out } = await run(['repos', '--root', path.join(tmp, 'p'), '--origins', path.join(tmp, 'o'), '--projects', 'soak-a,soak-b']);
    assert.equal(code, 0);
    const result = JSON.parse(out);
    assert.deepEqual(result.repos.map((r) => [r.name, r.status]), [['soak-a', 'created'], ['soak-b', 'created']]);
  });

  it('exits 3 with the refusal as JSON when a path is not owned', async () => {
    fs.mkdirSync(path.join(tmp, 'p', 'soak-a'), { recursive: true });
    const { code, err } = await run(['repos', '--root', path.join(tmp, 'p'), '--origins', path.join(tmp, 'o')]);
    assert.equal(code, 3);
    assert.equal(JSON.parse(err).code, repos.REFUSAL.NOT_OWNED);
  });

  it('exits 2 on a missing flag, and on a refused project list', async () => {
    assert.equal((await run(['repos', '--root', path.join(tmp, 'p')])).code, 2);
    assert.equal((await run(['repos', '--root', path.join(tmp, 'p'), '--origins', path.join(tmp, 'o'), '--projects', 'prod'])).code, 2);
    assert.equal((await run(['repos', '--root', 'rel', '--origins', path.join(tmp, 'o')])).code, 2);
  });
});
