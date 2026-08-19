'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

const LANDING_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');

const readEngine = (id) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', `${id}.json`), 'utf8'));

function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

function setupLanding() {
  const ids = ['launchModeModal', 'launchModeText', 'launchModeList', 'launchModeWarning', 'launchModeConfirmBtn'];
  const { doc, ids: domIds } = makeDocument(ids);
  
  const ctx = {
    document: doc,
    window: { location: { host: 'localhost:3000' } },
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    pendingContinuityMode: null,
    launchModeTarget: null,
    selectedLaunchMode: null
  };
  
  vm.createContext(ctx);
  vm.runInContext(liftFunction(LANDING_SRC, 'function updateLaunchModeWarning'), ctx);
  vm.runInContext(liftFunction(LANDING_SRC, 'function openLaunchModeModal'), ctx);
  
  return { doc, ctx };
}

describe('Launch Mode picker (#596)', () => {
  it('renders all enabled modes from the engine profile and checks the default', () => {
    const { doc, ctx } = setupLanding();
    const claude = readEngine('claude');
    
    ctx.openLaunchModeModal('MyProj', claude);
    
    const list = doc.getElementById('launchModeList');
    const html = list.innerHTML;
    
    // Assert vacuous pass prevention
    assert.ok(html.includes('launch-mode-option'), 'must render at least one option');
    
    // Check modes
    assert.match(html, /value="default"/);
    assert.match(html, /value="acceptEdits"/);
    assert.match(html, /value="plan"/);
    assert.match(html, /value="auto"/);
    assert.match(html, /value="bypassPermissions"/);
    
    // Default checked
    assert.match(html, /value="default" checked/);
  });
  
  it('renders the warning for bypassPermissions', () => {
    const { doc, ctx } = setupLanding();
    const claude = readEngine('claude');
    
    ctx.openLaunchModeModal('MyProj', claude);
    
    const list = doc.getElementById('launchModeList');
    assert.match(list.innerHTML, /Only use in isolated environments/);
  });

  it('wires Launch button to doLaunchProject with selected mode', async () => {
    const { doc, ctx } = setupLanding();
    const claude = readEngine('claude');
    
    let launched = null;
    ctx.doLaunchProject = async (name, mode, contMode) => {
      launched = { name, mode, contMode };
    };
    // We need to lift closeLaunchModeModal and confirmLaunchMode as well
    vm.runInContext(liftFunction(LANDING_SRC, 'function closeLaunchModeModal'), ctx);
    vm.runInContext(liftFunction(LANDING_SRC, 'async function confirmLaunchMode'), ctx);

    ctx.openLaunchModeModal('MyProj', claude);
    ctx.selectedLaunchMode = 'bypassPermissions';
    await ctx.confirmLaunchMode();
    
    assert.deepEqual(launched, {
      name: 'MyProj',
      mode: 'bypassPermissions',
      contMode: null
    }, 'must launch with the currently selected mode');
  });
});
