'use strict';

/*
 * #540 ask-mode — the operator picks the version bump in the wrap modal
 * (Auto / Patch / Minor / Major) and it threads to the pipeline as
 * `options.bumpLevel`, which `version-bump` honors (and skips loudly on an
 * out-of-set value rather than falling back to the heuristic).
 *
 * Two layers, because the path spans pure logic and browser DOM code:
 *  - the option assembly is a pure helper in `public/wrap-drawer.js`;
 *  - the modal capture/reset/threading lives in `public/session.js`, which is
 *    not require()-able, so it's pinned at the source level per the
 *    test/wrap-drawer-select-a11y.test.js convention.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadHelpers() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'wrap-drawer.js'), 'utf8');
  const sandbox = { module: { exports: {} }, window: null };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.module.exports;
}

/**
 * Slice out a top-level function body by brace-matching from its declaration.
 * @param {string} src full source text
 * @param {string} decl the function declaration to find
 * @returns {string} the function body including its braces
 */
function functionBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  assert.fail(`${decl} body must close`);
}

describe('#540 ask-mode — collectOptionsFromAccessors carries bumpLevel', () => {
  const H = loadHelpers();

  it('threads an explicit level through to options', () => {
    const opts = H.collectOptionsFromAccessors({ bumpLevel: () => 'minor' });
    assert.equal(opts.bumpLevel, 'minor');
  });

  it('omits bumpLevel entirely for Auto (empty string)', () => {
    // Load-bearing: version-bump treats an out-of-set bumpLevel as a reason to
    // SKIP, so sending '' for Auto would disable the bump instead of running
    // the CHANGELOG heuristic.
    const opts = H.collectOptionsFromAccessors({ bumpLevel: () => '' });
    assert.equal('bumpLevel' in opts, false);
  });

  it('omits bumpLevel when no accessor is supplied at all', () => {
    const opts = H.collectOptionsFromAccessors({});
    assert.equal('bumpLevel' in opts, false);
  });

  it('coexists with the other retry options rather than replacing them', () => {
    const opts = H.collectOptionsFromAccessors({
      bumpLevel: () => 'major',
      skipTests: () => true,
      skipAiContent: () => 'changelog-update'
    });
    assert.equal(opts.bumpLevel, 'major');
    assert.equal(opts.skipTests, true);
    // Compared field-wise, not deepEqual: the helper is evaluated in a vm
    // sandbox, so its objects carry that realm's prototype and deepStrictEqual
    // rejects them as not reference-equal despite identical structure.
    assert.equal(opts.skipAiContent['changelog-update'], true);
  });

  it('ignores a non-string accessor return', () => {
    const opts = H.collectOptionsFromAccessors({ bumpLevel: () => null });
    assert.equal('bumpLevel' in opts, false);
  });
});

describe('#540 ask-mode — the modal wiring (source pins)', () => {
  let session;
  let html;

  before(() => {
    const root = path.resolve(__dirname, '..');
    session = fs.readFileSync(path.join(root, 'public/session.js'), 'utf8');
    html = fs.readFileSync(path.join(root, 'public/session.html'), 'utf8');
  });

  it('the modal offers Auto plus the three semver levels', () => {
    assert.match(html, /id="wrapBumpLevel"/, 'the select exists');
    for (const level of ['patch', 'minor', 'major']) {
      assert.match(html, new RegExp(`<option value="${level}"`), `offers ${level}`);
    }
    assert.match(html, /<option value="">Auto/, 'offers an Auto default that sends nothing');
  });

  it('the select is labelled for a11y', () => {
    assert.match(html, /<label[^>]*for="wrapBumpLevel"/, 'label is tied to the select');
  });

  it('confirmWrap captures the choice and sends it through the shared option assembler', () => {
    const body = functionBody(session, 'async function confirmWrap()');
    assert.match(body, /getElementById\('wrapBumpLevel'\)/, 'reads the select');
    assert.match(body, /collectOptionsFromAccessors\(/,
      'assembles options via the same pure helper the retry path uses, so the two cannot drift');
    assert.match(body, /bumpLevel:\s*\(\)\s*=>\s*wrapBumpLevel/, 'supplies the bumpLevel accessor');
    assert.match(body, /body\.options\s*=\s*initialOptions/,
      'threads the assembled options into the wrap POST body');
  });

  it('openWrapModal resets the choice to Auto, so a cancelled pick cannot re-arm', () => {
    const body = functionBody(session, 'function openWrapModal()');
    assert.match(body, /wrapBumpLevel/, 'the modal reset touches the bump select');
    assert.match(body, /bumpEl\.value\s*=\s*''/, 'and clears it back to Auto');
  });

  it('retryWrap replays the choice via the pure helper accessor', () => {
    const body = functionBody(session, 'async function retryWrap()');
    assert.match(body, /bumpLevel:\s*\(\)\s*=>\s*wrapBumpLevel/,
      'retry supplies the bumpLevel accessor so the pipeline re-runs with the same choice');
  });
});
