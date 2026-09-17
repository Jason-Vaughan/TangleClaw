'use strict';

/**
 * Prime scenarios for the byte-identity golden test (Train 21, car 21.2).
 *
 * The launch-step renderer splits the prime into four steps that the push path
 * and the `tc start` pull path both render from. The push prime must not change
 * in the process, so these scenarios pin it: each one sets up a project whose
 * prime exercises a different set of sections, renders it, and replaces the
 * two values that differ between runs and machines: the temporary base
 * directory, and this machine's host name in the Session Ownership block.
 *
 * The fixtures in `test/fixtures/prime-golden/` were captured from the prime
 * generator as it stood before the refactor. Regenerate them only when a prime
 * change is intended: `UPDATE_PRIME_GOLDEN=1 node --test test/prime-golden.test.js`.
 *
 * The caller owns the store: it must have called `store._setBasePath` and
 * `store.init()` on a fresh temporary directory.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Create a project with its own directory under `projectsDir`.
 * @param {object} store - The initialized store module
 * @param {string} projectsDir - Parent directory for project checkouts
 * @param {string} name - Project name and directory name
 * @param {string} engine - Engine id
 * @returns {object} The created project record
 */
function makeProject(store, projectsDir, name, engine) {
  const dir = path.join(projectsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return store.projects.create({ name, path: dir, engine });
}

/**
 * Build every scenario's inputs. Kept separate from rendering so a caller can
 * render the same inputs through more than one generator.
 * @param {object} store - The initialized store module
 * @param {string} baseDir - The store's temporary base directory
 * @returns {Array<{name: string, project: object, engineId: string, engineIdOverride?: string, options: object}>}
 */
function buildScenarios(store, baseDir) {
  const continuity = require('../lib/continuity');
  const projectsDir = path.join(baseDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  const contract = path.join(baseDir, 'golden-contract.md');
  fs.writeFileSync(contract, '# Golden Consumer Contract\nRegister, then drain the inbox.\n');
  process.env.MEDUSA_CONTRACT_PATH = contract;

  // A: silent-prime Claude with everything a prime can carry.
  const full = makeProject(store, projectsDir, 'golden-full', 'claude');
  store.projectConfig.save(full.path, {
    silentPrime: true,
    medusaEnabled: true,
    featureIndexEnabled: true,
    projectMapEnabled: true
  });
  store.sessionRules.create({ projectId: full.id, content: 'Always run the suite before a commit.' });
  store.sessionRules.create({ projectId: full.id, content: 'Never push to main.' });
  store.learnings.create({ projectId: full.id, content: 'The store opens SQLite at require time.', tier: 'active' });
  store.learnings.create({ projectId: full.id, content: 'tmux targets need an exact-match prefix.', tier: 'active' });
  fs.writeFileSync(path.join(full.path, 'FEATURES.md'),
    '# Features\n\n## Curated\n\n- **Launch** — `lib/sessions.js`\n');
  fs.writeFileSync(path.join(full.path, 'PROJECT-MAP.md'), '# Map\n\n- lib/ — the server\n');
  continuity.writeIndex(full.path, {
    project: 'golden-full',
    currentState: 'Chunk 01 is half built.',
    nextAction: 'finish the renderer · open the plan',
    freshness: { sha: 'abc1234', branch: 'feat/golden', writtenAt: '2026-09-17' }
  });

  // B: a paste engine with inline rules and a passive last-session summary.
  const paste = makeProject(store, projectsDir, 'golden-paste', 'codex');
  store.sessionRules.create({ projectId: paste.id, content: 'Keep diffs small.' });
  const prior = store.sessions.start({ projectId: paste.id, engineId: 'codex' });
  store.sessions.wrap(prior.id, 'Shipped the parser; the lexer is next.');

  // C: directives alone overflow the budget, so every bulk section yields.
  const huge = makeProject(store, projectsDir, 'golden-overflow', 'claude');
  store.projectConfig.save(huge.path, { silentPrime: true });
  for (let i = 0; i < 6; i++) {
    store.learnings.create({ projectId: huge.id, content: `Learning ${i}: ${'x'.repeat(400)}`, tier: 'active' });
  }
  const priorHuge = store.sessions.start({ projectId: huge.id, engineId: 'claude' });
  store.sessions.wrap(priorHuge.id, `Summary ${'y'.repeat(2000)}`);

  // D: a fresh continuity mode over an existing index, on a paste engine with no rules.
  const fresh = makeProject(store, projectsDir, 'golden-fresh', 'antigravity');
  continuity.writeIndex(fresh.path, {
    project: 'golden-fresh',
    currentState: 'Ignored in fresh mode.',
    nextAction: 'ignored',
    freshness: { sha: 'def5678', branch: 'main', writtenAt: '2026-09-16' }
  });

  // E: Eval Audit reaches only an OpenClaw-connection engine id.
  const audited = makeProject(store, projectsDir, 'golden-audit', 'claude');
  store.projectConfig.save(audited.path, {
    evalAuditMode: { enabled: true, judgeModel: 'judge-x', costCapPerSession: 2 }
  });

  return [
    {
      name: 'full-silent-claude',
      project: full,
      engineId: 'claude',
      options: { medusaWorkspaceId: 'golden-full-cafe0123', operatorHost: 'operator.example.test', healReport: 'Launch heal: moved one leftover file.' }
    },
    { name: 'paste-codex', project: paste, engineId: 'codex', options: { operatorHost: 'operator.example.test' } },
    // The heal report is a directive (it never yields), so an oversized one
    // overflows the channel after every bulk section has yielded.
    { name: 'overflow-claude', project: huge, engineId: 'claude', options: { operatorHost: null, healReport: `Heal: ${'h'.repeat(9000)}` } },
    { name: 'fresh-antigravity', project: fresh, engineId: 'antigravity', options: { operatorHost: 'operator.example.test', continuityMode: 'fresh' } },
    { name: 'audit-openclaw', project: audited, engineId: 'openclaw', engineIdOverride: 'openclaw:golden-conn', options: { operatorHost: 'operator.example.test' } }
  ];
}

/**
 * Replace run-specific values with stable placeholders.
 * @param {string} text - A rendered prime
 * @param {string} baseDir - The store's temporary base directory
 * @returns {string}
 */
function normalize(text, baseDir) {
  const real = fs.realpathSync(baseDir);
  return text.split(real).join('<BASE>').split(baseDir).join('<BASE>')
    .replace(/^- Host: `[^`]*`/m, '- Host: `<HOST>`');
}

/**
 * Render every scenario through `generate`.
 * @param {object} store - The initialized store module
 * @param {string} baseDir - The store's temporary base directory
 * @param {(project: object, engine: object, options: object) => string} generate
 * @returns {Object<string, string>} Scenario name → normalized prime
 */
function renderScenarios(store, baseDir, generate) {
  const out = {};
  for (const s of buildScenarios(store, baseDir)) {
    const base = store.engines.get(s.engineId);
    const engine = s.engineIdOverride ? { ...base, id: s.engineIdOverride } : base;
    out[s.name] = normalize(generate(store.projects.get(s.project.id), engine, s.options), baseDir);
  }
  return out;
}

module.exports = { buildScenarios, renderScenarios, normalize };
