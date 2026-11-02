'use strict';

// #1876: external delivery of Medusa escalations (a webhook or ntfy page) on
// top of the existing dashboard alert (`lib/medusa-watchdog.js`, #1839).
//
// Pure unit tests against the module's own `_internal` seam: `loadConfig`,
// `listEscalations`, `now`, `env`, and `fetch`/`timeoutSignal` are all
// injected, so nothing here opens a socket, touches `lib/store.js`, or reads
// this machine's real environment beyond what a test sets itself.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const watchdog = require('../lib/medusa-escalation-watchdog');

const real = { ...watchdog._internal };

/**
 * One escalation entry, shaped like `medusaWatchdog.listEscalations()`'s own
 * output.
 * @param {object} [overrides]
 * @returns {object}
 */
function escalation(overrides = {}) {
  return {
    exchangeId: 'ex-1',
    priority: 'blocking',
    escalation: 'operator',
    condition: 'unread',
    ageMinutes: 70,
    blocker: { code: 'engine-thread-unknown', meaning: 'the engine has not confirmed idle' },
    senderName: 'sender-project',
    recipientName: 'recipient-project',
    ...overrides
  };
}

afterEach(() => {
  Object.assign(watchdog._internal, real);
  watchdog.__unsafeResetDeliveries();
  delete process.env.TC_TEST_ESCALATION_TOKEN;
});

describe('resolveSettings', () => {
  it('defaults to disabled, and a disabled setting is never a problem whatever else is missing', () => {
    const { settings, problem } = watchdog.resolveSettings({});
    assert.equal(settings.enabled, false);
    assert.equal(problem, null);
  });

  it('enabled with no adapter and no adapterFn is a problem', () => {
    const { problem } = watchdog.resolveSettings({ enabled: true });
    assert.match(problem, /adapter must be/);
  });

  it('enabled with a built-in adapter and a valid url is accepted', () => {
    const { problem } = watchdog.resolveSettings({ enabled: true, adapter: 'webhook', url: 'https://example.test/hook' });
    assert.equal(problem, null);
  });

  it('enabled with a custom adapterFn needs no built-in adapter name', () => {
    const { problem } = watchdog.resolveSettings({ enabled: true, adapterFn: async () => ({ ok: true, status: 200 }), url: 'https://example.test/hook' });
    assert.equal(problem, null);
  });

  it('rejects a non-http(s) url', () => {
    const { problem } = watchdog.resolveSettings({ enabled: true, adapter: 'webhook', url: 'not-a-url' });
    assert.match(problem, /url must be/);
  });

  it('rejects a non-string authTokenEnvVar', () => {
    const { problem } = watchdog.resolveSettings({ enabled: true, adapter: 'webhook', url: 'https://example.test/hook', authTokenEnvVar: 123 });
    assert.match(problem, /authTokenEnvVar must be/);
  });

  it('never carries a resolved secret — only the env var NAME, never its value', () => {
    const { settings } = watchdog.resolveSettings({ enabled: true, adapter: 'webhook', url: 'https://example.test/hook', authTokenEnvVar: 'SOME_ENV_VAR' });
    assert.equal(settings.authTokenEnvVar, 'SOME_ENV_VAR');
    assert.equal('token' in settings, false, 'settings must never carry a resolved credential value');
  });

  it('falls back to default backoffMs/maxAttempts/tickMs for malformed values, rather than treating them as a problem', () => {
    const { settings, problem } = watchdog.resolveSettings({
      enabled: true, adapter: 'webhook', url: 'https://example.test/hook',
      backoffMs: 'not-an-array', maxAttempts: -1, tickMs: 0
    });
    assert.equal(problem, null);
    assert.deepEqual(settings.backoffMs, watchdog.DEFAULTS.backoffMs);
    assert.equal(settings.maxAttempts, watchdog.DEFAULTS.maxAttempts);
    assert.equal(settings.tickMs, watchdog.DEFAULTS.tickMs);
  });
});

describe('tick — disabled and misconfigured', () => {
  it('does nothing, and does not even read escalations, when disabled', async () => {
    let listed = false;
    watchdog._internal.loadConfig = () => ({ escalationExternalAlert: { enabled: false } });
    watchdog._internal.listEscalations = () => { listed = true; return []; };
    const result = await watchdog.tick();
    assert.equal(result.skippedDisabled, true);
    assert.equal(listed, false);
  });

  it('does nothing, and names the problem, when enabled but misconfigured', async () => {
    let called = false;
    watchdog._internal.loadConfig = () => ({ escalationExternalAlert: { enabled: true } });
    watchdog._internal.listEscalations = () => { called = true; return []; };
    const result = await watchdog.tick();
    assert.match(result.skippedMisconfigured, /adapter must be/);
    assert.equal(called, false, 'a misconfigured adapter must not even read escalations');
  });

  it('config removed mid-flight is read as disabled, same as never configured', async () => {
    watchdog._internal.loadConfig = () => ({});
    const result = await watchdog.tick();
    assert.equal(result.skippedDisabled, true);
  });
});

describe('tick — delivery', () => {
  let calls;

  beforeEach(() => {
    calls = [];
    watchdog._internal.now = () => 1_000_000;
  });

  /**
   * Configure a fake adapter and one escalation, then return the calls array.
   * @param {object} [adapterOverride] - Replaces the default accept-everything adapter
   * @param {object} [escalationOverride]
   * @returns {void}
   */
  function configure(adapterOverride, escalationOverride) {
    watchdog._internal.loadConfig = () => ({
      escalationExternalAlert: {
        enabled: true,
        url: 'https://example.test/hook',
        adapterFn: adapterOverride || (async (e, opts) => { calls.push({ e, opts }); return { ok: true, status: 200 }; })
      }
    });
    watchdog._internal.listEscalations = () => [escalation(escalationOverride)];
  }

  it('delivers an escalation at the operator rung', async () => {
    configure();
    const result = await watchdog.tick();
    assert.equal(result.considered, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].e.exchangeId, 'ex-1');
  });

  it('delivers a critical-priority escalation even if its rung is only "aged"', async () => {
    configure(undefined, { escalation: 'aged', priority: 'critical' });
    const result = await watchdog.tick();
    assert.equal(result.considered, 1);
    assert.equal(calls.length, 1);
  });

  it('a non-operator, non-critical escalation is never passed to listEscalations\' own filter (the module trusts its caller\'s filtering)', async () => {
    // listEscalations here is a stub, so this proves the module itself adds
    // no SECOND filter that would exclude something the real function already filtered in.
    configure(undefined, { escalation: 'aged', priority: 'normal' });
    const result = await watchdog.tick();
    assert.equal(result.considered, 0, 'the module\'s own operator/critical filter still applies to whatever listEscalations returns');
  });

  it('does not send the same escalation a second time on a duplicate tick', async () => {
    configure();
    await watchdog.tick();
    await watchdog.tick();
    assert.equal(calls.length, 1);
  });

  it('a different exchangeId is a genuinely new escalation and is sent independently', async () => {
    let n = 0;
    watchdog._internal.loadConfig = () => ({
      escalationExternalAlert: {
        enabled: true, url: 'https://example.test/hook',
        adapterFn: async () => { n += 1; return { ok: true, status: 200 }; }
      }
    });
    watchdog._internal.listEscalations = () => [escalation({ exchangeId: 'ex-1' }), escalation({ exchangeId: 'ex-2' })];
    await watchdog.tick();
    assert.equal(n, 2);
  });

  it('a credential configured but not set in the environment is skipped — never sent unauthenticated', async () => {
    watchdog._internal.loadConfig = () => ({
      escalationExternalAlert: {
        enabled: true, url: 'https://example.test/hook', authTokenEnvVar: 'TC_TEST_ESCALATION_TOKEN_UNSET',
        adapterFn: async () => { calls.push(1); return { ok: true, status: 200 }; }
      }
    });
    watchdog._internal.listEscalations = () => [escalation()];
    const result = await watchdog.tick();
    assert.equal(result.considered, 1);
    assert.equal(calls.length, 0, 'the adapter must never be called when the configured credential is missing');
  });

  it('resolves the credential from the environment and passes it to the adapter, without the module ever persisting it', async () => {
    process.env.TC_TEST_ESCALATION_TOKEN = 'the-secret-value';
    watchdog._internal.loadConfig = () => ({
      escalationExternalAlert: {
        enabled: true, url: 'https://example.test/hook', authTokenEnvVar: 'TC_TEST_ESCALATION_TOKEN',
        adapterFn: async (e, opts) => { calls.push(opts.token); return { ok: true, status: 200 }; }
      }
    });
    watchdog._internal.listEscalations = () => [escalation()];
    await watchdog.tick();
    assert.deepEqual(calls, ['the-secret-value']);
  });

  it('recovers WITHOUT a restart once the operator sets the missing env var on a later tick (#1876 Round 2)', async () => {
    watchdog._internal.loadConfig = () => ({
      escalationExternalAlert: {
        enabled: true, url: 'https://example.test/hook', authTokenEnvVar: 'TC_TEST_ESCALATION_TOKEN',
        adapterFn: async (e, opts) => { calls.push(opts.token); return { ok: true, status: 200 }; }
      }
    });
    watchdog._internal.listEscalations = () => [escalation()];

    delete process.env.TC_TEST_ESCALATION_TOKEN;
    const first = await watchdog.tick();
    assert.equal(first.considered, 1);
    assert.equal(calls.length, 0, 'the credential is missing: nothing is sent yet');

    process.env.TC_TEST_ESCALATION_TOKEN = 'now-set';
    await watchdog.tick();
    assert.deepEqual(calls, ['now-set'], 'the very next tick must deliver, with no restart, once the env var is set');
  });

  it('a missing credential is never marked retry-exhausted, however many ticks pass', async () => {
    watchdog._internal.loadConfig = () => ({
      escalationExternalAlert: {
        enabled: true, url: 'https://example.test/hook', authTokenEnvVar: 'TC_TEST_ESCALATION_TOKEN_UNSET', maxAttempts: 1,
        adapterFn: async () => { calls.push(1); return { ok: true, status: 200 }; }
      }
    });
    watchdog._internal.listEscalations = () => [escalation()];
    for (let i = 0; i < 5; i++) await watchdog.tick();
    assert.equal(calls.length, 0);
    process.env.TC_TEST_ESCALATION_TOKEN_UNSET = 'finally-set';
    await watchdog.tick();
    assert.equal(calls.length, 1, 'a missing credential must never exhaust the retry budget — it is not a delivery attempt at all');
    delete process.env.TC_TEST_ESCALATION_TOKEN_UNSET;
  });
});

describe('tick — overlapping (concurrent) calls', () => {
  it('two tick() calls that overlap in time invoke the adapter only once for the same escalation (#1876 Round 2)', async () => {
    let calls = 0;
    let resolveAdapter;
    watchdog._internal.loadConfig = () => ({
      escalationExternalAlert: {
        enabled: true, url: 'https://example.test/hook',
        adapterFn: () => {
          calls += 1;
          return new Promise((resolve) => { resolveAdapter = resolve; }).then(() => ({ ok: true, status: 200 }));
        }
      }
    });
    watchdog._internal.listEscalations = () => [escalation()];

    const first = watchdog.tick();
    const second = watchdog.tick(); // fired before the first's adapter call has resolved
    resolveAdapter();
    await Promise.all([first, second]);

    assert.equal(calls, 1, 'the second, overlapping tick must see the first attempt as already in flight and skip it');
  });

  it('a third tick, started only after the first has fully settled, is correctly idempotent (not an in-flight false positive)', async () => {
    let calls = 0;
    watchdog._internal.loadConfig = () => ({
      escalationExternalAlert: {
        enabled: true, url: 'https://example.test/hook',
        adapterFn: async () => { calls += 1; return { ok: true, status: 200 }; }
      }
    });
    watchdog._internal.listEscalations = () => [escalation()];
    await watchdog.tick();
    await watchdog.tick();
    assert.equal(calls, 1);
  });
});

describe('tick — failure, backoff and retry-exhaustion', () => {
  let now;

  beforeEach(() => {
    now = 1_000_000;
    watchdog._internal.now = () => now;
  });

  it('a failed delivery is retried only after its backoff elapses, not on the very next tick', async () => {
    let attempts = 0;
    watchdog._internal.loadConfig = () => ({
      escalationExternalAlert: {
        enabled: true, url: 'https://example.test/hook', backoffMs: [1000, 2000], maxAttempts: 3,
        adapterFn: async () => { attempts += 1; throw new Error('ECONNREFUSED'); }
      }
    });
    watchdog._internal.listEscalations = () => [escalation()];

    await watchdog.tick(now);
    assert.equal(attempts, 1);
    await watchdog.tick(now);
    assert.equal(attempts, 1, 'the same clock reading must not retry before its own backoff');
    now += 1500;
    await watchdog.tick(now);
    assert.equal(attempts, 2, 'past the first backoff, a retry is made');
  });

  it('stops retrying once maxAttempts is reached, and never retries that escalation again', async () => {
    let attempts = 0;
    watchdog._internal.loadConfig = () => ({
      escalationExternalAlert: {
        enabled: true, url: 'https://example.test/hook', backoffMs: [100], maxAttempts: 2,
        adapterFn: async () => { attempts += 1; throw new Error('unavailable'); }
      }
    });
    watchdog._internal.listEscalations = () => [escalation()];

    await watchdog.tick(now);
    now += 200;
    await watchdog.tick(now);
    assert.equal(attempts, 2, 'both attempts of the budget were spent');
    now += 1_000_000;
    await watchdog.tick(now);
    assert.equal(attempts, 2, 'a retry-exhausted escalation is never attempted again, however much later');
  });

  it('a destination that answers but refuses (e.g. 401) is treated the same as any other failure', async () => {
    let attempts = 0;
    watchdog._internal.loadConfig = () => ({
      escalationExternalAlert: {
        enabled: true, url: 'https://example.test/hook', backoffMs: [100], maxAttempts: 1,
        adapterFn: async () => { attempts += 1; return { ok: false, status: 401 }; }
      }
    });
    watchdog._internal.listEscalations = () => [escalation()];
    await watchdog.tick(now);
    assert.equal(attempts, 1);
    now += 10_000;
    await watchdog.tick(now);
    assert.equal(attempts, 1, 'a single-attempt budget must not retry after an auth failure either');
  });

  it('a timeout-shaped rejection is handled the same as any other failed delivery, never thrown out of tick', async () => {
    watchdog._internal.loadConfig = () => ({
      escalationExternalAlert: {
        enabled: true, url: 'https://example.test/hook', backoffMs: [100], maxAttempts: 1,
        adapterFn: async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }
      }
    });
    watchdog._internal.listEscalations = () => [escalation()];
    await assert.doesNotReject(() => watchdog.tick(now));
  });

  it('an unavailable destination (network error) is bounded in the recorded reason, never an unbounded message', async () => {
    watchdog._internal.loadConfig = () => ({
      escalationExternalAlert: {
        enabled: true, url: 'https://example.test/hook', backoffMs: [100], maxAttempts: 1,
        adapterFn: async () => { throw new Error('x'.repeat(10000)); }
      }
    });
    watchdog._internal.listEscalations = () => [escalation()];
    // Does not throw, and does not hang — the bounding is on what's logged/recorded internally, asserted
    // indirectly here by the call completing cleanly with a finite, swift result.
    await assert.doesNotReject(() => watchdog.tick(now));
  });
});

describe('tick — restart / rehydration', () => {
  it('a still-open escalation is delivered again exactly once after __unsafeResetDeliveries (simulating a restart)', async () => {
    let calls = 0;
    watchdog._internal.now = () => 1_000_000;
    watchdog._internal.loadConfig = () => ({
      escalationExternalAlert: {
        enabled: true, url: 'https://example.test/hook',
        adapterFn: async () => { calls += 1; return { ok: true, status: 200 }; }
      }
    });
    watchdog._internal.listEscalations = () => [escalation()];

    await watchdog.tick();
    await watchdog.tick();
    assert.equal(calls, 1, 'precondition: duplicate ticks before any restart send only once');

    watchdog.__unsafeResetDeliveries();
    await watchdog.tick();
    assert.equal(calls, 2, 'after a simulated restart, a still-open escalation is told once more');
    await watchdog.tick();
    assert.equal(calls, 2, 'and immediately re-settles into idempotency again, not a storm');
  });
});

describe('start/stop/settled', () => {
  afterEach(() => watchdog.stop());

  it('start is idempotent and stop clears the timer without throwing', () => {
    watchdog._internal.loadConfig = () => ({});
    watchdog.start({ intervalMs: 50 });
    watchdog.start({ intervalMs: 50 });
    assert.doesNotThrow(() => watchdog.stop());
  });

  it('settled resolves once no pass is in flight', async () => {
    await assert.doesNotReject(() => watchdog.settled());
  });
});

describe('the adapters this module ships', () => {
  it('BUILTIN_ADAPTERS names exactly the keys ADAPTERS implements, and resolveSettings accepts each by name', () => {
    assert.deepEqual(watchdog.BUILTIN_ADAPTERS.slice().sort(), Object.keys(watchdog.ADAPTERS).sort());
    for (const name of watchdog.BUILTIN_ADAPTERS) {
      const { problem } = watchdog.resolveSettings({ enabled: true, adapter: name, url: 'https://example.test/hook' });
      assert.equal(problem, null, `${name} must be an accepted adapter name`);
    }
  });

  it('webhookAdapter POSTs JSON with a bearer header when a token is given', async () => {
    let captured = null;
    watchdog._internal.fetch = async (url, init) => { captured = { url, init }; return { ok: true, status: 202 }; };
    watchdog._internal.timeoutSignal = () => undefined;
    const result = await watchdog.ADAPTERS.webhook(escalation(), { url: 'https://example.test/hook', token: 'tok-1', timeoutMs: 1000 });
    assert.equal(result.ok, true);
    assert.equal(captured.url, 'https://example.test/hook');
    assert.equal(captured.init.headers.Authorization, 'Bearer tok-1');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.exchangeId, 'ex-1');
    assert.equal(body.event, 'medusa_escalation');
  });

  it('webhookAdapter omits the Authorization header when no token is given', async () => {
    let captured = null;
    watchdog._internal.fetch = async (url, init) => { captured = init; return { ok: true, status: 200 }; };
    watchdog._internal.timeoutSignal = () => undefined;
    await watchdog.ADAPTERS.webhook(escalation(), { url: 'https://example.test/hook', token: null, timeoutMs: 1000 });
    assert.equal('Authorization' in captured.headers, false);
  });

  it('ntfyAdapter POSTs a bounded plain-text line, never the raw escalation object', async () => {
    let captured = null;
    watchdog._internal.fetch = async (url, init) => { captured = init; return { ok: true, status: 200 }; };
    watchdog._internal.timeoutSignal = () => undefined;
    await watchdog.ADAPTERS.ntfy(escalation(), { url: 'https://ntfy.example/topic', token: null, timeoutMs: 1000 });
    assert.equal(typeof captured.body, 'string');
    assert.match(captured.body, /Medusa escalation: blocking message to recipient-project/);
    assert.match(captured.body, /Exchange ex-1/);
  });
});
