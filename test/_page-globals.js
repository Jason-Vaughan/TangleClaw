'use strict';

/*
 * Page globals that a page script calls but another script defines, for tests
 * that run a page script in a `vm` sandbox.
 *
 * On `index.html`, `landing.js` loads before `setup.js`, `ui.js` and
 * `history-drawer.js`, so its `jsArg` is a global they call (#1902). A sandbox
 * that runs one of those scripts must supply it as the page does. This takes
 * the production declaration verbatim rather than a copy, so a test cannot pass
 * against an encoder that differs from the shipped one. It binds to whatever
 * `esc` the sandbox provides, exactly as the page's does.
 */

const fs = require('node:fs');
const path = require('node:path');

const LANDING_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');

/**
 * Slice a function declaration out of source text by brace-matching.
 * @param {string} src - File source text.
 * @param {string} decl - Declaration head, e.g. `function jsArg(`.
 * @returns {string} The declaration through its balanced closing brace.
 */
function liftDeclaration(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error(`${decl} not found`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${decl} body does not close`);
}

/** `landing.js`'s `function jsArg(value) {…}`, for `vm.runInContext`. */
const LANDING_JSARG_SRC = liftDeclaration(LANDING_SRC, 'function jsArg(');

module.exports = { LANDING_JSARG_SRC, liftDeclaration };
