'use strict';

/*
 * An extension rule that carries a VALUE has to reach the generated config
 * (#1253).
 *
 * `rules.extensions` was collected with `filter(([, v]) => v === true)`, so the
 * only non-boolean rule the product ships — `loggingLevel`, default `'info'` —
 * could never reach the prose path. Two generators read it straight off the
 * config and worked; the three markdown ones never mentioned it, which made a
 * real setting silently do nothing on three of five engines. ADR 0013 makes
 * that a defect rather than a gap.
 *
 * Widening a filter that every generated config file depends on is the risk
 * here, so the boolean rules are pinned to render exactly as they did.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const engines = require('../lib/engines');
const { DEFAULT_PROJECT_CONFIG } = require('../lib/project-config');

/** @param {object} extensions - `rules.extensions` to render. @returns {object} A project config. */
const withExtensions = (extensions) => ({ rules: { core: {}, extensions } });

/** @param {object} extensions - `rules.extensions`. @returns {string[]} The rendered rule lines. */
const linesFor = (extensions) =>
  engines._getRulesContent(withExtensions(extensions), null).extensionRulesLines;

// Every generator that emits the rules prose, and how it renders one line. The
// roster is the fixture: a generator added without the rules block would
// otherwise be the one place a value-carrying rule stays invisible, which is
// the shape of the defect itself.
const GENERATORS = [
  { name: 'claude-md', run: (cfg) => engines._generateClaudeMd(cfg, null) },
  { name: 'codex-yaml', run: (cfg) => engines._generateCodexYaml(cfg, null) },
  { name: 'aider-conf', run: (cfg) => engines._generateAiderConf(cfg, null) },
  { name: 'gemini-md', run: (cfg) => engines._generateGeminiMd(cfg, '# GEMINI.md', null) },
  { name: 'antigravity-md', run: (cfg) => engines._generateGeminiMd(cfg, '## TangleClaw', null) }
];

describe('an extension rule that carries a value reaches the generated config (#1253)', () => {
  it('renders a string-valued rule as prose naming its value', () => {
    const lines = linesFor({ loggingLevel: 'debug' });
    assert.deepEqual(lines, ['Log at the "debug" level'],
      'the value is the content — a label without it tells the agent nothing');
  });

  it('reaches every generator, not only the two that read the key directly', () => {
    // `_generateCodexYaml` and `_generateAiderConf` already emitted their own
    // native field for this rule and were the only two engines on which the
    // setting did anything. The prose is what makes it real on the other three.
    for (const gen of GENERATORS) {
      const content = gen.run(withExtensions({ loggingLevel: 'debug' }));
      assert.ok(content.includes('Log at the "debug" level'),
        `${gen.name} never mentions the rule's value`);
    }
  });

  it('keeps the two native fields the engines that read the key already emit', () => {
    // The prose is added, not swapped in: codex and aider act on their own
    // fields, and losing them would trade one silent setting for another.
    assert.ok(engines._generateCodexYaml(withExtensions({ loggingLevel: 'debug' }), null)
      .includes('logging_level: debug'));
    assert.ok(engines._generateAiderConf(withExtensions({ loggingLevel: 'debug' }), null)
      .includes('verbose: true'));
  });

  it('renders the level the product ships, so a default project is told it too', () => {
    // Not gated on "differs from the default": the two engines that read the
    // key emit it at the default as well, and a rule the agent is told about
    // on codex but not on claude is the same inconsistency in a new place.
    const shipped = DEFAULT_PROJECT_CONFIG.rules.extensions.loggingLevel;
    assert.equal(typeof shipped, 'string', 'the shipped default must still be value-carrying');
    assert.deepEqual(linesFor({ loggingLevel: shipped }), [`Log at the "${shipped}" level`]);
  });

  it('names the value of a value-carrying rule it has no label for', () => {
    // Falling through to the bare key would print a rule whose content is the
    // half that matters, dropped.
    assert.deepEqual(linesFor({ retryBudget: 3 }), ['retryBudget: 3']);
  });

  describe('the off-switch is unchanged — this widens the filter, it does not remove it', () => {
    it('drops false, which is how every boolean rule is turned off', () => {
      assert.deepEqual(linesFor({ docsParity: false, loggingLevel: false }), []);
    });

    it('drops an absent key', () => {
      assert.deepEqual(linesFor({}), []);
    });

    it('drops values that express nothing', () => {
      // An empty string is an unset field, not a level; null and undefined are
      // absence spelled two more ways; an object has no one-line prose form.
      assert.deepEqual(linesFor({
        loggingLevel: '', a: '   ', b: null, c: undefined, d: {}, e: [], f: NaN
      }), []);
    });

    it('renders the boolean rules exactly as it did before the filter widened', () => {
      // The frozen expectation: every generated config file in every project
      // depends on these sentences, and this is the change most able to move
      // one without anybody noticing.
      assert.deepEqual(linesFor({
        identitySentry: true,
        docsParity: true,
        decisionFramework: true,
        zeroDebtProtocol: true,
        independentCritic: true,
        adversarialTesting: true
      }), [
        'Verify identity with sentry checks',
        'Update docs in same commit as code changes',
        'Use decision framework before adding code',
        'Zero tech debt protocol',
        'Independent Critic review after medium+ work',
        'Adversarial stress testing'
      ]);
    });

    it('keeps declaration order when boolean and value-carrying rules mix', () => {
      assert.deepEqual(linesFor({ docsParity: true, loggingLevel: 'warn', zeroDebtProtocol: true }), [
        'Update docs in same commit as code changes',
        'Log at the "warn" level',
        'Zero tech debt protocol'
      ]);
    });

    it('renders every rule the shipped defaults switch on, and nothing else', () => {
      // Driven off `DEFAULT_PROJECT_CONFIG` rather than a list written here: a
      // rule added to the shipped extensions with no label falls through to its
      // bare key, and a fixture enumerating today's keys would not see it.
      const shipped = DEFAULT_PROJECT_CONFIG.rules.extensions;
      const expected = Object.entries(shipped).filter(([, v]) => v !== false).map(([key]) => key);
      assert.ok(expected.length > 0, 'an all-false default set would assert nothing');
      const lines = linesFor(shipped);
      assert.equal(lines.length, expected.length,
        `the shipped defaults must render exactly their non-false rules: ${JSON.stringify(lines)}`);
      for (const line of lines) {
        assert.doesNotMatch(line, /^\w+: /,
          `a shipped rule fell through to its bare key — it needs a label: ${line}`);
      }
    });
  });
});
