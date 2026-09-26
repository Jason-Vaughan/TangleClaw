#!/usr/bin/env node
'use strict';

/**
 * Build and package the TangleClaw-owned, self-contained ttyd runtime (#1245,
 * ADR 0018). The deterministic entry point: every input comes from
 * deploy/ttyd/inputs.json and is verified against its pinned SHA-256 BEFORE it
 * is extracted, applied or executed; the build runs outside the repository;
 * the result is refused unless its complete Mach-O load graph reaches only
 * macOS system libraries. The output is a STAGED runtime (the binary plus a
 * provenance manifest). This script never installs it, never touches the
 * plist, and never restarts anything — see lib/ttyd-runtime.js for the
 * transactional install, which is an Operator/PM action.
 *
 * Usage:
 *   node scripts/build-ttyd.js [--work DIR] [--cache DIR] [--out DIR] [--offline] [--check-inputs]
 *
 *   --work          build directory (default: a fresh directory under /tmp)
 *   --cache         download cache, reused across builds (default: ~/.tangleclaw/cache/ttyd-build)
 *   --out           staging directory for the packaged runtime (default: <work>/stage)
 *   --offline       use only the cache; fail if an input is missing from it
 *   --check-inputs  validate inputs.json and the tracked patches, then exit
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readPinnedInputs } = require('../lib/ttyd-runtime');

const REPO_ROOT = path.resolve(__dirname, '..');
const INPUTS_DIR = path.join(REPO_ROOT, 'deploy', 'ttyd');
const REQUIRED_SOURCES = ['libuv', 'json-c', 'libwebsockets', 'ttyd'];
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The manifest's record of what a build was made from, taken from the ONE
 * reading of inputs.json the build used (`readPinnedInputs`). It never reads
 * the file again, so the recorded digest always matches the inputs built.
 * @param {{inputs: object, sha256: string}} pinned - From `readPinnedInputs`.
 * @returns {{inputsJsonSha256: string, sources: object[], patches: object[], cmake: object}}
 */
function manifestInputs(pinned) {
  const { inputs } = pinned;
  return {
    inputsJsonSha256: pinned.sha256,
    sources: inputs.sources.map((s) => ({ name: s.name, version: s.version, url: s.url, sha256: s.sha256 })),
    patches: inputs.patches.map((p) => ({ file: p.file, sha256: p.sha256 })),
    cmake: { version: inputs.cmake.version, wheelSha256: inputs.cmake.sha256 }
  };
}

/**
 * Parse the command line.
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{work: string|null, cache: string|null, out: string|null, offline: boolean, checkInputs: boolean}}
 */
function parseArgs(argv) {
  const o = { work: null, cache: null, out: null, offline: false, checkInputs: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return path.resolve(v);
    };
    if (a === '--work') o.work = value();
    else if (a === '--cache') o.cache = value();
    else if (a === '--out') o.out = value();
    else if (a === '--offline') o.offline = true;
    else if (a === '--check-inputs') o.checkInputs = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/**
 * SHA-256 of a file, hex.
 * @param {string} file - Path.
 * @returns {string}
 */
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Validate inputs.json and the tracked patch files it names. Every problem is
 * returned, not just the first, so one run shows everything to fix.
 * @param {object} inputs - Parsed inputs.json.
 * @param {string} [dir=INPUTS_DIR] - Directory the patch paths are relative to.
 * @returns {string[]} Problems; empty when valid.
 */
function validateInputs(inputs, dir = INPUTS_DIR) {
  const problems = [];
  if (!inputs || inputs.schema !== 1) problems.push('schema must be 1');
  if (!inputs || !inputs.cmake || !SHA256.test(inputs.cmake.sha256 || '') || !inputs.cmake.version || !inputs.cmake.wheel) {
    problems.push('cmake needs version, wheel and a sha256');
  }
  const sources = (inputs && inputs.sources) || [];
  for (const name of REQUIRED_SOURCES) {
    const s = sources.find((x) => x.name === name);
    if (!s) { problems.push(`missing source ${name}`); continue; }
    if (!/^https:\/\//.test(s.url || '')) problems.push(`${name}: url must be https`);
    if (!SHA256.test(s.sha256 || '')) problems.push(`${name}: sha256 must be 64 hex characters`);
    if (!s.version) problems.push(`${name}: version is required`);
  }
  for (const p of (inputs && inputs.patches) || []) {
    const file = path.join(dir, p.file || '');
    if (!p.file || !fs.existsSync(file)) { problems.push(`patch ${p.file}: file not found`); continue; }
    if (!SHA256.test(p.sha256 || '')) { problems.push(`patch ${p.file}: sha256 must be 64 hex characters`); continue; }
    const actual = sha256File(file);
    if (actual !== p.sha256) problems.push(`patch ${p.file}: sha256 is ${actual}, inputs.json pins ${p.sha256}`);
  }
  if (!inputs || !inputs.patches || inputs.patches.length === 0) problems.push('no patches listed');
  if (!inputs || !/^\d+\.\d+$/.test(inputs.macosxDeploymentTarget || '')) problems.push('macosxDeploymentTarget must look like 14.0');
  return problems;
}

/**
 * Run a command with inherited output, failing loudly.
 * @param {string} cmd - Executable.
 * @param {string[]} args - Arguments.
 * @param {object} [opts] - `execFileSync` options.
 * @returns {string}
 */
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
}

/**
 * Put an input in the cache, verified. A cached file whose digest does not
 * match is deleted and fetched again; a download whose digest does not match
 * is refused and never moved into the cache.
 * @param {{url: string, sha256: string}} input
 * @param {string} cacheDir - Cache directory.
 * @param {boolean} offline - Refuse to download.
 * @returns {string} Path to the verified file.
 */
function fetchVerified(input, cacheDir, offline) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const dest = path.join(cacheDir, `${input.sha256}-${path.basename(new URL(input.url).pathname)}`);
  if (fs.existsSync(dest)) {
    if (sha256File(dest) === input.sha256) return dest;
    fs.rmSync(dest);
  }
  if (offline) throw new Error(`--offline and ${input.url} is not in the cache`);
  const tmp = `${dest}.part`;
  run('curl', ['-fsSL', '--retry', '2', '-o', tmp, input.url]);
  const actual = sha256File(tmp);
  if (actual !== input.sha256) {
    fs.rmSync(tmp);
    throw new Error(`${input.url}: sha256 ${actual} does not match the pinned ${input.sha256}`);
  }
  fs.renameSync(tmp, dest);
  return dest;
}

/**
 * The environment every build step runs in: no Homebrew/MacPorts on PATH, no
 * compiler or pkg-config hints that could pull in a foreign library.
 * @param {string} venvBin - The venv's bin directory (CMake).
 * @param {string} target - MACOSX_DEPLOYMENT_TARGET.
 * @returns {object}
 */
function cleanEnv(venvBin, target) {
  return {
    PATH: `${venvBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: os.homedir(),
    TMPDIR: os.tmpdir(),
    LANG: 'C',
    MACOSX_DEPLOYMENT_TARGET: target
  };
}

/**
 * Build and stage the runtime.
 * @param {object} o - Parsed options.
 * @returns {object} The provenance manifest.
 */
function build(o) {
  if (process.platform !== 'darwin') throw new Error('the owned ttyd runtime is built on macOS only');
  // Read once: the manifest records the digest of exactly the bytes this build
  // used, even if inputs.json changes while it runs.
  const pinned = readPinnedInputs(path.join(INPUTS_DIR, 'inputs.json'));
  const inputs = pinned.inputs;
  const problems = validateInputs(inputs);
  if (problems.length) throw new Error(`inputs.json is invalid:\n  ${problems.join('\n  ')}`);

  const work = o.work || fs.mkdtempSync(path.join('/tmp', 'tc-ttyd-build-'));
  const cache = o.cache || path.join(os.homedir(), '.tangleclaw', 'cache', 'ttyd-build');
  const out = o.out || path.join(work, 'stage');
  const prefix = path.join(work, 'prefix');
  const srcRoot = path.join(work, 'src');
  for (const d of [work, prefix, srcRoot]) fs.mkdirSync(d, { recursive: true });
  const log = (msg) => console.log(`[build-ttyd] ${msg}`);

  // 1. CMake from a pinned wheel, hash-checked by pip, into a venv inside work.
  const venv = path.join(work, 'venv');
  run('/usr/bin/python3', ['-m', 'venv', venv]);
  const req = path.join(work, 'cmake-requirements.txt');
  fs.writeFileSync(req, `cmake==${inputs.cmake.version} --hash=sha256:${inputs.cmake.sha256}\n`);
  run(path.join(venv, 'bin', 'pip'), ['install', '--quiet', '--require-hashes', '--only-binary=:all:', '--no-deps', '-r', req]);
  const cmake = path.join(venv, 'bin', 'cmake');
  const cmakeVersion = run(cmake, ['--version']).split('\n')[0];
  if (!cmakeVersion.includes(inputs.cmake.version)) throw new Error(`venv CMake reports "${cmakeVersion}"`);
  const env = cleanEnv(path.join(venv, 'bin'), inputs.macosxDeploymentTarget);
  log(cmakeVersion);

  // 2. Every source, verified before extraction.
  const archives = {};
  for (const s of inputs.sources) {
    archives[s.name] = fetchVerified(s, cache, o.offline);
    const dir = path.join(srcRoot, s.name);
    fs.mkdirSync(dir, { recursive: true });
    run('tar', ['-xzf', archives[s.name], '-C', dir, '--strip-components=1']);
    log(`${s.name} ${s.version} verified`);
  }

  // 3. Static dependencies, with Homebrew and friends excluded from every search.
  const ignore = inputs.build.ignorePrefixes.join(';');
  const common = [`-DCMAKE_BUILD_TYPE=Release`, `-DCMAKE_INSTALL_PREFIX=${prefix}`, `-DCMAKE_PREFIX_PATH=${prefix}`,
    `-DCMAKE_IGNORE_PREFIX_PATH=${ignore}`, `-DCMAKE_SYSTEM_IGNORE_PREFIX_PATH=${ignore}`,
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${inputs.macosxDeploymentTarget}`];
  const cmakeBuild = (name, extra) => {
    const b = path.join(work, `build-${name}`);
    run(cmake, ['-S', path.join(srcRoot, name), '-B', b, ...common, ...extra], { env });
    run(cmake, ['--build', b, '-j', String(Math.max(1, os.cpus().length))], { env });
    run(cmake, ['--install', b], { env });
    log(`${name} built`);
  };
  cmakeBuild('libuv', inputs.build.libuv);
  cmakeBuild('json-c', inputs.build['json-c']);
  cmakeBuild('libwebsockets', [...inputs.build.libwebsockets,
    `-DLIBUV_INCLUDE_DIRS=${prefix}/include`, `-DLIBUV_LIBRARIES=${prefix}/lib/libuv.a`]);
  // libwebsockets' installed config names BOTH targets whatever was built;
  // this build has only the static one, and naming the missing shared target
  // makes ttyd's link fail.
  const lwsConfig = path.join(prefix, 'lib', 'cmake', 'libwebsockets', 'libwebsockets-config.cmake');
  const cfg = fs.readFileSync(lwsConfig, 'utf8');
  const fixed = cfg.replace(/^set\(LIBWEBSOCKETS_LIBRARIES websockets websockets_shared\)$/m, 'set(LIBWEBSOCKETS_LIBRARIES websockets)');
  if (fixed === cfg) throw new Error('libwebsockets-config.cmake did not have the expected LIBWEBSOCKETS_LIBRARIES line');
  fs.writeFileSync(lwsConfig, fixed);

  // 4. ttyd with the tracked patches, each verified again right before use.
  for (const p of inputs.patches) {
    const file = path.join(INPUTS_DIR, p.file);
    if (sha256File(file) !== p.sha256) throw new Error(`${p.file} changed after validation`);
    run('patch', ['-p1', '-i', file], { cwd: path.join(srcRoot, 'ttyd'), env });
    log(`applied ${p.file}`);
  }
  cmakeBuild('ttyd', [`-DLIBUV_INCLUDE_DIR=${prefix}/include`, `-DLIBUV_LIBRARY=${prefix}/lib/libuv.a`,
    `-DJSON-C_INCLUDE_DIR=${prefix}/include/json-c`, `-DJSON-C_LIBRARY=${prefix}/lib/libjson-c.a`]);
  const built = path.join(work, 'build-ttyd', 'ttyd');

  // 5. Stage, then verify the STAGED file — what would be installed.
  fs.mkdirSync(out, { recursive: true });
  const staged = path.join(out, 'ttyd');
  fs.copyFileSync(built, staged);
  fs.chmodSync(staged, 0o755);
  const closure = require('../lib/macho-closure').verifyClosureOnHost(staged, { bundleDir: out, systemRoots: inputs.closure.systemRoots });
  if (!closure.ok) {
    throw new Error(`the staged ttyd is not self-contained:\n  ${closure.violations.map((v) => `${v.image}: ${v.ref} (${v.reason})`).join('\n  ')}`);
  }
  const version = run(staged, ['--version']).trim();
  const manifest = {
    schema: 1,
    builtAt: new Date().toISOString(),
    binary: { file: 'ttyd', sha256: sha256File(staged), version },
    inputs: manifestInputs(pinned),
    toolchain: {
      compiler: run('xcrun', ['clang', '--version']).split('\n')[0],
      sdk: run('xcrun', ['--show-sdk-version']).trim(),
      cmake: cmakeVersion,
      deploymentTarget: inputs.macosxDeploymentTarget,
      host: `${os.type()} ${os.release()} ${os.arch()}`
    },
    closure: { systemRoots: inputs.closure.systemRoots, graph: closure.graph }
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  log(`staged ${staged} (${manifest.binary.sha256})`);
  return manifest;
}

if (require.main === module) {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (o.checkInputs) {
    const problems = validateInputs(JSON.parse(fs.readFileSync(path.join(INPUTS_DIR, 'inputs.json'), 'utf8')));
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('inputs.json and the tracked patches are valid');
    process.exit(0);
  }
  try {
    build(o);
  } catch (err) {
    console.error(`build-ttyd failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { parseArgs, validateInputs, sha256File, fetchVerified, cleanEnv, manifestInputs, REQUIRED_SOURCES };
