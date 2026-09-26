'use strict';

/*
 * #1888: the SessionStart prime hook's WHOLE output must fit the engine cap.
 *
 * The hook prints the prime, then the UI wrap advisory, and on a `/clear` or
 * compaction fire it puts the re-entry preamble first. The engine caps that
 * combined output, and past the cap it injects a 2 KB preview instead, so a
 * session starts without its prime. The prime was budgeted against the cap as
 * if it were printed alone, and a Medusa project's prime (whose contract
 * section expands into whatever room is left) filled it, so the advisory then
 * pushed the output over.
 *
 * These tests run the REAL hook script, not a model of it. Two things are
 * pinned: the Node composition matches what the script prints byte for byte,
 * and the composed output of a maximum Medusa prime stays within the cap on
 * both a startup and a `/clear` fire.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');
setLevel('error');
const store = require('../lib/store');
const sessions = require('../lib/sessions');
const hookOutput = require('../lib/prime-hook-output');
const provenance = require('../lib/provenance');

const HOOK = path.join(__dirname, '..', 'data', 'hooks', 'sessionstart-prime-claude.sh');

/**
 * What the real hook prints for one fire in `dir`.
 * @param {string} dir - Project root (CLAUDE_PROJECT_DIR).
 * @param {string} source - startup | resume | clear | compact
 * @returns {string}
 */
function runHook(dir, source) {
  const r = spawnSync('bash', [HOOK], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    input: JSON.stringify({ hook_event_name: 'SessionStart', source }),
    encoding: 'utf8'
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/**
 * @param {string} dir
 * @param {string} rel
 * @param {string|null} text - Null removes the file.
 */
function put(dir, rel, text) {
  const file = path.join(dir, rel);
  if (text === null) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe('the Node composition is what the hook prints', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hook-parity-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const PRIME = '# Session Start — demo\n\nbody line\n';
  const REENTRY = hookOutput.renderReentryFile({ name: 'demo' }, {});
  const ADVISORY = hookOutput.renderAdvisoryFile({});
  const cases = [
    ['all three files', PRIME, REENTRY, ADVISORY],
    ['no advisory', PRIME, REENTRY, null],
    ['no re-entry preamble', PRIME, null, ADVISORY],
    ['advisory alone (no prime)', null, REENTRY, ADVISORY],
    ['a prime without a trailing newline', 'no newline at end', REENTRY, ADVISORY]
  ];
  for (const [label, prime, reentry, advisory] of cases) {
    for (const source of ['startup', 'resume', 'clear', 'compact']) {
      it(`${label}, ${source}`, () => {
        put(dir, '.tangleclaw/session-prime.md', prime);
        put(dir, '.tangleclaw/session-reentry.md', reentry);
        put(dir, '.tangleclaw/ui-wrap-advisory.md', advisory);
        assert.equal(runHook(dir, source), hookOutput.composeHookOutput({ source, prime, reentry, advisory }));
      });
    }
  }
});

describe('companionOverhead is the worst case the hook adds to a prime', () => {
  it('equals the /clear output minus the prime, with provenance on or off', () => {
    const project = { name: 'demo' };
    for (const config of [{}, { provenanceWatermark: { enabled: true, template: null } }]) {
      const ctx = { config, project: 'demo', engine: 'claude' };
      const prime = 'P'.repeat(500);
      const full = hookOutput.composeHookOutput({
        source: 'clear', prime,
        reentry: hookOutput.renderReentryFile(project, ctx),
        advisory: hookOutput.renderAdvisoryFile(ctx)
      });
      assert.equal(hookOutput.companionOverhead(project, ctx), full.length - prime.length);
      assert.equal(hookOutput.primeReserve(project, ctx),
        full.length - prime.length + provenance.lineOverhead('session-prime', ctx));
    }
  });

  it('with provenance on, both companions carry their line', () => {
    const ctx = { config: { provenanceWatermark: { enabled: true, template: null } }, project: 'demo', engine: 'claude' };
    assert.ok(hookOutput.renderAdvisoryFile(ctx).startsWith('<!-- tangleclaw:provenance '));
    assert.ok(hookOutput.renderReentryFile({ name: 'demo' }, ctx).startsWith('<!-- tangleclaw:provenance '));
    assert.equal(hookOutput.renderAdvisoryFile({}), hookOutput.UI_WRAP_ADVISORY_TEXT, 'and none while off');
  });
});

describe('#1888 regression: a maximum Medusa prime fits the cap on every fire', () => {
  let tmpDir;
  let project;
  let claude;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1888-'));
    store._setBasePath(tmpDir);
    store.init();
    const dir = path.join(tmpDir, 'medusa-max');
    fs.mkdirSync(dir, { recursive: true });
    store.projects.create({ name: 'medusa-max', path: dir, engine: 'claude' });
    project = store.projects.getByName('medusa-max');
    claude = store.engines.get('claude');
    // Grow the project's own state until the Medusa contract is squeezed and
    // the unreserved prime fills the cap. That is the maximum payload: the
    // contract expands into whatever room the rest of the prime leaves.
    const cap = claude.capabilities.startupInjection.maxChars;
    store.projectConfig.save(project.path, { engine: 'claude', silentPrime: true, medusaEnabled: true });
    for (let i = 0; i < 60; i++) {
      const prime = sessions.generatePrimePrompt(project, claude, { medusaWorkspaceId: 'medusa-max-0000abcd' });
      if (prime.length > cap - 100) break;
      store.learnings.create({ projectId: project.id, content: `Learning ${i}: ${'state the project accumulated. '.repeat(8)}`, tier: 'active' });
    }
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Generate and write the three files the way a launch does, then return what
   * the real hook prints for `source`.
   * @param {object} config - Project config to save.
   * @param {boolean} reserve - Whether to budget the companions (false models the defect).
   * @param {string} source
   * @returns {{output: string, cap: number, prime: string}}
   */
  function launchLike(config, reserve, source) {
    store.projectConfig.save(project.path, { engine: 'claude', silentPrime: true, medusaEnabled: true, ...config });
    const projConfig = store.projectConfig.load(project.path);
    const ctx = { config: projConfig, project: project.name, engine: 'claude' };
    const prime = sessions.generatePrimePrompt(project, claude, {
      medusaWorkspaceId: 'medusa-max-0000abcd',
      reserveChars: reserve ? hookOutput.primeReserve(project, ctx) : 0
    });
    sessions._writePrimeFile(project.path, prime, ctx);
    sessions._writeReentryFile(project.path, project, ctx);
    provenance.writeOwnedFile(path.join(project.path, '.tangleclaw', 'ui-wrap-advisory.md'),
      'ui-wrap-advisory', hookOutput.UI_WRAP_ADVISORY_TEXT, ctx);
    return { output: runHook(project.path, source), cap: claude.capabilities.startupInjection.maxChars, prime };
  }

  it('precondition: the Medusa contract fills an unreserved prime to the cap, so the defect is reachable', () => {
    const { output, cap, prime } = launchLike({}, false, 'startup');
    assert.ok(prime.length > cap - 200, `the prime should nearly fill the cap (got ${prime.length} of ${cap})`);
    assert.ok(output.length > cap, `without the reserve the hook output must overflow (got ${output.length} of ${cap})`);
  });

  for (const provenanceOn of [false, true]) {
    for (const source of ['startup', 'clear', 'compact']) {
      it(`${source} fire, provenance ${provenanceOn ? 'on' : 'off'}: the whole output is within the cap`, () => {
        const config = provenanceOn ? { provenanceWatermark: { enabled: true, template: null } } : {};
        const { output, cap } = launchLike(config, true, source);
        assert.ok(output.length <= cap, `hook printed ${output.length} characters against a ${cap} cap`);
        assert.ok(output.includes('# Session Start — medusa-max'), 'the prime itself is in the output');
        if (source !== 'startup') assert.ok(output.startsWith(provenanceOn ? '<!-- tangleclaw:provenance ' : '# Context re-entry'));
      });
    }
  }
});
