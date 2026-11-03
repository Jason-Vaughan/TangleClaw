'use strict';

/*
 * Load `public/api-helper.js` and hand back the globals it publishes.
 *
 * The file is a browser script, not a module — it assigns factories onto
 * `window`. Tests that need to assert what a shared component RENDERS should
 * run the real thing rather than restate its markup, which is the difference
 * between pinning behaviour and pinning a copy of it.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * @returns {object} The sandbox, carrying every `tc*` global api-helper exports.
 */
module.exports = function loadApiHelperGlobals() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');
  // `vm.createContext` gives an isolated global with no timers of its own —
  // Node's real `setTimeout`/`clearTimeout` are not inherited automatically.
  // Several shared components schedule a transient auto-dismiss (an inline
  // "Saved" confirmation, a rules-status banner) via a bare or `global.`-
  // qualified call; without this, exercising that code path in a test throws
  // "setTimeout is not defined"/"is not a function" instead of running it.
  const sandbox = { console, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
};
