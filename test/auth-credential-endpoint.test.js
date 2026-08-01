'use strict';

// POST /api/auth/credential — the only route that changes a login outside first-run
// setup and the terminal recovery tool.
//
// What these tests are really about is REFUSAL. The endpoint's value is not that it
// can write a credential — `PATCH /api/config` could do that, which is the defect
// it replaces — but that it declines whenever nothing is authenticating the caller,
// whenever there is no credential to change, and whenever the change would end at
// "no password". The happy path is the small part.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const caddy = require('../lib/caddy');
const { createServer, _setRestartScheduler } = require('../server');
const { installCaddyStub } = require('./_caddy-stub');

const STUB_HASH = '$2a$14$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU';
const OLD_HASH = '$2b$12$' + 'o'.repeat(53);
const GOOD_PASSWORD = 'a-perfectly-fine-passphrase';

/** Make a JSON request to the test server. */
function request(server, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** A live, gated Caddyfile — the only state in which a change is allowed. */
function writeGatedCaddyfile(user = 'jason', hash = OLD_HASH) {
  const p = caddy.getCaddyfilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, [
    'localhost:8443 {',
    '  basic_auth {',
    `    ${user} ${hash}`,
    '  }',
    '  reverse_proxy 127.0.0.1:3102',
    '}',
    ''
  ].join('\n'), { mode: 0o600 });
}

describe('POST /api/auth/credential', () => {
  let server; let tmpDir; let caddyStub;

  before(async () => {
    caddyStub = installCaddyStub();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-credapi-'));
    store._setBasePath(tmpDir);
    store.init();
    _setRestartScheduler(() => {});
    server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  });

  after(async () => {
    caddyStub.restore();
    await new Promise((r) => server.close(r));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const p = caddy.getCaddyfilePath();
    if (fs.existsSync(p)) fs.rmSync(p);
    // The allowed shape, restored per case so a refusal test cannot pass because a
    // previous case left the install in a state that refuses anyway.
    const config = store.config.load();
    config.ingressMode = 'caddy';
    config.authEnabled = true;
    config.basicAuthUser = 'jason';
    config.basicAuthHash = OLD_HASH;
    store.config.save(config);
    writeGatedCaddyfile();
  });

  describe('the guard — what it will not do', () => {
    it('refuses when nothing is enforcing a login, because nothing authenticated the caller', () => {
      // The #805 shape, from the other direction: on an ungated install there is no
      // perimeter, so this request is anonymous. Writing a credential here would let
      // whoever reaches the box claim it.
      const config = store.config.load();
      config.ingressMode = 'direct';
      store.config.save(config);
      return request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: GOOD_PASSWORD }).then(({ status, data }) => {
        assert.equal(status, 409);
        assert.equal(data.code, 'NOT_CADDY_MODE');
        assert.equal(store.config.load().basicAuthHash, OLD_HASH, 'nothing may be written');
      });
    });

    it('refuses when config records a credential the live Caddyfile is not applying', async () => {
      // The stored-unconfirmed state. Changing it would report a password change
      // that nothing enforces.
      fs.writeFileSync(caddy.getCaddyfilePath(),
        'localhost:8443 {\n  reverse_proxy 127.0.0.1:3102\n}\n', { mode: 0o600 });
      const { status, data } = await request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: GOOD_PASSWORD });
      assert.equal(status, 409);
      assert.equal(data.code, 'NO_GATE');
      assert.match(data.error, /reset-admin/, 'recovery lives at a terminal');
      assert.equal(store.config.load().basicAuthHash, OLD_HASH);
    });

    it('refuses to CREATE a first credential — that is recovery, not settings', async () => {
      // A dashboard route that creates a gate is the second remote door the
      // Direction forbids: a reset behind the gate cannot help someone the gate has
      // locked out.
      const config = store.config.load();
      config.basicAuthUser = null;
      config.basicAuthHash = null;
      store.config.save(config);
      const { status, data } = await request(server, 'POST', '/api/auth/credential',
        { user: 'brand-new', password: GOOD_PASSWORD });
      assert.equal(status, 409);
      assert.equal(data.code, 'NO_CREDENTIAL');
      assert.equal(store.config.load().basicAuthHash, null, 'no credential may appear from here');
    });

    it('has no way to blank the credential — every empty spelling is a validation error', async () => {
      // The Direction allows exactly one route to "no password" and it is not this
      // one. An empty password must read as an invalid password, never as "clear it".
      for (const password of ['', null, undefined]) {
        const { status } = await request(server, 'POST', '/api/auth/credential',
          { user: 'jason', password });
        assert.equal(status, 400, `password ${JSON.stringify(password)} must not blank the login`);
        assert.equal(store.config.load().basicAuthHash, OLD_HASH);
      }
    });

    it('rejects a weak password with the same rules setup uses, not a second set', async () => {
      const { status, data } = await request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: 'short' });
      assert.equal(status, 400);
      // Same validator as the wizard: one implementation, so the rules cannot drift
      // between where a password is first set and where it is changed.
      assert.equal(data.error, caddy.validateAdminPassword('short', 'jason').error);
    });
  });

  describe('the change itself', () => {
    it('rewrites the LIVE gate, not just the recorded config', async () => {
      // Config alone would tell the operator their password changed while the old
      // one still opens the dashboard.
      const { status, data } = await request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: GOOD_PASSWORD });
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      const live = fs.readFileSync(caddy.getCaddyfilePath(), 'utf8');
      assert.ok(live.includes(STUB_HASH), 'the Caddyfile must carry the new hash');
      assert.ok(!live.includes(OLD_HASH), 'and must not still carry the old one');
      assert.equal(store.config.load().basicAuthHash, STUB_HASH);
    });

    it('keeps the username in force when only a password is sent', async () => {
      // Making someone retype a username to change a password is how a typo
      // silently becomes a second account.
      const { status, data } = await request(server, 'POST', '/api/auth/credential',
        { password: GOOD_PASSWORD });
      assert.equal(status, 200);
      assert.equal(data.user, 'jason');
      assert.equal(store.config.load().basicAuthUser, 'jason');
    });

    it('REFUSES a rename, naming the login that is actually in force', async () => {
      // The defect this test exists for: `replaceBasicAuthCredential` takes a
      // username as a SELECTOR of which line to re-hash and writes back the MATCHED
      // name, so a rename either throws (500) or silently keeps the old name in the
      // gate while config records the new one. Every earlier test here sent
      // `user: 'jason'` — the fixture's OWN name — so the rename path was never
      // once executed. The fixture has to contain the real shape.
      const { status, data } = await request(server, 'POST', '/api/auth/credential',
        { user: 'somebody-else', password: GOOD_PASSWORD });
      assert.equal(status, 400);
      assert.equal(data.code, 'RENAME_UNSUPPORTED');
      assert.match(data.error, /jason/, 'it must say which login IS in force');
      assert.match(data.error, /reset-admin/, 'and where a rename actually happens');
      // Nothing may have moved — not the gate, not config.
      assert.equal(store.config.load().basicAuthUser, 'jason');
      assert.equal(store.config.load().basicAuthHash, OLD_HASH);
      assert.ok(fs.readFileSync(caddy.getCaddyfilePath(), 'utf8').includes(OLD_HASH));
    });

    it('resolves the target from the FILE, not from config, when the two disagree', async () => {
      // ADR 0009's amendment describes config and the live Caddyfile drifting. The
      // file is what the gate enforces, so config naming someone else must not
      // redirect the change — or send it to a 500.
      const config = store.config.load();
      config.basicAuthUser = 'stale-name-in-config';
      store.config.save(config);
      const { status, data } = await request(server, 'POST', '/api/auth/credential',
        { password: GOOD_PASSWORD });
      assert.equal(status, 200);
      assert.equal(data.user, 'jason', 'the answer is the gate\'s name, not config\'s');
      assert.equal(store.config.load().basicAuthUser, 'jason', 'and config is corrected to match');
    });

    it('says plainly that the operator is about to be signed out', async () => {
      // Caddy reloads with the new hash and basic_auth cannot hand a browser new
      // credentials, so the re-prompt is certain. Unexplained, it reads as a fault.
      const { data } = await request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: GOOD_PASSWORD });
      assert.equal(data.signedOut, true);
    });

    it('never returns the hash it just wrote', async () => {
      const { raw } = await request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: GOOD_PASSWORD });
      assert.ok(!raw.includes(STUB_HASH), 'a credential hash must not cross the HTTP boundary');
      assert.ok(!raw.includes(GOOD_PASSWORD), 'and neither must the plaintext');
    });

    it('answers BEFORE restarting the Caddy the answer travels through', async () => {
      // The defect this pins: the reply to this request goes back through the very
      // Caddy the change restarts, so restarting first tears down the connection
      // carrying it and a change that SUCCEEDED reaches the browser as a network
      // error. The response arriving at all is the assertion; the reload following
      // it is the second half.
      fs.writeFileSync(caddyStub.launchctlLog, '');
      const { status, data } = await request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: GOOD_PASSWORD });

      assert.equal(status, 200, 'the response must survive the change it reports');
      assert.equal(data.signedOut, true);
      // Deferred means the outcome is unknowable here, so the response must not
      // pretend to carry it.
      assert.ok(!('reloaded' in data),
        'no reload result can exist yet — the restart has not been asked for');
      assert.match(data.reloadCommand, /launchctl kickstart -k gui\/\d+\/com\.tangleclaw\.caddy/,
        'the operator\'s recourse ships unconditionally, since a failed restart cannot be reported');

      // ...and the restart really is asked for, once the response is out. Polled
      // because it is deliberately asynchronous — asserting immediately would pass
      // against a version that never reloads at all.
      const deadline = Date.now() + 5000;
      let logged = '';
      while (Date.now() < deadline) {
        logged = fs.readFileSync(caddyStub.launchctlLog, 'utf8');
        if (logged.includes('kickstart')) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.match(logged, /kickstart -k gui\/\d+\/com\.tangleclaw\.caddy/,
        'the reload must still happen — just after the response, not before it');
    });

    it('never restarts Caddy from inside the handler', () => {
      // Pinned structurally rather than by timing, because the runtime assertion
      // above cannot distinguish the two orders: the test client talks to the
      // server directly, with no Caddy in between to tear the connection down. The
      // operator's browser does not have that luxury, so the ORDER is the contract
      // and this is where it is enforced.
      const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      const start = src.indexOf("route('POST', '/api/auth/credential'");
      assert.ok(start > -1, 'could not locate the credential route');
      const handler = src.slice(start, src.indexOf("route('GET', '/api/service-token'", start));
      assert.match(handler, /reload: false/,
        'the apply call must not reload inline');
      // `close`, not `finish`. finish fires only when the response was fully
      // sent, so a client that aborts mid-reply would leave the credential
      // changed on disk with Caddy never reloaded — the old password still
      // opening the door and nothing reporting it.
      assert.match(handler, /res\.on\('close'/,
        'the reload must hang off the response closing, which covers an abort too');
      assert.doesNotMatch(handler, /res\.on\('finish'/,
        'finish alone drops the reload on an aborted response');
      assert.doesNotMatch(handler, /adminCredential\.reloadCaddy\(/,
        'the SYNCHRONOUS reload would hold the event loop for the length of a Caddy restart');
    });

    it('applies the no-username-in-password rule to the login actually in force', async () => {
      // The UI sends only `{ password }` — the username field is read-only and the
      // server resolves the target itself — so validating against the REQUEST's
      // username left this rule inert on every call the product actually makes.
      // Setup enforces it; a change surface that did not would let it be escaped
      // by simply changing the password afterwards.
      const { status, data } = await request(server, 'POST', '/api/auth/credential',
        { password: 'jason-jason-jason' });
      assert.equal(status, 400);
      assert.match(data.error, /username/i);
      assert.equal(store.config.load().basicAuthHash, OLD_HASH, 'nothing may have changed');
    });

    it('checks the password against the GATE\'s username when config has drifted', async () => {
      // The guard requires config AND the file to carry a credential, but never
      // requires them to be the SAME name — and ADR 0009's amendment says they
      // drift. Checking against config's copy in that state accepts a password
      // containing the real login name, which setup would refuse. The GET was
      // moved onto the file's username for this exact reason; the validation has
      // to come from the same place or the two disagree about one machine.
      const stored = store.config.load();
      const had = stored.basicAuthUser;
      stored.basicAuthUser = 'stale-name-in-config';
      store.config.save(stored);
      try {
        const { status, data } = await request(server, 'POST', '/api/auth/credential',
          { password: 'jason-jason-jason' });
        assert.equal(status, 400, 'the gate\'s username is `jason`, so this must be refused');
        assert.match(data.error, /username/i);
      } finally {
        const back = store.config.load();
        back.basicAuthUser = had;
        store.config.save(back);
      }
    });

    it('answers a broken gate with 500 and the backup path, not "nothing was changed"', async () => {
      // Pins the ARM as well as the code. This branch sits above the generic
      // `!result.ok` handler on purpose — reordered, the route re-emits the old
      // 400 "nothing was changed" for a machine whose ingress may not load, and
      // the module's unit tests stay green because they never see the response.
      const realWrite = fs.writeFileSync;
      const realCopy = fs.copyFileSync;
      let copies = 0;
      let res;
      try {
        fs.writeFileSync = (p, ...rest) => {
          if (p === caddy.getCaddyfilePath()) throw new Error('ENOSPC: no space left on device');
          return realWrite(p, ...rest);
        };
        fs.copyFileSync = (from, to) => {
          if (++copies > 1) throw new Error('EROFS: read-only file system');
          return realCopy(from, to);
        };
        res = await request(server, 'POST', '/api/auth/credential', { password: GOOD_PASSWORD });
      } finally {
        fs.writeFileSync = realWrite;
        fs.copyFileSync = realCopy;
      }

      assert.equal(res.status, 500);
      assert.equal(res.data.code, 'GATE_BROKEN');
      assert.match(res.data.error, /ingress may now be broken/);
      assert.match(res.data.error, /\.credential\.bak/, 'the operator needs the file to restore');
      assert.doesNotMatch(res.data.error, /rejected by Caddy/,
        'the parser is not what failed, and saying so sends them to audit a fine Caddyfile');
    });

    it('blames the disk, not the Caddy parser, when the write itself fails', async () => {
      const realWrite = fs.writeFileSync;
      let res;
      try {
        fs.writeFileSync = (p, ...rest) => {
          if (p === caddy.getCaddyfilePath()) throw new Error('ENOSPC: no space left on device');
          return realWrite(p, ...rest);
        };
        res = await request(server, 'POST', '/api/auth/credential', { password: GOOD_PASSWORD });
      } finally {
        fs.writeFileSync = realWrite;
      }

      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'WRITE_FAILED');
      assert.match(res.data.error, /full disk or a permissions problem/);
      assert.equal(store.config.load().basicAuthHash, OLD_HASH, 'and nothing changed');
    });

    it('answers a bodyless POST with a refusal, not a crash', async () => {
      // parseBody resolves null for an empty request, so every field read in the
      // handler runs against null. A 500 there reads as "the server broke" for what
      // is simply a malformed request.
      const { status, data } = await request(server, 'POST', '/api/auth/credential');
      assert.equal(status, 400);
      assert.equal(data.code, 'BAD_REQUEST');
      assert.equal(store.config.load().basicAuthHash, OLD_HASH, 'and nothing may have changed');
    });
  });

  describe('GET /api/auth/credential — the same answer, before the form is drawn', () => {
    it('reports changeable with the username to prefill, and never the hash', async () => {
      const { status, data } = await request(server, 'GET', '/api/auth/credential');
      assert.equal(status, 200);
      assert.equal(data.changeable, true);
      assert.equal(data.user, 'jason');
      assert.equal('hash' in data, false);
    });

    it('agrees with POST about a machine, so the form is never offered then refused', async () => {
      // The wizard's step list already had to fix exactly this: a client deciding
      // one thing while the server decided another about the same install.
      const config = store.config.load();
      config.ingressMode = 'direct';
      store.config.save(config);
      const get = await request(server, 'GET', '/api/auth/credential');
      const post = await request(server, 'POST', '/api/auth/credential',
        { user: 'jason', password: GOOD_PASSWORD });
      assert.equal(get.data.changeable, false);
      assert.equal(post.status, 409);
      assert.equal(get.data.code, post.data.code, 'both must name the same reason');
    });

    it('withholds the username when the change is refused', async () => {
      // Nothing here is authenticating the caller in that state, so it must not
      // answer questions about the account either.
      const config = store.config.load();
      config.ingressMode = 'direct';
      store.config.save(config);
      const { data } = await request(server, 'GET', '/api/auth/credential');
      assert.equal(data.user, null);
    });
  });
});

describe('POST /api/auth/credential — fail-closed when Caddy rejects the file', () => {
  let server; let tmpDir; let caddyStub;

  before(async () => {
    // The one suite that needs `caddy validate` to REJECT.
    caddyStub = installCaddyStub({ answersValidate: false });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-credapi-bad-'));
    store._setBasePath(tmpDir);
    store.init();
    _setRestartScheduler(() => {});
    server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  });

  after(async () => {
    caddyStub.restore();
    await new Promise((r) => server.close(r));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores the gate and leaves the recorded credential where it was', async () => {
    const config = store.config.load();
    config.ingressMode = 'caddy';
    config.authEnabled = true;
    config.basicAuthUser = 'jason';
    config.basicAuthHash = OLD_HASH;
    store.config.save(config);
    writeGatedCaddyfile();

    const { status, data } = await request(server, 'POST', '/api/auth/credential',
      { user: 'jason', password: GOOD_PASSWORD });

    assert.equal(status, 400);
    assert.equal(data.code, 'VALIDATE_FAILED');
    assert.equal(store.config.load().basicAuthHash, OLD_HASH,
      'config must not record a credential the ingress rejected');
    assert.ok(fs.readFileSync(caddy.getCaddyfilePath(), 'utf8').includes(OLD_HASH),
      'the working gate must be restored');
  });

  it('does not leak the rejected hash through the error message', async () => {
    // `caddy validate` output quotes the offending line, and that line carries a
    // credential. Filtered at the HTTP boundary as well as the log.
    const config = store.config.load();
    config.ingressMode = 'caddy';
    config.basicAuthUser = 'jason';
    config.basicAuthHash = OLD_HASH;
    store.config.save(config);
    writeGatedCaddyfile();
    const { raw } = await request(server, 'POST', '/api/auth/credential',
      { user: 'jason', password: GOOD_PASSWORD });
    assert.ok(!raw.includes(STUB_HASH));
    assert.ok(!raw.includes(OLD_HASH));
  });
});
