'use strict';

/**
 * The recursive Mach-O dependency check behind the owned ttyd runtime (#1245,
 * ADR 0018 §3).
 *
 * "Self-contained" is a property of the RESOLVED load graph, not of how the
 * binary was built: the runtime may load only macOS system libraries and its
 * own private bundle. Checking the main binary alone is not enough, because a
 * private library can still point back into Homebrew — so every image the
 * graph reaches is walked, and every `@rpath` / `@loader_path` /
 * `@executable_path` reference is resolved to a real path before it is judged.
 *
 * The walk takes its `otool` reads through injected functions, so every rule
 * is testable from fixtures on any platform.
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_SYSTEM_ROOTS = Object.freeze(['/usr/lib/', '/System/Library/']);

/**
 * Parse `otool -L <image>` into the image's dependency install names.
 *
 * `otool -L` prints the image path first, then one dependency per line; for a
 * dylib the first dependency is the library's own install name, which is not a
 * dependency and is dropped when `ownId` is given.
 * @param {string} text - `otool -L` stdout.
 * @param {string|null} [ownId] - The image's own install name (`otool -D`), if a dylib.
 * @returns {string[]}
 */
function parseOtoolL(text, ownId = null) {
  const deps = [];
  const lines = String(text).split('\n').slice(1);
  for (const line of lines) {
    const m = line.match(/^\s+(\S.*?)\s+\(compatibility version/);
    if (!m) continue;
    if (ownId && m[1] === ownId) continue;
    deps.push(m[1]);
  }
  return deps;
}

/**
 * Parse the `LC_RPATH` entries out of `otool -l <image>`.
 * @param {string} text - `otool -l` stdout.
 * @returns {string[]}
 */
function parseRpaths(text) {
  const rpaths = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*cmd LC_RPATH\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const m = lines[j].match(/^\s*path (.+?) \(offset \d+\)\s*$/);
      if (m) { rpaths.push(m[1]); break; }
    }
  }
  return rpaths;
}

/**
 * Whether a path lies inside a directory (the directory itself included).
 * @param {string} p - Absolute, normalized path.
 * @param {string} dir - Absolute directory.
 * @returns {boolean}
 */
function _inside(p, dir) {
  const d = path.resolve(dir);
  const q = path.resolve(p);
  return q === d || q.startsWith(d + path.sep);
}

/**
 * Walk an executable's complete load graph and judge every reference.
 *
 * Allowed: an absolute path under a macOS system root (not descended: those
 * images live in the dyld shared cache), or a reference that resolves to a file
 * inside `bundleDir` (descended). Everything else is a violation: an absolute
 * path anywhere else (`/opt/homebrew`, `/usr/local`, a temp or build dir), an
 * `@rpath` that no rpath inside the bundle resolves, an rpath pointing outside
 * the bundle, or an image that could not be read.
 *
 * @param {string} executable - Absolute path of the main binary.
 * @param {object} opts
 * @param {string} opts.bundleDir - The private bundle directory the runtime may load from.
 * @param {string[]} [opts.systemRoots] - Allowed system roots.
 * @param {(image: string) => string} opts.otoolL - `otool -L` stdout for an image.
 * @param {(image: string) => string} opts.otooll - `otool -l` stdout for an image.
 * @param {(image: string) => string|null} opts.dylibId - An image's own install name, or null for an executable.
 * @param {(p: string) => boolean} opts.exists - Whether a file exists.
 * @returns {{ok: boolean, graph: Array<{image: string, deps: string[], rpaths: string[]}>, violations: Array<{image: string, ref: string, reason: string}>}}
 */
function verifyClosure(executable, opts) {
  const roots = opts.systemRoots || DEFAULT_SYSTEM_ROOTS;
  const bundleDir = path.resolve(opts.bundleDir);
  const exeDir = path.dirname(path.resolve(executable));
  const graph = [];
  const violations = [];
  const seen = new Set();
  const queue = [path.resolve(executable)];

  while (queue.length) {
    const image = queue.shift();
    if (seen.has(image)) continue;
    seen.add(image);
    let deps;
    let rpaths;
    try {
      deps = parseOtoolL(opts.otoolL(image), opts.dylibId(image));
      rpaths = parseRpaths(opts.otooll(image));
    } catch (err) {
      violations.push({ image, ref: image, reason: `could not read the image: ${err.message}` });
      continue;
    }
    graph.push({ image, deps, rpaths });
    const loaderDir = path.dirname(image);
    const expand = (p) => p.replace(/^@loader_path/, loaderDir).replace(/^@executable_path/, exeDir);

    const resolvedRpaths = [];
    for (const rp of rpaths) {
      const r = path.resolve(expand(rp));
      if (!_inside(r, bundleDir)) violations.push({ image, ref: rp, reason: 'LC_RPATH points outside the private bundle' });
      else resolvedRpaths.push(r);
    }

    for (const dep of deps) {
      if (roots.some((root) => dep.startsWith(root))) continue;
      let target = null;
      if (dep.startsWith('@rpath/')) {
        const rest = dep.slice('@rpath/'.length);
        target = resolvedRpaths.map((r) => path.join(r, rest)).find((c) => opts.exists(c)) || null;
        if (!target) { violations.push({ image, ref: dep, reason: '@rpath reference that no rpath inside the bundle resolves' }); continue; }
      } else if (dep.startsWith('@loader_path/') || dep.startsWith('@executable_path/')) {
        target = path.resolve(expand(dep));
      } else if (dep.startsWith('@')) {
        violations.push({ image, ref: dep, reason: 'unsupported @-relative reference' });
        continue;
      } else {
        violations.push({ image, ref: dep, reason: 'absolute path outside the macOS system roots' });
        continue;
      }
      if (!_inside(target, bundleDir)) { violations.push({ image, ref: dep, reason: `resolves outside the private bundle (${target})` }); continue; }
      if (!opts.exists(target)) { violations.push({ image, ref: dep, reason: `resolves to a missing file (${target})` }); continue; }
      queue.push(target);
    }
  }
  return { ok: violations.length === 0, graph, violations };
}

/**
 * `verifyClosure` against the real host `otool`. macOS only.
 * @param {string} executable - Absolute path of the main binary.
 * @param {{bundleDir: string, systemRoots?: string[]}} opts
 * @returns {ReturnType<typeof verifyClosure>}
 */
function verifyClosureOnHost(executable, opts) {
  const run = (args) => execFileSync('otool', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const fs = require('node:fs');
  return verifyClosure(executable, {
    ...opts,
    otoolL: (image) => run(['-L', image]),
    otooll: (image) => run(['-l', image]),
    dylibId: (image) => {
      const lines = run(['-D', image]).trim().split('\n');
      return lines.length > 1 ? lines[1].trim() : null;
    },
    exists: (p) => fs.existsSync(p)
  });
}

module.exports = { parseOtoolL, parseRpaths, verifyClosure, verifyClosureOnHost, DEFAULT_SYSTEM_ROOTS };
