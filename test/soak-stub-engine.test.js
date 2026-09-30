'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const store = require('../lib/store');
const engines = require('../lib/engines');
const stub = require('../deploy/soak/stub-engine/soak-stub');
const { STUB_ENGINE_ID } = require('../lib/soak/executors');

const STUB_DIR = path.join(__dirname, '..', 'deploy', 'soak', 'stub-engine');
const PROGRAM = path.join(STUB_DIR, 'soak-stub.js');
const profile = JSON.parse(fs.readFileSync(path.join(STUB_DIR, 'soak-stub.json'), 'utf8'));

let tempDir;
before(() => {
  // engines reads through the store; point it at a scratch home so the
  // machine's real ~/.tangleclaw is never read or written.
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-stub-'));
  store._setBasePath(tempDir);
});
after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('soak stub engine — profile', () => {
  it('passes TangleClaw\'s engine profile validation', () => {
    assert.deepEqual(engines.validateProfile(profile), { valid: true, errors: [] });
  });

  it('carries the id the soak executors launch it by, and launches the program by that name', () => {
    assert.equal(profile.id, STUB_ENGINE_ID);
    assert.equal(profile.launch.shellCommand, 'soak-stub');
    assert.equal(profile.detection.target, 'soak-stub');
  });

  it('claims no config file, prime prompt or launch sequence, so TangleClaw writes nothing for it', () => {
    assert.equal(profile.capabilities.supportsConfigFile, false);
    assert.equal(profile.capabilities.supportsPrimePrompt, false);
    assert.equal(profile.capabilities.launchSequence.supported, false);
  });
});

describe('soak stub engine — program', () => {
  it('answers each line deterministically and exits 0 on /exit', () => {
    const input = 'soak ping 1\nsoak ping 2\n/exit\nnever read\n';
    const a = spawnSync(process.execPath, [PROGRAM], { input, encoding: 'utf8', timeout: 10000 });
    const b = spawnSync(process.execPath, [PROGRAM], { input, encoding: 'utf8', timeout: 10000 });
    assert.equal(a.status, 0);
    assert.equal(a.stdout, b.stdout);
    assert.equal(a.stdout, [
      'soak-stub ready',
      `${stub.PROMPT}${stub.answer(1, 'soak ping 1')}`,
      `${stub.PROMPT}${stub.answer(2, 'soak ping 2')}`,
      stub.PROMPT
    ].join('\n'));
    assert.doesNotMatch(a.stdout, /never read/);
  });

  it('exits 0 at end of input', () => {
    const r = spawnSync(process.execPath, [PROGRAM], { input: 'one\n', encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ack 1 [0-9a-f]{12}/);
  });

  it('answers with a counter and a stable hash of the line', () => {
    assert.equal(stub.answer(7, 'x'), `ack 7 ${require('node:crypto').createHash('sha256').update('x').digest('hex').slice(0, 12)}`);
  });

  it('is executable, so it can be installed on PATH as soak-stub', () => {
    assert.ok(fs.statSync(PROGRAM).mode & 0o111);
    assert.match(fs.readFileSync(PROGRAM, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  });

  it('loads no networking module, so it cannot reach anything from the guest', () => {
    const src = fs.readFileSync(PROGRAM, 'utf8');
    const required = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(required.sort(), ['node:crypto', 'node:readline']);
  });
});
