'use strict';

// Guards the operator-ratified lockdown constraints of the tc-cleanroom
// acceptance-gate environment (deploy/cleanroom/). These are textual
// contracts on purpose — the project is zero-dependency, so there is no
// YAML parser; the assertions pin the exact spellings compose consumes.
// Negative assertions run against comment-stripped content so prose in
// header comments can name the very patterns being forbidden.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLEANROOM_DIR = path.join(__dirname, '..', 'deploy', 'cleanroom');
const compose = fs.readFileSync(path.join(CLEANROOM_DIR, 'compose.yaml'), 'utf8');
const provision = fs.readFileSync(path.join(CLEANROOM_DIR, 'provision.sh'), 'utf8');

/**
 * Strip full-line and trailing comments from YAML/shell-style text so
 * assertions see only effective configuration, not documentation prose.
 * @param {string} text - raw file content
 * @returns {string} content with comment text removed
 */
function stripComments(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
}

const effective = stripComments(compose);

describe('tc-cleanroom lockdown contract', () => {
  it('names the compose project tc-cleanroom', () => {
    assert.match(effective, /^name: tc-cleanroom$/m);
  });

  it('declares exactly one network, and it is internal (zero egress)', () => {
    // A second, non-internal network attached to the service would restore
    // egress while an "internal: true exists somewhere" check still passed —
    // so pin the whole networks topology, not just the flag's presence.
    const topLevelBlocks = effective.match(/^networks:$/gm) || [];
    assert.equal(topLevelBlocks.length, 1, 'expected exactly one top-level networks block');
    const topLevel = effective.slice(effective.lastIndexOf('\nnetworks:\n'));
    const definedNetworks = [...topLevel.matchAll(/^ {2}(\w[\w-]*):/gm)].map((m) => m[1]);
    assert.deepEqual(definedNetworks, ['cleanroom'], 'only the cleanroom network may be defined');
    assert.match(topLevel, /internal: true/);
    const serviceNets = compose.match(/networks:\n( {6}- .+\n)+/);
    assert.ok(serviceNets, 'service must list its networks explicitly');
    assert.deepEqual(
      serviceNets[0].split('\n').filter((l) => l.trim().startsWith('- ')).map((l) => l.trim().slice(2)),
      ['cleanroom'],
      'the service may attach only to the cleanroom network'
    );
  });

  it('publishes no ports (internal networks ignore publishes; none may be declared)', () => {
    assert.doesNotMatch(effective, /^\s*ports:/m);
  });

  it('never pulls — the image is pre-baked', () => {
    assert.match(effective, /pull_policy: never/);
  });

  it('attaches to no external or pre-existing networks', () => {
    assert.doesNotMatch(effective, /external: true/);
    assert.doesNotMatch(effective, /host\.docker\.internal/);
  });

  it('pins every compose invocation in the provisioner to the tc-cleanroom project', () => {
    const composeLines = stripComments(provision).split('\n').filter((l) => l.includes('docker compose'));
    assert.ok(composeLines.length > 0, 'expected docker compose usage in provision.sh');
    for (const line of composeLines) {
      assert.ok(line.includes('-p tc-cleanroom'), `compose line missing -p tc-cleanroom: ${line}`);
    }
  });

  it('exports the ssh docker PATH (non-interactive habitat PATH lacks /usr/local/bin)', () => {
    assert.match(provision, /export PATH="\/usr\/local\/bin:\/Applications\/Docker\.app\/Contents\/Resources\/bin:\$PATH"/);
  });

  it('rejects unrecognized provisioner arguments before touching the remote host', () => {
    const run = spawnSync('bash', [path.join(CLEANROOM_DIR, 'provision.sh'), '--dwon'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.notEqual(run.status, 0, 'a typoed flag must not fall through to provisioning');
    assert.match(run.stderr + run.stdout, /usage/i);
  });

  it('tracks the image bake recipe beside the compose file (reproducible from a fresh clone)', () => {
    assert.ok(fs.existsSync(path.join(CLEANROOM_DIR, 'bake.sh')), 'deploy/cleanroom/bake.sh must exist');
  });
});
