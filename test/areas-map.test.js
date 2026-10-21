'use strict';
/**
 * The area map (`docs/areas.json`) is total and unambiguous (#2248).
 *
 * The map is what lets two planned issues be checked for overlap by path, so
 * a file that matches no area, or two, makes that check wrong silently. These
 * tests hold the map to its own contract: every source file under the four
 * roots matches exactly one area or `shared`; every glob matches a file; an
 * area with no paths yet is one `shared` still holds; labels are issue labels;
 * `shared` is exactly the two files being split.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'areas.json'), 'utf8'));
const ROOTS = ['server.js', 'lib', 'public', 'scripts'];

/**
 * Compile one glob to a regex: `**` spans directories, `*` stays within one
 * segment, everything else is literal.
 * @param {string} glob - A path glob as the map writes it
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else {
      out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Every `.js` file under the mapped roots, as repo-relative paths.
 * @returns {string[]}
 */
function sourceFiles() {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      if (rel.endsWith('.js')) files.push(rel);
      return;
    }
    for (const entry of fs.readdirSync(abs).sort()) walk(path.join(rel, entry));
  };
  for (const root of ROOTS) walk(root);
  return files;
}

/** Every (area, glob, regex) triple in map order, `shared` last. */
const GLOBS = [];
for (const [name, area] of Object.entries(MAP.areas)) {
  for (const glob of area.paths) GLOBS.push({ area: name, glob, re: globToRegExp(glob) });
}
for (const glob of MAP.shared.paths) GLOBS.push({ area: 'shared', glob, re: globToRegExp(glob) });

describe('the area map (#2248)', () => {
  it('maps every source file under server.js, lib/, public/ and scripts/ to exactly one area', () => {
    const problems = [];
    for (const file of sourceFiles()) {
      const owners = [...new Set(GLOBS.filter((g) => g.re.test(file)).map((g) => g.area))];
      if (owners.length !== 1) problems.push(`${file}: ${owners.length ? owners.join(', ') : 'no area'}`);
    }
    assert.deepEqual(problems, [], `files with no area or more than one:\n${problems.join('\n')}`);
  });

  it('writes no glob that matches nothing', () => {
    const files = sourceFiles();
    const dead = GLOBS.filter((g) => !files.some((f) => g.re.test(f))).map((g) => `${g.area}: ${g.glob}`);
    assert.deepEqual(dead, [], `globs matching no file: ${dead.join(', ')}`);
  });

  it('leaves an area without paths only while shared still holds it', () => {
    const empty = Object.entries(MAP.areas).filter(([, a]) => a.paths.length === 0).map(([n]) => n);
    const orphaned = empty.filter((n) => !MAP.shared.holds.includes(n));
    assert.deepEqual(orphaned, [], `areas with no paths that shared no longer holds: ${orphaned.join(', ')}`);
  });

  it('names only known areas in shared.holds, and exactly the two files being split in shared.paths', () => {
    const unknown = MAP.shared.holds.filter((n) => !(n in MAP.areas));
    assert.deepEqual(unknown, [], `shared.holds names areas the map does not define: ${unknown.join(', ')}`);
    assert.deepEqual([...MAP.shared.paths].sort(), ['lib/store.js', 'server.js']);
  });

  it('gives every area an issue label of the form area:<kebab> and a reason', () => {
    for (const [name, area] of Object.entries(MAP.areas)) {
      assert.match(area.label, /^area:[a-z0-9]+(-[a-z0-9]+)*$/, `${name} label ${area.label}`);
      assert.ok(typeof area.why === 'string' && area.why.length > 0, `${name} has no why`);
    }
  });
});
