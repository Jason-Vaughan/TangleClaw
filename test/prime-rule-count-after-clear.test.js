'use strict';

/**
 * After a clear, the prime states no rule count that disagrees with the rules
 * block beside it (#2317).
 *
 * The prime is written once, at launch, and a `clear` or `compact` fire prints
 * that file again as it is. The rules block is read at the fire. A count in the
 * prime is therefore the launch's count, and once a rule is activated or
 * retired it contradicts the block. The prime now states no count and names
 * the block as the authority, on every channel that carries the rules, and a
 * launch with no rules says what was true at launch rather than "none active".
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const hookOutput = require('../lib/prime-hook-output');
const rulesChannel = require('../lib/session-rules-channel');

/**
 * Any "<number> rule(s)" phrase, with or without a word between. "N binding rule
 * sources" counts channels, not rules, and is left out.
 */
const COUNTED = /(\d+)\s+(?:[A-Za-z-]+\s+)?rules?\b(?!\s+sources?\b)/gi;

/**
 * The text of one `## ` section of a prime, heading included.
 * @param {string} prime - The rendered prime.
 * @param {string} heading - The section heading, without the `## `.
 * @returns {string} The section, or '' when the prime has none.
 */
function section(prime, heading) {
  const start = prime.indexOf(`## ${heading}\n`);
  if (start === -1) return '';
  const next = prime.indexOf('\n## ', start + 3);
  return prime.slice(start, next === -1 ? undefined : next);
}

/**
 * The rule-sources line about project rules.
 * @param {string} prime - The rendered prime.
 * @returns {string}
 */
function projectRulesSource(prime) {
  const line = section(prime, 'Rule sources in force').split('\n').find((l) => l.includes('TangleClaw project rules'));
  assert.ok(line, 'the prime names the project rules as a source');
  return line;
}

describe('the prime after a clear states no stale rule count (#2317)', () => {
  let tmpDir;
  let projectsDir;
  let sessions;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rule-count-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    sessions = require('../lib/sessions');
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Create a project with some active startup rules.
   * @param {string} name - Project and directory name.
   * @param {string} engine - Engine id.
   * @param {number} rules - How many rules to activate.
   * @param {object} [config] - Project config to save.
   * @returns {object} The project record.
   */
  function makeProject(name, engine, rules, config = {}) {
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine });
    store.projectConfig.save(dir, { engine, ...config });
    addRules(project, rules, 'launch');
    return store.projects.get(project.id);
  }

  /**
   * Activate more startup rules on a project.
   * @param {object} project - Project record.
   * @param {number} count - How many.
   * @param {string} tag - Distinguishes their text.
   */
  function addRules(project, count, tag) {
    for (let i = 0; i < count; i++) {
      store.sessionRules.create({ projectId: project.id, content: `Rule ${tag} ${i}: keep the diff small.` });
    }
  }

  it('the manifest on the rules-hook channel states no count and keeps its absence check', () => {
    const project = makeProject('count-hook', 'claude', 3, { silentPrime: true });
    const prime = sessions.generatePrimePrompt(project, store.engines.get('claude'));
    const manifest = section(prime, 'Rules delivery');
    assert.ok(manifest.includes('they arrive on a separate channel'), 'it names the hook channel');
    assert.doesNotMatch(manifest, /\d/, 'no number of any kind');
    assert.ok(manifest.includes('look for a heading reading exactly **"Project Rules"**'));
    assert.ok(manifest.includes('that block states which rules are in force and how many'));
    assert.ok(manifest.includes('**If no such block is present, say so before you act on anything else**'));
    const source = projectRulesSource(prime);
    assert.doesNotMatch(source, COUNTED);
    assert.ok(source.endsWith('delivered through the rules hook.'), source);
  });

  it('the pull pointer of a launch sequence states no count and keeps its absence check', () => {
    const project = makeProject('count-pull', 'codex', 3);
    const prime = sessions.generatePrimePrompt(project, store.engines.get('codex'), { launchSequence: true });
    const pointer = section(prime, 'Rules delivery');
    assert.ok(pointer.includes('they arrive in the **governance** step of your launch sequence'), 'it names the launch-step channel');
    assert.doesNotMatch(pointer, /\d/, 'no number of any kind');
    assert.ok(pointer.includes('**"Project Rules"**, which states which rules are in force and how many'));
    assert.ok(pointer.includes('**If you reach the end of the sequence without having seen that block, say so before you act on anything else**'));
    const source = projectRulesSource(prime);
    assert.doesNotMatch(source, COUNTED);
    assert.ok(source.includes("in the governance step of this session's launch sequence"), source);
  });

  it('the rule-sources line of an inline delivery states no count', () => {
    const project = makeProject('count-inline', 'codex', 2);
    const source = projectRulesSource(sessions.generatePrimePrompt(project, store.engines.get('codex'), {}));
    assert.doesNotMatch(source, COUNTED);
    assert.ok(source.endsWith('delivered in this prime.'), source);
  });

  it('a clear re-delivers a prime written with 3 rules beside a block of 7, and no number disagrees', () => {
    const project = makeProject('count-clear', 'claude', 3, { silentPrime: true });
    const prime = sessions.generatePrimePrompt(project, store.engines.get('claude'));
    addRules(project, 4, 'later');
    const active = store.sessionRules.listActiveForProject(project.id);
    assert.equal(active.length, 7);
    const shards = rulesChannel.buildShards(active, 100000);
    assert.equal(shards.length, 1);
    const block = rulesChannel.renderShardText(shards[0], active.length);
    assert.ok(block.includes('(all 7)'), 'the block read at the fire holds 7');

    const reentry = hookOutput.renderReentryFile(project);
    const redelivered = hookOutput.composeHookOutput({ source: 'clear', reentry, prime, advisory: null });
    assert.ok(redelivered.includes(prime), 'the clear prints the launch prime as written');
    const counts = [...redelivered.matchAll(COUNTED)].map((m) => Number(m[1]));
    assert.deepEqual(counts.filter((n) => n !== 7), [], `the re-delivered output states a count the block contradicts: ${counts}`);
  });

  it('a launch with no rules says what was true at launch and points at the block', () => {
    const project = makeProject('count-none', 'claude', 0, { silentPrime: true });
    const prime = sessions.generatePrimePrompt(project, store.engines.get('claude'));
    assert.equal(section(prime, 'Rules delivery'), '', 'no manifest without rules');
    const source = projectRulesSource(prime);
    assert.ok(source.includes('none were active when this session launched'), source);
    assert.ok(source.includes('a **Project Rules** block in your context, if present, is in force'), source);
    assert.ok(!prime.includes('none active for this project'), 'nothing claims the project has none now');
  });
});
