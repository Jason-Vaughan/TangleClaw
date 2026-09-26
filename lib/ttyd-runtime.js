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
 * Installation is transactional: the staged runtime is verified, copied in
 * beside the current one, verified again where it will run, and only then
 * renamed into place; the runtime it replaces is kept as the last known good.
 * Nothing here restarts ttyd or edits a plist.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const RUNTIME_ENV = 'TANGLECLAW_TTYD_RUNTIME';
const INPUTS_FILE = path.join(__dirname, '..', 'deploy', 'ttyd', 'inputs.json');
const HOMEBREW_CANDIDATES = Object.freeze(['/opt/homebrew/bin/ttyd', '/usr/local/bin/ttyd']);

const REPAIR = 'Build and install the owned ttyd runtime: `node scripts/build-ttyd.js --out <stage-dir>`, then '
  + '`node scripts/ttyd-runtime.js install --from <stage-dir>`. To run the Homebrew ttyd instead — WITHOUT the '
  + '#1245 leak fix — set TANGLECLAW_TTYD_RUNTIME=homebrew and re-run.';
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
 * The host-facing operations, replaceable in tests.
 * @returns {{verifyClosure: Function, version: Function, sha256: Function, homebrewTtyd: Function}}
 */
function defaultDeps() {
  return {
    verifyClosure: (bin, bundleDir) => require('./macho-closure').verifyClosureOnHost(bin, { bundleDir }),
    version: (bin) => execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    sha256: (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    homebrewTtyd: () => HOMEBREW_CANDIDATES.find((p) => fs.existsSync(p)) || null,
    expectedInputs
  };
}

/**
 * The pinned inputs this checkout expects a runtime to have been built from:
 * the SHA-256 of every source and patch in deploy/ttyd/inputs.json.
 * @returns {{sources: Array<{name: string, sha256: string}>, patches: string[]}|null} null when unreadable.
 */
function expectedInputs() {
  try {
    const inputs = JSON.parse(fs.readFileSync(INPUTS_FILE, 'utf8'));
    return {
      sources: inputs.sources.map((s) => ({ name: s.name, sha256: s.sha256 })),
      patches: inputs.patches.map((p) => p.sha256)
    };
  } catch {
    return null;
  }
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
 * manifest is readable and names its digest, the digest matches, it was built
 * from the pinned inputs, its whole load graph stays inside its own directory
 * and the macOS system roots, and it runs and reports the version its manifest
 * recorded. Every failing check is reported, so an operator sees the whole
 * problem at once.
 * @param {string} bin - The binary.
 * @param {string} manifestPath - Its manifest.
 * @param {object} deps - From `defaultDeps`; `deps.expectedInputs()` supplies the pinned inputs.
 * @returns {{ok: boolean, reasons: string[], manifest: object|null}}
 */
function verifyRuntime(bin, manifestPath, deps) {
  const reasons = [];
  let manifest = null;
  try {
    fs.accessSync(bin, fs.constants.X_OK);
  } catch {
    return { ok: false, reasons: [`${bin} is missing or not executable`], manifest: null };
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
    else reasons.push(..._provenanceMismatches(manifest, expected));
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
  return { ok: reasons.length === 0, reasons, manifest };
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
 * The one answer to "which ttyd does launchd run". Throws
 * `RuntimeUnavailableError` rather than ever falling back on its own.
 * @param {object} opts
 * @param {string} opts.baseDir - TangleClaw's base directory.
 * @param {object} [opts.env=process.env] - Where `TANGLECLAW_TTYD_RUNTIME` is read.
 * @param {object} [opts.deps] - Host operations (tests).
 * @returns {{path: string, managed: boolean, warning: string|null}}
 */
function resolveTtydPath({ baseDir, env = process.env, deps = defaultDeps() }) {
  const mode = String(env[RUNTIME_ENV] || 'managed').trim().toLowerCase();
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
  if (!v.ok) throw new RuntimeUnavailableError(`the managed ttyd runtime at ${p.ttyd} cannot be used`, v.reasons);
  return { path: p.ttyd, managed: true, warning: null };
}

/**
 * Install a staged runtime transactionally. The staged runtime is verified
 * where it was built, copied in beside the current one, verified again where
 * it will run, and only then renamed into place; the current runtime, when it
 * verifies, is kept as the last known good first. Any failure before the final
 * rename leaves the current runtime and the last known good exactly as they were.
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
  const cleanup = () => { for (const f of [p.staging, p.stagingManifest]) fs.rmSync(f, { force: true }); };
  cleanup();
  fs.copyFileSync(stagedBin, p.staging);
  fs.chmodSync(p.staging, 0o755);
  fs.copyFileSync(stagedManifest, p.stagingManifest);
  const inPlace = verifyRuntime(p.staging, p.stagingManifest, deps);
  if (!inPlace.ok) {
    cleanup();
    throw new RuntimeUnavailableError('the runtime does not verify where it would run; nothing was changed', inPlace.reasons);
  }

  // Keep the current runtime as the last known good — but only a GOOD one: an
  // invalid current runtime must not overwrite a good fallback.
  let previous = null;
  let keptPrevious = false;
  const current = verifyRuntime(p.ttyd, p.manifest, deps);
  if (current.ok) {
    fs.copyFileSync(p.ttyd, p.prev);
    fs.chmodSync(p.prev, 0o755);
    fs.copyFileSync(p.manifest, p.prevManifest);
    previous = current.manifest.binary.sha256;
    keptPrevious = true;
  }

  // Manifest first, binary last: an interruption between the two leaves a
  // binary that does not match its manifest, which the resolver refuses —
  // failure is visible, never a silently mismatched runtime.
  fs.renameSync(p.stagingManifest, p.manifest);
  fs.renameSync(p.staging, p.ttyd);
  const after = verifyRuntime(p.ttyd, p.manifest, deps);
  if (!after.ok) throw new RuntimeUnavailableError('the runtime did not verify after installation; roll back with `node scripts/ttyd-runtime.js rollback`', after.reasons);
  return { installed: staged.manifest.binary.sha256, previous, keptPrevious };
}

/**
 * Put the last known good runtime back. The runtime it replaces is set aside,
 * not deleted, so the swap itself can be undone by hand.
 * @param {object} opts
 * @param {string} opts.baseDir - TangleClaw's base directory.
 * @param {object} [opts.deps] - Host operations (tests).
 * @returns {{restored: string, setAside: string|null}}
 */
function rollbackRuntime({ baseDir, deps = defaultDeps() }) {
  const p = runtimePaths(baseDir);
  const prev = verifyRuntime(p.prev, p.prevManifest, deps);
  if (!prev.ok) throw new RuntimeUnavailableError('there is no verified last-known-good runtime to roll back to', prev.reasons);
  let setAside = null;
  if (fs.existsSync(p.ttyd)) {
    fs.renameSync(p.ttyd, p.discarded);
    if (fs.existsSync(p.manifest)) fs.renameSync(p.manifest, p.discardedManifest);
    setAside = p.discarded;
  }
  fs.renameSync(p.prevManifest, p.manifest);
  fs.renameSync(p.prev, p.ttyd);
  const after = verifyRuntime(p.ttyd, p.manifest, deps);
  if (!after.ok) throw new RuntimeUnavailableError('the restored runtime did not verify', after.reasons);
  return { restored: prev.manifest.binary.sha256, setAside };
}

/**
 * A read-only report on the managed runtime and its last known good.
 * @param {object} opts
 * @param {string} opts.baseDir - TangleClaw's base directory.
 * @param {object} [opts.deps] - Host operations (tests).
 * @returns {{current: object, previous: object}}
 */
function runtimeStatus({ baseDir, deps = defaultDeps() }) {
  const p = runtimePaths(baseDir);
  const report = (bin, man) => {
    const v = verifyRuntime(bin, man, deps);
    return { path: bin, ok: v.ok, sha256: v.manifest ? v.manifest.binary.sha256 : null, reasons: v.reasons };
  };
  return { current: report(p.ttyd, p.manifest), previous: report(p.prev, p.prevManifest) };
}

module.exports = {
  resolveTtydPath,
  installRuntime,
  rollbackRuntime,
  runtimeStatus,
  verifyRuntime,
  runtimePaths,
  defaultDeps,
  RuntimeUnavailableError,
  RUNTIME_ENV,
  REPAIR,
  ROLLBACK_WARNING,
  HOMEBREW_CANDIDATES
};
