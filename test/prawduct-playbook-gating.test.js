'use strict';

// #536 — V1 prawduct remnant bugfix.
//
// The V1 `prawduct` methodology's playbook (the "Session Playbook: Prawduct"
// governance prose, incl. the Independent Critic protocol) was injected into
// EVERY non-plugin-governed project's generated engine config:
//   - into non-Claude configs (codex/antigravity/aider), where the Claude-
//     harness governance it describes cannot apply (`governanceState` →
//     `not-applicable`), and
//   - with the Critic section rendered even when the project explicitly set
//     `rules.extensions.independentCritic: false` (the render mismatch the
//     TiLT v2 session hit on 2026-07-10).
//
// The fix is template-declared (template.json reconciles additively into
// live installs on boot — #136 — while playbook.md is user-owned after first
// copy, so the generator must gate at render time):
//   - `playbookEngines: ["claude"]` — engines whose configs get the playbook
//   - `playbookRuleSections: { independentCritic: "### Independent Critic
//     Review" }` — sections stripped when the project rule is explicitly false
// Plus `deprecated`/`deprecationNote` surfaced by methodologies.listTemplates.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const engines = require('../lib/engines');
const methodologies = require('../lib/methodologies');

const PLAYBOOK_MARKER = 'Session Playbook: Prawduct';
const CRITIC_HEADING = '### Independent Critic Review';

describe('prawduct V1 playbook gating (#536)', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-playbook-gating-'));
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Minimal project config with the given extension rules. */
  function cfg(extensions) {
    return { rules: { core: {}, extensions: extensions || {} } };
  }

  describe('template declarations', () => {
    it('bundled prawduct template declares the gates and deprecation', () => {
      const t = store.templates.get('prawduct');
      assert.ok(t, 'prawduct template must exist');
      assert.equal(t.deprecated, true);
      assert.ok(typeof t.deprecationNote === 'string' && t.deprecationNote.includes('V2'));
      assert.deepEqual(t.playbookEngines, ['claude']);
      assert.equal(t.playbookRuleSections.independentCritic, CRITIC_HEADING);
    });
  });

  describe('_stripPlaybookSection', () => {
    const md = [
      '## Playbook', '', 'intro',
      '### Keep Me', 'kept line',
      '### Strip Me', 'stripped line', 'another stripped',
      '### After', 'after line'
    ].join('\n');

    it('strips from the heading to the next same-level heading', () => {
      const out = engines._stripPlaybookSection(md, '### Strip Me');
      assert.ok(!out.includes('Strip Me'));
      assert.ok(!out.includes('stripped line'));
      assert.ok(out.includes('kept line'));
      assert.ok(out.includes('### After'), 'following section survives');
    });

    it('strips to end-of-text when the section is last', () => {
      const out = engines._stripPlaybookSection(md, '### After');
      assert.ok(!out.includes('after line'));
      assert.ok(out.includes('### Strip Me'));
    });

    it('returns the playbook unchanged when the heading is absent', () => {
      assert.equal(engines._stripPlaybookSection(md, '### Missing'), md);
    });
  });

  describe('_renderPlaybook', () => {
    it('returns null for a non-listed engine when playbookEngines is declared', () => {
      const t = store.templates.get('prawduct');
      for (const engineId of ['codex', 'antigravity', 'aider', 'custom-engine']) {
        assert.equal(engines._renderPlaybook(t, cfg(), engineId), null);
      }
    });

    it('returns the playbook for a listed engine', () => {
      const t = store.templates.get('prawduct');
      const out = engines._renderPlaybook(t, cfg(), 'claude');
      assert.ok(out && out.includes(PLAYBOOK_MARKER));
    });

    it('applies to all engines when playbookEngines is absent (pre-#536 default)', () => {
      const t = { ...store.templates.get('prawduct') };
      delete t.playbookEngines;
      delete t.playbookRuleSections;
      const out = engines._renderPlaybook(t, cfg(), 'codex');
      assert.ok(out && out.includes(PLAYBOOK_MARKER));
    });

    it('strips a rule section only on explicit false', () => {
      const t = store.templates.get('prawduct');
      // explicit false → stripped
      const off = engines._renderPlaybook(t, cfg({ independentCritic: false }), 'claude');
      assert.ok(!off.includes(CRITIC_HEADING), 'Critic section stripped when explicitly disabled');
      assert.ok(off.includes(PLAYBOOK_MARKER), 'rest of the playbook survives');
      // true → kept
      const on = engines._renderPlaybook(t, cfg({ independentCritic: true }), 'claude');
      assert.ok(on.includes(CRITIC_HEADING));
      // absent → kept (template defaultRules declare the rule enabled)
      const absent = engines._renderPlaybook(t, cfg({}), 'claude');
      assert.ok(absent.includes(CRITIC_HEADING));
    });
  });

  describe('generateConfig integration', () => {
    it('claude config carries the playbook; non-claude configs do not', () => {
      const t = store.templates.get('prawduct');
      const claude = engines.generateConfig('claude', cfg({ independentCritic: true }), t);
      assert.ok(claude.includes(PLAYBOOK_MARKER), 'claude keeps the prawduct playbook');
      for (const engineId of ['codex', 'antigravity', 'aider']) {
        const content = engines.generateConfig(engineId, cfg({ independentCritic: true }), t);
        assert.ok(content, `${engineId} config generates`);
        assert.ok(!content.includes(PLAYBOOK_MARKER), `${engineId} config has no prawduct playbook`);
        assert.ok(content.includes('Prawduct'), `${engineId} config still names the methodology`);
      }
    });

    it('claude config omits the Critic section when independentCritic is false', () => {
      const t = store.templates.get('prawduct');
      const content = engines.generateConfig('claude', cfg({ independentCritic: false }), t);
      assert.ok(content.includes(PLAYBOOK_MARKER));
      assert.ok(!content.includes(CRITIC_HEADING));
    });
  });

  describe('listTemplates deprecation surfacing', () => {
    it('marks prawduct deprecated with a note; others are not', () => {
      const list = methodologies.listTemplates();
      const prawduct = list.find((t) => t.id === 'prawduct');
      assert.ok(prawduct);
      assert.equal(prawduct.deprecated, true);
      assert.ok(prawduct.deprecationNote && prawduct.deprecationNote.includes('plugin'));
      const minimal = list.find((t) => t.id === 'minimal');
      assert.ok(minimal);
      assert.equal(minimal.deprecated, false);
      assert.equal(minimal.deprecationNote, null);
    });
  });
});
