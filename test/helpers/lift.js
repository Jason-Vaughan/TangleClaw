'use strict';

/**
 * Lift a shipped browser function out of its source text so a test can run it.
 *
 * `public/*.js` files are browser scripts, not modules, so a test that wants to
 * exercise one of their functions finds its declaration in the text and takes
 * the balanced-brace body after it. This is the one copy of that matcher: the
 * private copies in individual test files drifted, and one of them accepted
 * fewer types in `esc` than the shipped function did.
 *
 * The matcher counts every `{` and `}` from the first brace after the
 * declaration, including any inside a string or a comment. That is what every
 * copy did when this helper was written, and it is kept so that moving a test
 * onto the helper cannot change what the test lifts; `test/lift-helper.test.js`
 * pins it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/**
 * Find the first `decl` in `src` and the brace span of the body after it.
 * @param {string} src - Source text.
 * @param {string} decl - Text that starts the declaration, e.g. `'function esc('`.
 * @returns {{start:number, bodyStart:number, end:number}} `end` is the index of
 *   the closing brace.
 */
function _span(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return { start, bodyStart, end: i };
  }
  assert.fail(`${decl} body must close`);
}

/**
 * The declaration plus its balanced body: from the first occurrence of `decl`
 * through the brace that closes the first `{` after it.
 * @param {string} src - Source text.
 * @param {string} decl - Text that starts the declaration.
 * @returns {string}
 */
function liftDeclaration(src, decl) {
  const { start, end } = _span(src, decl);
  return src.slice(start, end + 1);
}

/**
 * The balanced body alone: from the first `{` after `decl` through its closing `}`.
 * @param {string} src - Source text.
 * @param {string} decl - Text that starts the declaration.
 * @returns {string}
 */
function liftBody(src, decl) {
  const { bodyStart, end } = _span(src, decl);
  return src.slice(bodyStart, end + 1);
}

/**
 * Read a shipped browser script.
 * @param {string} file - File name under `public/`.
 * @returns {string}
 */
function _readPublic(file) {
  return fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
}

/**
 * The `esc` a page ships, built from its own text rather than re-implemented.
 * @param {string} [file='landing.js'] - File name under `public/`.
 * @returns {(value: *) => string}
 */
function loadEsc(file = 'landing.js') {
  const src = _readPublic(file);
  return new Function(`${liftDeclaration(src, 'function esc(')}\nreturn esc;`)();
}

/**
 * The `jsArg` a page ships, with the `esc` it calls, both built from its own text.
 * @param {string} [file='landing.js'] - File name under `public/`.
 * @returns {(value: *) => string}
 */
function loadJsArg(file = 'landing.js') {
  const src = _readPublic(file);
  return new Function(
    `${liftDeclaration(src, 'function esc(')}\n${liftDeclaration(src, 'function jsArg(')}\nreturn jsArg;`
  )();
}

module.exports = { liftDeclaration, liftBody, loadEsc, loadJsArg };
