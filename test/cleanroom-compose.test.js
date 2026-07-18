'use strict';

// Guards the operator-ratified lockdown constraints of the tc-cleanroom
// acceptance-gate environment (deploy/cleanroom/). These are textual
// contracts on purpose — the project is zero-dependency, so there is no
// YAML parser; the assertions pin the exact spellings compose consumes.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CLEANROOM_DIR = path.join(__dirname, '..', 'deploy', 'cleanroom');
const compose = fs.readFileSync(path.join(CLEANROOM_DIR, 'compose.yaml'), 'utf8');
const provision = fs.readFileSync(path.join(CLEANROOM_DIR, 'provision.sh'), 'utf8');

describe('tc-cleanroom lockdown contract', () => {
  test('compose project is named tc-cleanroom', () => {
    assert.match(compose, /^name: tc-cleanroom$/m);
  });

  test('the cleanroom network is internal (zero egress)', () => {
    assert.match(compose, /internal: true/);
  });

  test('no ports are published (internal networks ignore publishes; none may be declared)', () => {
    assert.doesNotMatch(compose, /^\s*ports:/m);
  });

  test('image is pre-baked — compose must never pull', () => {
    assert.match(compose, /pull_policy: never/);
  });

  test('no attachment to external/pre-existing networks', () => {
    assert.doesNotMatch(compose, /external: true/);
    assert.doesNotMatch(compose, /host\.docker\.internal/);
  });

  test('provisioner pins every compose invocation to the tc-cleanroom project', () => {
    const composeLines = provision.split('\n').filter((l) => l.includes('docker compose'));
    assert.ok(composeLines.length > 0, 'expected docker compose usage in provision.sh');
    for (const line of composeLines) {
      assert.ok(line.includes('-p tc-cleanroom'), `compose line missing -p tc-cleanroom: ${line}`);
    }
  });

  test('provisioner exports the ssh docker PATH (non-interactive habitat PATH lacks /usr/local/bin)', () => {
    assert.match(provision, /export PATH="\/usr\/local\/bin:\/Applications\/Docker\.app\/Contents\/Resources\/bin:\$PATH"/);
  });
});
