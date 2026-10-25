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

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { liftBody } = require('./helpers/lift');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const versionBump = require('../lib/wrap-steps/version-bump');

setLevel('error');

function loadHelpers() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'wrap-drawer.js'), 'utf8');
  const sandbox = { module: { exports: {} }, window: null };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.module.exports;
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
    const body = liftBody(session, 'async function confirmWrap()');
    assert.match(body, /getElementById\('wrapBumpLevel'\)/, 'reads the select');
    assert.match(body, /collectOptionsFromAccessors\(/,
      'assembles options via the same pure helper the retry path uses, so the two cannot drift');
    assert.match(body, /bumpLevel:\s*\(\)\s*=>\s*wrapBumpLevel/, 'supplies the bumpLevel accessor');
    assert.match(body, /body\.options\s*=\s*initialOptions/,
      'threads the assembled options into the wrap POST body');
  });

  it('openWrapModal resets the choice to Auto, so a cancelled pick cannot re-arm', () => {
    const body = liftBody(session, 'function openWrapModal()');
    assert.match(body, /wrapBumpLevel/, 'the modal reset touches the bump select');
    assert.match(body, /bumpEl\.value\s*=\s*''/, 'and clears it back to Auto');
  });

  it('retryWrap replays the choice via the pure helper accessor', () => {
    const body = liftBody(session, 'async function retryWrap()');
    assert.match(body, /bumpLevel:\s*\(\)\s*=>\s*wrapBumpLevel/,
      'retry supplies the bumpLevel accessor so the pipeline re-runs with the same choice');
  });

  // #1497 — syncWrapReleaseControls offNote and legacy versionBumpEnabled guard
  it('syncWrapReleaseControls sets offNote text mentioning the API override path', () => {
    const body = liftBody(session, 'function syncWrapReleaseControls()');
    assert.match(body, /release.*cut.*options|options.*release.*cut/i,
      'offNote text mentions passing release: cut in options to override the off state');
  });

  it('syncWrapReleaseControls treats legacy versionBumpEnabled:false as off (A466-G2)', () => {
    const body = liftBody(session, 'function syncWrapReleaseControls()');
    assert.match(body, /versionBumpEnabled\s*===\s*false/,
      'const off covers legacy versionBumpEnabled:false projects without a releaseMode field');
  });
});

// #1497 — version-bump.run() behaviour when releaseMode is off, tested here
// because test/version-bump-release-gate.test.js is outside W4-A's P0.2 target scope.
describe('#1497 version-bump.run — releaseMode:off override (A466-G2)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-off-override-'));
    store._setBasePath(path.join(tmpDir, 'store'));
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    versionBump._internal.todayIso = () => '2026-09-14';
  });

  /** Minimal off-project: version.json at 1.2.3, CHANGELOG with an Added entry. */
  function makeOffProject(config = { releaseMode: 'off' }) {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'p-'));
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '1.2.3' }));
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n### Added\n- a feature\n\n## [1.2.3] - 2026-09-01\n\n### Fixed\n- a fix\n');
    fs.mkdirSync(path.join(dir, '.tangleclaw'));
    fs.writeFileSync(path.join(dir, '.tangleclaw', 'project.json'), JSON.stringify(config));
    return { name: path.basename(dir), path: dir };
  }

  const run = (project, options = {}) => {
    const context = { project, step: { id: 'version-bump', kind: 'version-bump' }, staged: {}, options, previousResults: [] };
    return versionBump.run(context).then((result) => ({ result, staged: context.staged }));
  };

  it('skips but names the ignored bumpLevel when level sent without release:cut (A466-G2)', async () => {
    const { result, staged } = await run(makeOffProject(), { bumpLevel: 'minor' });
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /releaseMode is off/);
    assert.match(result.output.reason, /bumpLevel .minor. was ignored/);
    assert.equal(result.output.ignoredBumpLevel, 'minor');
    assert.deepEqual(staged, {});
  });

  it('proceeds when operator sends release:cut (A466-G2 override)', async () => {
    const { result, staged } = await run(makeOffProject(), { release: 'cut' });
    assert.equal(result.status, 'done');
    assert.equal(result.output.from, '1.2.3');
    assert.equal(result.output.to, '1.3.0');
    assert.equal(result.output.releaseModeOverride, 'operator-supplied-release-cut');
    assert.ok(staged['version-bump:changelog']);
  });

  it('proceeds with the supplied bumpLevel when both release:cut and bumpLevel are sent', async () => {
    const { result } = await run(makeOffProject(), { release: 'cut', bumpLevel: 'patch' });
    assert.equal(result.status, 'done');
    assert.equal(result.output.bumpLevel, 'patch');
    assert.equal(result.output.to, '1.2.4');
    assert.equal(result.output.releaseModeOverride, 'operator-supplied-release-cut');
  });
});
