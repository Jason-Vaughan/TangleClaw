'use strict';

// A seeded soak repository, attached and synced by the candidate itself, must
// already be in the state the soak's executors read: a clean work tree (the
// wrap cycle refuses files the session did not make), a listed plan (the plans
// read), and a Medusa opt-in (the switchboard cycle). The seed is where that
// state comes from, so this drives the real attach and startup sync over it.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const repos = require('../lib/soak/repos');
const planDocs = require('../lib/plan-docs');
const { PLAN_FILE } = require('../lib/soak/executors');

let projects;
let tmpDir;
let root;

/**
 * Run git in a directory and return its trimmed output.
 * @param {string} cwd - Directory
 * @param {string[]} args - Git arguments
 * @returns {string} Output
 */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('soak repos: attached and synced by the candidate', () => {
  before(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soak-attach-')));
    store._setBasePath(path.join(tmpDir, 'home'));
    store.init();
    root = path.join(tmpDir, 'projects');
    repos.ensureRepos({ root, origins: path.join(tmpDir, 'origins'), projects: ['soak-a'] });
    const config = store.config.load();
    config.projectsDir = root;
    store.config.save(config);
    projects = require('../lib/projects');
    await projects.attachProject('soak-a');
    projects.syncAllProjects();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('leaves the work tree clean, so a wrap has no foreign file to refuse', () => {
    assert.equal(git(path.join(root, 'soak-a'), ['status', '--porcelain=v1', '-uall']), '');
  });

  it('lists the plan the plans read looks for', () => {
    const files = planDocs.listPlans(path.join(root, 'soak-a')).map((p) => p.file);
    assert.ok(files.includes(PLAN_FILE), `plans: ${files.join(', ')}`);
  });

  it('keeps the seeded project config: stub engine, Medusa on, no wrap PR, no release', () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'soak-a', '.tangleclaw', 'project.json'), 'utf8'));
    assert.equal(config.engine, 'soak-stub');
    assert.equal(config.medusaEnabled, true);
    assert.equal(config.wrapAutoPrEnabled, false);
    assert.equal(config.releaseMode, 'off');
  });
});
