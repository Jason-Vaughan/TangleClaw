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
 * Register rules hooks 1..count in the project's local settings file, in the
 * shape the hook sync writes, beside a hook and a setting that are not ours.
 * @param {string} projectPath
 * @param {number} count
 */
function registerHooks(projectPath, count) {
  const entry = (command) => ({ matcher: 'startup|clear|compact', hooks: [{ type: 'command', command }] });
  const SessionStart = [entry("'/opt/tc'/data/hooks/sessionstart-prime-claude.sh"), entry('echo operator-hook 7')];
  for (let i = 1; i <= count; i += 1) {
    SessionStart.push(entry(`'/opt/tc'/data/hooks/sessionstart-rules-claude.sh ${i}`));
  }
  fs.mkdirSync(path.join(projectPath, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: [] }, hooks: { SessionStart } }, null, 2));
}

/**
 * Write the files a launch writes for the project's rules as they stand now,
 * and register one hook per file, as the launch's hook sync does.
 * @param {{id:number, path:string}} project
 * @returns {number} how many files the launch wrote
 */
function launchFiles(project) {
  const rules = store.sessionRules.listActiveForProject(project.id);
  const shards = channel.buildShards(rules, budget);
  channel.writeShards(project.path, shards, rules.length);
  registerHooks(project.path, shards.length);
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

/**
 * @param {string} projectPath
 * @param {number} index - 1-based file number
 * @returns {string} the text one rules file would have the hook print
 */
function deliveredTextOf(projectPath, index) {
  const parsed = JSON.parse(fs.readFileSync(channel.shardPath(projectPath, index), 'utf8'));
  return parsed.hookSpecificOutput.additionalContext;
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

    assert.deepEqual(verdict, {
      status: 'nothing-to-refresh', projectId: project.id, reason: 'no-rules-files', rulesInForce: 1
    });
    assert.equal(fs.existsSync(path.join(project.path, '.tangleclaw')), false,
      'a refresh must not start delivery the launch declined');
  });

  it('counts the rules in force on every verdict that leaves the files alone', () => {
    // A project launched with no rule has no file and no hook, so its first
    // rules land on the same verdict as a launch that declined delivery. The
    // count is what lets a caller say a rule is in force and not delivered.
    assert.equal(refresh.refreshProjectRules(project.id).rulesInForce, 0);
    addRule(project.id, 'The first rule of a project launched with none.');
    const second = addRule(project.id, 'A second, switched off below.');
    store.sessionRules.create({ content: 'A wrap rule is not delivered this way.', projectId: project.id, kind: 'wrap' });
    assert.equal(refresh.refreshProjectRules(project.id).rulesInForce, 2);
    store.sessionRules.update(second.id, { enabled: false });
    assert.equal(refresh.refreshProjectRules(project.id).rulesInForce, 1, 'a disabled rule is not in force');

    assert.equal(refresh.refreshProjectRules(null).rulesInForce, 0);
    assert.equal(refresh.refreshProjectRules(987654).rulesInForce, 0);
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
    assert.equal(verdict.files, 1, 'a file no hook is registered for would be printed by nothing');
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

  it('writes a file for every registered hook, including one the launch wrote no file for', () => {
    const body = 't'.repeat(Math.floor(budget * 0.6));
    addRule(project.id, `one ${body}`);
    addRule(project.id, `two ${body}`);
    assert.equal(launchFiles(project), 2);
    registerHooks(project.path, 3);
    addRule(project.id, `three ${body}`);

    const verdict = refresh.refreshProjectRules(project.id, { now: NOW });

    assert.equal(verdict.files, 3, 'two files and three hooks: the third hook has a file to print');
    assert.deepEqual(verdict.omittedRuleIds, []);
    const texts = deliveredTexts(project.path);
    assert.equal(texts.length, 3);
    assert.match(texts[2], /part 3 of 3/);
    assert.ok(texts[2].includes('three t'));
  });

  it('holds to the registered hooks when more files are on disk than hooks', () => {
    const body = 's'.repeat(Math.floor(budget * 0.6));
    addRule(project.id, `one ${body}`);
    const second = addRule(project.id, `two ${body}`);
    assert.equal(launchFiles(project), 2);
    registerHooks(project.path, 1);

    const verdict = refresh.refreshProjectRules(project.id, { now: NOW });

    assert.equal(verdict.files, 1);
    assert.equal(verdict.removed, 1, 'a file nothing prints is not left to look delivered');
    assert.deepEqual(verdict.omittedRuleIds, [second.id]);
    assert.ok(deliveredTexts(project.path)[0].includes(`Not carried in this block: Rule #${second.id}.`));
  });

  it('writes nothing when files are on disk and no rules hook is registered', () => {
    addRule(project.id, 'A rule whose file has no reader.');
    launchFiles(project);
    const before = fs.readFileSync(channel.shardPath(project.path, 1), 'utf8');
    registerHooks(project.path, 0);

    const verdict = refresh.refreshProjectRules(project.id, { now: NOW });

    assert.deepEqual(verdict, {
      status: 'nothing-to-refresh', projectId: project.id, reason: 'no-rules-hooks', rulesInForce: 1
    });
    assert.equal(fs.readFileSync(channel.shardPath(project.path, 1), 'utf8'), before);
    fs.rmSync(path.join(project.path, '.claude'), { recursive: true });
    assert.equal(refresh.refreshProjectRules(project.id, { now: NOW }).reason, 'no-rules-hooks',
      'no settings file registers no hook');
  });

  it('fails, and changes nothing, when the registered hooks cannot be read', () => {
    addRule(project.id, 'A rule delivered at launch.');
    launchFiles(project);
    const before = fs.readFileSync(channel.shardPath(project.path, 1), 'utf8');
    fs.writeFileSync(path.join(project.path, '.claude', 'settings.local.json'), '{ not json');

    const verdict = refresh.refreshProjectRules(project.id, { now: NOW });

    assert.equal(verdict.status, 'failed', 'an unknown number of readers is not zero readers');
    assert.ok(verdict.reason.includes(path.join(project.path, '.claude', 'settings.local.json')),
      `the cause names the file at fault, not only the parser's complaint: ${verdict.reason}`);
    assert.equal(verdict.filesReplaced, 0);
    assert.equal(fs.readFileSync(channel.shardPath(project.path, 1), 'utf8'), before);
  });

  it('counts registered hooks as 1..n with no gap, and only the rules scripts', () => {
    const entry = (command) => ({ hooks: [{ type: 'command', command }] });
    const write = (commands) => {
      fs.mkdirSync(path.join(project.path, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(project.path, '.claude', 'settings.local.json'),
        JSON.stringify({ hooks: { SessionStart: commands.map(entry), Stop: [entry('x/data/hooks/sessionstart-rules-claude.sh 9')] } }));
    };
    const rules = (n) => `'/opt/tc'/data/hooks/sessionstart-rules-claude.sh ${n}`;

    assert.equal(refresh.registeredSlots(project.path), 0, 'no settings file');
    write([rules(1), rules(2), rules(4)]);
    assert.equal(refresh.registeredSlots(project.path), 2, 'a hook after a gap has no file the packing gives it');
    write([rules(2)]);
    assert.equal(refresh.registeredSlots(project.path), 0);
    write(["'/opt/tc'/data/hooks/sessionstart-prime-claude.sh", 'echo 1', rules(1), rules(1)]);
    assert.equal(refresh.registeredSlots(project.path), 1, 'the prime hook and an operator hook are not rules hooks');
  });

  it('reads the hooks the real hook sync writes', () => {
    // The count is parsed from what another module writes; a change to that
    // shape must fail here and not leave every refresh finding no hook.
    const engines = require('../lib/engines');
    const body = 'r'.repeat(Math.floor(budget * 0.6));
    addRule(project.id, `one ${body}`);
    addRule(project.id, `two ${body}`);
    const rules = store.sessionRules.listActiveForProject(project.id);
    const expected = channel.shardCount(rules, budget);
    assert.equal(expected, 2);

    engines.syncEngineHooks(project.path);

    assert.equal(refresh.registeredSlots(project.path), expected);
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
    assert.equal(verdict.filesReplaced, 0, 'the caller can say the old set is whole');
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

  it('says how many files it had replaced when a swap fails part-way', () => {
    const body = 'v'.repeat(Math.floor(budget * 0.6));
    addRule(project.id, `one ${body}`);
    addRule(project.id, `two ${body}`);
    assert.equal(launchFiles(project), 2);
    // A directory where the second file was: staging succeeds beside it and the
    // swap onto it is refused, after the first file has already been swapped.
    fs.rmSync(channel.shardPath(project.path, 2));
    fs.mkdirSync(channel.shardPath(project.path, 2));

    const verdict = refresh.refreshProjectRules(project.id, { now: NOW });

    assert.equal(verdict.status, 'failed');
    assert.equal(verdict.filesReplaced, 1, 'a set part new and part old is not reported as the old set');
    assert.match(deliveredTextOf(project.path, 1), /Rules in force: 2, as of/);
  });

  it('sizes the files for the engine the live session runs, not the one the project stores', () => {
    // Only an engine that declares a startup cap has one; every other profile
    // gets the larger fallback. A session started on Claude in a project stored
    // under another engine must still be held to Claude's cap.
    const dir = path.join(tmpBase, 'override-proj');
    fs.mkdirSync(dir, { recursive: true });
    const other = store.engines.list().find((e) => channel.resolveChannelBudget(e) > budget);
    assert.ok(other, 'the fixture needs an engine whose budget is larger than Claude\'s');
    const stored = store.projects.create({ name: 'override-proj', path: dir, engine: other.id });
    const body = 'u'.repeat(Math.floor(budget * 0.45));
    for (const n of ['one', 'two', 'three']) addRule(stored.id, `${n} ${body}`);
    channel.writeShards(dir, channel.buildShards([{ id: 1, content: 'launch-time rule' }], budget), 1);
    registerHooks(dir, 1);

    const idle = refresh.refreshProjectRules(stored.id, { now: NOW });
    assert.deepEqual(idle.omittedRuleIds, [], 'with nothing running, the stored engine\'s budget carries all three');

    store.sessions.start({ projectId: stored.id, engineId: 'claude' });
    const live = refresh.refreshProjectRules(stored.id, { now: NOW });

    assert.equal(live.status, 'refreshed');
    assert.ok(fs.readFileSync(channel.shardPath(dir, 1), 'utf8').length <= budget,
      'a file over the running engine\'s cap is replaced by a preview and every rule in it is lost');
    assert.equal(live.omittedRuleIds.length, 1);
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
