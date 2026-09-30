'use strict';

/**
 * Synthetic `soak-*` repositories for the release-candidate soak (#2020).
 *
 * The soak's load launches and kills sessions in projects that must already
 * exist on the target. This creates them: one work repo per project under a
 * projects root, each with a bare origin on the local filesystem, never a
 * network remote.
 *
 * Three properties matter for evidence:
 *
 * - **Deterministic.** Every repo's first commit (the seed) is built from a
 *   fixed tree, identity, date and message, with the caller's git
 *   configuration and environment kept out, so its SHA is the same on every
 *   machine and every run. `expectedSeedSha` computes it without git, and the
 *   created commit is checked against it.
 * - **Exactly owned.** Each work repo and its origin carry `soak.owner` in
 *   their own git config, and the seed commit carries `.soak-synthetic.json`.
 *   Anything else found at a repo's path, including an empty directory or a
 *   repo with a different marker or remote, is refused and left untouched.
 *   Every path is inspected before anything is created, so a refusal creates
 *   nothing.
 * - **Idempotent.** A repo that is already owned is reported `present` and not
 *   written to. A missing work repo whose owned origin survived (a crash
 *   between the two renames below) is rebuilt by cloning that origin.
 *
 * Each repo is assembled in a staging directory beside its final path and
 * renamed into place, origin first. A crash therefore never leaves a marked
 * repo without its seed at a final path.
 *
 * Filesystem only: registering the repos as TangleClaw projects happens in
 * the guest, through its own API (`deploy/soak/guest/guest-setup.sh`).
 *
 * @module lib/soak/repos
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const schedule = require('./schedule');

const SCHEMA = 'tc.soak-repos/v1';

/** The engine profile the seeded project config names (`deploy/soak/stub-engine/`). */
const STUB_ENGINE_ID = 'soak-stub';

/** Fixed identity and date for the seed commit: 2026-01-01T00:00:00Z. */
const SEED_IDENTITY = Object.freeze({ name: 'TangleClaw Soak', email: 'soak@tangleclaw.invalid' });
const SEED_EPOCH_S = 1767225600;

/** Closed set of refusal codes. */
const REFUSAL = Object.freeze({
  BAD_ROOTS: 'BAD_ROOTS',
  BAD_PROJECTS: 'BAD_PROJECTS',
  NOT_OWNED: 'NOT_OWNED',
  SEED_MISMATCH: 'SEED_MISMATCH',
  GIT_FAILED: 'GIT_FAILED'
});

/** A refusal with a stable `code` and structured `details`. */
class RepoRefusal extends Error {
  /**
   * @param {string} code - One of `REFUSAL`
   * @param {string} message - Human-readable reason
   * @param {object} [details] - Structured context
   */
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/**
 * The value `soak.owner` must hold for a project's repos.
 * @param {string} name - Project name
 * @returns {string} Marker value
 */
function ownerMarker(name) {
  return `${SCHEMA}:${name}`;
}

/**
 * The seed tree for a project, as flat files. Paths use `/`.
 * @param {string} name - Project name
 * @returns {{path: string, content: string}[]} Files
 */
function seedFiles(name) {
  return [
    {
      path: '.soak-synthetic.json',
      content: `${JSON.stringify({ schema: SCHEMA, name, synthetic: true, note: 'Synthetic soak repository. Holds no real code, credentials or data.' }, null, 2)}\n`
    },
    {
      // An attach keeps an existing project.json, so the project runs the stub
      // engine, joins the switchboard (the Medusa cycle waits for its listener),
      // and wraps with no pull request and no release: the guest is offline.
      path: '.tangleclaw/project.json',
      content: `${JSON.stringify({ engine: STUB_ENGINE_ID, medusaEnabled: true, wrapAutoPrEnabled: false, releaseMode: 'off' }, null, 2)}\n`
    },
    {
      // Committed so the candidate's startup sync, which writes this file only
      // when it is missing, leaves nothing untracked for a wrap to refuse.
      path: '.tangleclaw/memories/MEMORY.md',
      content: '# Session Memory\n\nThis file persists context across AI sessions. Update it with key decisions, progress, and open questions.\n'
    },
    {
      // The plan the plans read expects to find listed.
      path: '.tangleclaw/plans/soak-plan.md',
      content: `# ${name} soak plan\n\nA synthetic plan for the TangleClaw release-candidate soak.\n`
    },
    {
      // Present so an attach has no changelog to scaffold into the work tree.
      path: 'CHANGELOG.md',
      content: `# Changelog\n\nAll notable changes to ${name} are documented in this file.\n\n## [Unreleased]\n`
    },
    {
      path: 'README.md',
      content: `# ${name}\n\nA synthetic repository for the TangleClaw release-candidate soak. Its origin is a local bare repository.\n`
    },
    {
      path: 'src/index.js',
      content: `'use strict';\n\nmodule.exports = { name: ${JSON.stringify(name)} };\n`
    }
  ];
}

/**
 * The seed commit's message, as git stores it.
 * @param {string} name - Project name
 * @returns {string} Message, ending in a newline
 */
function seedMessage(name) {
  return `Seed ${name} (synthetic soak repository)\n`;
}

/**
 * A git object id, computed the way git does.
 * @param {string} type - `blob`, `tree` or `commit`
 * @param {Buffer} body - Object body
 * @returns {Buffer} 20-byte SHA-1
 */
function objectId(type, body) {
  return crypto.createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest();
}

/**
 * The tree id of a nested file map.
 * @param {object} node - `{name: string|object}`: a string is a file, an object a directory
 * @returns {Buffer} 20-byte tree id
 */
function treeId(node) {
  // Git orders entries by name, comparing a directory as if its name ended in `/`.
  const key = (n) => (typeof node[n] === 'string' ? n : `${n}/`);
  const names = Object.keys(node).sort((a, b) => Buffer.compare(Buffer.from(key(a)), Buffer.from(key(b))));
  const parts = names.map((n) => {
    const isFile = typeof node[n] === 'string';
    const id = isFile ? objectId('blob', Buffer.from(node[n])) : treeId(node[n]);
    return Buffer.concat([Buffer.from(`${isFile ? '100644' : '40000'} ${n}\0`), id]);
  });
  return objectId('tree', Buffer.concat(parts));
}

/**
 * The seed commit's SHA, computed without git, so the created commit can be
 * checked against an independent derivation.
 * @param {string} name - Project name
 * @returns {string} 40-hex commit id
 */
function expectedSeedSha(name) {
  const root = {};
  for (const f of seedFiles(name)) {
    const segs = f.path.split('/');
    let dir = root;
    for (const s of segs.slice(0, -1)) dir = (dir[s] = dir[s] || {});
    dir[segs[segs.length - 1]] = f.content;
  }
  const who = `${SEED_IDENTITY.name} <${SEED_IDENTITY.email}> ${SEED_EPOCH_S} +0000`;
  const body = `tree ${treeId(root).toString('hex')}\nauthor ${who}\ncommitter ${who}\n\n${seedMessage(name)}`;
  return objectId('commit', Buffer.from(body)).toString('hex');
}

/**
 * The environment git runs under: the caller's, minus every `GIT_*` variable
 * and with global and system config ignored, plus the seed identity. Nothing
 * the operator configured can change a seed SHA or run a hook.
 * @returns {Object<string, string>} Environment
 */
function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  const date = `${SEED_EPOCH_S} +0000`;
  return Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: SEED_IDENTITY.name,
    GIT_AUTHOR_EMAIL: SEED_IDENTITY.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: SEED_IDENTITY.name,
    GIT_COMMITTER_EMAIL: SEED_IDENTITY.email,
    GIT_COMMITTER_DATE: date
  });
}

/** Per-invocation settings that keep repo-local config out of the seed as well. */
const GIT_FLAGS = Object.freeze([
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.autocrlf=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'commit.gpgsign=false',
  '-c', 'init.defaultBranch=main'
]);

/**
 * Run git and return trimmed stdout.
 * @param {string} cwd - Working directory
 * @param {string[]} args - Arguments
 * @returns {string} Stdout
 * @throws {RepoRefusal} `GIT_FAILED` when git exits non-zero or cannot start
 */
function runGit(cwd, args) {
  try {
    return execFileSync('git', [...GIT_FLAGS, ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : err.message;
    throw new RepoRefusal(REFUSAL.GIT_FAILED, `git ${args.join(' ')} failed in ${cwd}: ${stderr}`, { cwd, args, status: err.status ?? null, stderr });
  }
}

/**
 * Run git as a yes/no probe: exit 0 answers true, any other answer false.
 * @param {string} cwd - Working directory
 * @param {string[]} args - Arguments
 * @returns {string|null} Trimmed stdout on success, null otherwise
 */
function probeGit(cwd, args) {
  try {
    return runGit(cwd, args);
  } catch (err) {
    if (err instanceof RepoRefusal) return null;
    throw err;
  }
}

/**
 * Check the roots: absolute, distinct, not nested, and directories when present.
 * @param {string} root - Projects root
 * @param {string} origins - Origins root
 * @returns {{root: string, origins: string}} Normalized roots
 * @throws {RepoRefusal} `BAD_ROOTS`
 */
function checkRoots(root, origins) {
  for (const [flag, p] of [['root', root], ['origins', origins]]) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new RepoRefusal(REFUSAL.BAD_ROOTS, `${flag} must be an absolute path`, { [flag]: p ?? null });
  }
  const r = path.resolve(root);
  const o = path.resolve(origins);
  const within = (a, b) => a === b || a.startsWith(b + path.sep);
  if (within(r, o) || within(o, r)) throw new RepoRefusal(REFUSAL.BAD_ROOTS, 'root and origins must be separate, non-nested directories', { root: r, origins: o });
  for (const p of [r, o]) {
    if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) throw new RepoRefusal(REFUSAL.BAD_ROOTS, `${p} exists and is not a directory`, { path: p });
  }
  return { root: r, origins: o };
}

/**
 * Check the project list against the schedule's own limits, so the repos and
 * the load can never disagree about what a synthetic name is.
 * @param {string[]} [projects] - Names; defaults to the schedule's
 * @returns {string[]} Names
 * @throws {RepoRefusal} `BAD_PROJECTS`
 */
function checkProjects(projects) {
  const list = projects === undefined ? [...schedule.DEFAULTS.projects] : projects;
  const { projectPattern, maxProjects } = schedule.LIMITS;
  if (!Array.isArray(list) || list.length === 0 || list.length > maxProjects
    || !list.every((n) => typeof n === 'string' && projectPattern.test(n)) || new Set(list).size !== list.length) {
    throw new RepoRefusal(REFUSAL.BAD_PROJECTS, `projects must be 1-${maxProjects} distinct synthetic names matching ${projectPattern}`, { projects: list });
  }
  return list;
}

/**
 * Whether `p` is itself a git repository root of the wanted kind, not a plain
 * directory that git resolves to an enclosing repository.
 * @param {string} p - Path
 * @param {boolean} bare - Whether a bare repository is wanted
 * @returns {boolean} True when it is
 */
function isRepoRoot(p, bare) {
  const gitDir = probeGit(p, ['rev-parse', '--absolute-git-dir']);
  if (gitDir === null) return false;
  const real = fs.realpathSync(p);
  const want = bare ? real : path.join(real, '.git');
  return fs.realpathSync(gitDir) === want && probeGit(p, ['rev-parse', '--is-bare-repository']) === String(bare);
}

/**
 * Inspect one path: absent, owned, or something to refuse.
 * @param {string} p - Repo path
 * @param {object} want - `{name, bare, seed, originPath}`; `originPath` only for a work repo
 * @returns {{state: 'absent'}|{state: 'owned'}|{state: 'foreign', found: string}} Finding
 */
function inspect(p, want) {
  if (!fs.existsSync(p)) {
    // A dangling symlink is not absent: something was put here.
    try {
      fs.lstatSync(p);
      return { state: 'foreign', found: 'a dangling symlink' };
    } catch (err) {
      if (err.code === 'ENOENT') return { state: 'absent' };
      throw err;
    }
  }
  if (fs.lstatSync(p).isSymbolicLink()) return { state: 'foreign', found: 'a symlink' };
  if (!fs.statSync(p).isDirectory()) return { state: 'foreign', found: 'a file' };
  if (!isRepoRoot(p, want.bare)) return { state: 'foreign', found: want.bare ? 'not a bare git repository' : 'not a git repository root' };
  const marker = probeGit(p, ['config', '--local', '--get', 'soak.owner']);
  if (marker !== ownerMarker(want.name)) return { state: 'foreign', found: marker === null ? 'no soak.owner marker' : `soak.owner ${JSON.stringify(marker)}` };
  if (!want.bare) {
    const url = probeGit(p, ['config', '--local', '--get', 'remote.origin.url']);
    if (url !== want.originPath) return { state: 'foreign', found: `origin remote ${JSON.stringify(url)}` };
  }
  const tip = want.bare ? 'refs/heads/main' : 'HEAD';
  if (probeGit(p, ['merge-base', '--is-ancestor', want.seed, tip]) === null) return { state: 'foreign', found: `no seed commit ${want.seed} on ${tip}` };
  return { state: 'owned' };
}

/**
 * A fresh staging directory beside `finalPath`, on the same filesystem so the
 * final rename is atomic.
 * @param {string} finalPath - Where the repo will live
 * @returns {string} Staging path
 */
function stagingPath(finalPath) {
  return path.join(path.dirname(finalPath), `.soak-staging-${path.basename(finalPath)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
}

/**
 * Rename a finished staging directory to its final path. Something that
 * appeared there after the inspection is refused, not merged into or
 * replaced. rename(2) silently replaces an empty directory, so the path is
 * checked first; a directory created in the instant between that check and
 * the rename can still be replaced, but only if it is empty.
 * @param {string} staging - Built repo
 * @param {string} finalPath - Destination
 * @throws {RepoRefusal} `NOT_OWNED` when the destination is now occupied
 */
function place(staging, finalPath) {
  const occupied = (found) => new RepoRefusal(REFUSAL.NOT_OWNED, `${finalPath} appeared while it was being created; refusing to replace it`, { path: finalPath, found });
  try {
    fs.lstatSync(finalPath);
    throw occupied('occupied before rename');
  } catch (err) {
    if (err instanceof RepoRefusal) throw err;
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    fs.renameSync(staging, finalPath);
  } catch (err) {
    if (err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST' && err.code !== 'ENOTDIR') throw err;
    throw occupied(`occupied at rename (${err.code})`);
  }
}

/**
 * Run `build(staging)` in a staging directory, then rename it to `finalPath`.
 * The staging directory is removed if the build fails.
 * @param {string} finalPath - Destination
 * @param {(staging: string) => void} build - Builder
 */
function buildInto(finalPath, build) {
  const staging = stagingPath(finalPath);
  try {
    build(staging);
    place(staging, finalPath);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Create both repos for a project from nothing.
 * @param {object} spec - `{name, workPath, originPath, seed}`
 * @throws {RepoRefusal} `SEED_MISMATCH` when git's commit differs from the computed seed
 */
function createBoth(spec) {
  const { name, workPath, originPath, seed } = spec;
  const workStage = stagingPath(workPath);
  try {
    fs.mkdirSync(workStage);
    runGit(workStage, ['init', '-q', '-b', 'main']);
    runGit(workStage, ['config', 'soak.owner', ownerMarker(name)]);
    for (const f of seedFiles(name)) {
      const target = path.join(workStage, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content);
    }
    runGit(workStage, ['add', '-A']);
    runGit(workStage, ['commit', '-q', '--no-verify', '--cleanup=verbatim', '-m', seedMessage(name).trimEnd()]);
    const head = runGit(workStage, ['rev-parse', 'HEAD']);
    if (head !== seed) throw new RepoRefusal(REFUSAL.SEED_MISMATCH, `seed commit for ${name} is ${head}, expected ${seed}`, { name, head, expected: seed });

    buildInto(originPath, (originStage) => {
      runGit(path.dirname(originStage), ['init', '-q', '--bare', '-b', 'main', originStage]);
      runGit(originStage, ['config', 'soak.owner', ownerMarker(name)]);
      runGit(workStage, ['push', '-q', originStage, 'main:refs/heads/main']);
    });
    runGit(workStage, ['remote', 'add', 'origin', originPath]);
    runGit(workStage, ['update-ref', 'refs/remotes/origin/main', seed]);
    runGit(workStage, ['branch', '-q', '--set-upstream-to=origin/main', 'main']);
    place(workStage, workPath);
  } finally {
    fs.rmSync(workStage, { recursive: true, force: true });
  }
}

/**
 * Rebuild a missing work repo from its surviving, owned origin.
 * @param {object} spec - `{name, workPath, originPath}`
 */
function cloneWork(spec) {
  buildInto(spec.workPath, (stage) => {
    runGit(path.dirname(stage), ['clone', '-q', '--no-hardlinks', '--origin', 'origin', spec.originPath, stage]);
    runGit(stage, ['config', 'soak.owner', ownerMarker(spec.name)]);
  });
}

/**
 * Create the synthetic repos, or confirm they are already exactly as this
 * module would create them.
 * @param {object} opts - Options
 * @param {string} opts.root - Absolute projects root; each repo is `<root>/<name>`
 * @param {string} opts.origins - Absolute origins root; each origin is `<origins>/<name>.git`
 * @param {string[]} [opts.projects] - Project names; defaults to the schedule's
 * @returns {{schema: string, digest: string, root: string, origins: string, repos: object[]}} Result
 * @throws {RepoRefusal} On bad input, anything not exactly owned, or a git failure
 */
function ensureRepos(opts) {
  const { root, origins } = checkRoots(opts.root, opts.origins);
  const projects = checkProjects(opts.projects);
  const specs = projects.map((name) => ({
    name,
    workPath: path.join(root, name),
    originPath: path.join(origins, `${name}.git`),
    seed: expectedSeedSha(name)
  }));

  // Inspect everything before writing anything, so a refusal creates nothing.
  const plans = specs.map((s) => {
    const origin = inspect(s.originPath, { name: s.name, bare: true, seed: s.seed });
    const work = inspect(s.workPath, { name: s.name, bare: false, seed: s.seed, originPath: s.originPath });
    for (const [p, f] of [[s.originPath, origin], [s.workPath, work]]) {
      if (f.state === 'foreign') throw new RepoRefusal(REFUSAL.NOT_OWNED, `${p} is ${f.found}; refusing to touch a path this tool does not own`, { name: s.name, path: p, found: f.found });
    }
    // Origin is renamed into place first, so an owned work repo without its
    // origin was not left by this tool.
    if (work.state === 'owned' && origin.state === 'absent') {
      throw new RepoRefusal(REFUSAL.NOT_OWNED, `${s.workPath} is owned but its origin ${s.originPath} is missing`, { name: s.name, path: s.originPath, found: 'missing origin' });
    }
    return { spec: s, action: origin.state === 'absent' ? 'create' : work.state === 'absent' ? 'clone' : 'present' };
  });

  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(origins, { recursive: true });
  const results = plans.map(({ spec, action }) => {
    if (action === 'create') createBoth(spec);
    if (action === 'clone') cloneWork(spec);
    const head = runGit(spec.workPath, ['rev-parse', 'HEAD']);
    const originMain = runGit(spec.originPath, ['rev-parse', 'refs/heads/main']);
    return {
      name: spec.name,
      status: action === 'present' ? 'present' : 'created',
      workPath: spec.workPath,
      originPath: spec.originPath,
      seedSha: spec.seed,
      head,
      originMain,
      pristine: head === spec.seed && originMain === spec.seed
    };
  });

  const digest = crypto.createHash('sha256')
    .update(JSON.stringify({ schema: SCHEMA, repos: specs.map((s) => [s.name, s.seed]).sort() }))
    .digest('hex');
  return { schema: SCHEMA, digest, root, origins, repos: results };
}

module.exports = {
  SCHEMA,
  REFUSAL,
  RepoRefusal,
  ownerMarker,
  seedFiles,
  expectedSeedSha,
  ensureRepos
};
