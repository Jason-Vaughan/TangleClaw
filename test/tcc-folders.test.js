'use strict';

/*
 * The shipped projects directory and the macOS protected folders (#880).
 *
 * Two contracts. The default must sit OUTSIDE every protected folder, because
 * the wizard cautions on path shape alone and a caution every fresh Mac sees is
 * one people learn to ignore. And every copy that cannot import its source must
 * still say the same thing: the default's copies (the browser's fallbacks) must
 * name `lib/store.js`'s value, and the folder list's copies (the wizard's
 * caution, the EACCES hint, the installer) must name every folder in
 * `lib/tcc-folders.js`. Otherwise a fresh install pre-fills one folder and warns
 * about another.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tccFolders = require('../lib/tcc-folders');
const { DEFAULT_CONFIG } = require('../lib/store');
const { liftDeclaration } = require('./helpers/lift');

const ROOT = path.join(__dirname, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'setup.js'), 'utf8');

/**
 * The wizard's own caution check, fed the roots the server would send.
 * @param {string} home - The home directory the server would report
 * @returns {function(string): (string|null)} The protected root a path is under, or null
 */
function wizardCheck(home) {
  const ctx = { state: { config: { protectedRoots: tccFolders.protectedRootsFor(home) } } };
  vm.createContext(ctx);
  vm.runInContext(liftDeclaration(SETUP_SRC, 'function wizardProtectedRootFor'), ctx);
  return (p) => ctx.wizardProtectedRootFor(p);
}

describe('macOS protected folders, one owner (#880)', () => {
  it('names the three folders TCC protects, and the prose says the same three', () => {
    assert.deepEqual([...tccFolders.TCC_PROTECTED_FOLDERS], ['Documents', 'Desktop', 'Downloads']);
    assert.equal(tccFolders.TCC_PROTECTED_FOLDERS_PROSE, '~/Documents, ~/Desktop and ~/Downloads');
    assert.ok(Object.isFrozen(tccFolders.TCC_PROTECTED_FOLDERS), 'a shared list nobody can edit in place');
  });

  it('builds the roots the server ships, in both the ~ and the absolute form', () => {
    assert.deepEqual(tccFolders.protectedRootsFor('/Users/tester'), [
      '~/Documents', '/Users/tester/Documents',
      '~/Desktop', '/Users/tester/Desktop',
      '~/Downloads', '/Users/tester/Downloads'
    ]);
    assert.deepEqual(tccFolders.protectedRootsFor(''), ['~/Documents', '~/Desktop', '~/Downloads'],
      'with no home, only the form an operator types');
  });

  it('every copy that cannot import the list still names every folder in it', () => {
    const caution = liftDeclaration(SETUP_SRC, 'function wizardUpdateDirAdvice');
    const apiHelper = fs.readFileSync(path.join(ROOT, 'public', 'api-helper.js'), 'utf8');
    const eacces = apiHelper.slice(apiHelper.indexOf('EACCES:'), apiHelper.indexOf('SCAN_FAILED:'));
    const install = fs.readFileSync(path.join(ROOT, 'deploy', 'install.sh'), 'utf8');
    const tccFn = liftDeclaration(install, 'tcc_protected_path()');
    for (const name of tccFolders.TCC_PROTECTED_FOLDERS) {
      assert.ok(caution.includes(`~/${name}`), `the wizard caution names ~/${name}`);
      assert.ok(eacces.includes(`~/${name}`), `the EACCES hint names ~/${name}`);
      // Lower-cased there, because the function folds case before matching.
      assert.ok(tccFn.includes(`"$_tcc_home/${name.toLowerCase()}/"*`), `install.sh's tcc_protected_path covers ${name}`);
    }
  });
});

describe('the shipped projects directory (#880)', () => {
  it('is ~/Projects, and the wizard\'s own check draws no caution for it', () => {
    assert.equal(DEFAULT_CONFIG.projectsDir, '~/Projects');
    const check = wizardCheck('/Users/tester');
    assert.equal(check(DEFAULT_CONFIG.projectsDir), null,
      'a fresh Mac must reach the projects step with no caution showing');
    assert.equal(check('/Users/tester/Projects'), null, 'nor for its absolute form');
    // The same check still fires for a protected folder an operator types, so
    // the test above is not passing because the check is inert.
    assert.equal(check('~/Documents/Projects'), '~/Documents');
    assert.equal(check('/Users/tester/Desktop/code'), '/Users/tester/Desktop');
  });

  it('is the value every copy that cannot import the store falls back to', () => {
    const quoted = `'${DEFAULT_CONFIG.projectsDir}'`;
    assert.ok(SETUP_SRC.includes(`state.config.projectsDir || ${quoted} : ${quoted}`),
      'the wizard\'s fallback when no config arrived');
    assert.ok(SETUP_SRC.includes(`placeholder="${DEFAULT_CONFIG.projectsDir}"`), 'the wizard\'s placeholder');
    const ui = fs.readFileSync(path.join(ROOT, 'public', 'ui.js'), 'utf8');
    assert.ok(ui.includes(`c.projectsDir || ${quoted}`), 'the settings modal\'s fallback');
    assert.ok(!/Documents\/Projects/.test(liftDeclaration(SETUP_SRC, 'function showWizard')),
      'no stale default left in the wizard\'s opening');
  });
});
