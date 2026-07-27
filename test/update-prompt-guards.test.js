'use strict';

/*
 * #730 — the update prompt injected into an AI session must go through the same
 * guarded applier as the dashboard button, never raw git.
 *
 * Two halves:
 *
 *  - Behavioral, over `scripts/apply-update.js`: the CLI reports the applier's
 *    verbatim result and its exit code distinguishes applied from refused. The
 *    applier is stubbed — a test that spawned the real script for coverage would
 *    run `git checkout` against the developer's own tree.
 *
 *  - Source-level, over `public/session.js`: the prompt text is a durable
 *    instruction executed verbatim by an agent, so its contract is the words.
 *    Same pattern as test/update-prompt-path.test.js (#183) and
 *    test/ub-self-update-pill.test.js.
 *
 * The regression this locks: `git pull origin main` merged into whatever branch
 * was checked out, and from a healthy install (detached at a release tag, which
 * is what `applyUpdate` leaves behind) it moved HEAD to a non-tag commit that
 * `_headState` then refuses — so one prompt-driven update disabled the button.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { main } = require('../scripts/apply-update');

/** Collect stdout writes for assertion. */
function capture() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
}

/**
 * Slice a function's body out of source text.
 *
 * The assertions below are about the instructions an agent receives, so they
 * must read the prompt itself — not the file around it. The JSDoc on
 * `buildUpdatePrompt` names the banned command deliberately (it records why the
 * command is banned), and a whole-file grep cannot tell that explanation apart
 * from an instruction to run it.
 *
 * @param {string} src - File source
 * @param {string} name - Function name
 * @returns {string} Source from the declaration to the matching closing brace
 */
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/**
 * Strip comments so a source sweep sees instructions, not prose about them.
 * @param {string} src - File source
 * @returns {string}
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('apply-update CLI (#730)', () => {
  it('exits 0 and prints the applier result when the update applied', () => {
    const out = capture();
    const result = { ok: true, code: null, error: null, fromSha: 'abc1234', toRef: 'v9.9.9', toSha: 'def5678' };
    const code = main({ applyUpdate: () => result }, out);

    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out.text()), result);
  });

  it('exits 1 on a refused guard, preserving the stable code for the caller', () => {
    const out = capture();
    const result = {
      ok: false,
      code: 'dirty-tree',
      error: 'local changes present — commit or stash before updating',
      fromSha: 'abc1234',
      toRef: null,
      toSha: null
    };
    const code = main({ applyUpdate: () => result }, out);

    assert.equal(code, 1);
    const printed = JSON.parse(out.text());
    assert.equal(printed.code, 'dirty-tree');
    assert.equal(printed.error, result.error);
  });

  it('exits 1 on a git failure and keeps fromSha so recovery is one line', () => {
    const out = capture();
    const code = main({
      applyUpdate: () => ({ ok: false, code: 'git-error', error: 'boom', fromSha: 'abc1234', toRef: null, toSha: null })
    }, out);

    assert.equal(code, 1);
    assert.equal(JSON.parse(out.text()).fromSha, 'abc1234');
  });

  it('does not restart the server — staging and restarting stay separate acts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'apply-update.js'), 'utf8');
    assert.doesNotMatch(src, /launchctl|server\/restart/);
  });

  it('runs the same applier the dashboard button calls — one guarded path', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'apply-update.js'), 'utf8');
    assert.match(src, /require\('\.\.\/lib\/update-applier'\)/);
  });
});

describe('injected update prompt (#730)', () => {
  let prompt;

  before(() => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
    prompt = functionBody(js, 'buildUpdatePrompt');
  });

  it('drives the guarded updater instead of raw git', () => {
    assert.match(prompt, /node scripts\/apply-update\.js/);
  });

  it('never tells the agent to pull, and never names a branch to update from', () => {
    // The specific regression: `git pull origin main` shipped unreleased commits
    // and stranded a tag-detached install off the applier.
    assert.doesNotMatch(prompt, /git pull/);
    assert.doesNotMatch(prompt, /git checkout/);
    assert.doesNotMatch(prompt, /origin main/);
  });

  it('forbids working around a refused guard rather than leaving it ambiguous', () => {
    // An agent told only "report the error" will often try to satisfy the guard
    // by stashing or switching branches — which destroys exactly what the guard
    // was protecting.
    assert.match(prompt, /Do NOT use git directly/);
    assert.match(prompt, /Do not try to satisfy the guard/);
    assert.match(prompt, /STOP/);
  });

  it('names the applier codes the agent will have to report', () => {
    for (const code of ['dirty-tree', 'wrong-ref', 'no-update', 'no-git', 'git-error']) {
      assert.match(prompt, new RegExp(code), `prompt omits the "${code}" refusal code`);
    }
  });

  it('states the restart cost rather than issuing it silently', () => {
    assert.match(prompt, /drops the dashboard/);
  });

  it('no public script hands an agent a bare git mutation of the install', () => {
    const publicDir = path.join(__dirname, '..', 'public');
    for (const file of fs.readdirSync(publicDir)) {
      if (!file.endsWith('.js')) continue;
      const src = stripComments(fs.readFileSync(path.join(publicDir, file), 'utf8'));
      assert.doesNotMatch(
        src,
        /git (pull|reset|stash)/,
        `${file} instructs a raw git mutation of the checkout`
      );
    }
  });
});
