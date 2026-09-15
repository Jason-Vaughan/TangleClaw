'use strict';

/*
 * The wrap boundary lives in an untracked state file, not project.json (#1510).
 *
 * Files on a real temp directory: the contract is about what lands on disk —
 * which file changes and which stays byte-identical — so a stubbed fs would test
 * the stub.
 */

const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const wrapState = require('../lib/wrap-state');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * A fresh project directory, optionally with a project.json.
 * @param {object|string|null} [config] - Object (serialized like `save`), raw text, or null for none.
 * @returns {string} Project path.
 */
function project(config = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-state-'));
  dirs.push(dir);
  if (config !== null) {
    fs.mkdirSync(path.join(dir, '.tangleclaw'), { recursive: true });
    const text = typeof config === 'string' ? config : `${JSON.stringify(config, null, 2)}\n`;
    fs.writeFileSync(path.join(dir, '.tangleclaw', 'project.json'), text);
  }
  return dir;
}

/**
 * Read a project's project.json bytes.
 * @param {string} dir
 * @returns {string}
 */
function configBytes(dir) {
  return fs.readFileSync(path.join(dir, '.tangleclaw', 'project.json'), 'utf8');
}

const NOW = () => new Date('2026-09-15T12:00:00Z');

describe('reading the boundary', () => {
  it('is absent on a project that never wrapped', () => {
    assert.deepEqual(wrapState.readLastWrapSha(project({ engine: 'claude' })),
      { sha: null, read: 'absent', source: null, error: null });
    assert.equal(wrapState.readLastWrapSha(project()).read, 'absent');
  });

  it('is recorded from the state file', () => {
    const dir = project({ engine: 'claude' });
    wrapState.stampLastWrapSha(dir, 'abc1234', { now: NOW, version: '9.9.9' });
    assert.deepEqual(wrapState.readLastWrapSha(dir), { sha: 'abc1234', read: 'recorded', source: 'state', error: null });
  });

  it('falls back to a project not yet migrated, so its boundary is not lost', () => {
    const dir = project({ engine: 'claude', lastWrapSha: 'legacy1' });
    assert.deepEqual(wrapState.readLastWrapSha(dir), { sha: 'legacy1', read: 'recorded', source: 'project-config', error: null });
  });

  it('prefers the state file over a legacy value left in project.json', () => {
    const dir = project({ engine: 'claude', lastWrapSha: 'legacy1' });
    wrapState.stampLastWrapSha(dir, 'newer99', { now: NOW });
    assert.equal(wrapState.readLastWrapSha(dir).sha, 'newer99');
  });

  it('an unparseable state file is unreadable, never absent', () => {
    const dir = project({ engine: 'claude', lastWrapSha: 'legacy1' });
    fs.writeFileSync(wrapState.statePath(dir), '{ nope');
    const r = wrapState.readLastWrapSha(dir);
    assert.equal(r.read, 'unreadable');
    assert.equal(r.sha, null, 'a legacy value must not stand in for a record nobody could read');
  });

  it('a state file in a schema this build does not know is unreadable', () => {
    const dir = project();
    fs.mkdirSync(path.dirname(wrapState.statePath(dir)), { recursive: true });
    fs.writeFileSync(wrapState.statePath(dir), JSON.stringify({ schema: 2, lastWrapSha: 'abc1234' }));
    assert.equal(wrapState.readLastWrapSha(dir).read, 'unreadable');
  });

  it('an unparseable project.json during the fallback is unreadable, never absent (#797)', () => {
    const dir = project('{ not json');
    assert.equal(wrapState.readLastWrapSha(dir).read, 'unreadable');
  });
});

describe('stamping the boundary', () => {
  it('two consecutive stamps leave project.json byte-identical', () => {
    const dir = project({ engine: 'claude', activePlan: 'a.md' });
    const before = configBytes(dir);
    wrapState.stampLastWrapSha(dir, 'first11', { now: NOW });
    assert.equal(configBytes(dir), before);
    wrapState.stampLastWrapSha(dir, 'second2', { now: NOW });
    assert.equal(configBytes(dir), before);
    assert.equal(wrapState.readLastWrapSha(dir).sha, 'second2');
  });

  it('records when and by which version, and keeps other state fields', () => {
    const dir = project();
    wrapState.adoptLegacyLastWrapSha(dir, 'legacy1', { now: NOW });
    wrapState.stampLastWrapSha(dir, 'abc1234', { now: NOW, version: '5.27.0' });
    const { record } = wrapState.readState(dir);
    assert.equal(record.schema, wrapState.SCHEMA);
    assert.equal(record.lastWrapSha, 'abc1234');
    assert.equal(record.lastWrapStampedAt, '2026-09-15T12:00:00.000Z');
    assert.equal(record.lastWrapStampedBy, '5.27.0');
    assert.equal(record.migratedFromProjectConfigAt, '2026-09-15T12:00:00.000Z');
  });

  it('replaces an unreadable state file rather than failing', () => {
    const dir = project();
    fs.mkdirSync(path.dirname(wrapState.statePath(dir)), { recursive: true });
    fs.writeFileSync(wrapState.statePath(dir), 'garbage');
    wrapState.stampLastWrapSha(dir, 'abc1234', { now: NOW });
    assert.equal(wrapState.readLastWrapSha(dir).sha, 'abc1234');
  });

  it('removes its temp file when the write fails', () => {
    const dir = project();
    fs.mkdirSync(wrapState.statePath(dir), { recursive: true }); // a directory where the file goes: rename fails
    assert.throws(() => wrapState.stampLastWrapSha(dir, 'abc1234', { now: NOW }));
    assert.deepEqual(fs.readdirSync(path.join(dir, '.tangleclaw')), ['state.json']);
  });

  it('leaves no temp file behind', () => {
    const dir = project();
    wrapState.stampLastWrapSha(dir, 'abc1234', { now: NOW });
    assert.deepEqual(fs.readdirSync(path.join(dir, '.tangleclaw')), ['state.json']);
  });
});

describe('migrating project.json', () => {
  it('moves the key out, keeps every other key, and adopts the value', () => {
    const dir = project({ engine: 'claude', lastWrapSha: 'legacy1', activePlan: 'a.md' });
    const r = wrapState.migrateProjectConfig(dir, { now: NOW });
    assert.equal(r.migrated, true);
    assert.equal(configBytes(dir), `${JSON.stringify({ engine: 'claude', activePlan: 'a.md' }, null, 2)}\n`);
    assert.deepEqual(wrapState.readLastWrapSha(dir), { sha: 'legacy1', read: 'recorded', source: 'state', error: null });
  });

  it('is idempotent: a second run writes nothing', () => {
    const dir = project({ engine: 'claude', lastWrapSha: 'legacy1' });
    wrapState.migrateProjectConfig(dir, { now: NOW });
    const configAfter = configBytes(dir);
    const stateAfter = fs.readFileSync(wrapState.statePath(dir), 'utf8');
    const r = wrapState.migrateProjectConfig(dir, { now: () => new Date('2030-01-01T00:00:00Z') });
    assert.equal(r.migrated, false);
    assert.equal(configBytes(dir), configAfter);
    assert.equal(fs.readFileSync(wrapState.statePath(dir), 'utf8'), stateAfter);
  });

  it('never overwrites a newer recorded boundary with the legacy one', () => {
    const dir = project({ engine: 'claude', lastWrapSha: 'legacy1' });
    wrapState.stampLastWrapSha(dir, 'newer99', { now: NOW });
    assert.equal(wrapState.migrateProjectConfig(dir, { now: NOW }).migrated, true);
    assert.equal(wrapState.readLastWrapSha(dir).sha, 'newer99');
    assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(configBytes(dir)), 'lastWrapSha'), false);
  });

  it('removes a null legacy key too — a default written by an older save', () => {
    const dir = project({ engine: 'claude', lastWrapSha: null });
    assert.equal(wrapState.migrateProjectConfig(dir, { now: NOW }).migrated, true);
    assert.equal(configBytes(dir), `${JSON.stringify({ engine: 'claude' }, null, 2)}\n`);
    assert.equal(wrapState.readLastWrapSha(dir).read, 'absent');
  });

  it('never overwrites an unreadable state file with the legacy value, and keeps the key', () => {
    const dir = project({ engine: 'claude', lastWrapSha: 'legacy1' });
    fs.mkdirSync(path.dirname(wrapState.statePath(dir)), { recursive: true });
    fs.writeFileSync(wrapState.statePath(dir), '{ corrupt');
    const configBefore = configBytes(dir);
    const r = wrapState.migrateProjectConfig(dir, { now: NOW });
    assert.equal(r.migrated, false);
    assert.match(r.reason, /could not be read/);
    assert.equal(fs.readFileSync(wrapState.statePath(dir), 'utf8'), '{ corrupt', 'the unreadable record is not replaced by a stale one');
    assert.equal(configBytes(dir), configBefore, 'the legacy copy is the only one left, so it stays');
    assert.equal(wrapState.readLastWrapSha(dir).read, 'unreadable');
  });

  it('leaves an unparseable project.json untouched', () => {
    const dir = project('{ not json');
    const r = wrapState.migrateProjectConfig(dir, { now: NOW });
    assert.equal(r.migrated, false);
    assert.match(r.reason, /could not be read/);
    assert.equal(configBytes(dir), '{ not json');
  });

  it('says so when there is nothing to migrate', () => {
    assert.match(wrapState.migrateProjectConfig(project()).reason, /no project\.json/);
    assert.match(wrapState.migrateProjectConfig(project({ engine: 'claude' })).reason, /holds no lastWrapSha/);
  });
});

describe('store.projectConfig.save never writes the boundary back', () => {
  let store;
  let tmpBase;
  beforeEach(() => {
    store = require('../lib/store');
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-state-store-'));
    dirs.push(tmpBase);
    store._setBasePath(tmpBase);
  });

  it('adopts a loaded legacy value and omits it from project.json', () => {
    const dir = project({ engine: 'claude', lastWrapSha: 'legacy1' });
    const cfg = store.projectConfig.load(dir);
    cfg.activePlan = 'b.md';
    store.projectConfig.save(dir, cfg);
    assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(configBytes(dir)), 'lastWrapSha'), false);
    assert.equal(wrapState.readLastWrapSha(dir).sha, 'legacy1');
  });

  it('keeps the key when the state file is unreadable, and does not overwrite it', () => {
    const dir = project({ engine: 'claude', lastWrapSha: 'legacy1' });
    fs.mkdirSync(path.dirname(wrapState.statePath(dir)), { recursive: true });
    fs.writeFileSync(wrapState.statePath(dir), JSON.stringify({ schema: 99 }));
    store.projectConfig.save(dir, store.projectConfig.load(dir));
    assert.equal(JSON.parse(configBytes(dir)).lastWrapSha, 'legacy1');
    assert.equal(fs.readFileSync(wrapState.statePath(dir), 'utf8'), JSON.stringify({ schema: 99 }));
  });

  it('keeps the key when the state file cannot be written, so nothing is lost', () => {
    const dir = project({ engine: 'claude', lastWrapSha: 'legacy1' });
    const orig = wrapState.adoptLegacyLastWrapSha;
    wrapState.adoptLegacyLastWrapSha = () => { throw new Error('EACCES'); };
    try {
      store.projectConfig.save(dir, store.projectConfig.load(dir));
    } finally {
      wrapState.adoptLegacyLastWrapSha = orig;
    }
    assert.equal(JSON.parse(configBytes(dir)).lastWrapSha, 'legacy1');
  });
});
