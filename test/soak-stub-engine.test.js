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

  it('loads no networking module: its only network path is the switchboard client\'s fetch to TANGLECLAW_API', () => {
    const src = fs.readFileSync(PROGRAM, 'utf8');
    const required = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(required.sort(), ['node:crypto', 'node:readline']);
    assert.equal([...src.matchAll(/\bfetch\(/g)].length, 1, 'one fetch call site, in the origin-pinned request helper');
  });

  it('makes no network call for an ordinary line, even with an identity in its env', async () => {
    const net = fakeNet(() => { throw new Error('no call expected'); });
    const out = await runLines(['soak ping 1', 'hello'], { env: ENV, fetch: net.fetch });
    assert.equal(net.calls.length, 0);
    assert.equal(out, ['soak-stub ready', `${stub.PROMPT}${stub.answer(1, 'soak ping 1')}`, `${stub.PROMPT}${stub.answer(2, 'hello')}`, stub.PROMPT].join('\n'));
  });
});

const API = 'http://127.0.0.1:3102';
const LAUNCH = 'launch-0f1e2d3c-secret';
const ENV = Object.freeze({ TANGLECLAW_API: API, TANGLECLAW_LAUNCH_ID: LAUNCH, TANGLECLAW_PROJECT_ID: '42', TANGLECLAW_WORKSPACE_ID: 'ws-soak-a' });
const NONCE = '0123abcd';
const MSG_ID = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
const WHOAMI_OK = Object.freeze({ project: { id: 42, name: 'soak a' }, binding: { state: 'verified', projectId: 42 }, workspaceId: 'ws-soak-a' });

/**
 * A fetch stand-in that records each request and answers from a script.
 * @param {(req: {method: string, url: URL, path: string, headers: object, body: *, redirect: string}) => ({status: number, body?: *, text?: string}|Error)} answerFn - Response per request
 * @returns {{fetch: Function, calls: object[]}} The fake and its log
 */
function fakeNet(answerFn) {
  const calls = [];
  const fetch = async (url, init) => {
    const req = { method: init.method, url, path: url.pathname, query: url.search, headers: init.headers, redirect: init.redirect, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(req);
    const r = answerFn(req);
    if (r instanceof Error) throw r;
    const text = r.text !== undefined ? r.text : (r.body === undefined ? '' : JSON.stringify(r.body));
    return { status: r.status, text: async () => text };
  };
  return { fetch, calls };
}

/**
 * A fake TangleClaw: whoami, send, the inbox and mark-handled, each overridable.
 * @param {object} [over] - `{whoami, send, messages(n), read}`
 * @returns {{fetch: Function, calls: object[]}} The fake and its log
 */
function fakeServer(over = {}) {
  let inboxReads = 0;
  const o = {
    whoami: () => ({ status: 200, body: WHOAMI_OK }),
    send: () => ({ status: 200, body: { id: MSG_ID } }),
    messages: () => ({ status: 200, body: { messages: [{ id: 'other', message: 'unrelated' }, { id: MSG_ID, message: 'soak medusa-cycle e41-tag9' }] } }),
    read: () => ({ status: 200, body: {} }),
    ...over
  };
  return fakeNet((req) => {
    if (req.path === '/api/tc/whoami') return o.whoami(req);
    if (req.path.endsWith('/medusa/send')) return o.send(req);
    if (req.path.endsWith('/medusa/messages')) return o.messages(++inboxReads, req);
    if (req.path.endsWith('/medusa/read')) return o.read(req);
    throw new Error(`unexpected ${req.method} ${req.path}`);
  });
}

/**
 * A clock the read wait can run out on without waiting.
 * @returns {{now: Function, sleep: Function, slept: number[]}} Clock
 */
function fakeClock() {
  let t = 1_000_000;
  const slept = [];
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, slept };
}

/**
 * Feed lines to the stub through in-memory streams and collect what it printed.
 * @param {string[]} lines - Input lines
 * @param {object} io - `{env, fetch, now, sleep}`
 * @returns {Promise<string>} Everything printed
 */
async function runLines(lines, io) {
  const { PassThrough } = require('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = '';
  output.on('data', (d) => { printed += d; });
  const done = stub.run(input, output, io);
  input.end(lines.map((l) => `${l}\n`).join(''));
  await done;
  return printed;
}

const SEND = `/soak-medusa send ${NONCE} soak%20a ws-soak-b e41-tag9 soak-medusa-abcdef0123456789-1-41`;
const READ = `/soak-medusa read ${NONCE} soak%20a e41-tag9`;
const handle = (line, over = {}, env = ENV, clock = fakeClock()) => {
  const net = over.fetch ? over : fakeServer(over);
  return stub.handleMedusa(stub.parseMedusaLine(line), env, { fetch: net.fetch, now: clock.now, sleep: clock.sleep }).then((line) => ({ line, calls: net.calls, clock }));
};

describe('soak stub engine — the in-pane switchboard client: command grammar', () => {
  it('reads a send and a read, decoding the project name', () => {
    assert.deepEqual(stub.parseMedusaLine(SEND), { verb: 'send', nonce: NONCE, project: 'soak a', to: 'ws-soak-b', tag: 'e41-tag9', requestId: 'soak-medusa-abcdef0123456789-1-41' });
    assert.deepEqual(stub.parseMedusaLine(`/soak-medusa send ${NONCE} soak-a ws-b t1`), { verb: 'send', nonce: NONCE, project: 'soak-a', to: 'ws-b', tag: 't1', requestId: null });
    assert.deepEqual(stub.parseMedusaLine(READ), { verb: 'read', nonce: NONCE, project: 'soak a', tag: 'e41-tag9' });
  });

  it('is not a switchboard command unless the first word is exactly /soak-medusa', () => {
    for (const line of ['soak ping 1', 'soak-medusa send x', ' /soak-medusax send', 'say /soak-medusa send']) assert.equal(stub.parseMedusaLine(line), null, line);
  });

  it('marks a malformed command BAD_COMMAND, keeping what it can of the verb and nonce', () => {
    for (const line of [
      `/soak-medusa post ${NONCE} soak-a`,
      '/soak-medusa send NOTHEX soak-a ws-b t1',
      `/soak-medusa send ${NONCE}`,
      `/soak-medusa send ${NONCE} soak-a ws-b`,
      `/soak-medusa send ${NONCE} soak-a ws-b t1 r1 extra`,
      `/soak-medusa send ${NONCE} soak-a ws-b t<1>`,
      `/soak-medusa read ${NONCE} soak-a`,
      `/soak-medusa read ${NONCE} %E0%A4%A soak-a`
    ]) assert.equal(stub.parseMedusaLine(line).error, 'BAD_COMMAND', line);
  });

  it('answers a malformed command with one failed line and makes no call', async () => {
    const net = fakeNet(() => { throw new Error('no call expected'); });
    const out = await runLines([`/soak-medusa send ${NONCE} soak-a`], { env: ENV, fetch: net.fetch });
    assert.match(out, new RegExp(`^${stub.PROMPT}soak-medusa ${NONCE} send failed reason=BAD_COMMAND$`, 'm'));
    assert.equal(net.calls.length, 0);
  });
});

describe('soak stub engine — the in-pane switchboard client: identity', () => {
  it('sends only this pane\'s launch binding, read from its env: no cookie, CSRF, bearer or Operator header', async () => {
    const { line, calls } = await handle(SEND);
    assert.equal(line, `soak-medusa ${NONCE} send ok id=${MSG_ID}`);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /api/tc/whoami', 'POST /api/sessions/soak%20a/medusa/send']);
    for (const c of calls) {
      assert.equal(c.headers['x-tangleclaw-launch-id'], LAUNCH);
      assert.equal(c.headers['x-tangleclaw-project-id'], '42');
      for (const h of ['cookie', 'x-csrf-token', 'authorization', 'x-tangleclaw-role']) assert.equal(c.headers[h], undefined, `${c.path} carried ${h}`);
      assert.equal(c.redirect, 'manual', 'a redirect is never followed');
      assert.equal(c.url.origin, API);
    }
  });

  it('reads the env at the moment of the call, not when the program started', async () => {
    const env = { ...ENV };
    const net = fakeServer();
    const p = stub.handleMedusa(stub.parseMedusaLine(SEND), env, { fetch: net.fetch });
    env.TANGLECLAW_LAUNCH_ID = 'changed-later';
    await p;
    assert.equal(net.calls[0].headers['x-tangleclaw-launch-id'], LAUNCH);
    await stub.handleMedusa(stub.parseMedusaLine(SEND), env, { fetch: net.fetch });
    assert.equal(net.calls.at(-1).headers['x-tangleclaw-launch-id'], 'changed-later');
  });

  it('asks whoami as a side lookup, for this pane\'s own project and workspace', async () => {
    const { calls } = await handle(SEND);
    assert.equal(calls[0].headers['x-tangleclaw-aux'], '1');
    assert.equal(calls[0].query, '?projectId=42&workspaceId=ws-soak-a');
    assert.equal(calls[1].headers['x-tangleclaw-aux'], undefined, 'the switchboard call itself is not a side lookup');
  });

  for (const [what, env, reason] of [
    ['no TANGLECLAW_API', { ...ENV, TANGLECLAW_API: undefined }, 'NO_API'],
    ['a TANGLECLAW_API that is not http(s)', { ...ENV, TANGLECLAW_API: 'file:///etc/passwd' }, 'NO_API'],
    ['an unparseable TANGLECLAW_API', { ...ENV, TANGLECLAW_API: 'not a url' }, 'NO_API'],
    ['no TANGLECLAW_LAUNCH_ID', { ...ENV, TANGLECLAW_LAUNCH_ID: '' }, 'NO_BINDING'],
    ['no TANGLECLAW_PROJECT_ID', { ...ENV, TANGLECLAW_PROJECT_ID: undefined }, 'NO_BINDING'],
    ['no TANGLECLAW_WORKSPACE_ID', { ...ENV, TANGLECLAW_WORKSPACE_ID: undefined }, 'NO_BINDING']
  ]) {
    it(`fails closed with no call at all on ${what}`, async () => {
      for (const line of [SEND, READ]) {
        const net = fakeNet(() => { throw new Error('no call expected'); });
        const { line: out } = await handle(line, net, env);
        assert.match(out, new RegExp(`^soak-medusa ${NONCE} (send|read) failed reason=${reason}$`));
        assert.equal(net.calls.length, 0);
      }
    });
  }

  it('calls only TANGLECLAW_API\'s own origin, whatever path the API value carries', async () => {
    const { calls } = await handle(SEND, {}, { ...ENV, TANGLECLAW_API: `${API}/some/path?x=1` });
    assert.ok(calls.every((c) => c.url.origin === API && c.url.pathname.startsWith('/api/')));
  });

  const whoamiCases = [
    ['an unbound binding', { ...WHOAMI_OK, binding: { state: 'unbound', projectId: null } }, 'BINDING_UNVERIFIED state=unbound'],
    ['a stale binding', { ...WHOAMI_OK, binding: { state: 'stale', projectId: 42 } }, 'BINDING_UNVERIFIED state=stale'],
    ['an unknown binding', { ...WHOAMI_OK, binding: { state: 'unknown', projectId: null } }, 'BINDING_UNVERIFIED state=unknown'],
    ['a state it does not know', { ...WHOAMI_OK, binding: { state: 'Verified!', projectId: 42 } }, 'BINDING_UNVERIFIED state=?'],
    ['a verified binding of another project', { ...WHOAMI_OK, binding: { state: 'verified', projectId: 7 } }, 'WRONG_PROJECT'],
    ['another project id', { ...WHOAMI_OK, project: { id: 7, name: 'soak a' } }, 'WRONG_PROJECT'],
    ['another project name than the route\'s', { ...WHOAMI_OK, project: { id: 42, name: 'soak b' } }, 'WRONG_PROJECT'],
    ['no project', { ...WHOAMI_OK, project: null }, 'WRONG_PROJECT'],
    ['no workspace', { ...WHOAMI_OK, workspaceId: null }, 'WRONG_PROJECT'],
    ['another workspace', { ...WHOAMI_OK, workspaceId: 'ws-soak-b' }, 'WRONG_PROJECT'],
    ['no binding', { ...WHOAMI_OK, binding: undefined }, 'WHOAMI_FAILED']
  ];
  for (const [what, body, tail] of whoamiCases) {
    it(`refuses, with no switchboard call, when whoami reports ${what}`, async () => {
      for (const line of [SEND, READ]) {
        const { line: out, calls } = await handle(line, { whoami: () => ({ status: 200, body }) });
        assert.match(out, new RegExp(`^soak-medusa ${NONCE} (send|read) failed reason=${tail.replace('?', '\\?')}$`));
        assert.deepEqual(calls.map((c) => c.path), ['/api/tc/whoami']);
      }
    });
  }

  for (const [what, reply, reason] of [
    ['answers 500', { status: 500, body: {} }, 'WHOAMI_FAILED'],
    ['answers a non-JSON body', { status: 200, text: '<html>' }, 'BAD_BODY'],
    ['answers an empty body', { status: 200, text: '' }, 'WHOAMI_FAILED'],
    ['redirects', { status: 307, body: {} }, 'REDIRECT_REFUSED'],
    ['cannot be reached', new Error('ECONNREFUSED'), 'NETWORK']
  ]) {
    it(`refuses, with no switchboard call, when whoami ${what}`, async () => {
      const { line, calls } = await handle(SEND, { whoami: () => reply });
      // A whoami that gave no usable verdict is WHOAMI_FAILED, whatever stopped it.
      assert.equal(line, `soak-medusa ${NONCE} send failed reason=WHOAMI_FAILED`, reason);
      assert.deepEqual(calls.map((c) => c.path), ['/api/tc/whoami']);
    });
  }
});

describe('soak stub engine — the in-pane switchboard client: send', () => {
  it('sends the tagged message and the request id to the named workspace', async () => {
    const { calls } = await handle(SEND);
    assert.deepEqual(calls[1].body, { to: 'ws-soak-b', message: 'soak medusa-cycle e41-tag9', requestId: 'soak-medusa-abcdef0123456789-1-41' });
    const { calls: bare } = await handle(`/soak-medusa send ${NONCE} soak%20a ws-soak-b e41-tag9`);
    assert.equal(bare[1].body.requestId, undefined);
  });

  for (const [what, reply, tail] of [
    ['no binding', { status: 403, body: { code: 'LAUNCH_BINDING_REQUIRED' } }, 'refused status=403 code=LAUNCH_BINDING_REQUIRED'],
    ['an invalid binding (another project\'s id with this launch)', { status: 403, body: { code: 'LAUNCH_BINDING_INVALID', reason: 'project-mismatch' } }, 'refused status=403 code=LAUNCH_BINDING_INVALID'],
    ['a resent request id', { status: 409, body: { code: 'SEND_ALREADY_ATTEMPTED' } }, 'refused status=409 code=SEND_ALREADY_ATTEMPTED'],
    ['a refusal with no code', { status: 502, body: {} }, 'refused status=502 code=HTTP_STATUS'],
    ['a refusal whose code is not a code', { status: 400, body: { code: 'x y\nLAUNCH' } }, 'refused status=400 code=HTTP_STATUS'],
    ['no message id', { status: 200, body: {} }, 'failed reason=BAD_BODY'],
    ['a message id that is not an id', { status: 200, body: { id: 'a b' } }, 'failed reason=BAD_BODY'],
    ['a redirect', { status: 302, body: {} }, 'failed reason=REDIRECT_REFUSED'],
    ['a timeout', Object.assign(new Error('t'), { name: 'TimeoutError' }), 'failed reason=TIMEOUT']
  ]) {
    it(`prints ${tail} for ${what}, carrying the server's code unchanged`, async () => {
      const { line } = await handle(SEND, { send: () => reply });
      assert.equal(line, `soak-medusa ${NONCE} send ${tail}`);
    });
  }
});

describe('soak stub engine — the in-pane switchboard client: read', () => {
  it('reads its own inbox, marks only the tagged message handled, and prints its id', async () => {
    const { line, calls } = await handle(READ);
    assert.equal(line, `soak-medusa ${NONCE} read ok id=${MSG_ID}`);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /api/tc/whoami', 'GET /api/sessions/soak%20a/medusa/messages', 'POST /api/sessions/soak%20a/medusa/read']);
    assert.deepEqual(calls[2].body, { ids: [MSG_ID] });
    assert.ok(calls.every((c) => c.headers['x-tangleclaw-launch-id'] === LAUNCH));
  });

  it('matches the tag as a whole word, never a prefix of another message\'s tag', async () => {
    const { line } = await handle(READ, { messages: () => ({ status: 200, body: { messages: [{ id: 'm-other', message: 'soak medusa-cycle e41-tag99' }] } }) });
    assert.equal(line, `soak-medusa ${NONCE} read failed reason=NOT_DELIVERED`);
  });

  it('waits for the message, then reports NOT_DELIVERED and marks nothing when the wait runs out', async () => {
    const late = await handle(READ, { messages: (n) => ({ status: 200, body: { messages: n < 3 ? [] : [{ id: MSG_ID, message: 'soak medusa-cycle e41-tag9' }] } }) });
    assert.equal(late.line, `soak-medusa ${NONCE} read ok id=${MSG_ID}`);
    assert.equal(late.calls.filter((c) => c.path.endsWith('/messages')).length, 3);

    const never = await handle(READ, { messages: () => ({ status: 200, body: { messages: [] } }) });
    assert.equal(never.line, `soak-medusa ${NONCE} read failed reason=NOT_DELIVERED`);
    assert.equal(never.calls.some((c) => c.path.endsWith('/read')), false);
    assert.equal(never.clock.slept.reduce((a, b) => a + b, 0), stub.READ_WAIT_MS, 'the whole wait, and not more');
  });

  for (const [what, over, tail] of [
    ['a refused inbox read', { messages: () => ({ status: 403, body: { code: 'LAUNCH_BINDING_INVALID' } }) }, 'refused status=403 code=LAUNCH_BINDING_INVALID'],
    ['an inbox with no list', { messages: () => ({ status: 200, body: {} }) }, 'failed reason=BAD_BODY'],
    ['a tagged message with no usable id', { messages: () => ({ status: 200, body: { messages: [{ id: 5, message: 'soak medusa-cycle e41-tag9' }] } }) }, 'failed reason=BAD_BODY'],
    ['a refused mark-handled', { read: () => ({ status: 403, body: { code: 'LAUNCH_BINDING_REQUIRED' } }) }, 'refused status=403 code=LAUNCH_BINDING_REQUIRED'],
    ['an unreachable mark-handled', { read: () => new Error('reset') }, 'failed reason=NETWORK']
  ]) {
    it(`prints ${tail} for ${what}`, async () => {
      const { line } = await handle(READ, over);
      assert.equal(line, `soak-medusa ${NONCE} read ${tail}`);
    });
  }
});

describe('soak stub engine — the in-pane switchboard client: what it prints', () => {
  it('prints one result line per command, after the ordinary answers keep their count', async () => {
    const net = fakeServer();
    const out = await runLines(['soak ping 1', SEND, 'soak ping 2', READ], { env: ENV, fetch: net.fetch, ...fakeClock() });
    const lines = out.split('\n');
    assert.equal(lines.filter((l) => l.includes(`soak-medusa ${NONCE} send`)).length, 1);
    assert.equal(lines.filter((l) => l.includes(`soak-medusa ${NONCE} read`)).length, 1);
    assert.ok(lines.includes(`${stub.PROMPT}${stub.answer(2, 'soak ping 2')}`), 'a switchboard line does not use up an ack number');
  });

  it('never prints a launch id, a project id, a workspace id or a message body', async () => {
    const outs = [];
    for (const over of [{}, { send: () => ({ status: 403, body: { code: 'LAUNCH_BINDING_INVALID', error: LAUNCH } }) }, { whoami: () => ({ status: 200, body: { ...WHOAMI_OK, workspaceId: 'x' } }) }]) {
      const net = fakeServer(over);
      outs.push(await runLines([SEND, READ], { env: ENV, fetch: net.fetch, ...fakeClock() }));
    }
    const all = outs.join('\n');
    for (const secret of [LAUNCH, 'ws-soak-a', 'soak medusa-cycle', '42']) assert.equal(all.includes(secret), false, secret);
  });

  it('keeps every result line short enough that an 80-column pane does not wrap it', async () => {
    // The prompt shares the result's row on the pane, so it counts too.
    const fits = (line) => assert.ok(stub.PROMPT.length + line.length < 80, line);
    fits((await handle(SEND, { send: () => ({ status: 409, body: { code: 'SEND_ALREADY_ATTEMPTED' } }) })).line);
    fits((await handle(SEND, { send: () => ({ status: 403, body: { code: 'LAUNCH_BINDING_REQUIRED' } }) })).line);
    fits((await handle(READ)).line);
    fits((await handle(READ, { whoami: () => ({ status: 200, body: { ...WHOAMI_OK, binding: { state: 'unbound' } } }) })).line);
  });

  it('waits for an in-flight switchboard call before it exits', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const net = fakeServer({ send: () => ({ status: 200, body: { id: MSG_ID } }) });
    const slowFetch = async (url, init) => { if (url.pathname.endsWith('/send')) await gate; return net.fetch(url, init); };
    const outP = runLines([SEND, '/exit'], { env: ENV, fetch: slowFetch });
    setImmediate(release);
    assert.match(await outP, new RegExp(`soak-medusa ${NONCE} send ok id=${MSG_ID}`));
  });
});
