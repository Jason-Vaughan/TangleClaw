'use strict';

// #1911: a plugin-governed CLAUDE.md written earlier in whole-file mode keeps
// TangleClaw's legacy operational sections above the Prawduct anchor, and the
// managed block appended below duplicates them. Detection must never mutate;
// removal needs an operator-approved preview whose digest binds the plan.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

delete process.env.TANGLECLAW_PORT;
const store = require('../lib/store');
const engines = require('../lib/engines');
const legacy = require('../lib/legacy-claude-md');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'repair-governed-claude-md.js');
const PROJ_CONFIG = {
  rules: { core: { changelogPerChange: true, jsdocAllFunctions: true, unitTestRequirements: true, sessionWrapProtocol: true, porthubRegistration: true }, extensions: {} }
};
const ANCHOR_SECTION = '\n<!-- PRAWDUCT:ANCHOR -->\n## Governance (Prawduct)\n\nGoverned by the plugin.\n';

/**
 * Count lines that are exactly a given heading.
 * @param {string} text
 * @param {string} heading
 * @returns {number}
 */
function headingCount(text, heading) {
  return text.split('\n').filter((l) => l === heading).length;
}

describe('governed CLAUDE.md legacy duplicates (#1911)', () => {
  let base;
  let profile;
  let ctx;

  before(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-legacy-claude-md-'));
    store._setBasePath(base);
    store.init();
    const rules = path.join(base, 'global-rules.md');
    fs.writeFileSync(rules, '# Global Rules\n\n## General\n\n- Seed rule\n');
    store.globalRules._setBundledGlobalRulesPath(rules);
    profile = store.engines.get('claude');
    ctx = engines.legacyCarrierContext('markdown');
  });

  after(() => {
    store.globalRules._resetBundledGlobalRulesPath();
    store.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  /**
   * Reproduce the affected layout with the real generators: a whole-file
   * launch, Prawduct onboarding, then a governed relaunch.
   * @returns {{proj: string, md: string}}
   */
  function affectedProject() {
    const proj = fs.mkdtempSync(path.join(base, 'proj-'));
    const md = path.join(proj, 'CLAUDE.md');
    assert.equal(engines.writeEngineConfig('claude', proj, PROJ_CONFIG, profile).written, true);
    fs.appendFileSync(md, ANCHOR_SECTION);
    fs.mkdirSync(path.join(proj, '.claude'));
    fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'prawduct@prawduct': true } }));
    assert.equal(engines.writeEngineConfig('claude', proj, PROJ_CONFIG, profile).written, true);
    return { proj, md };
  }

  /**
   * The file from the Prawduct anchor to the end.
   * @param {string} text
   * @returns {string}
   */
  function fromAnchor(text) {
    return text.slice(text.indexOf('<!-- PRAWDUCT:ANCHOR -->'));
  }

  /**
   * The Core, Extension and Global rules region of the legacy copy.
   * @param {string} text
   * @returns {string}
   */
  function rulesRegion(text) {
    // It ends at the legacy PortHub section while that exists, else at the anchor.
    const ends = [text.indexOf('## Port Management (PortHub)'), text.indexOf('<!-- PRAWDUCT:ANCHOR -->')].filter((i) => i !== -1);
    return text.slice(text.indexOf('## Core Rules (Enforced)'), Math.min(...ends)).trimEnd();
  }

  describe('detection never mutates', () => {
    it('a governed launch over an affected file leaves every legacy section in place', () => {
      const { proj, md } = affectedProject();
      const text = fs.readFileSync(md, 'utf8');
      assert.equal(headingCount(text, '## Port Management (PortHub)'), 2, 'reproduces the duplicate');
      const analysis = engines.analyzeGovernedCarrier(text);
      assert.equal(analysis.eligible, true);
      assert.deepEqual(analysis.candidates.filter((c) => c.kind === 'section').map((c) => c.heading),
        ['## Port Management (PortHub)', '## Shared Documents', '## Session Memory']);
      assert.ok(analysis.candidates.some((c) => c.kind === 'bullet'), 'the duplicated bootstrap bullets are candidates');

      engines.writeEngineConfig('claude', proj, PROJ_CONFIG, profile);
      assert.equal(fs.readFileSync(md, 'utf8'), text, 'a further launch detects but removes nothing');
    });

    it('analysis is pure: it returns a plan and never touches the file', () => {
      const { md } = affectedProject();
      const text = fs.readFileSync(md, 'utf8');
      legacy.analyzeLegacyCarrier(text, ctx);
      assert.equal(fs.readFileSync(md, 'utf8'), text);
    });

    it('never nominates the rules tiers or any heading the managed block lacks', () => {
      const { md } = affectedProject();
      const analysis = engines.analyzeGovernedCarrier(fs.readFileSync(md, 'utf8'));
      const headings = analysis.candidates.map((c) => c.heading).filter(Boolean);
      for (const tier of ['## Core Rules (Enforced)', '## Extension Rules', '# Global Rules', '## General']) {
        assert.ok(!headings.includes(tier), `${tier} must never be a candidate`);
      }
    });
  });

  describe('operator-approved repair', () => {
    it('applies exactly the previewed plan: one copy of each section, rules and anchor byte-identical', () => {
      const { md } = affectedProject();
      const before = fs.readFileSync(md, 'utf8');
      const { digest } = legacy.analyzeLegacyCarrier(before, ctx);

      const result = legacy.applyLegacyRepair(md, digest, ctx);
      assert.equal(result.status, 'applied');
      const after = fs.readFileSync(md, 'utf8');
      for (const h of ['## Port Management (PortHub)', '## Shared Documents', '## Session Memory']) {
        assert.equal(headingCount(after, h), 1, `${h} appears once, inside the managed block`);
      }
      assert.equal(rulesRegion(after), rulesRegion(before), 'rules tiers are byte-identical');
      assert.equal(fromAnchor(after), fromAnchor(before), 'the anchor and everything after it are byte-identical');
      assert.equal(result.removedBytes, Buffer.byteLength(before) - Buffer.byteLength(after));
    });

    it('refuses a digest that is not the preview of this file, writing nothing', () => {
      const { md } = affectedProject();
      const before = fs.readFileSync(md, 'utf8');
      const result = legacy.applyLegacyRepair(md, 'f'.repeat(64), ctx);
      assert.equal(result.status, 'refused');
      assert.equal(fs.readFileSync(md, 'utf8'), before);
    });

    it('refuses when the file changed after the preview, writing nothing', () => {
      const { md } = affectedProject();
      const { digest } = legacy.analyzeLegacyCarrier(fs.readFileSync(md, 'utf8'), ctx);
      const edited = fs.readFileSync(md, 'utf8').replace('## Core Rules (Enforced)\n', '## Core Rules (Enforced)\n\n- An operator rule added after the preview\n');
      fs.writeFileSync(md, edited);

      const result = legacy.applyLegacyRepair(md, digest, ctx);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /changed since the preview/);
      assert.equal(fs.readFileSync(md, 'utf8'), edited);
    });

    it('refuses a read-only carrier rather than renaming over it', () => {
      const { md } = affectedProject();
      const before = fs.readFileSync(md, 'utf8');
      const { digest } = legacy.analyzeLegacyCarrier(before, ctx);
      fs.chmodSync(md, 0o444);
      try {
        const result = legacy.applyLegacyRepair(md, digest, ctx);
        assert.equal(result.status, 'refused');
        assert.match(result.reason, /read-only/);
        assert.equal(fs.readFileSync(md, 'utf8'), before);
      } finally {
        fs.chmodSync(md, 0o644);
      }
    });

    it('is idempotent: a second repair is a byte-identical no-op', () => {
      const { md } = affectedProject();
      const { digest } = legacy.analyzeLegacyCarrier(fs.readFileSync(md, 'utf8'), ctx);
      assert.equal(legacy.applyLegacyRepair(md, digest, ctx).status, 'applied');
      const once = fs.readFileSync(md, 'utf8');

      const again = legacy.analyzeLegacyCarrier(once, ctx);
      assert.equal(legacy.hasRepairWork(again), false);
      assert.equal(legacy.applyLegacyRepair(md, digest, ctx).status, 'noop');
      assert.equal(legacy.applyLegacyRepair(md, again.digest || 'x', ctx).status, 'noop');
      assert.equal(fs.readFileSync(md, 'utf8'), once);
    });

    it('keeps the file mode', () => {
      const { md } = affectedProject();
      fs.chmodSync(md, 0o640);
      const { digest } = legacy.analyzeLegacyCarrier(fs.readFileSync(md, 'utf8'), ctx);
      legacy.applyLegacyRepair(md, digest, ctx);
      assert.equal(fs.statSync(md).mode & 0o777, 0o640);
    });
  });

  describe('operator edits are preserved', () => {
    it('keeps a hand-added section in the legacy region', () => {
      const { md } = affectedProject();
      const note = '## This Repo\'s Exceptions\n\n- Keep me.\n\n';
      fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace('## Port Management (PortHub)', `${note}## Port Management (PortHub)`));
      const { digest } = legacy.analyzeLegacyCarrier(fs.readFileSync(md, 'utf8'), ctx);
      legacy.applyLegacyRepair(md, digest, ctx);
      assert.ok(fs.readFileSync(md, 'utf8').includes(note), 'the hand-added section survives byte for byte');
    });

    it('flags a candidate whose body differs from the managed copy', () => {
      const { md } = affectedProject();
      const text = fs.readFileSync(md, 'utf8');
      const legacyEnd = text.indexOf('<!-- PRAWDUCT:ANCHOR -->');
      const edited = text.slice(0, legacyEnd).replace('## Session Memory\n', '## Session Memory\n\nOperator note inside the legacy copy.\n') + text.slice(legacyEnd);
      const analysis = legacy.analyzeLegacyCarrier(edited, ctx);
      const memory = analysis.candidates.find((c) => c.heading === '## Session Memory');
      assert.equal(memory.matchesManagedCopy, false);
      assert.equal(analysis.candidates.find((c) => c.heading === '## Shared Documents').matchesManagedCopy, true);
    });

    it('leaves a file TangleClaw did not write alone', () => {
      const { md } = affectedProject();
      const handWritten = fs.readFileSync(md, 'utf8').replace(engines.CLAUDE_MD_GENERATED_HEADER, '# CLAUDE.md\n\n**Project Vision:** mine.');
      const analysis = legacy.analyzeLegacyCarrier(handWritten, ctx);
      assert.equal(analysis.eligible, false);
      assert.equal(legacy.hasRepairWork(analysis), false);
    });
  });

  describe('ambiguous bounds refuse without partial mutation', () => {
    /**
     * Refused by analysis, and apply writes nothing.
     * @param {string} md
     * @param {string} text
     * @param {RegExp} reason
     */
    function assertRefused(md, text, reason) {
      fs.writeFileSync(md, text);
      const analysis = legacy.analyzeLegacyCarrier(text, ctx);
      assert.match(analysis.refused || '', reason);
      assert.equal(legacy.applyLegacyRepair(md, analysis.digest || 'x', ctx).status, 'refused');
      assert.equal(fs.readFileSync(md, 'utf8'), text);
    }

    it('a candidate heading that occurs twice above the anchor', () => {
      const { md } = affectedProject();
      const text = fs.readFileSync(md, 'utf8');
      assertRefused(md, text.replace('## Core Rules (Enforced)', '## Shared Documents\n\nstray\n\n## Core Rules (Enforced)'), /occurs 2 times/);
    });

    it('an unterminated code fence above the anchor', () => {
      const { md } = affectedProject();
      assertRefused(md, fs.readFileSync(md, 'utf8').replace('## Core Rules (Enforced)', '```\n## Core Rules (Enforced)'), /unterminated code fence/);
    });

    it('two anchors', () => {
      const { md } = affectedProject();
      const text = fs.readFileSync(md, 'utf8');
      assertRefused(md, text.replace('## Core Rules (Enforced)', '<!-- PRAWDUCT:ANCHOR -->\n## Core Rules (Enforced)'), /2 PRAWDUCT:ANCHOR/);
    });

    it('an anchor after the managed block', () => {
      const { md } = affectedProject();
      const text = fs.readFileSync(md, 'utf8');
      const moved = text.replace(ANCHOR_SECTION.trimEnd(), '').trimEnd() + '\n' + ANCHOR_SECTION;
      assertRefused(md, moved, /inside or after the managed block/);
    });

    it('malformed managed-block markers', () => {
      const { md } = affectedProject();
      assertRefused(md, fs.readFileSync(md, 'utf8') + '\n<!-- END:tangleclaw -->\n', /malformed managed-block markers/);
    });
  });

  describe('the header', () => {
    it('is replaced with a neutral heading only when byte-identical to the generated form', () => {
      const { md } = affectedProject();
      const { digest } = legacy.analyzeLegacyCarrier(fs.readFileSync(md, 'utf8'), ctx);
      legacy.applyLegacyRepair(md, digest, ctx);
      assert.equal(fs.readFileSync(md, 'utf8').split('\n', 1)[0], legacy.NEUTRAL_HEADER);
    });

    it('is kept when the operator altered it', () => {
      const { md } = affectedProject();
      const altered = `${engines.CLAUDE_MD_GENERATED_HEADER} (kept by hand)`;
      fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace(engines.CLAUDE_MD_GENERATED_HEADER, altered));
      const analysis = legacy.analyzeLegacyCarrier(fs.readFileSync(md, 'utf8'), ctx);
      assert.equal(analysis.header.replaceable, false);
      legacy.applyLegacyRepair(md, analysis.digest, ctx);
      assert.equal(fs.readFileSync(md, 'utf8').split('\n', 1)[0], altered);
    });
  });

  describe('scripts/repair-governed-claude-md.js', () => {
    /**
     * Run the script, returning exit code and stdout.
     * @param {string[]} args
     * @returns {{code: number, out: string}}
     */
    function run(args) {
      try {
        return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
      } catch (err) {
        return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
      }
    }

    it('previews without changing anything, then applies that preview by its digest', () => {
      const { proj, md } = affectedProject();
      const before = fs.readFileSync(md, 'utf8');
      const preview = run([proj, '--json']);
      assert.equal(preview.code, 0);
      const plan = JSON.parse(preview.out);
      assert.equal(plan.status, 'preview');
      assert.equal(fs.readFileSync(md, 'utf8'), before, 'the preview changes nothing');

      const applied = JSON.parse(run([proj, '--apply', plan.digest, '--json']).out);
      assert.equal(applied.status, 'applied');
      assert.equal(headingCount(fs.readFileSync(md, 'utf8'), '## Port Management (PortHub)'), 1);
    });

    it('refuses a project that is not plugin-governed', () => {
      const proj = fs.mkdtempSync(path.join(base, 'ungoverned-'));
      engines.writeEngineConfig('claude', proj, PROJ_CONFIG, profile);
      const before = fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8');
      const r = run([proj]);
      assert.equal(r.code, 1);
      assert.match(r.out, /not plugin-governed/);
      assert.equal(fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8'), before);
    });
  });
});
