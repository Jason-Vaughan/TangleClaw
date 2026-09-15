'use strict';

/*
 * #1512 — the Stop tracking / Keep tracking offer in the wrap drawer.
 *
 * The pure drawer helpers run in a sandbox the way the page loads them; the
 * session page's render function is lifted out of the real source and RUN
 * against the mini DOM, because a source match cannot say what the operator sees.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./_mini-dom');

const PUB = path.join(__dirname, '..', 'public');
const SESSION_SRC = fs.readFileSync(path.join(PUB, 'session.js'), 'utf8');

/**
 * Load the drawer helpers the way the page does, in a sandbox.
 *
 * @returns {object} The exported helpers.
 */
function loadHelpers() {
  const src = fs.readFileSync(path.join(PUB, 'wrap-drawer.js'), 'utf8');
  const sandbox = { module: { exports: {} }, window: null };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.module.exports;
}

/**
 * Slice a top-level function out of source text by brace-matching.
 *
 * @param {string} src - File source text.
 * @param {string} decl - Declaration to find.
 * @returns {string} The declaration plus its balanced body.
 */
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
  return '';
}

const H = loadHelpers();

/** session-files halted on the offer, as the runner records it. */
const haltedOffer = () => ({
  stepId: 'session-files',
  kind: 'session-files',
  status: 'needs-operator',
  blockers: ['2 TangleClaw state files are tracked by git — choose Stop tracking or Keep tracking before the wrap goes on'],
  output: { untrackOffer: { paths: ['.tangleclaw/medusa/registry.json', '.tangleclaw/session-prime.md'] }, remediation: 'r' }
});

/**
 * Every descendant of an element, depth first.
 *
 * @param {object} el - Root.
 * @returns {object[]} Descendants.
 */
const all = (el) => el.childNodes.flatMap((c) => [c, ...all(c)]);

describe('untrackOfferWidget', () => {
  it('describes the halted offer with its exact paths', () => {
    const raw = haltedOffer();
    const w = H.untrackOfferWidget(H.buildStepRow(raw, { blockedAt: 'session-files' }), raw.output);
    assert.equal(w.kind, 'untrack-offer');
    assert.equal(w.optionsKey, 'untrackState');
    assert.deepEqual([...w.paths], ['.tangleclaw/medusa/registry.json', '.tangleclaw/session-prime.md']);
  });

  it('is null for anything that is not that halt', () => {
    const raw = haltedOffer();
    assert.equal(H.untrackOfferWidget(H.buildStepRow({ ...raw, status: 'blocked' }, { blockedAt: 'session-files' }), raw.output), null);
    assert.equal(H.untrackOfferWidget(H.buildStepRow(raw, { blockedAt: 'commit' }), raw.output), null, 'not the active blocker');
    assert.equal(H.untrackOfferWidget(H.buildStepRow(raw, { blockedAt: 'session-files' }), { untrackOffer: { paths: [] } }), null);
    assert.equal(H.untrackOfferWidget(H.buildStepRow({ ...raw, kind: 'commit', stepId: 'commit' }, { blockedAt: 'commit' }), raw.output), null);
  });
});

describe('the answer rides the Retry', () => {
  it('sends only approve or decline', () => {
    assert.equal(H.collectOptionsFromAccessors({ untrackState: () => 'approve' }).untrackState, 'approve');
    assert.equal(H.collectOptionsFromAccessors({ untrackState: () => 'decline' }).untrackState, 'decline');
    assert.equal(H.collectOptionsFromAccessors({ untrackState: () => '' }).untrackState, undefined);
    assert.equal(H.collectOptionsFromAccessors({ untrackState: () => 'yes' }).untrackState, undefined);
  });

  it('retryWrap prefers a drawer answer and keeps it for the rest of the wrap; a new wrap forgets it', () => {
    const retry = liftFunction(SESSION_SRC, 'async function retryWrap()');
    assert.match(retry, /\.wrap-decision--untrack input\[type="radio"\]:checked/);
    assert.match(retry, /picked \? picked\.value : wrapUntrackState/);
    assert.match(retry, /if \(options\.untrackState\) wrapUntrackState = options\.untrackState/);
    assert.match(liftFunction(SESSION_SRC, 'async function confirmWrap()'), /wrapUntrackState = '';/);
    assert.match(liftFunction(SESSION_SRC, 'function adoptWrapRunChoices(options)'), /wrapUntrackState = choices\.untrackState;/);
  });

  it('the drawer renders the widget for a blocked row', () => {
    assert.match(SESSION_SRC, /const untrackWidget = H\.untrackOfferWidget\(row, raw\.output\);/);
  });
});

describe('renderUntrackOfferWidget (run)', () => {
  /**
   * Render the widget for the halted fixture.
   *
   * @returns {object} The widget's root element.
   */
  function render() {
    const { doc } = makeDocument([]);
    const ctx = { document: doc };
    vm.createContext(ctx);
    vm.runInContext(liftFunction(SESSION_SRC, 'function renderUntrackOfferWidget(widget)'), ctx);
    const raw = haltedOffer();
    return ctx.renderUntrackOfferWidget(H.untrackOfferWidget(H.buildStepRow(raw, { blockedAt: 'session-files' }), raw.output));
  }

  it('names every path and says the files stay on disk', () => {
    const root = render();
    assert.equal(root.className, 'wrap-decision wrap-decision--untrack');
    assert.equal(root.dataset.optionsKey, 'untrackState');
    const text = all(root).map((n) => n.textContent || '').join('\n');
    assert.match(text, /2 TangleClaw state files are tracked by git/);
    assert.match(text, /\.tangleclaw\/medusa\/registry\.json/);
    assert.match(text, /\.tangleclaw\/session-prime\.md/);
    assert.match(text, /the files stay on disk/);
  });

  it('offers Stop and Keep tracking with neither preselected, outside the Include / Leave list', () => {
    const nodes = all(render());
    const radios = nodes.filter((n) => n.tagName === 'INPUT');
    assert.deepEqual(radios.map((r) => r.value), ['approve', 'decline']);
    assert.ok(radios.every((r) => r.type === 'radio' && r.name === 'wrapUntrackOffer' && r.checked !== true));
    assert.equal(nodes.some((n) => /wrap-decision-pathlist/.test(n.className || '')), false,
      'inside that list the Include / Leave accessor would read these radios as file decisions');
  });
});
