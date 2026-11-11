'use strict';

/**
 * v6 (#2994, V6-24 / D3, Car V61-W1-B): the open-weight / all-local fleet
 * qualification harness and its tool-call gate.
 *
 * Qualifies a local model (served by Ollama or vLLM on loopback, driven
 * directly or through an Aider/OpenClaw wrapper) for each of the six fleet
 * roles. A role passes only when all six gates pass on one probe:
 *
 * 1. `toolDiff` — the model returned a structurally valid unified diff.
 * 2. `launchAttestation` — the harness OBSERVED the exact session,
 *    generation and nonce attested through the tool hooks.
 * 3. `medusaProtocol` — the harness OBSERVED a reply to the probe's message
 *    id, then an ack of it, in that order.
 * 4. `contextRetention` — the provider reported a prompt at least the
 *    requested window, and the model returned both the early and the late
 *    marker.
 * 5. `throughput` — output tokens per second met the role's published
 *    floor ({@link MIN_TOKENS_PER_SECOND}).
 * 6. `memoryCeiling` — observed peak model memory stayed within the
 *    hardware ceiling.
 *
 * Gates 2 and 3 read harness-instrumented `toolEvents` and
 * `launchAttestation`, never the model's own text: a model claiming it
 * attested or replied does not pass. A missing throughput or memory reading
 * FAILS its gate and is listed in `unknownMetrics` — an unmeasured metric is
 * never a pass. No model is claimed qualified by this module; it runs
 * nothing on its own.
 *
 * Adapted from the PRR-A Phase 5 prototype
 * (`v6-phase5-a-d-sqlite-integration-and-d3-openweight-harness.md`, an ES
 * module) as CommonJS, with these departures, each covered by a test:
 * - {@link invokeTool} requires an absolute executable path, swallows a
 *   stdin EPIPE from a wrapper that exits early (it would otherwise crash
 *   the process), and settles exactly once; the request can no longer
 *   override the `tool` field it is sent with.
 * - {@link qualifyFleet} records a role whose invocation throws as a failed
 *   role carrying the error, instead of abandoning the whole fleet run.
 * - {@link evaluateProbe} treats a missing observation as all gates failed
 *   rather than throwing.
 * The prototype's CLI entry point is not carried over: a runnable command
 * is a `scripts/*` file, outside this car's envelope.
 *
 * @module lib/v6/d3-openweight-qualification
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

/** The six fleet roles a model must qualify for. */
const ROLES = Object.freeze(['Builder', 'PR Reviewer', 'Integrator', 'Observer', 'Architect', 'PM']);

/** Local model servers the harness can call directly. */
const PROVIDERS = Object.freeze(['ollama', 'vllm']);

/** Agent tools the harness can drive through a JSON wrapper. */
const TOOLS = Object.freeze(['aider', 'openclaw']);

/** The published per-role throughput floor, in output tokens per second. */
const MIN_TOKENS_PER_SECOND = Object.freeze({
  Builder: 15, 'PR Reviewer': 12, Integrator: 15, Observer: 8, Architect: 12, PM: 10
});

/** The six gate names, in the order a result lists them. */
const GATES = Object.freeze(['toolDiff', 'launchAttestation', 'medusaProtocol', 'contextRetention', 'throughput', 'memoryCeiling']);

/** Default memory ceiling: 8 GiB. */
const DEFAULT_MEMORY_CEILING_BYTES = 8 * 1024 ** 3;

/** Smallest context window a probe may request. */
const MIN_WINDOW_TOKENS = 512;

/** Output cap per wrapper stream before the child is killed. */
const MAX_WRAPPER_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Hostnames a provider endpoint may name: loopback only. */
const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]']);

/**
 * Parse a provider endpoint, refusing anything but loopback http(s).
 * @param {string} url
 * @returns {URL}
 * @throws {Error} `LOCAL_ENDPOINT_REQUIRED`.
 */
function localEndpoint(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('LOCAL_ENDPOINT_REQUIRED');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !LOOPBACK_HOSTS.includes(parsed.hostname)
      || parsed.username || parsed.password) {
    throw new Error('LOCAL_ENDPOINT_REQUIRED');
  }
  return parsed;
}

/**
 * Build one role's probe: a prompt carrying an early and a late marker
 * around enough filler to fill the requested window, plus the identifiers
 * the harness will look for in the observed tool events.
 * @param {string} role - One of {@link ROLES}.
 * @param {{sessionId: string, generation: number, windowTokens?: number, nonce?: string}} opts
 * @returns {{role: string, sessionId: string, generation: number, windowTokens: number,
 *   early: string, late: string, messageId: string, nonce: string, prompt: string}}
 * @throws {TypeError} On an unknown role, missing session, non-integer generation, or a window under {@link MIN_WINDOW_TOKENS}.
 */
function makeProbe(role, { sessionId, generation, windowTokens = 4096, nonce = randomUUID() } = {}) {
  if (!ROLES.includes(role) || typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(generation)
      || !Number.isSafeInteger(windowTokens) || windowTokens < MIN_WINDOW_TOKENS) {
    throw new TypeError('Invalid qualification probe');
  }
  const early = `early:${nonce}`;
  const late = `late:${nonce}`;
  const messageId = `medusa:${nonce}`;
  const filler = 'context filler '.repeat(windowTokens);
  return {
    role, sessionId, generation, windowTokens, early, late, messageId, nonce,
    prompt: `Role ${role}. Use the qualification tool hooks to attest launch `
      + `{sessionId:"${sessionId}",generation:${generation},nonce:"${nonce}"}; reply to fake Medusa `
      + `message "${messageId}" before acking it. Return JSON with a unified diff in diff `
      + `and retained ["${early}","${late}"]. `
      + `Early marker ${early}. ${filler} Late marker ${late}. No actual side effects.`
  };
}

/**
 * Judge one observation against its probe.
 * @param {ReturnType<typeof makeProbe>} probe
 * @param {{response?: string|object, outputTokens?: number, promptTokens?: number, durationMs?: number,
 *   launchAttestation?: object, toolEvents?: Array<object>, peakMemoryBytes?: number}|null} observation
 * @param {{memoryCeilingBytes?: number}} [opts]
 * @returns {{role: string, passed: boolean, gates: Record<string, boolean>,
 *   metrics: {tokensPerSecond: number|null, peakMemoryBytes: number|null, windowTokens: number|null},
 *   unknownMetrics: string[]}}
 */
function evaluateProbe(probe, observation, { memoryCeilingBytes = DEFAULT_MEMORY_CEILING_BYTES } = {}) {
  const obs = observation && typeof observation === 'object' ? observation : {};
  let data = null;
  try {
    data = typeof obs.response === 'string' ? JSON.parse(obs.response) : obs.response;
  } catch {
    data = null;
  }
  const diff = data && typeof data.diff === 'string' ? data.diff : '';
  const events = Array.isArray(obs.toolEvents) ? obs.toolEvents : [];
  const reply = events.findIndex((e) => e && e.type === 'reply' && e.inReplyTo === probe.messageId);
  const ack = events.findIndex((e, i) => i > reply && e && e.type === 'ack' && e.messageId === probe.messageId);
  const elapsed = obs.durationMs;
  const tps = Number.isFinite(elapsed) && elapsed > 0 && Number.isFinite(obs.outputTokens)
    ? obs.outputTokens / (elapsed / 1000) : null;
  const memory = obs.peakMemoryBytes;
  const attested = obs.launchAttestation || {};
  const gates = {
    toolDiff: /^diff --git a\/[^\n]+ b\/[^\n]+\n[\s\S]*^@@ /m.test(diff),
    launchAttestation: attested.sessionId === probe.sessionId && attested.generation === probe.generation
      && attested.nonce === probe.nonce,
    medusaProtocol: reply >= 0 && ack > reply,
    contextRetention: Number.isFinite(obs.promptTokens) && obs.promptTokens >= probe.windowTokens
      && Boolean(data) && Array.isArray(data.retained) && data.retained.includes(probe.early) && data.retained.includes(probe.late),
    throughput: tps !== null && tps >= MIN_TOKENS_PER_SECOND[probe.role],
    memoryCeiling: Number.isFinite(memory) && memory >= 0 && memory <= memoryCeilingBytes
  };
  return {
    role: probe.role,
    passed: GATES.every((g) => gates[g]),
    gates,
    metrics: {
      tokensPerSecond: tps,
      peakMemoryBytes: Number.isFinite(memory) ? memory : null,
      windowTokens: Number.isFinite(obs.promptTokens) ? obs.promptTokens : null
    },
    unknownMetrics: [...(tps === null ? ['throughput'] : []), ...(!Number.isFinite(memory) ? ['memoryCeiling'] : [])]
  };
}

/**
 * Call a loopback Ollama (`/api/generate`) or vLLM (`/v1/chat/completions`)
 * server directly, reading the provider's own token counters.
 * @param {{provider: string, model: string, endpoint: string, prompt: string, timeoutMs?: number,
 *   fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{response: string, outputTokens: number|undefined, promptTokens: number|undefined, durationMs: number}>}
 * @throws {TypeError|Error} `Unknown provider/model`, `LOCAL_ENDPOINT_REQUIRED`, `LOCAL_PROVIDER_HTTP_<status>`.
 */
async function invokeLocal({ provider, model, endpoint, prompt, timeoutMs = 120000, fetchImpl = fetch }) {
  if (!PROVIDERS.includes(provider) || !model) throw new TypeError('Unknown provider/model');
  const url = localEndpoint(endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const ollama = provider === 'ollama';
    const route = ollama ? '/api/generate' : '/v1/chat/completions';
    const body = ollama
      ? { model, prompt, stream: false, format: 'json' }
      : { model, messages: [{ role: 'user', content: prompt }], stream: false, response_format: { type: 'json_object' } };
    const response = await fetchImpl(new URL(route, url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal
    });
    if (!response.ok) throw new Error(`LOCAL_PROVIDER_HTTP_${response.status}`);
    const json = await response.json();
    const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
    const usage = (json && json.usage) || {};
    return {
      response: ollama ? json.response : (choice && choice.message ? choice.message.content : undefined),
      outputTokens: ollama ? json.eval_count : usage.completion_tokens,
      promptTokens: ollama ? json.prompt_eval_count : usage.prompt_tokens,
      durationMs: ollama && json.eval_duration ? json.eval_duration / 1e6 : performance.now() - start
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run an Aider/OpenClaw JSON wrapper: one JSON request on stdin, one JSON
 * observation on stdout. Spawned with `shell: false`, so no prompt or model
 * text can become shell syntax; killed on timeout or on output past
 * {@link MAX_WRAPPER_OUTPUT_BYTES}.
 * @param {{tool: string, executable: string, args?: string[], request?: object, timeoutMs?: number}} opts
 * @returns {Promise<object>}
 * @throws {TypeError} `Invalid tool adapter` (unknown tool, relative executable, non-array args).
 */
function invokeTool({ tool, executable, args = [], request = {}, timeoutMs = 120000 }) {
  if (!TOOLS.includes(tool) || typeof executable !== 'string' || !path.isAbsolute(executable)
      || !Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
    return Promise.reject(new TypeError('Invalid tool adapter'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; if (out.length > MAX_WRAPPER_OUTPUT_BYTES) child.kill('SIGKILL'); });
    child.stderr.on('data', (chunk) => { err += chunk; if (err.length > MAX_WRAPPER_OUTPUT_BYTES) child.kill('SIGKILL'); });
    // A wrapper that exits before reading stdin makes the write EPIPE; the
    // exit code reported on close is the real outcome, so this is not one.
    child.stdin.on('error', () => {});
    child.on('error', (e) => { clearTimeout(timer); finish(reject, e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) return finish(reject, new Error(`TOOL_EXIT_${code === null ? signal : code}: ${err.slice(0, 200)}`));
      try {
        finish(resolve, JSON.parse(out));
      } catch (e) {
        finish(reject, new Error(`TOOL_OUTPUT_NOT_JSON: ${e.message}`));
      }
    });
    child.stdin.end(JSON.stringify({ ...request, tool }));
  });
}

/**
 * Qualify a local fleet configuration for every role. A role whose
 * invocation or memory probe throws is recorded as failed with its error;
 * the fleet qualifies only when every role passes.
 * @param {{provider: string, tool: string, model: string, endpoint?: string, sessionId: string,
 *   generation: number, windowTokens?: number, memoryCeilingBytes?: number}} config
 * @param {{invoke?: (request: object) => Promise<object>,
 *   memoryProbe?: (config: object, role: string) => Promise<number>}} [deps]
 * @returns {Promise<{provider: string, tool: string, model: string, qualified: boolean, roles: object[]}>}
 * @throws {TypeError} `Invalid local fleet configuration`; `LOCAL_ENDPOINT_REQUIRED` for a non-loopback endpoint.
 */
async function qualifyFleet(config, { invoke = invokeLocal, memoryProbe } = {}) {
  if (!config || !PROVIDERS.includes(config.provider) || !TOOLS.includes(config.tool) || !config.model) {
    throw new TypeError('Invalid local fleet configuration');
  }
  if (config.endpoint) localEndpoint(config.endpoint);
  const results = [];
  for (const role of ROLES) {
    const probe = makeProbe(role, { sessionId: config.sessionId, generation: config.generation, windowTokens: config.windowTokens ?? 4096 });
    try {
      const observation = { ...(await invoke({ ...config, role, prompt: probe.prompt, probe })) };
      if (memoryProbe) observation.peakMemoryBytes = await memoryProbe(config, role);
      results.push(evaluateProbe(probe, observation, { memoryCeilingBytes: config.memoryCeilingBytes }));
    } catch (error) {
      const failed = evaluateProbe(probe, null, { memoryCeilingBytes: config.memoryCeilingBytes });
      results.push({ ...failed, error: error.message });
    }
  }
  return { provider: config.provider, tool: config.tool, model: config.model, qualified: results.every((r) => r.passed), roles: results };
}

module.exports = {
  ROLES,
  PROVIDERS,
  TOOLS,
  GATES,
  MIN_TOKENS_PER_SECOND,
  DEFAULT_MEMORY_CEILING_BYTES,
  MIN_WINDOW_TOKENS,
  localEndpoint,
  makeProbe,
  evaluateProbe,
  invokeLocal,
  invokeTool,
  qualifyFleet
};
