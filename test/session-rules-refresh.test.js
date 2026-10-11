'use strict';

/*
 * #2273 — the session-start hook prints the rules files the launch wrote, on
 * every start including after a `/clear`. A rule changed while the session ran
 * left those files alone, so a cleared session was told the launch-time set was
 * binding. These cases hold the regeneration to what a cleared session must be
 * able to rely on: the files say what is in force now, a file is never started
 * where the launch declined delivery, and a refresh that cannot write changes
 * nothing and breaks nothing.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const channel = require('../lib/session-rules-channel');
const refresh = require('../lib/session-rules-refresh');

const HOOK = path.join(__dirname, '..', 'data', 'hooks', 'sessionstart-rules-claude.sh');
const NOW = new Date('2026-10-10T12:00:00.000Z');

let tmpBase;
let budget;
let seq = 0;

before(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-2273-'));
  store._setBasePath(path.join(tmpBase, 'store'));
  store.init();
  budget = channel.resolveChannelBudget(store.engines.get('claude'));
});
after(() => {
  store.close();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

/** @returns {{id:number, path:string}} a fresh project with its own directory */
function makeProject() {
  seq += 1;
  const dir = path.join(tmpBase, `proj-${seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const project = store.projects.create({ name: `refresh-proj-${seq}`, path: dir, engine: 'claude' });
  return { id: project.id, path: dir };
}

/**
 * Add an active startup rule, as the operator does.
 * @param {number} projectId
 * @param {string} content
 * @returns {object} the stored rule
 */
function addRule(projectId, content) {
  return store.sessionRules.create({ content, projectId });
}

/**
 * Write the files a launch writes for the project's rules as they stand now.
 * @param {{id:number, path:string}} project
 * @returns {number} how many files the launch wrote
 */
function launchFiles(project) {
  const rules = store.sessionRules.listActiveForProject(project.id);
  const shards = channel.buildShards(rules, budget);
  channel.writeShards(project.path, shards, rules.length);
  return shards.length;
}

/**
 * Read back what the hook would print, one text per file, in order.
 * @param {string} projectPath
 * @returns {string[]}
 */
function deliveredTexts(projectPath) {
  const texts = [];
  for (let i = 1; fs.existsSync(channel.shardPath(projectPath, i)); i += 1) {
    const parsed = JSON.parse(fs.readFileSync(channel.shardPath(projectPath, i), 'utf8'));
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    texts.push(parsed.hookSpecificOutput.additionalContext);
  }
  return texts;
}

/** @returns {string[]} the names in a project's `.tangleclaw/` directory */
function tangleclawDir(projectPath) {
  return fs.readdirSync(path.join(projectPath, '.tangleclaw')).sort();
}

describe('#2273 — delivered rules files follow the rules in force', () => {
  let project;
  beforeEach(() => { project = makeProject(); });

  it('rewrites the files to the set in force: a kept rule, an edited one, a new one, and not the removed ones', () => {
    const a = addRule(project.id, 'Alpha rule stays as it is.');
    const b = addRule(project.id, 'Bravo rule is retired mid-session.');
    const c = addRule(project.id, 'Charlie rule in its first wording.');
    launchFiles(project);

    store.sessionRules.setStatus(b.id, 'retired');
    const edit = store.sessionRules.update(c.id, { content: 'Charlie rule, reworded by the operator.' });
    store.sessionRules.setStatus(edit.replacementProposed.id, 'active', {
      expectedContent: 'Charlie rule, reworded by the operator.'
    });
    const d = addRule(project.id, 'Delta rule approved after the launch.');

    const verdict = refresh.refreshProjectRules(project.id, { now: NOW });

    assert.equal(verdict.status, 'refreshed');
    assert.equal(verdict.rules, 3);
    assert.deepEqual(verdict.omittedRuleIds, []);
    const text = deliveredTexts(project.path).join('\n');
    assert.ok(text.includes('Alpha rule stays as it is.'));
    assert.ok(text.includes('Charlie rule, reworded by the operator.'));
    assert.ok(text.includes('Delta rule approved after the launch.'));
    assert.ok(!text.includes('Bravo rule'), 'a retired rule must not be re-delivered as binding');
    assert.ok(!text.includes('first wording'), 'the replaced text must not be re-delivered');
    assert.ok(text.includes(`Rule #${a.id}`) && text.includes(`Rule #${d.id}`), 'rules are labelled by id');
  });

  it('states the count in force, when it was written, and that it is the current statement', () => {
    addRule(project.id, 'One.');
    launchFiles(project);
    addRule(project.id, 'Two.');

    refresh.refreshProjectRules(project.id, { now: NOW });

    const [text] = deliveredTexts(project.path);
    assert.match(text, /^## Project Rules\n/);
    assert.match(text, /Rules in force: 2, as of 2026-10-10T12:00:00\.000Z\./);
    assert.match(text, /is the current statement: where a count elsewhere in this session differs, this one is right/);
  });

  it('writes nothing where the launch delivered no rules files, and says so', () => {
    addRule(project.id, 'A rule for a project whose launch chose no delivery.');

    const verdict = refresh.refreshProjectRules(project.id, { now: NOW });

    assert.deepEqual(verdict, { status: 'nothing-to-refresh', projectId: project.id, reason: 'no-rules-files' });
    assert.equal(fs.existsSync(path.join(project.path, '.tangleclaw')), false,
      'a refresh must not start delivery the launch declined');
  });

  it('has nothing to refresh for a rule with no project, or a project that is gone', () => {
    assert.equal(refresh.refreshProjectRules(null).status, 'nothing-to-refresh');
    assert.equal(refresh.refreshProjectRules(undefined).reason, 'no-project');
    assert.equal(refresh.refreshProjectRules(987654).reason, 'no-project');
  });

  it('keeps the first file when no rule is left in force, and removes the others', () => {
    const big = 'x'.repeat(Math.floor(budget * 0.6));
    const rules = [addRule(project.id, `first ${big}`), addRule(project.id, `second ${big}`)];
    assert.equal(launchFiles(project), 2, 'the fixture needs a launch that wrote two files');
    for (const rule of rules) store.sessionRules.setStatus(rule.id, 'retired');

    const verdict = refresh.refreshProjectRules(project.id, { now: NOW });

    assert.equal(verdict.status, 'refreshed');
    assert.equal(verdict.rules, 0);
    assert.equal(verdict.files, 1);
    assert.equal(verdict.removed, 1);
    const texts = deliveredTexts(project.path);
    assert.equal(texts.length, 1);
    assert.match(texts[0], /^## Project Rules\n/, 'a missing heading reads as a failed delivery');
    assert.match(texts[0], /No operator-authored rule is in force for this project, as of 2026-10-10T12:00:00\.000Z/);
    assert.ok(!texts[0].includes('first x'), 'no retired rule text is left behind');
  });

  it('names what the registered files cannot carry, without growing their number or breaking the budget', () => {
    const body = 'y'.repeat(Math.floor(budget * 0.45));
    const kept = [addRule(project.id, `one ${body}`), addRule(project.id, `two ${body}`)];
    assert.equal(launchFiles(project), 1, 'the fixture needs a launch that wrote one file');
    const added = [addRule(project.id, `three ${body}`), addRule(project.id, `four ${body}`)];

    const verdict = refresh.refreshProjectRules(project.id, { now: NOW });

    assert.equal(verdict.status, 'refreshed');
    assert.equal(verdict.files, 1, 'a file no hook was registered for would be printed by nothing');
    assert.equal(verdict.rules, 4);
    assert.deepEqual(tangleclawDir(project.path), ['session-rules-1.json']);
    const raw = fs.readFileSync(channel.shardPath(project.path, 1), 'utf8');
    assert.ok(raw.length <= budget, `the payload is ${raw.length} characters against a budget of ${budget}`);

    const [text] = deliveredTexts(project.path);
    assert.ok(verdict.omittedRuleIds.length > 0, 'four rules of this size cannot fit one file');
    for (const rule of [...kept, ...added]) {
      const printed = text.includes(rule.content);
      const named = verdict.omittedRuleIds.includes(rule.id);
      assert.ok(printed !== named, `rule ${rule.id} is either printed or named, never both and never neither`);
      if (named) assert.ok(text.includes(`Rule #${rule.id}`), `rule ${rule.id} is named in the block`);
    }
    const line = text.split('\n').find((l) => l.includes('Not carried in this block'));
    assert.ok(line, 'the block says that it is not the whole set');
    assert.match(line, /Rules in force: 4\./);
    assert.match(line, /run `tc rules` for their text/);
  });

  it('fills the files it has before naming anything', () => {
    const body = 'z'.repeat(Math.floor(budget * 0.6));
    addRule(project.id, `one ${body}`);
    addRule(project.id, `two ${body}`);
    assert.equal(launchFiles(project), 2);
    const third = addRule(project.id, `three ${body}`);

    const verdict = refresh.refreshProjectRules(project.id, { now: NOW });

    assert.equal(verdict.files, 2);
    assert.deepEqual(verdict.omittedRuleIds, [third.id]);
    const texts = deliveredTexts(project.path);
    assert.match(texts[0], /part 1 of 2/);
    assert.ok(texts[0].includes('one z'));
    assert.match(texts[1], /part 2 of 2/);
    assert.ok(texts[1].includes('two z'));
    assert.ok(texts[1].includes(`Not carried in this block: Rule #${third.id}.`));
    for (let i = 1; i <= 2; i += 1) {
      assert.ok(fs.readFileSync(channel.shardPath(project.path, i), 'utf8').length <= budget);
    }
  });

  it('returns a failure and leaves the previous files readable when it cannot write', () => {
    addRule(project.id, 'The rule the launch delivered.');
    launchFiles(project);
    const before = fs.readFileSync(channel.shardPath(project.path, 1), 'utf8');
    addRule(project.id, 'A rule added after the launch.');
    // A directory where the staging file belongs refuses the write whatever the
    // process's privileges, which a permission bit does not.
    fs.mkdirSync(channel.shardPath(project.path, 1) + refresh.TMP_SUFFIX);

    let verdict;
    assert.doesNotThrow(() => { verdict = refresh.refreshProjectRules(project.id, { now: NOW }); });

    assert.equal(verdict.status, 'failed');
    assert.equal(verdict.projectId, project.id);
    assert.ok(verdict.reason, 'the verdict carries the cause for the caller to log and report');
    assert.equal(fs.readFileSync(channel.shardPath(project.path, 1), 'utf8'), before,
      'the file the hook prints is untouched');
    assert.doesNotThrow(() => deliveredTexts(project.path));
  });

  it('replaces no file when a later one cannot be staged', () => {
    const body = 'w'.repeat(Math.floor(budget * 0.6));
    addRule(project.id, `one ${body}`);
    const second = addRule(project.id, `two ${body}`);
    assert.equal(launchFiles(project), 2);
    const before = [1, 2].map((i) => fs.readFileSync(channel.shardPath(project.path, i), 'utf8'));
    store.sessionRules.setStatus(second.id, 'retired');
    addRule(project.id, `three ${body}`);
    fs.mkdirSync(channel.shardPath(project.path, 2) + refresh.TMP_SUFFIX);

    const verdict = refresh.refreshProjectRules(project.id, { now: NOW });

    assert.equal(verdict.status, 'failed');
    assert.deepEqual([1, 2].map((i) => fs.readFileSync(channel.shardPath(project.path, i), 'utf8')), before,
      'a set half old and half new would state rules that were never in force together');
    assert.equal(fs.existsSync(channel.shardPath(project.path, 1) + refresh.TMP_SUFFIX), false,
      'the staging file that was written is cleaned up');
  });

  it('leaves no staging file behind after a refresh, and a second refresh agrees with the first', () => {
    addRule(project.id, 'Stable rule.');
    launchFiles(project);

    refresh.refreshProjectRules(project.id, { now: NOW });
    const first = fs.readFileSync(channel.shardPath(project.path, 1), 'utf8');
    refresh.refreshProjectRules(project.id, { now: NOW });

    assert.deepEqual(tangleclawDir(project.path), ['session-rules-1.json']);
    assert.equal(fs.readFileSync(channel.shardPath(project.path, 1), 'utf8'), first);
  });

  it('leaves the receipt token alone: it belongs to the launch', () => {
    addRule(project.id, 'Rule with a receipt pending.');
    launchFiles(project);
    channel.writeReceiptToken(project.path, { deliveryId: 7, api: 'http://127.0.0.1:1' });
    for (const rule of store.sessionRules.listActiveForProject(project.id)) {
      store.sessionRules.setStatus(rule.id, 'retired');
    }

    refresh.refreshProjectRules(project.id, { now: NOW });

    assert.ok(fs.existsSync(channel.receiptTokenPath(project.path)));
  });

  it('is what the real hook prints after a clear', () => {
    addRule(project.id, 'Launch-time rule that is then retired.');
    launchFiles(project);
    const [old] = store.sessionRules.listActiveForProject(project.id);
    store.sessionRules.setStatus(old.id, 'retired');
    const fresh = addRule(project.id, 'Rule approved "mid-session", with a \\ backslash.');
    refresh.refreshProjectRules(project.id, { now: NOW });

    const printed = execFileSync('bash', [HOOK, '1'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: project.path },
      input: '{"source":"clear"}',
      encoding: 'utf8'
    });

    const context = JSON.parse(printed).hookSpecificOutput.additionalContext;
    assert.ok(context.includes(`Rule #${fresh.id} — Rule approved "mid-session", with a \\ backslash.`));
    assert.ok(!context.includes('Launch-time rule'));
  });
});
