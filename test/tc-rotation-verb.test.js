'use strict';

/*
 * #2032: the `tc rotation` client. Prepare sends the checkpoint file under a
 * key derived from its content (so a retried prepare converges); resume sends
 * the receipt with the rotation's own id, attempt key and generation read back
 * from the server, never typed by hand; show gives the replacement context its
 * checkpoint, the inbox interval to handle and the receipt shape.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { VERB_ROSTER, receiptVerbLabel, renderRotation, renderLaneLine } = require('../lib/tc-verbs');

const verb = VERB_ROSTER.find((v) => v.id === 'rotation');

const ROTATION = {
  rotationId: 'rot_abc', attemptKey: 'ck-1234567890', state: 'reconciling', fenced: true, generation: 2,
  priorThreadId: 'old', replacementThreadId: 'new', checkpointDigest: 'd'.repeat(64),
  inboxIds: ['m-1'], failure: null, checkpoint: { schema: 1, role: 'architect', note: 'n' }
};

/**
 * A fake `tc` context that records requests and serves files from a map.
 * @param {string[]} argv - Arguments after `tc rotation`
 * @param {object} [files] - Path → contents
 * @param {object} [reply] - What the fake server answers
 * @returns {{ctx: object, calls: object[]}}
 */
function fakeCtx(argv, files = {}, reply = { rotation: ROTATION, generation: 1 }) {
  const calls = [];
  return {
    calls,
    ctx: {
      argv,
      env: {},
      readFile: (p) => {
        if (!(p in files)) throw new Error('ENOENT');
        return files[p];
      },
      getJson: async (p) => { calls.push({ method: 'GET', path: p }); return reply; },
      postJson: async (p, body) => { calls.push({ method: 'POST', path: p, body }); return reply; }
    }
  };
}

describe('tc rotation (#2032)', () => {
  it('is on the roster and records its subverb in the receipt label', () => {
    assert.ok(verb);
    for (const sub of ['prepare', 'show', 'advance', 'resume']) assert.equal(receiptVerbLabel('rotation', [sub]), `rotation.${sub}`);
  });

  it('prepare sends the checkpoint under a key derived from its content, the same key every time', async () => {
    const files = { '/tmp/cp.json': '{"schema":1,"role":"architect"}' };
    const a = fakeCtx(['prepare', '--checkpoint', '/tmp/cp.json'], files);
    const b = fakeCtx(['prepare', '--checkpoint', '/tmp/cp.json'], files);
    assert.equal((await verb.run(a.ctx)).code, 0);
    await verb.run(b.ctx);
    assert.equal(a.calls[0].path, '/api/tc/rotation/prepare');
    assert.deepEqual(a.calls[0].body.checkpoint, { schema: 1, role: 'architect' });
    assert.match(a.calls[0].body.attemptKey, /^ck-[0-9a-f]{40}$/);
    assert.equal(a.calls[0].body.attemptKey, b.calls[0].body.attemptKey);
    const keyed = fakeCtx(['prepare', '--checkpoint', '/tmp/cp.json', '--key', 'my-key-0001'], files);
    await verb.run(keyed.ctx);
    assert.equal(keyed.calls[0].body.attemptKey, 'my-key-0001');
  });

  it('resume reads the rotation back and sends its own identity with the receipt', async () => {
    const f = fakeCtx(['resume', '--receipt', '/tmp/r.json'], { '/tmp/r.json': '{"schema":1,"resumeNonce":"n-1"}' });
    const out = await verb.run(f.ctx);
    assert.equal(out.code, 0);
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), ['GET /api/tc/rotation', 'POST /api/tc/rotation/resume']);
    assert.deepEqual(f.calls[1].body, { rotationId: 'rot_abc', attemptKey: 'ck-1234567890', generation: 2, resumeNonce: 'n-1', receipt: { schema: 1 } },
      'the nonce travels beside the receipt, never inside it');
  });

  it('refuses a malformed invocation, a missing file and a non-JSON file before any request', async () => {
    for (const argv of [[], ['nope'], ['prepare'], ['resume'], ['prepare', '--checkpoint'], ['show', '--bogus', 'x']]) {
      const f = fakeCtx(argv);
      assert.equal((await verb.run(f.ctx)).code, 1, argv.join(' '));
      assert.equal(f.calls.length, 0);
    }
    const missing = fakeCtx(['prepare', '--checkpoint', '/nope.json']);
    assert.match((await verb.run(missing.ctx)).stderr, /could not read/);
    const bad = fakeCtx(['resume', '--receipt', '/bad.json'], { '/bad.json': 'not json' });
    assert.match((await verb.run(bad.ctx)).stderr, /not JSON/);
    assert.equal(bad.calls.length, 0);
  });

  it('a rotating lane says so in tc sessions, with its blocker and next command (A13)', () => {
    const lane = { composed: { availability: 'WORKING', clearance: 'do-not-clear' }, workload: {}, engine: {},
      rotation: { state: 'reconciling', generation: 2, blocker: 'waiting for the receipt', nextCommand: 'tc rotation resume --receipt <file>' } };
    assert.match(renderLaneLine(lane), /ROTATING \(reconciling, generation 2\): waiting for the receipt — next: tc rotation resume/);
    assert.doesNotMatch(renderLaneLine({ ...lane, rotation: undefined }), /ROTATING/);
  });

  it('show gives a reconciling context its checkpoint, the messages to handle and a receipt template carrying the digest', () => {
    const text = renderRotation({ rotation: ROTATION, generation: 1 });
    assert.match(text, /reconciling \(new dispatch FENCED\), generation 2/);
    assert.match(text, /- m-1/);
    assert.match(text, /"role": "architect"/);
    assert.match(text, new RegExp(`"checkpointDigest": "${'d'.repeat(64)}"`));
    assert.match(text, /tc rotation resume --receipt/);
    const drifted = renderRotation({ rotation: { ...ROTATION, drift: { integrity: [], unavailable: [], trusted: [{ key: 'github:o/r#pr5' }] },
      readiness: { verdict: 'not-ready', reason: 'No workload receipt has been published.' } } });
    assert.match(drifted, /drift to dispose of in the receipt: github:o\/r#pr5/);
    assert.match(drifted, /readiness: No workload receipt/);
    assert.match(renderRotation({ rotation: { ...ROTATION, drift: { integrity: [{ key: 'checkout.head' }], unavailable: [], trusted: [] } } }),
      /integrity drift \(operator recovery required\): checkout.head/);
    assert.match(renderRotation({ rotation: null, generation: 3 }), /No coordinator rotation is in progress .*generation 3/);
    assert.match(renderRotation({ rotation: { ...ROTATION, state: 'rebinding', failure: { code: 'prior-thread-busy', detail: 'waiting' } } }),
      /waiting on: prior-thread-busy/);
  });
});

describe('bin/tc forwards the engine thread (#2032, ruling A11)', () => {
  const http = require('node:http');
  const path = require('node:path');
  const { execFile } = require('node:child_process');

  /**
   * Run bin/tc against a server that records request headers.
   * @param {object} env - Extra environment.
   * @returns {Promise<object[]>} The headers of each request received.
   */
  async function headersSeen(env) {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ rotation: null, generation: 0 }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = { PATH: process.env.PATH, HOME: process.env.HOME, TANGLECLAW_API: `http://127.0.0.1:${server.address().port}` };
      await new Promise((resolve) => execFile(path.join(__dirname, '..', 'bin', 'tc'), ['rotation', 'show'], { env: { ...base, ...env } }, () => resolve()));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    return seen;
  }

  it('sends CODEX_THREAD_ID as x-tangleclaw-engine-thread, and nothing when it is unset', async () => {
    const withThread = await headersSeen({ CODEX_THREAD_ID: '01a0-thread' });
    assert.equal(withThread[0]['x-tangleclaw-engine-thread'], '01a0-thread');
    const without = await headersSeen({});
    assert.equal(without[0]['x-tangleclaw-engine-thread'], undefined);
  });
});
