'use strict';

/*
 * v6 (#2994, V6-24 / D3, Car V61-W1-B): the open-weight qualification
 * harness (`lib/v6/d3-openweight-qualification.js`). Large tier: the tool
 * wrapper cases spawn a child `node`, and the provider adapter cases listen
 * on a loopback socket.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');

const {
  ROLES, PROVIDERS, TOOLS, GATES, MIN_TOKENS_PER_SECOND, DEFAULT_MEMORY_CEILING_BYTES, MIN_WINDOW_TOKENS,
  localEndpoint, makeProbe, evaluateProbe, invokeLocal, invokeTool, qualifyFleet
} = require('../lib/v6/d3-openweight-qualification');

/** A Builder probe with a fixed nonce. */
const probe = () => makeProbe('Builder', { sessionId: 's', generation: 7, windowTokens: 512, nonce: 'N' });

/**
 * A complete, passing observation for `p`.
 * @param {object} p
 * @returns {object}
 */
function good(p) {
  return {
    response: { diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b', retained: [p.early, p.late] },
    launchAttestation: { sessionId: p.sessionId, generation: p.generation, nonce: p.nonce },
    toolEvents: [{ type: 'reply', inReplyTo: p.messageId }, { type: 'ack', messageId: p.messageId }],
    outputTokens: 100, durationMs: 1000, peakMemoryBytes: 1024, promptTokens: p.windowTokens
  };
}

/** Evaluate a passing observation with `change` applied. */
const verdict = (change = {}) => { const p = probe(); return evaluateProbe(p, Object.assign(good(p), change)); };

/**
 * Serve one JSON body on a loopback port for the duration of `fn`.
 * @param {(req: object) => object} handler - Returns the JSON body.
 * @param {(base: string, seen: object[]) => Promise<void>} fn
 */
async function withServer(handler, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body) });
      const out = handler(req);
      res.statusCode = out.status || 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out.json || {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('published constants', () => {
  it('enumerates six roles, two providers, two tools and six gates', () => {
    assert.deepEqual([...ROLES], ['Builder', 'PR Reviewer', 'Integrator', 'Observer', 'Architect', 'PM']);
    assert.deepEqual([...PROVIDERS], ['ollama', 'vllm']);
    assert.deepEqual([...TOOLS], ['aider', 'openclaw']);
    assert.deepEqual([...GATES], ['toolDiff', 'launchAttestation', 'medusaProtocol', 'contextRetention', 'throughput', 'memoryCeiling']);
  });

  it('publishes a throughput floor for every role, and the 8 GiB / 512-token defaults', () => {
    assert.deepEqual(Object.keys(MIN_TOKENS_PER_SECOND).sort(), [...ROLES].sort());
    assert.ok(Object.values(MIN_TOKENS_PER_SECOND).every((v) => Number.isFinite(v) && v > 0));
    assert.equal(DEFAULT_MEMORY_CEILING_BYTES, 8 * 1024 ** 3);
    assert.equal(MIN_WINDOW_TOKENS, 512);
  });
});

describe('localEndpoint', () => {
  it('accepts loopback http(s) only', () => {
    for (const ok of ['http://127.0.0.1:11434', 'http://localhost:8000', 'https://[::1]:8000']) {
      assert.equal(localEndpoint(ok).protocol.startsWith('http'), true, ok);
    }
    for (const bad of ['https://example.com', 'http://10.0.0.5:11434', 'ftp://127.0.0.1', 'not a url',
      'http://user:pw@127.0.0.1:1', 'http://127.0.0.1.example.com']) {
      assert.throws(() => localEndpoint(bad), /LOCAL_ENDPOINT_REQUIRED/, bad);
    }
  });
});

describe('makeProbe', () => {
  it('places the early marker before the late one, around the filler', () => {
    const p = probe();
    // The markers are also named in the instruction text near the start;
    // anchor on the phrases that place them around the filler.
    const early = p.prompt.indexOf(`Early marker ${p.early}`);
    const late = p.prompt.indexOf(`Late marker ${p.late}`);
    assert.ok(early > 0 && early < p.prompt.indexOf('context filler'));
    assert.ok(p.prompt.lastIndexOf('context filler') < late);
    assert.equal(p.messageId, 'medusa:N');
  });

  it('refuses an unknown role, missing session, non-integer generation, and a small window', () => {
    assert.throws(() => makeProbe('Janitor', { sessionId: 's', generation: 1 }), TypeError);
    assert.throws(() => makeProbe('Builder', { generation: 1 }), TypeError);
    assert.throws(() => makeProbe('Builder', { sessionId: 's', generation: 1.5 }), TypeError);
    assert.throws(() => makeProbe('Builder', { sessionId: 's', generation: 1, windowTokens: 10 }), TypeError);
  });

  it('mints a fresh nonce when none is given', () => {
    const a = makeProbe('PM', { sessionId: 's', generation: 1 });
    const b = makeProbe('PM', { sessionId: 's', generation: 1 });
    assert.notEqual(a.nonce, b.nonce);
  });
});

describe('evaluateProbe — the six gates', () => {
  it('passes every gate on a complete observation', () => {
    const p = probe();
    const result = evaluateProbe(p, good(p));
    assert.equal(result.passed, true);
    assert.deepEqual(GATES.map((g) => result.gates[g]), Array(6).fill(true));
    assert.deepEqual(result.unknownMetrics, []);
    assert.equal(result.metrics.tokensPerSecond, 100);
  });

  it('accepts the response as a JSON string too', () => {
    const p = probe();
    const obs = good(p);
    obs.response = JSON.stringify(obs.response);
    assert.equal(evaluateProbe(p, obs).passed, true);
  });

  it('toolDiff fails on prose that only looks like a diff, and on unparseable JSON', () => {
    const p = probe();
    const obs = good(p);
    obs.response.diff = 'looks like a diff';
    assert.equal(evaluateProbe(p, obs).gates.toolDiff, false);
    assert.equal(verdict({ response: '{not json' }).gates.toolDiff, false);
  });

  it('launchAttestation fails on a wrong nonce, generation, or session, and on none at all', () => {
    for (const change of [{ nonce: 'X' }, { generation: 6 }, { sessionId: 'other' }]) {
      const p = probe();
      const obs = good(p);
      Object.assign(obs.launchAttestation, change);
      assert.equal(evaluateProbe(p, obs).gates.launchAttestation, false, JSON.stringify(change));
    }
    assert.equal(verdict({ launchAttestation: undefined }).gates.launchAttestation, false);
  });

  it('a model CLAIMING attestation and a Medusa reply in its text does not pass gates 2 and 3', () => {
    const p = probe();
    const obs = good(p);
    obs.response.launchAttestation = obs.launchAttestation;
    obs.response.toolEvents = obs.toolEvents;
    delete obs.launchAttestation;
    delete obs.toolEvents;
    const result = evaluateProbe(p, obs);
    assert.equal(result.gates.launchAttestation, false);
    assert.equal(result.gates.medusaProtocol, false);
  });

  it('medusaProtocol fails on ack-before-reply, a reply to another message, or a missing ack', () => {
    const p = probe();
    const reversed = good(p);
    reversed.toolEvents.reverse();
    assert.equal(evaluateProbe(p, reversed).gates.medusaProtocol, false);
    const wrong = good(p);
    wrong.toolEvents[0].inReplyTo = 'other';
    assert.equal(evaluateProbe(p, wrong).gates.medusaProtocol, false);
    assert.equal(verdict({ toolEvents: [{ type: 'reply', inReplyTo: 'medusa:N' }] }).gates.medusaProtocol, false);
  });

  it('contextRetention fails on a lost marker or a prompt shorter than the window', () => {
    const p = probe();
    const early = good(p);
    early.response.retained.shift();
    assert.equal(evaluateProbe(p, early).gates.contextRetention, false);
    const late = good(p);
    late.response.retained.pop();
    assert.equal(evaluateProbe(p, late).gates.contextRetention, false);
    assert.equal(verdict({ promptTokens: 10 }).gates.contextRetention, false);
  });

  it('throughput fails under the role floor, and an unmeasured throughput fails and is named', () => {
    assert.equal(verdict({ durationMs: 100000 }).gates.throughput, false);
    const missing = verdict({ outputTokens: undefined });
    assert.equal(missing.gates.throughput, false);
    assert.ok(missing.unknownMetrics.includes('throughput'));
    assert.equal(verdict({ durationMs: 0 }).gates.throughput, false);
  });

  it('memoryCeiling fails above the ceiling, and an unmeasured memory fails the whole role', () => {
    assert.equal(verdict({ peakMemoryBytes: 9 * 1024 ** 3 }).gates.memoryCeiling, false);
    const missing = verdict({ peakMemoryBytes: undefined });
    assert.equal(missing.passed, false);
    assert.ok(missing.unknownMetrics.includes('memoryCeiling'));
    assert.equal(missing.metrics.peakMemoryBytes, null);
    const p = probe();
    assert.equal(evaluateProbe(p, good(p), { memoryCeilingBytes: 512 }).gates.memoryCeiling, false);
  });

  it('a null observation fails every gate rather than throwing', () => {
    const result = evaluateProbe(probe(), null);
    assert.equal(result.passed, false);
    assert.ok(GATES.every((g) => result.gates[g] === false));
    assert.deepEqual(result.unknownMetrics, ['throughput', 'memoryCeiling']);
  });
});

describe('qualifyFleet', () => {
  const config = { provider: 'ollama', tool: 'aider', model: 'local', sessionId: 's', generation: 7 };

  it('qualifies a fleet only when every role passes', async () => {
    const result = await qualifyFleet(config, { invoke: async (x) => good(x.probe), memoryProbe: async () => 1024 });
    assert.equal(result.qualified, true);
    assert.deepEqual(result.roles.map((r) => r.role), [...ROLES]);
  });

  it('one failed role disqualifies the fleet', async () => {
    const result = await qualifyFleet({ ...config, provider: 'vllm', tool: 'openclaw' }, {
      invoke: async (x) => { const y = good(x.probe); if (x.role === 'PM') y.response.retained = []; return y; },
      memoryProbe: async () => 1024
    });
    assert.equal(result.qualified, false);
    assert.deepEqual(result.roles.filter((r) => !r.passed).map((r) => r.role), ['PM']);
  });

  it('a role whose invocation throws is recorded as failed with its error; the rest still run', async () => {
    const seen = [];
    const result = await qualifyFleet(config, {
      invoke: async (x) => { seen.push(x.role); if (x.role === 'Observer') throw new Error('LOCAL_PROVIDER_HTTP_500'); return good(x.probe); },
      memoryProbe: async () => 1024
    });
    assert.deepEqual(seen, [...ROLES]);
    const observer = result.roles.find((r) => r.role === 'Observer');
    assert.equal(observer.passed, false);
    assert.equal(observer.error, 'LOCAL_PROVIDER_HTTP_500');
    assert.equal(result.qualified, false);
  });

  it('uses the memory probe\'s reading over the wrapper\'s', async () => {
    const result = await qualifyFleet({ ...config, memoryCeilingBytes: 2048 }, {
      invoke: async (x) => good(x.probe), memoryProbe: async () => 4096
    });
    assert.equal(result.qualified, false);
    assert.equal(result.roles[0].metrics.peakMemoryBytes, 4096);
  });

  it('refuses an invalid configuration and a non-loopback endpoint', async () => {
    await assert.rejects(() => qualifyFleet({ ...config, provider: 'openai' }), TypeError);
    await assert.rejects(() => qualifyFleet({ ...config, tool: 'cursor' }), TypeError);
    await assert.rejects(() => qualifyFleet(null), TypeError);
    await assert.rejects(() => qualifyFleet({ ...config, endpoint: 'https://example.com' }), /LOCAL_ENDPOINT_REQUIRED/);
  });
});

describe('invokeLocal — provider adapters over loopback HTTP', () => {
  it('refuses a remote endpoint and an unknown provider before any request', async () => {
    await assert.rejects(() => invokeLocal({ provider: 'ollama', model: 'm', endpoint: 'https://example.com', prompt: 'p' }), /LOCAL_ENDPOINT_REQUIRED/);
    await assert.rejects(() => invokeLocal({ provider: 'tgi', model: 'm', endpoint: 'http://127.0.0.1:1', prompt: 'p' }), TypeError);
  });

  it('Ollama reads eval_count, prompt_eval_count and eval_duration', async () => {
    await withServer(() => ({ json: { response: '{}', eval_count: 42, prompt_eval_count: 110, eval_duration: 2e9 } }), async (base, seen) => {
      const x = await invokeLocal({ provider: 'ollama', model: 'm', endpoint: base, prompt: 'p' });
      assert.deepEqual(x, { response: '{}', outputTokens: 42, promptTokens: 110, durationMs: 2000 });
      assert.equal(seen[0].url, '/api/generate');
      assert.deepEqual(seen[0].body, { model: 'm', prompt: 'p', stream: false, format: 'json' });
    });
  });

  it('vLLM reads OpenAI-compatible usage', async () => {
    await withServer(() => ({ json: { choices: [{ message: { content: '{}' } }], usage: { completion_tokens: 25, prompt_tokens: 70 } } }), async (base, seen) => {
      const x = await invokeLocal({ provider: 'vllm', model: 'm', endpoint: base, prompt: 'p' });
      assert.equal(x.outputTokens, 25);
      assert.equal(x.promptTokens, 70);
      assert.ok(x.durationMs >= 0);
      assert.equal(seen[0].url, '/v1/chat/completions');
    });
  });

  it('a non-2xx answer is an error naming the status', async () => {
    await withServer(() => ({ status: 503, json: {} }), async (base) => {
      await assert.rejects(() => invokeLocal({ provider: 'ollama', model: 'm', endpoint: base, prompt: 'p' }), /LOCAL_PROVIDER_HTTP_503/);
    });
  });
});

describe('invokeTool — JSON wrapper subprocess', () => {
  const echo = "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const r=JSON.parse(s);process.stdout.write(JSON.stringify({tool:r.tool,prompt:r.prompt}))})";

  it('sends the request on stdin with no shell, so shell syntax stays inert', async () => {
    const marker = path.join(os.tmpdir(), `d3-never-${process.pid}`);
    const x = await invokeTool({ tool: 'aider', executable: process.execPath, args: ['-e', echo], request: { prompt: `$(touch ${marker})` } });
    assert.deepEqual(x, { tool: 'aider', prompt: `$(touch ${marker})` });
    assert.equal(fs.existsSync(marker), false);
  });

  it('the request cannot override the tool it is sent with', async () => {
    const x = await invokeTool({ tool: 'openclaw', executable: process.execPath, args: ['-e', echo], request: { tool: 'aider' } });
    assert.equal(x.tool, 'openclaw');
  });

  it('refuses an unknown tool, a relative executable, and non-string args', async () => {
    await assert.rejects(() => invokeTool({ tool: 'cursor', executable: process.execPath }), TypeError);
    await assert.rejects(() => invokeTool({ tool: 'aider', executable: 'node' }), TypeError);
    await assert.rejects(() => invokeTool({ tool: 'aider', executable: process.execPath, args: [1] }), TypeError);
  });

  it('a non-zero exit rejects with the code and stderr', async () => {
    await assert.rejects(
      () => invokeTool({ tool: 'aider', executable: process.execPath, args: ['-e', "process.stderr.write('bad model');process.exit(3)"] }),
      /TOOL_EXIT_3: bad model/
    );
  });

  it('non-JSON output rejects', async () => {
    await assert.rejects(
      () => invokeTool({ tool: 'aider', executable: process.execPath, args: ['-e', "process.stdout.write('hello')"] }),
      /TOOL_OUTPUT_NOT_JSON/
    );
  });

  it('a wrapper that exits without reading stdin does not crash the harness', async () => {
    await assert.rejects(
      () => invokeTool({ tool: 'aider', executable: process.execPath, args: ['-e', 'process.exit(5)'], request: { prompt: 'x'.repeat(4 * 1024 * 1024) } }),
      /TOOL_EXIT_5/
    );
  });

  it('a wrapper past its timeout is killed', async () => {
    await assert.rejects(
      () => invokeTool({ tool: 'aider', executable: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'], timeoutMs: 200 }),
      /TOOL_EXIT_SIGKILL/
    );
  });
});
