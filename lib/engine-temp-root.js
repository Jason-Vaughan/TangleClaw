'use strict';

/**
 * A private temp root for an engine whose native features put Unix sockets in a
 * shared temp directory (#1904).
 *
 * Claude Code binds its cross-session messaging socket at
 * `/tmp/cc-socks/<pid>.sock` unless told otherwise, and it refuses any
 * directory on that path that another local user could tamper with: one that is
 * world- or group-writable without the sticky bit, or owned by someone other
 * than the user or root. That refusal is right. It also means one badly-moded
 * `/tmp` (macOS `/private/tmp` at `0777` instead of `1777`) switches native
 * messaging off in every session TangleClaw launches. Claude names its own fix,
 * a private `0700` directory handed over in its temp-dir variable, and this
 * module provisions that directory under TangleClaw's run state.
 *
 * **What it never does:** change the mode of any directory TangleClaw does not
 * own. `/tmp`, `/private/tmp` and every ancestor are only read. The one `chmod`
 * here tightens TangleClaw's own leaf back to `0700`.
 *
 * **Fails closed.** A root TangleClaw cannot vet is not handed to the engine at
 * all: the variable is omitted and the result says which path failed and what
 * the operator can run by hand. The launch itself goes ahead. Native messaging
 * is one feature, and the engine already turns it off when its directory is
 * unsafe, so refusing the launch would only swap one outage for another.
 *
 * **Declared, not hard-coded.** What the engine reads comes from its profile's
 * `capabilities.privateTempRoot`: the variable, the socket suffix it appends,
 * the byte cap on a Unix socket path, and where it looks when the variable is
 * unset. An engine without the field is untouched. Medusa is a separate
 * transport with its own listener and is not governed here.
 *
 * @module lib/engine-temp-root
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Directory under TangleClaw's base directory that holds per-engine runtime roots.
 * @type {string}
 */
const RUN_DIRNAME = 'run';

/**
 * Mode bits for "anyone in the group may write" and "anyone at all may write".
 * @type {number}
 */
const GROUP_WRITE = 0o020;
const OTHER_WRITE = 0o002;
const STICKY = 0o1000;

/**
 * The filesystem and identity the module reads. Tests replace these to stage
 * states they cannot create as an ordinary user: a root-owned ancestor, a
 * foreign owner, a `0777` `/tmp`.
 * @returns {{lstat: Function, realpath: Function, mkdir: Function, chmod: Function, uid: number|undefined}}
 */
function _defaultDeps() {
  return {
    lstat: fs.lstatSync,
    realpath: fs.realpathSync.native,
    mkdir: fs.mkdirSync,
    chmod: fs.chmodSync,
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined
  };
}

/**
 * Read and check an engine profile's `capabilities.privateTempRoot` declaration.
 * @param {object} profile - Engine profile.
 * @returns {object|null} The declaration, or null when the engine declares none
 *   or declares one missing a field this module needs.
 */
function declaration(profile) {
  const decl = profile && profile.capabilities ? profile.capabilities.privateTempRoot : null;
  if (!decl || typeof decl !== 'object') return null;
  if (typeof decl.env !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(decl.env)) return null;
  if (typeof decl.socketSuffix !== 'string' || decl.socketSuffix === '') return null;
  if (!Number.isInteger(decl.maxSocketPathBytes) || decl.maxSocketPathBytes <= 0) return null;
  return decl;
}

/**
 * Find the first component of an absolute real path that the engine would refuse.
 *
 * The rule mirrors the engine's: each component is a directory owned by the
 * user or root, and none is group- or world-writable unless the sticky bit is
 * set. Walks from `/` down, so the answer names the highest failing ancestor,
 * which is the one the operator has to fix.
 * @param {string} realPath - Absolute path with no symlinks left in it.
 * @param {object} deps - From `_defaultDeps`.
 * @returns {object|null} `{path, problem, uid, mode}` for the failing component, or
 *   null when every component passes. `problem` is `not-directory`,
 *   `foreign-owner`, `world-writable`, `group-writable` or `unreadable`.
 */
function vetAncestry(realPath, deps) {
  const parts = realPath.split(path.sep).filter(Boolean);
  let current = path.sep;
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) current = path.join(current, parts[i - 1]);
    let st;
    try {
      st = deps.lstat(current);
    } catch (err) {
      if (!err.code) throw err;
      return { path: current, problem: 'unreadable', uid: null, mode: null, code: err.code };
    }
    const mode = st.mode & 0o7777;
    if (!st.isDirectory()) return { path: current, problem: 'not-directory', uid: st.uid, mode };
    if (deps.uid !== undefined && st.uid !== deps.uid && st.uid !== 0) {
      return { path: current, problem: 'foreign-owner', uid: st.uid, mode };
    }
    if (!(mode & STICKY)) {
      if (mode & OTHER_WRITE) return { path: current, problem: 'world-writable', uid: st.uid, mode };
      if (mode & GROUP_WRITE) return { path: current, problem: 'group-writable', uid: st.uid, mode };
    }
  }
  return null;
}

/**
 * The hand-run fix for a failing component. TangleClaw prints it and never runs it.
 * @param {object} failure - From `vetAncestry`, or a provisioning failure.
 * @param {object} decl - The profile declaration.
 * @param {object} deps - From `_defaultDeps`.
 * @returns {string} One operator-facing sentence.
 */
function remediation(failure, decl, deps) {
  const p = failure.path;
  const asRoot = failure.uid === 0 && deps.uid !== 0 ? 'sudo ' : '';
  switch (failure.problem) {
    case 'world-writable':
      // A world-writable directory is either a shared temp dir, which needs the
      // sticky bit, or a mistake, which needs the write bit removed. The first is
      // the only kind the engine's default path runs through.
      return `${p} is world-writable without the sticky bit. If it is a shared temp directory, restore the sticky bit: ${asRoot}chmod +t ${p}. Otherwise remove the write bit: ${asRoot}chmod o-w ${p}.`;
    case 'group-writable':
      return `${p} is group-writable without the sticky bit. Remove the group write bit: ${asRoot}chmod g-w ${p}.`;
    case 'foreign-owner':
      return `${p} is owned by uid ${failure.uid}, not by you or root. Point TANGLECLAW_HOME at a directory you own, or set ${decl.env} in the engine profile's launch.env to a private 0700 directory you own.`;
    case 'not-directory':
      return `${p} is not a directory. Move what is there aside so a directory can be created.`;
    case 'symlink':
      return `${p} is a symlink. TangleClaw keeps its runtime directories real so nothing can redirect them; remove the link and relaunch.`;
    case 'too-long':
      return `${p} is too long for a Unix socket path (${failure.bytes} of ${decl.maxSocketPathBytes} bytes with the engine's socket name). Set TANGLECLAW_HOME to a shorter directory, or set ${decl.env} in the engine profile's launch.env to a short private 0700 directory.`;
    case 'unreadable':
    default:
      return `${p} could not be read (${failure.code || 'unknown error'}). Check that it exists and that you can search it.`;
  }
}

/**
 * Create TangleClaw's own root and check it, without following a planted symlink.
 * @param {string} baseDir - TangleClaw's base directory.
 * @param {string} engineId - Engine id; names the leaf.
 * @param {object} deps - From `_defaultDeps`.
 * @returns {{dir: string}|{failure: object}} The root's real path, or why it could not be made.
 */
function _provision(baseDir, engineId, deps) {
  const runDir = path.join(baseDir, RUN_DIRNAME);
  const leaf = path.join(runDir, `${engineId}-tmp`);
  try {
    deps.mkdir(runDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (!err.code) throw err;
    return { failure: { path: runDir, problem: err.code === 'ENOTDIR' || err.code === 'EEXIST' ? 'not-directory' : 'unreadable', uid: null, code: err.code } };
  }
  // Checked before the leaf is made: a recursive mkdir would follow a symlinked
  // `run` and create the leaf wherever it points.
  const runStat = deps.lstat(runDir);
  if (runStat.isSymbolicLink()) return { failure: { path: runDir, problem: 'symlink', uid: runStat.uid } };
  if (!runStat.isDirectory()) return { failure: { path: runDir, problem: 'not-directory', uid: runStat.uid } };

  try {
    deps.mkdir(leaf, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      if (!err.code) throw err;
      return { failure: { path: leaf, problem: 'unreadable', uid: null, code: err.code } };
    }
  }
  let leafStat = deps.lstat(leaf);
  if (leafStat.isSymbolicLink()) return { failure: { path: leaf, problem: 'symlink', uid: leafStat.uid } };
  if (!leafStat.isDirectory()) return { failure: { path: leaf, problem: 'not-directory', uid: leafStat.uid } };
  if (deps.uid !== undefined && leafStat.uid !== deps.uid) {
    return { failure: { path: leaf, problem: 'foreign-owner', uid: leafStat.uid, mode: leafStat.mode & 0o7777 } };
  }
  if ((leafStat.mode & 0o7777) !== 0o700) {
    // Ours, owned by us and not a link: tightening it is safe. mkdir's mode is
    // filtered through the umask and an older install may have left it wider.
    deps.chmod(leaf, 0o700);
    leafStat = deps.lstat(leaf);
    if ((leafStat.mode & 0o7777) !== 0o700) {
      return { failure: { path: leaf, problem: (leafStat.mode & OTHER_WRITE) ? 'world-writable' : 'group-writable', uid: leafStat.uid, mode: leafStat.mode & 0o7777 } };
    }
  }
  return { dir: deps.realpath(leaf) };
}

/**
 * Where the engine puts its sockets when its variable is unset, checked the same
 * way, so a refusal of TangleClaw's root still tells the operator whether the
 * engine's own default will work.
 * @param {object} decl - The profile declaration.
 * @param {object} env - The environment the pane inherits.
 * @param {object} deps - From `_defaultDeps`.
 * @returns {{path: string, failure: object|null, remediation: string|null}|null}
 *   The verdict on the default root, or null when the profile names none.
 */
function checkDefaultRoot(decl, env, deps) {
  const fromPlatform = typeof decl.platformRootEnv === 'string' ? env[decl.platformRootEnv] : undefined;
  const root = fromPlatform || decl.defaultRoot;
  if (typeof root !== 'string' || !path.isAbsolute(root)) return null;
  let real;
  try {
    real = deps.realpath(root);
  } catch (err) {
    if (!err.code) throw err;
    const failure = { path: root, problem: 'unreadable', uid: null, code: err.code };
    return { path: root, failure, remediation: remediation(failure, decl, deps) };
  }
  const failure = vetAncestry(real, deps);
  return { path: real, failure, remediation: failure ? remediation(failure, decl, deps) : null };
}

/**
 * Decide the private temp root for one launch.
 *
 * Never throws for a filesystem condition. The caller layers `env` between its
 * ambient floor and the profile's own `launch.env`, so a profile that sets the
 * variable itself still wins.
 * @param {object} args - Arguments.
 * @param {string} args.engineId - Engine id.
 * @param {object} args.profile - Engine launch profile.
 * @param {string} args.baseDir - TangleClaw's base directory (the store's live base, so tests that move the store move this too).
 * @param {object} [args.env] - The environment the pane inherits. Defaults to `process.env`.
 * @param {object} [args.deps] - Filesystem and identity seams; see `_defaultDeps`.
 * @returns {object} `{state, env, ...}`. `state` is one of:
 *   `not-declared` (the engine declares no root; `env` is empty),
 *   `operator-set` (the operator already names the variable; TangleClaw provisions nothing),
 *   `applied` (`dir` is the vetted real path; `env` carries it), or
 *   `refused` (`failure` and `remediation` say why; `env` is empty and
 *   `defaultRoot` is the verdict on where the engine will look instead).
 */
function resolve({ engineId, profile, baseDir, env = process.env, deps = _defaultDeps() }) {
  const decl = declaration(profile);
  if (!decl) return { state: 'not-declared', env: {} };

  const profileEnv = profile.launch && profile.launch.env ? profile.launch.env : {};
  if (Object.prototype.hasOwnProperty.call(profileEnv, decl.env)) {
    return { state: 'operator-set', env: {}, source: 'engine profile launch.env' };
  }
  if (typeof env[decl.env] === 'string' && env[decl.env] !== '') {
    return { state: 'operator-set', env: {}, source: 'TangleClaw environment' };
  }

  const refuse = (failure) => ({
    state: 'refused',
    env: {},
    failure,
    remediation: remediation(failure, decl, deps),
    defaultRoot: checkDefaultRoot(decl, env, deps)
  });

  if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) {
    return refuse({ path: String(baseDir), problem: 'unreadable', uid: null, code: 'NOT_ABSOLUTE' });
  }

  let provisioned;
  try {
    provisioned = _provision(baseDir, engineId, deps);
  } catch (err) {
    if (!err.code) throw err;
    return refuse({ path: baseDir, problem: 'unreadable', uid: null, code: err.code });
  }
  if (provisioned.failure) return refuse(provisioned.failure);

  const dir = provisioned.dir;
  const failure = vetAncestry(dir, deps);
  if (failure) return refuse(failure);

  const bytes = Buffer.byteLength(path.join(dir, decl.socketSuffix));
  if (bytes > decl.maxSocketPathBytes) return refuse({ path: dir, problem: 'too-long', uid: null, bytes });

  return { state: 'applied', dir, env: { [decl.env]: dir } };
}

module.exports = {
  resolve,
  declaration,
  vetAncestry,
  checkDefaultRoot,
  remediation,
  RUN_DIRNAME,
  _defaultDeps
};
