'use strict';

/**
 * Regenerate the `caddy adapt` fixtures behind `test/caddy-drift.test.js`.
 *
 * The drift check reads Caddy's own JSON, so its tests have to assert against
 * real `caddy adapt` output rather than a hand-written approximation of it —
 * a fixture nobody generated is a fixture that agrees with whatever the code
 * already does. CI has no `caddy`, so the output is committed and the suite
 * re-derives and compares it whenever `caddy` IS present, which is what keeps
 * a committed snapshot from quietly going stale across a Caddy release.
 *
 * The credential in these fixtures is a throwaway bcrypt hash generated for
 * this file. No live credential is ever written here.
 *
 * Usage: node scripts/regen-caddy-adapt-fixtures.js
 */

const fs = require('node:fs');
const path = require('node:path');
const caddy = require('../lib/caddy');
const drift = require('../lib/caddy-drift');
const { FIXTURE_CADDYFILES } = require('../test/_caddy-drift-fixtures');

const outDir = path.join(__dirname, '..', 'test', 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

const detection = caddy.detectCaddy();
if (!detection.available) {
  console.error(`caddy is not available (${detection.error}) — cannot regenerate fixtures.`);
  process.exit(1);
}

for (const [name, content] of Object.entries(FIXTURE_CADDYFILES)) {
  const adapted = drift.adaptCaddyfileContent(content);
  if (!adapted.ok) {
    console.error(`FAILED to adapt ${name}: ${adapted.reason}`);
    process.exit(1);
  }
  const file = path.join(outDir, `caddy-adapt-${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(adapted.config, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
