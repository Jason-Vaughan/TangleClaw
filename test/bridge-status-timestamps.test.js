'use strict';

/*
 * The helper's Discord times in the host's local time (#2313).
 *
 * The bridge's status routes give the helper's Discord connection with two
 * ISO times, `since` and `reportedAt`. A person reads those on the bridge
 * panel and in `tc bridge status`, often on a phone, and an ISO time in UTC
 * is a sum they have to do. The routes now also give each time as the
 * notices word it (`13:03 PDT on 2026-10-11`), as `sinceText` and
 * `reportedAtText`; the ISO fields stay for scripts. These cases hold the
 * wording, the CLI line that prints it, and the fallback to the ISO time a
 * server older than the words still sends.
 *
 * The status routes' own JSON, with the zone pinned, is held in
 * `test/api-bridge-gateway.test.js`, and the panel's line in
 * `test/operator-bridge-panel.test.js`.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const bridgeNotify = require('../lib/bridge-notify');

const TC_BIN = path.join(__dirname, '..', 'bin', 'tc');
const SINCE = '2026-10-11T05:03:00.000Z';
const HEARD = '2026-10-11T05:09:00.000Z';

describe('the formatter the status routes word their times with (#2313)', () => {
  const realZone = bridgeNotify._deps.timeZone;
  after(() => { bridgeNotify._deps.timeZone = realZone; });

  it('is the notices\' own: the host\'s local time with its zone', () => {
    bridgeNotify._deps.timeZone = () => 'America/Los_Angeles';
    assert.equal(bridgeNotify.when(SINCE), '22:03 PDT on 2026-10-10');
    bridgeNotify._deps.timeZone = () => 'America/New_York';
    assert.equal(bridgeNotify.when(SINCE), '01:03 EDT on 2026-10-11');
  });

  it('gives UTC, and says so, where the zone cannot be named', () => {
    bridgeNotify._deps.timeZone = () => 'Not/AZone';
    assert.equal(bridgeNotify.when(SINCE), '05:03 UTC on 2026-10-11');
  });
});

describe('tc bridge status: the Discord line (#2313)', () => {
  /**
   * Run the real `bin/tc bridge status` against a server that answers the
   * status route with `body`, and return its `Discord connection` line.
   * @param {object} body - The status body the stub server answers.
   * @returns {Promise<string>} The line, or '' when there is none.
   */
  async function discordLine(body) {
    const stub = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    try {
      const env = {
        PATH: process.env.PATH, HOME: process.env.HOME, TANGLECLAW_ROLE: 'master',
        TANGLECLAW_BRIDGE_CREDENTIAL: 'stub', TANGLECLAW_API: `http://127.0.0.1:${stub.address().port}`
      };
      const shown = await new Promise((resolve) => {
        execFile(TC_BIN, ['bridge', 'status'], { env, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
      });
      assert.equal(shown.code, 0, shown.stderr);
      return shown.stdout.split('\n').find((line) => line.startsWith('Discord connection: ')) || '';
    } finally {
      await new Promise((resolve) => stub.close(resolve));
    }
  }

  const base = { enabled: true, openRoutes: 0, masterGeneration: 1, proof: 'master-launch', configurationCircuit: null, scope: { kind: 'all' } };
  const words = { sinceText: '22:03 PDT on 2026-10-10', reportedAtText: '22:09 PDT on 2026-10-10' };
  const gateway = (reading, state, extra) => ({ ...base, discordGateway: { reading, state, since: SINCE, fatalCloseCode: null, reportedAt: HEARD, ...extra } });

  it('prints each time in the server\'s local words, for every reading that has times', async () => {
    assert.equal(await discordLine(gateway('connected', 'ready', words)),
      'Discord connection: connected since 22:03 PDT on 2026-10-10 (the helper\'s report of 22:09 PDT on 2026-10-10).');
    assert.equal(await discordLine(gateway('down', 'reconnecting', words)),
      'Discord connection: NOT CONNECTED since 22:03 PDT on 2026-10-10: the helper reports reconnecting (its report of 22:09 PDT on 2026-10-10). Nothing the operator writes arrives meanwhile.');
    assert.equal(await discordLine(gateway('down', 'fatal', { ...words, fatalCloseCode: 4004 })),
      'Discord connection: NOT CONNECTED since 22:03 PDT on 2026-10-10: the helper reports fatal (close code 4004): Discord refused the connection and the helper '
      + 'will not retry until it is put right and restarted (its report of 22:09 PDT on 2026-10-10). Nothing the operator writes arrives meanwhile.');
    assert.equal(await discordLine(gateway('not-reported', 'ready', words)),
      'Discord connection: NOT REPORTED since 22:09 PDT on 2026-10-10: the helper last said ready and has not reported since. It may not be running; whether Discord is connected is not known.');
  });

  it('prints the ISO time from a server older than the words, and never a missing value', async () => {
    const line = await discordLine(gateway('down', 'reconnecting'));
    assert.equal(line,
      `Discord connection: NOT CONNECTED since ${SINCE}: the helper reports reconnecting (its report of ${HEARD}). Nothing the operator writes arrives meanwhile.`);
    assert.ok(!/undefined|null/.test(line), line);
  });

  it('leaves the never-reported line as it was: it has no times', async () => {
    const never = { ...base, discordGateway: { reading: 'never-reported', state: null, since: null, fatalCloseCode: null, reportedAt: null, sinceText: null, reportedAtText: null } };
    assert.equal(await discordLine(never),
      'Discord connection: never reported since this server started: the helper is not running, has not yet asked for work, or predates the report and needs a restart.');
  });
});
