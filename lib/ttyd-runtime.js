'use strict';

/**
 * The TangleClaw-owned ttyd runtime (#1245, ADR 0018): where it lives, whether
 * it is fit to run, and how it is installed and rolled back.
 *
 * ONE resolver answers "which ttyd binary does launchd run", and both writers
 * of the ttyd plist — `deploy/install.sh` and `scripts/ingress-cutover.js` —
 * ask it rather than rediscovering ttyd on PATH. The managed runtime is the
 * default and only automatic answer. When it is missing or does not verify,
 * the resolver REFUSES and names the repair: silently falling back to the
 * Homebrew ttyd would reinstate the leak while the rollout looked healthy. The
 * Homebrew binary is reachable only through an explicit operator choice
 * (`TANGLECLAW_TTYD_RUNTIME=homebrew`), and choosing it says, every time, that
 * the fix is no longer active.
 *
 * A runtime is CURRENT only when its manifest records the SHA-256 of the very
 * deploy/ttyd/inputs.json this checkout tracks: any change to that file — a
 * source, a patch, a build flag, the CMake pin, the deployment target —
 * makes every runtime built before it stale, and a stale runtime is refused
 * like an invalid one. `provisionRuntime` (deploy/install.sh) builds and
 * installs a current runtime when there is none; the ingress cutover never
 * builds: it refuses, and the refusal names `provision` and the switch for the
 * ingress mode.
 *
 * Installation and rollback are fail-closed and recoverable, not atomic: a
 * binary and its manifest are two filesystem entries. Both copy the incoming
 * pair in beside the current one, verify it where it will run, and only then
 * rename the manifest and, last, the binary into place. Interrupted at any
 * point, either the selected pair verifies, or the resolver refuses the
 * partial state. A last known good that verified before the interruption
 * still verifies after it, for `rollback`; when there is none (a first
 * install, or one that is stale after a pin change), `provision` builds a
 * current runtime instead.
 * Nothing here restarts ttyd or edits a plist.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const RUNTIME_ENV = 'TANGLECLAW_TTYD_RUNTIME';
const INPUTS_FILE = path.join(__dirname, '..', 'deploy', 'ttyd', 'inputs.json');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-ttyd.js');
const ROLLBACK_COMMAND = 'node scripts/ttyd-runtime.js rollback';
const HOMEBREW_CANDIDATES = Object.freeze(['/opt/homebrew/bin/ttyd', '/usr/local/bin/ttyd']);

// How to put an installed runtime into launchd, per ingress mode. Every
// message that sends the operator on to that step uses this one text, because
// deploy/install.sh rewrites the ttyd plist for direct mode and so is the
// wrong step on a caddy-mode host.
const SELECT_BY_MODE = 'select it for your ingress mode — direct mode: `./deploy/install.sh`; caddy mode: '
  + '`node scripts/ingress-cutover.js --to caddy` (never deploy/install.sh, which rewrites the ttyd plist for direct mode)';
const REPAIR = 'Run `node scripts/ttyd-runtime.js provision` to build and install the owned ttyd runtime from '
  + `deploy/ttyd/inputs.json, then ${SELECT_BY_MODE}. `
  + 'By hand, provision is `node scripts/build-ttyd.js --out <stage-dir>`, then '
  + '`node scripts/ttyd-runtime.js install --from <stage-dir>`. To run the Homebrew ttyd instead — WITHOUT the #1245 '
  + 'leak fix — set TANGLECLAW_TTYD_RUNTIME=homebrew for that step.';
const ROLLBACK_WARNING = 'TANGLECLAW_TTYD_RUNTIME=homebrew: ttyd will run the Homebrew binary, WITHOUT the #1245 '
  + 'leak fix. Terminal children can wedge again; the ttyd watcher is again the only mitigation.';

/**
 * Where the managed runtime and its companions live.
 * @param {string} baseDir - TangleClaw's base directory (`~/.tangleclaw`).
 * @returns {{bin: string, ttyd: string, manifest: string, prev: string, prevManifest: string, staging: string, stagingManifest: string, discarded: string, discardedManifest: string}}
 */
function runtimePaths(baseDir) {
  const bin = path.join(baseDir, 'bin');
  return {
    bin,
    ttyd: path.join(bin, 'ttyd'),
    manifest: path.join(bin, 'ttyd.manifest.json'),
    prev: path.join(bin, 'ttyd.prev'),
    prevManifest: path.join(bin, 'ttyd.prev.manifest.json'),
    staging: path.join(bin, 'ttyd.new'),
    stagingManifest: path.join(bin, 'ttyd.new.manifest.json'),
    discarded: path.join(bin, 'ttyd.rolled-back'),
    discardedManifest: path.join(bin, 'ttyd.rolled-back.manifest.json')
  };
}

/**
 * The host-facing operations, replaceable in tests. `fs` holds the only calls
 * that mutate the runtime directory, so a test can fail any one of them.
 * `build({work, out, script?})` runs the builder (build-ttyd.js unless
 * `script` names another) with its output on stderr.
 * @returns {{verifyClosure: Function, version: Function, sha256: Function, homebrewTtyd: Function, expectedInputs: Function, build: Function, fs: {copyFileSync: Function, renameSync: Function, chmodSync: Function}}}
 */
function defaultDeps() {
  return {
    verifyClosure: (bin, bundleDir) => require('./macho-closure').verifyClosureOnHost(bin, { bundleDir }),
    version: (bin) => execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    sha256: (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    homebrewTtyd: () => HOMEBREW_CANDIDATES.find((p) => fs.existsSync(p)) || null,
    expectedInputs,
    // stdout is the caller's (install.sh reads the selected path from it), so
    // the build's own output goes to stderr.
    build: ({ work, out, script = BUILD_SCRIPT }) => {
      execFileSync(process.execPath, [script, '--work', work, '--out', out], { stdio: ['ignore', 2, 2] });
    },
    fs: {
      copyFileSync: (from, to) => fs.copyFileSync(from, to),
      renameSync: (from, to) => fs.renameSync(from, to),
      chmodSync: (file, mode) => fs.chmodSync(file, mode)
    }
  };
}

/**
 * Read deploy/ttyd/inputs.json ONCE and hash exactly the bytes that were
 * parsed. The builder records this digest in the manifest and the resolver
 * compares against it, so both use the same definition, and a build cannot
 * record the digest of a file that changed while it ran.
 * @param {string} [file] - The inputs file (default: this checkout's).
 * @returns {{inputs: object, sha256: string}}
 */
function readPinnedInputs(file = INPUTS_FILE) {
  const raw = fs.readFileSync(file);
  return { inputs: JSON.parse(raw.toString('utf8')), sha256: crypto.createHash('sha256').update(raw).digest('hex') };
}

/**
 * The pinned inputs this checkout expects a runtime to have been built from:
 * the SHA-256 of deploy/ttyd/inputs.json itself (what decides whether a
 * runtime is current), and the digest of every source and patch it pins
 * (which name what differs when it is not).
 * @returns {{inputsJsonSha256: string, sources: Array<{name: string, sha256: string}>, patches: string[]}|null} null when unreadable.
 */
function expectedInputs() {
  try {
    const { inputs, sha256 } = readPinnedInputs();
    return {
      inputsJsonSha256: sha256,
      sources: inputs.sources.map((s) => ({ name: s.name, sha256: s.sha256 })),
      patches: inputs.patches.map((p) => p.sha256)
    };
  } catch {
    return null;
  }
}

/**
 * Whether a manifest was built from a different deploy/ttyd/inputs.json than
 * the one this checkout tracks — the whole file, so a changed build flag,
 * CMake pin or deployment target counts as much as a changed source or patch.
 * @param {object} manifest - A runtime manifest.
 * @param {{inputsJsonSha256: string}} expected - From `expectedInputs`.
 * @returns {boolean}
 */
function _isStale(manifest, expected) {
  const got = manifest && manifest.inputs && manifest.inputs.inputsJsonSha256;
  return got !== expected.inputsJsonSha256;
}

/**
 * Why a manifest's recorded build inputs differ from the expected ones, or an
 * empty list when they match. The binary's `--version` cannot tell builds apart
 * (every static build reports `1.7.7-unknown`), so this is what stops a runtime
 * built without the fix — or before a patch changed — from being selected as
 * the fix.
 * @param {object} manifest - A runtime manifest.
 * @param {{sources: Array<{name: string, sha256: string}>, patches: string[]}} expected
 * @returns {string[]}
 */
function _provenanceMismatches(manifest, expected) {
  const got = (manifest && manifest.inputs) || {};
  const reasons = [];
  for (const s of expected.sources) {
    const m = (got.sources || []).find((x) => x.name === s.name);
    if (!m || m.sha256 !== s.sha256) reasons.push(`it was not built from the pinned ${s.name} (deploy/ttyd/inputs.json)`);
  }
  const gotPatches = (got.patches || []).map((p) => p.sha256);
  if (gotPatches.length !== expected.patches.length || expected.patches.some((d, i) => gotPatches[i] !== d)) {
    reasons.push('it was not built with exactly the patches pinned in deploy/ttyd/inputs.json');
  }
  return reasons;
}

/**
 * Check that a runtime binary is fit to run: it exists and is executable, its
 * manifest is readable and names its digest, the digest matches, it is current
 * (built from this checkout's deploy/ttyd/inputs.json) and from the pinned
 * sources and patches, its whole load graph stays inside its own directory
 * and the macOS system roots, and it runs and reports the version its manifest
 * recorded. Every failing check is reported, so an operator sees the whole
 * problem at once.
 * @param {string} bin - The binary.
 * @param {string} manifestPath - Its manifest.
 * @param {object} deps - From `defaultDeps`; `deps.expectedInputs()` supplies the pinned inputs.
 * @returns {{ok: boolean, reasons: string[], manifest: object|null, stale: boolean}}
 *   `stale` is true when the runtime was built from a different inputs.json.
 */
function verifyRuntime(bin, manifestPath, deps) {
  const reasons = [];
  let manifest = null;
  let stale = false;
  try {
    fs.accessSync(bin, fs.constants.X_OK);
  } catch {
    return { ok: false, reasons: [`${bin} is missing or not executable`], manifest: null, stale: false };
  }
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    reasons.push(`its manifest ${manifestPath} is missing or unreadable (${err.message})`);
  }
  if (manifest && (manifest.schema !== 1 || !manifest.binary || !/^[0-9a-f]{64}$/.test(manifest.binary.sha256 || ''))) {
    reasons.push(`its manifest ${manifestPath} does not record the binary's sha256`);
    manifest = null;
  }
  if (manifest) {
    const actual = deps.sha256(bin);
    if (actual !== manifest.binary.sha256) reasons.push(`its sha256 is ${actual}, the manifest records ${manifest.binary.sha256}`);
    const expected = deps.expectedInputs();
    if (!expected) reasons.push('deploy/ttyd/inputs.json could not be read, so its provenance cannot be checked');
    else {
      stale = _isStale(manifest, expected);
      if (stale) {
        const got = (manifest.inputs && manifest.inputs.inputsJsonSha256) || 'an unrecorded input set';
        reasons.push(`it is stale: it was built from deploy/ttyd/inputs.json ${got}, and this checkout pins ${expected.inputsJsonSha256}`);
      }
      reasons.push(..._provenanceMismatches(manifest, expected));
    }
  }
  let closure;
  try {
    closure = deps.verifyClosure(bin, path.dirname(bin));
  } catch (err) {
    closure = { ok: false, violations: [{ ref: bin, reason: `the load graph could not be read: ${err.message}` }] };
  }
  if (!closure.ok) {
    for (const v of closure.violations) reasons.push(`not self-contained: ${v.ref} (${v.reason})`);
  }
  let version = null;
  try {
    version = deps.version(bin);
  } catch (err) {
    reasons.push(`it does not run: ${err.message}`);
  }
  if (manifest && version !== null && manifest.binary.version && version !== manifest.binary.version) {
    reasons.push(`it reports "${version}", the manifest records "${manifest.binary.version}"`);
  }
  return { ok: reasons.length === 0, reasons, manifest, stale };
}

/**
 * Raised when no fit ttyd runtime can be selected. Carries the reasons and the
 * repair, so every caller can refuse with the same, complete message.
 */
class RuntimeUnavailableError extends Error {
  /**
   * @param {string} summary - One-line cause.
   * @param {string[]} reasons - Every failing check.
   */
  constructor(summary, reasons) {
    super(`${summary}${reasons.length ? `:\n  - ${reasons.join('\n  - ')}` : ''}\n${REPAIR}`);
    this.name = 'RuntimeUnavailableError';
    this.code = 'ttyd-runtime-unavailable';
    this.reasons = reasons;
    this.repair = REPAIR;
  }
}

/**
 * The selection mode `TANGLECLAW_TTYD_RUNTIME` asks for, normalized.
 * @param {object} env - The environment.
 * @returns {string} "managed" (the default), "homebrew", or whatever else was set.
 */
function _mode(env) {
  return String(env[RUNTIME_ENV] || 'managed').trim().toLowerCase();
}

/**
 * The one answer to "which ttyd does launchd run". Throws
 * `RuntimeUnavailableError` rather than ever falling back on its own. When the
 * managed runtime is refused but a verified last known good is kept, the
 * refusal names the rollback that restores it.
 * @param {object} opts
 * @param {string} opts.baseDir - TangleClaw's base directory.
 * @param {object} [opts.env=process.env] - Where `TANGLECLAW_TTYD_RUNTIME` is read.
 * @param {object} [opts.deps] - Host operations (tests).
 * @returns {{path: string, managed: boolean, warning: string|null}}
 */
function resolveTtydPath({ baseDir, env = process.env, deps = defaultDeps() }) {
  const mode = _mode(env);
  if (mode === 'homebrew') {
    const p = deps.homebrewTtyd();
    if (!p) throw new RuntimeUnavailableError(`${RUNTIME_ENV}=homebrew, but no Homebrew ttyd is installed`, []);
    return { path: p, managed: false, warning: ROLLBACK_WARNING };
  }
  if (mode !== 'managed') {
    throw new RuntimeUnavailableError(`${RUNTIME_ENV}=${JSON.stringify(env[RUNTIME_ENV])} is not "managed" or "homebrew"`, []);
  }
  const p = runtimePaths(baseDir);
  const v = verifyRuntime(p.ttyd, p.manifest, deps);
  if (!v.ok) {
    const reasons = [...v.reasons];
    if (fs.existsSync(p.prev)) {
      const prev = verifyRuntime(p.prev, p.prevManifest, deps);
      if (prev.ok) reasons.push(`a verified last-known-good runtime (${prev.manifest.binary.sha256}) is kept at ${p.prev}: \`${ROLLBACK_COMMAND}\` restores it`);
    }
    throw new RuntimeUnavailableError(`the managed ttyd runtime at ${p.ttyd} cannot be used`, reasons);
  }
  return { path: p.ttyd, managed: true, warning: null };
}

/**
 * Copy a runtime pair in beside the selected one (`ttyd.new` and its
 * manifest) and verify it where it will run. Throws, leaving no staging file
 * behind, when a copy fails or the copied pair does not verify; the selected
 * runtime and the last known good are untouched either way.
 * @param {object} p - From `runtimePaths`.
 * @param {string} bin - The incoming binary.
 * @param {string} manifestPath - Its manifest.
 * @param {object} deps - Host operations.
 * @returns {object} The verified manifest.
 */
function _stageBeside(p, bin, manifestPath, deps) {
  const cleanup = () => { for (const f of [p.staging, p.stagingManifest]) fs.rmSync(f, { force: true }); };
  cleanup();
  let staged = false;
  try {
    deps.fs.copyFileSync(bin, p.staging);
    deps.fs.chmodSync(p.staging, 0o755);
    deps.fs.copyFileSync(manifestPath, p.stagingManifest);
    staged = true;
  } finally {
    if (!staged) cleanup();
  }
  const inPlace = verifyRuntime(p.staging, p.stagingManifest, deps);
  if (!inPlace.ok) {
    cleanup();
    throw new RuntimeUnavailableError('the runtime does not verify where it would run; nothing was changed', inPlace.reasons);
  }
  return inPlace.manifest;
}

/**
 * Copy a runtime pair to another name (the last known good, or the set-aside
 * copy of a replaced runtime) WITHOUT writing over the existing files in
 * place: each file is copied to a `.tmp` name and renamed over its target. A
 * signed binary modified in place can be killed by macOS the next time it
 * runs, and an interrupted in-place copy would destroy the only fallback.
 * @param {string} fromBin - Source binary.
 * @param {string} fromManifest - Its manifest.
 * @param {string} toBin - Target binary path.
 * @param {string} toManifest - Target manifest path.
 * @param {object} deps - Host operations.
 * @returns {void}
 */
function _copyPairAside(fromBin, fromManifest, toBin, toManifest, deps) {
  const binTmp = `${toBin}.tmp`;
  const manifestTmp = `${toManifest}.tmp`;
  for (const f of [binTmp, manifestTmp]) fs.rmSync(f, { force: true });
  deps.fs.copyFileSync(fromBin, binTmp);
  deps.fs.chmodSync(binTmp, 0o755);
  if (fromManifest && fs.existsSync(fromManifest)) {
    deps.fs.copyFileSync(fromManifest, manifestTmp);
    deps.fs.renameSync(manifestTmp, toManifest);
  }
  deps.fs.renameSync(binTmp, toBin);
}

/**
 * Rename the staged pair into place: the manifest first, the binary last. An
 * interruption between the two leaves a binary that does not match its
 * manifest, which the resolver refuses — never a silently mismatched runtime.
 * @param {object} p - From `runtimePaths`.
 * @param {object} deps - Host operations.
 * @returns {void}
 */
function _promote(p, deps) {
  deps.fs.renameSync(p.stagingManifest, p.manifest);
  deps.fs.renameSync(p.staging, p.ttyd);
  const after = verifyRuntime(p.ttyd, p.manifest, deps);
  if (!after.ok) throw new RuntimeUnavailableError(`the runtime did not verify after it was put in place; roll back with \`${ROLLBACK_COMMAND}\``, after.reasons);
}

/**
 * Run the mutating part of an install or rollback, turning a filesystem
 * failure part-way through into a `RuntimeUnavailableError` that says what
 * state it left and how to recover, so every caller refuses the same way.
 * @param {string} what - "installation" or "rollback".
 * @param {Function} fn - The mutation.
 * @returns {*} What `fn` returns.
 */
function _recoverably(what, fn) {
  try {
    return fn();
  } catch (err) { // prawduct:allow prawduct/broad-except -- rethrown, never swallowed: any failure part-way through a mutation is re-raised as the typed refusal that names the recovery
    if (err instanceof RuntimeUnavailableError) throw err;
    throw new RuntimeUnavailableError(`the ${what} was interrupted (${err.message}). The resolver refuses a partial runtime; `
      + `\`node scripts/ttyd-runtime.js status\` shows what is selected, and \`${ROLLBACK_COMMAND}\` restores the last known good `
      + 'when one verifies', []);
  }
}

/**
 * Install a staged runtime, failing closed and recoverably. The staged pair is
 * verified where it was built, copied in beside the current one and verified
 * again where it will run; the current runtime, when it verifies, is copied
 * over the last known good; then the pair is renamed into place, manifest
 * first. Interrupted before the renames, the current runtime is still selected
 * and verifies. Interrupted between them, the resolver refuses the mismatched
 * pair and the replaced runtime survives, verified, as the last known good.
 * @param {object} opts
 * @param {string} opts.baseDir - TangleClaw's base directory.
 * @param {string} opts.stageDir - Directory holding `ttyd` and `manifest.json` (from build-ttyd).
 * @param {object} [opts.deps] - Host operations (tests).
 * @returns {{installed: string, previous: string|null, keptPrevious: boolean}}
 */
function installRuntime({ baseDir, stageDir, deps = defaultDeps() }) {
  const p = runtimePaths(baseDir);
  const stagedBin = path.join(stageDir, 'ttyd');
  const stagedManifest = path.join(stageDir, 'manifest.json');
  const staged = verifyRuntime(stagedBin, stagedManifest, deps);
  if (!staged.ok) throw new RuntimeUnavailableError(`the staged runtime in ${stageDir} does not verify; nothing was changed`, staged.reasons);

  fs.mkdirSync(p.bin, { recursive: true });
  return _recoverably('installation', () => {
    _stageBeside(p, stagedBin, stagedManifest, deps);

    // Keep the current runtime as the last known good — but only a GOOD one:
    // an invalid or stale current runtime must not overwrite a good fallback.
    let previous = null;
    let keptPrevious = false;
    const current = verifyRuntime(p.ttyd, p.manifest, deps);
    if (current.ok) {
      _copyPairAside(p.ttyd, p.manifest, p.prev, p.prevManifest, deps);
      previous = current.manifest.binary.sha256;
      keptPrevious = true;
    }

    _promote(p, deps);
    return { installed: staged.manifest.binary.sha256, previous, keptPrevious };
  });
}

/**
 * Put the last known good runtime back, by the same staged, manifest-first
 * route as an install. The last known good is COPIED, never moved, so it stays
 * verified until the restore is complete; the runtime it replaces is copied
 * aside, not deleted, so the swap itself can be undone by hand. A last known
 * good built from a different deploy/ttyd/inputs.json is stale and is refused:
 * after a pin change, `TANGLECLAW_TTYD_RUNTIME=homebrew` is the way back.
 * @param {object} opts
 * @param {string} opts.baseDir - TangleClaw's base directory.
 * @param {object} [opts.deps] - Host operations (tests).
 * @returns {{restored: string, setAside: string|null}}
 */
function rollbackRuntime({ baseDir, deps = defaultDeps() }) {
  const p = runtimePaths(baseDir);
  const prev = verifyRuntime(p.prev, p.prevManifest, deps);
  if (!prev.ok) {
    const reasons = [...prev.reasons];
    if (prev.stale) {
      reasons.push(`the last known good was built for a different deploy/ttyd/inputs.json, so it cannot be restored here; set ${RUNTIME_ENV}=homebrew to run the Homebrew ttyd (without the #1245 fix) until a current runtime is installed`);
    }
    throw new RuntimeUnavailableError('there is no verified last-known-good runtime to roll back to', reasons);
  }
  return _recoverably('rollback', () => {
    _stageBeside(p, p.prev, p.prevManifest, deps);
    let setAside = null;
    if (fs.existsSync(p.ttyd)) {
      _copyPairAside(p.ttyd, p.manifest, p.discarded, p.discardedManifest, deps);
      setAside = p.discarded;
    }
    _promote(p, deps);
    return { restored: prev.manifest.binary.sha256, setAside };
  });
}

/**
 * Make sure launchd has a current, verified ttyd to run, building one when it
 * does not. This is what deploy/install.sh calls. In managed mode it skips the
 * build only when the installed runtime verifies AND was built from this
 * checkout's deploy/ttyd/inputs.json; when the runtime is absent, invalid or
 * stale it builds into a temporary stage, installs the verified result and
 * resolves again. The explicit Homebrew rollback mode never builds. A failed
 * build installs nothing and keeps its work directory for inspection.
 * @param {object} opts
 * @param {string} opts.baseDir - TangleClaw's base directory.
 * @param {object} [opts.env=process.env] - Where `TANGLECLAW_TTYD_RUNTIME` is read.
 * @param {object} [opts.deps] - Host operations (tests); `deps.build({work, out})` builds a stage.
 * @param {Function} [opts.log] - Progress lines for the operator.
 * @returns {{path: string, managed: boolean, warning: string|null, built: boolean, installed: string|null}}
 */
function provisionRuntime({ baseDir, env = process.env, deps = defaultDeps(), log = () => {} }) {
  if (_mode(env) !== 'managed') return { ...resolveTtydPath({ baseDir, env, deps }), built: false, installed: null };
  try {
    return { ...resolveTtydPath({ baseDir, env, deps }), built: false, installed: null };
  } catch (err) {
    if (!(err instanceof RuntimeUnavailableError)) throw err;
    log(`the managed ttyd runtime must be built:\n  - ${err.reasons.join('\n  - ')}`);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ttyd-provision-'));
  const stageDir = path.join(work, 'stage');
  try {
    deps.build({ work: path.join(work, 'build'), out: stageDir });
  } catch (err) { // prawduct:allow prawduct/broad-except -- rethrown as the typed refusal with the cause; a failed build must stop the install, never be swallowed
    throw new RuntimeUnavailableError(`building the owned ttyd runtime failed (${err.message}); nothing was installed, and the build is kept at ${work}`, []);
  }
  log(`built; installing from ${stageDir}`);
  let r;
  try {
    r = installRuntime({ baseDir, stageDir, deps });
  } catch (err) {
    if (!(err instanceof RuntimeUnavailableError)) throw err;
    // Keep the verified build: re-running provision would rebuild it from
    // scratch, while installing it again only needs the fix the reasons name.
    throw new RuntimeUnavailableError(`${err.message.split('\n')[0]}. The build is kept at ${stageDir}; once the `
      + `reasons below are fixed, install it with \`node scripts/ttyd-runtime.js install --from ${stageDir}\``, err.reasons);
  }
  fs.rmSync(work, { recursive: true, force: true });
  return { ...resolveTtydPath({ baseDir, env, deps }), built: true, installed: r.installed };
}

/**
 * A read-only report on the managed runtime, its last known good, and which
 * ttyd the resolver selects right now under `env` (or why it refuses).
 * @param {object} opts
 * @param {string} opts.baseDir - TangleClaw's base directory.
 * @param {object} [opts.env=process.env] - Where `TANGLECLAW_TTYD_RUNTIME` is read.
 * @param {object} [opts.deps] - Host operations (tests).
 * @returns {{selected: object, current: object, previous: object}}
 */
function runtimeStatus({ baseDir, env = process.env, deps = defaultDeps() }) {
  const p = runtimePaths(baseDir);
  const report = (bin, man) => {
    const v = verifyRuntime(bin, man, deps);
    return { path: bin, ok: v.ok, stale: v.stale, sha256: v.manifest ? v.manifest.binary.sha256 : null, reasons: v.reasons };
  };
  let selected;
  try {
    const r = resolveTtydPath({ baseDir, env, deps });
    selected = { path: r.path, managed: r.managed, warning: r.warning, refused: null };
  } catch (err) {
    if (!(err instanceof RuntimeUnavailableError)) throw err;
    selected = { path: null, managed: null, warning: null, refused: err.message };
  }
  return { selected, current: report(p.ttyd, p.manifest), previous: report(p.prev, p.prevManifest) };
}

module.exports = {
  readPinnedInputs,
  resolveTtydPath,
  provisionRuntime,
  installRuntime,
  rollbackRuntime,
  runtimeStatus,
  verifyRuntime,
  runtimePaths,
  defaultDeps,
  RuntimeUnavailableError,
  RUNTIME_ENV,
  REPAIR,
  SELECT_BY_MODE,
  ROLLBACK_COMMAND,
  ROLLBACK_WARNING,
  HOMEBREW_CANDIDATES
};
