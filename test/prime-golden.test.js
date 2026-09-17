'use strict';

/**
 * Byte identity of the pushed prime across the launch-step refactor
 * (Train 21, car 21.2).
 *
 * `generatePrimePrompt` now composes from the same tagged sections that
 * `renderLaunchSteps` serves over `tc start`. The pushed prime must still be
 * byte for byte what it was, apart from the one declared delta: the bootstrap
 * line, which appears only when a launch has a sequence to pull. That delta is
 * tested in `test/launch-steps.test.js`; here no scenario passes one.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { renderScenarios } = require('./_prime-golden-scenarios');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'prime-golden');

describe('pushed prime byte identity (car 21.2)', () => {
  let tmpDir;
  let rendered;
  let savedContract;

  before(() => {
    savedContract = process.env.MEDUSA_CONTRACT_PATH;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-prime-golden-'));
    store._setBasePath(tmpDir);
    store.init();
    const config = store.config.load();
    config.projectsDir = path.join(tmpDir, 'projects');
    store.config.save(config);
    const sessions = require('../lib/sessions');
    rendered = renderScenarios(store, tmpDir, (p, e, o) => sessions.generatePrimePrompt(p, e, o));
    if (process.env.UPDATE_PRIME_GOLDEN === '1') {
      fs.mkdirSync(FIXTURE_DIR, { recursive: true });
      for (const [name, text] of Object.entries(rendered)) {
        fs.writeFileSync(path.join(FIXTURE_DIR, `${name}.txt`), text);
      }
    }
  });

  after(() => {
    if (savedContract === undefined) delete process.env.MEDUSA_CONTRACT_PATH;
    else process.env.MEDUSA_CONTRACT_PATH = savedContract;
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has a fixture for every scenario and a scenario for every fixture', () => {
    const fixtures = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)).sort();
    assert.deepEqual(Object.keys(rendered).sort(), fixtures);
  });

  for (const name of ['full-silent-claude', 'paste-codex', 'overflow-claude', 'fresh-antigravity', 'audit-openclaw']) {
    it(`renders ${name} byte for byte as before`, () => {
      const expected = fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8');
      assert.equal(rendered[name], expected);
    });
  }

  it('the scenarios reach the sections they exist to pin', () => {
    const full = rendered['full-silent-claude'];
    for (const heading of ['## Rules delivery', '## Rule sources in force', '## Medusa Switchboard',
      '## Active Learnings', '## Resume', '## Feature Index', '## Project Map', '## Wrapping this session', 'Launch heal: moved one leftover file.']) {
      assert.ok(full.includes(heading), `full scenario carries ${heading}`);
    }
    assert.ok(rendered['paste-codex'].includes('## Project Rules'), 'paste engines get inline rules');
    assert.ok(rendered['paste-codex'].includes('## Last Session Summary'));
    const overflow = rendered['overflow-claude'];
    assert.ok(overflow.includes('exceeds the 10000-character budget'), 'the overflow note is pinned');
    assert.ok(overflow.includes('omitted here to fit the prime size budget'), 'bulk sections yielded first');
    assert.ok(rendered['audit-openclaw'].includes('## Eval Audit Mode: Active'));
    assert.ok(!rendered['fresh-antigravity'].includes('## Resume'), 'fresh mode skips the resume block');
  });
});
