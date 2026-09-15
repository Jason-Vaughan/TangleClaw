'use strict';

/*
 * Which uncommitted paths are TangleClaw's own (#1508, #1509).
 *
 * The content judgements run against real repositories: the proof compares the
 * committed copy git holds with the file on disk, and a stub of `git show` would
 * test the stub. Engine knowledge is the one seam, stubbed only to prove a load
 * failure declines rather than guesses.
 */

const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const tcOwned = require('../lib/wrap-steps/_tc-owned-paths');
const engines = require('../lib/engines');
const { DEFAULT_PROJECT_CONFIG } = require('../lib/project-config');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const MD = engines._managedBlockMarkers('markdown');
const REAL_KNOWLEDGE = tcOwned._internal.engineKnowledge;

/**
 * The shipped engine knowledge. It reads the bundled profiles, never the live
 * store, so using it directly keeps these tests off the install's state; the
 * named alias is what each describe block restores after a stubbed failure.
 */
const repoKnowledge = REAL_KNOWLEDGE;

/**
 * Run git with a fixed identity.
 * @param {string} cwd
 * @param {...string} args
 * @returns {string}
 */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();
}

/**
 * A repo whose first commit holds `files`, then `edits` applied on disk.
 * @param {Object<string,string>} files - Committed content by path.
 * @param {Object<string,(string|null)>} [edits] - Working content by path; null deletes.
 * @returns {{root: string, dirty: Array<{path:string, deleted:boolean}>}}
 */
function repoWith(files, edits = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-owned-')));
  dirs.push(root);
  git(root, 'init', '-q');
  const write = (p, c) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); };
  for (const [p, c] of Object.entries(files)) write(p, c);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base', '--allow-empty');
  for (const [p, c] of Object.entries(edits)) {
    if (c === null) fs.rmSync(path.join(root, p));
    else write(p, c);
  }
  const ownership = require('../lib/wrap-steps/_file-ownership');
  const out = execFileSync('git', ownership.statusArgs(), { cwd: root, encoding: 'utf8' });
  return { root, dirty: ownership.parseStatus(out) };
}

/**
 * A markdown file with one managed block.
 * @param {string} body - Inside the markers.
 * @param {string} [before]
 * @param {string} [afterText]
 * @returns {string}
 */
function withBlock(body, before = '# Project\n\nOperator notes.\n\n', afterText = '\n') {
  return `${before}${MD.begin}\n${body}\n${MD.end}${afterText}`;
}

/** A TangleClaw SessionStart hook entry, as the engine layer emits it. */
const TC_HOOK = { matcher: 'startup', hooks: [{ type: 'command', command: '/opt/tc/data/hooks/sessionstart-prime-claude.sh' }] };

describe('TangleClaw machine state is recognised by name', () => {
  for (const p of [
    '.tangleclaw/ui-wrap-advisory.md', '.tangleclaw/session-prime.md', '.tangleclaw/session-rules-3.json',
    '.tangleclaw/session-rules-receipt.json', '.tangleclaw/project-version.txt', '.tangleclaw/.project-version.txt.tmp1',
    '.tangleclaw/medusa/registry.json', '.tangleclaw/critic-runs.json', '.tangleclaw/.wrap-summary.md',
    '.tangleclaw/continuity/index.md', '.tangleclaw/continuity/sessions/9/transcript.jsonl', '.tangleclaw/.release-recommendation.md'
  ]) {
    it(`${p} is state`, () => assert.equal(tcOwned.isStatePath(p), true));
  }
  for (const p of [
    '.tangleclaw/plans/next.md', '.tangleclaw/priming/build-session.md', '.tangleclaw/memories/MEMORY.md',
    '.tangleclaw/project.json', '.tangleclaw/session-rules-x.json', 'continuity/index.md', 'CLAUDE.md'
  ]) {
    it(`${p} is not state`, () => assert.equal(tcOwned.isStatePath(p), false));
  }

  it('every writer\'s name loads, so no state file silently falls back to being asked about', () => {
    assert.equal(tcOwned._statePathMatchers().length, 6);
  });

  it('the names come from the writers, so a writer\'s own path is state', () => {
    const files = require('../lib/tangleclaw-project-files');
    const channel = require('../lib/session-rules-channel');
    const versions = require('../lib/project-version-files');
    for (const p of [
      files.SESSION_PRIME_RELPATH, files.UI_WRAP_ADVISORY_RELPATH, files.MEDUSA_REGISTRY_RELPATH,
      `.tangleclaw/${channel.SHARD_STEM}-1.json`, `.tangleclaw/${channel.RECEIPT_STEM}.json`,
      `.tangleclaw/${versions.VERSION_CACHE_FILENAME}`, `.tangleclaw/${versions.STAGING_PREFIX}42.abcd.tmp`,
      require('../lib/actions/invoke-critic').CRITIC_RUNS_RELPATH.split(path.sep).join('/'),
      ...require('../lib/wrap-default-pipeline').steps().map((st) => st.captureFile).filter((f) => typeof f === 'string' && f.startsWith('.tangleclaw/'))
    ]) {
      assert.equal(tcOwned.isStatePath(p), true, p);
    }
    const medusa = path.relative('/p', require('../lib/tangleclaw-project-files').resolveIn('/p', files.MEDUSA_REGISTRY_RELPATH)).split(path.sep).join('/');
    assert.equal(medusa, files.MEDUSA_REGISTRY_RELPATH);
  });

  it('a deleted state file is still state, with no content to read', () => {
    const verdicts = tcOwned.judge(null, [{ path: '.tangleclaw/session-rules-2.json', deleted: true }]);
    assert.equal(verdicts.get('.tangleclaw/session-rules-2.json'), 'state');
  });
});

describe('carrier files come from every engine profile', () => {
  it('the shipped engine knowledge includes each bundled profile\'s config file and the shared convention files', () => {
    const carriers = REAL_KNOWLEDGE().carriers;
    const dir = path.join(__dirname, '..', 'data', 'engines');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const fmt = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).configFormat;
      if (fmt && fmt.filename && fmt.syntax) assert.equal(carriers.get(fmt.filename), fmt.syntax, f);
    }
    for (const f of engines.SHARED_CONVENTION_CARRIERS) assert.ok(carriers.has(f), f);
  });
});

describe('managed-block carriers', () => {
  beforeEach(() => { tcOwned._internal.engineKnowledge = repoKnowledge; });
  after(() => { tcOwned._internal.engineKnowledge = REAL_KNOWLEDGE; });

  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    it(`${file} changed only inside the block is maintenance`, () => {
      const { root, dirty } = repoWith({ [file]: withBlock('old guide') }, { [file]: withBlock('new guide\nmore') });
      assert.equal(tcOwned.judge(root, dirty).get(file), 'maintenance');
    });

    it(`${file} with one operator line outside the block is not TangleClaw's`, () => {
      const { root, dirty } = repoWith({ [file]: withBlock('old') }, { [file]: withBlock('new', '# Project\n\nOperator notes.\nMy new line.\n\n') });
      assert.equal(tcOwned.judge(root, dirty).has(file), false);
    });
  }

  it('a carrier absent from HEAD is not TangleClaw\'s', () => {
    const { root, dirty } = repoWith({ 'README.md': 'x\n' }, { 'AGENTS.md': withBlock('fresh') });
    assert.equal(tcOwned.judge(root, dirty).has('AGENTS.md'), false);
  });

  it('duplicated markers are not TangleClaw\'s', () => {
    const { root, dirty } = repoWith({ 'CLAUDE.md': withBlock('a') }, { 'CLAUDE.md': `${withBlock('b')}${MD.begin}\n` });
    assert.equal(tcOwned.judge(root, dirty).has('CLAUDE.md'), false);
  });

  it('a whole-file generated config with a TangleClaw header gets no pass', () => {
    const header = `# ${engines.GENERATED_HEADER_MARK}\n`;
    const { root, dirty } = repoWith({ '.codex.yaml': `${header}a: 1\n` }, { '.codex.yaml': `${header}a: 2\n` });
    assert.equal(tcOwned.judge(root, dirty).has('.codex.yaml'), false);
  });

  it('engine knowledge failing to load declines content judgements but keeps state', () => {
    tcOwned._internal.engineKnowledge = () => { throw new Error('store unavailable'); };
    const { root, dirty } = repoWith({ 'CLAUDE.md': withBlock('a') }, { 'CLAUDE.md': withBlock('b'), '.tangleclaw/session-prime.md': 'p' });
    const verdicts = tcOwned.judge(root, dirty);
    assert.equal(verdicts.has('CLAUDE.md'), false);
    assert.equal(verdicts.get('.tangleclaw/session-prime.md'), 'state');
  });
});

describe('shared hook settings', () => {
  beforeEach(() => { tcOwned._internal.engineKnowledge = repoKnowledge; });
  after(() => { tcOwned._internal.engineKnowledge = REAL_KNOWLEDGE; });
  const settingsPath = engines.SHARED_HOOK_SETTINGS_PATHS[0];
  const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

  it('retiring TangleClaw\'s hook entries is maintenance', () => {
    const before = { permissions: { allow: ['Bash(ls)'] }, hooks: { SessionStart: [TC_HOOK] } };
    const afterState = { permissions: { allow: ['Bash(ls)'] } };
    const { root, dirty } = repoWith({ [settingsPath]: json(before) }, { [settingsPath]: json(afterState) });
    assert.equal(tcOwned.judge(root, dirty).get(settingsPath), 'maintenance');
  });

  it('an operator hook kept beside a retired one is still maintenance', () => {
    const mine = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] };
    const { root, dirty } = repoWith(
      { [settingsPath]: json({ hooks: { SessionStart: [TC_HOOK, mine] } }) },
      { [settingsPath]: json({ hooks: { SessionStart: [mine] } }) }
    );
    assert.equal(tcOwned.judge(root, dirty).get(settingsPath), 'maintenance');
  });

  it('an added entry is not TangleClaw\'s, even one pointing at a TangleClaw hook script', () => {
    const { root, dirty } = repoWith({ [settingsPath]: json({ permissions: {} }) }, { [settingsPath]: json({ permissions: {}, hooks: { SessionStart: [TC_HOOK] } }) });
    assert.equal(tcOwned.judge(root, dirty).has(settingsPath), false);
  });

  it('an edited TangleClaw entry is not TangleClaw\'s: a changed matcher or an extra command', () => {
    const edits = [
      { ...TC_HOOK, matcher: '*' },
      { ...TC_HOOK, hooks: [...TC_HOOK.hooks, { type: 'command', command: 'curl example.invalid' }] }
    ];
    for (const edited of edits) {
      const { root, dirty } = repoWith({ [settingsPath]: json({ hooks: { SessionStart: [TC_HOOK] } }) }, { [settingsPath]: json({ hooks: { SessionStart: [edited] } }) });
      assert.equal(tcOwned.judge(root, dirty).has(settingsPath), false, JSON.stringify(edited));
    }
  });

  it('an emptied hook event kept as an empty list is not the writer\'s output', () => {
    const { root, dirty } = repoWith({ [settingsPath]: json({ hooks: { SessionStart: [TC_HOOK] } }) }, { [settingsPath]: json({ hooks: { SessionStart: [] } }) });
    assert.equal(tcOwned.judge(root, dirty).has(settingsPath), false);
  });

  it('an operator permission added alongside is not TangleClaw\'s', () => {
    const { root, dirty } = repoWith(
      { [settingsPath]: json({ hooks: { SessionStart: [TC_HOOK] } }) },
      { [settingsPath]: json({ permissions: { allow: ['Bash(rm)'] } }) }
    );
    assert.equal(tcOwned.judge(root, dirty).has(settingsPath), false);
  });

  it('invalid JSON is not TangleClaw\'s', () => {
    const { root, dirty } = repoWith({ [settingsPath]: '{}\n' }, { [settingsPath]: '{ nope' });
    assert.equal(tcOwned.judge(root, dirty).has(settingsPath), false);
  });
});

describe('project.json', () => {
  beforeEach(() => { tcOwned._internal.engineKnowledge = repoKnowledge; });
  after(() => { tcOwned._internal.engineKnowledge = REAL_KNOWLEDGE; });
  const P = tcOwned.PROJECT_CONFIG_PATH;
  const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
  const base = { engine: 'claude', lastWrapSha: 'aaa', activePlan: 'a.md' };

  it('removing the retired wrap boundary key is maintenance', () => {
    const { lastWrapSha: _gone, ...migrated } = base;
    const { root, dirty } = repoWith({ [P]: json(base) }, { [P]: json(migrated) });
    assert.equal(tcOwned.judge(root, dirty).get(P), 'maintenance');
  });

  it('a changed wrap boundary key is not TangleClaw\'s — no current writer puts it there', () => {
    const { root, dirty } = repoWith({ [P]: json(base) }, { [P]: json({ ...base, lastWrapSha: 'bbb' }) });
    assert.equal(tcOwned.judge(root, dirty).has(P), false);
  });

  it('adding the wrap boundary key is not TangleClaw\'s', () => {
    const { lastWrapSha: _gone, ...migrated } = base;
    const { root, dirty } = repoWith({ [P]: json(migrated) }, { [P]: json(base) });
    assert.equal(tcOwned.judge(root, dirty).has(P), false);
  });

  it('default keys filled in by a save are maintenance', () => {
    const { lastWrapSha: _gone, ...migrated } = base;
    const { root, dirty } = repoWith({ [P]: json(base) }, { [P]: json({ ...migrated, silentPrime: DEFAULT_PROJECT_CONFIG.silentPrime }) });
    assert.equal(tcOwned.judge(root, dirty).get(P), 'maintenance');
  });

  it('the untracked wrap state file is TangleClaw state', () => {
    assert.equal(tcOwned.isStatePath('.tangleclaw/state.json'), true);
  });

  it('the legacy engine id rename is maintenance', () => {
    const { root, dirty } = repoWith({ [P]: json({ ...base, engine: 'claude-code' }) }, { [P]: json(base) });
    assert.equal(tcOwned.judge(root, dirty).get(P), 'maintenance');
  });

  it('an operator setting changing is not TangleClaw\'s', () => {
    const { root, dirty } = repoWith({ [P]: json(base) }, { [P]: json({ ...base, lastWrapSha: 'bbb', activePlan: 'b.md' }) });
    assert.equal(tcOwned.judge(root, dirty).has(P), false);
  });

  it('a new key holding a non-default value is not TangleClaw\'s', () => {
    const { root, dirty } = repoWith({ [P]: json(base) }, { [P]: json({ ...base, silentPrime: !DEFAULT_PROJECT_CONFIG.silentPrime }) });
    assert.equal(tcOwned.judge(root, dirty).has(P), false);
  });

  it('invalid JSON is not TangleClaw\'s', () => {
    const { root, dirty } = repoWith({ [P]: json(base) }, { [P]: '{' });
    assert.equal(tcOwned.judge(root, dirty).has(P), false);
  });
});
