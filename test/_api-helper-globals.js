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
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
};
