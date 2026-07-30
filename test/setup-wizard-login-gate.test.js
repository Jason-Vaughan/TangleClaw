'use strict';

/*
 * Frontend tests for the wizard's login gate (#710 chunk 2).
 *
 * The ordering constraint these pin: the admin step and the provisioning that
 * enforces it may never come apart. A wizard that collects a username and
 * password and then finishes with nothing enforcing them is worse than one that
 * never asked — the operator who knows they have no login behaves accordingly,
 * the one who believes they have one does not. So:
 *
 *   - the step appears exactly when the SERVER said a gate can be provisioned,
 *     never on the browser's own reading of config;
 *   - the credential is sent under the same predicate that collected it;
 *   - every terminal screen states whether a login is actually in force, and
 *     "cannot confirm" is one of the answers rather than being rounded to
 *     success;
 *   - nothing resolves on a timer (#98/#268) — each end state waits for a click.
 *
 * Same vm-plus-DOM-stub approach as setup-wizard-engines.test.js — setup.js is a
 * plain <script> file, not a module.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SETUP_JS_PATH = path.join(__dirname, '..', 'public', 'setup.js');
const RAW_SRC = fs.readFileSync(SETUP_JS_PATH, 'utf8');
const SETUP_JS_SRC = RAW_SRC.replace(/^const wizard = /m, 'var wizard = ')
  + '\n;globalThis.wizard = wizard;\n';

const PROVISION_PLAN = { action: 'provision', reason: '', remedy: null };
const ADOPT_PLAN = { action: 'adopt', reason: 'An existing Caddy login for "jason" …', remedy: null };
const REFUSE_PLAN = {
  action: 'refuse',
  reason: 'Caddy is not installed, so TangleClaw cannot put a login in front of itself yet.',
  remedy: 'Install Caddy (e.g. `brew install caddy`), then run `node scripts/ingress-cutover.js --to caddy`.'
};

/** Minimal element stub covering what these steps touch. */
function makeElement(id) {
  const classSet = new Set();
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    style: {},
    className: '',
    classList: {
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
      contains: (c) => classSet.has(c)
    },
    focus() {},
    addEventListener() {},
    dispatchEvent() {}
  };
}

/**
 * Load setup.js in a sandbox.
 * @param {object} [opts]
 * @param {object|null} [opts.plan] - `plan` the ingress-state probe returns; null
 *   makes the probe fail.
 * @param {object} [opts.config] - Partial global config.
 * @param {Function} [opts.apiMutate] - Stub for POST /api/setup/complete.
 * @param {Function} [opts.statusFetch] - Stub answering /api/setup/provision-status.
 * @returns {object} sandbox, with `__nav` recording navigations and `__fetches`
 *   the URLs requested.
 */
function loadSetup(opts = {}) {
  const elements = new Map();
  const fetches = [];
  const nav = [];
  let fakeNow = 1000000;

  const sandbox = {
    console,
    // Immediate, so a poll loop advances without wall-clock waiting. Paired with
    // a clock that only moves when the code asks the time, so the deadline is
    // reached deterministically instead of by racing real time.
    setTimeout: (fn) => { fakeNow += 1500; Promise.resolve().then(fn); return 0; },
    clearTimeout() {},
    Promise, Math, JSON, Object, Array, Set, Map, String, Number, Boolean, Error,
    Date: { now: () => fakeNow },
    esc: (str) => (typeof str !== 'string' ? '' : str
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')),
    apiMutate: opts.apiMutate || (async () => null),
    api: Object.assign(async () => null, { lastError: null, lastErrorCode: null }),
    loadConfig: async () => {}, loadProjects: async () => ({}), loadStats: async () => {},
    loadPorts: async () => {}, maybeShowFilter: () => {}, startPolling: () => {},
    state: {
      engines: [{ id: 'claude', name: 'Claude Code', available: true }],
      config: Object.assign({ setupComplete: false }, opts.config || {})
    },
    fetch: async (url) => {
      fetches.push(url);
      if (String(url).includes('/api/setup/ingress-state')) {
        if (!opts.plan) throw new Error('probe unreachable');
        return { ok: true, json: async () => ({ plan: opts.plan }) };
      }
      if (String(url).includes('/api/setup/provision-status')) {
        if (!opts.statusFetch) throw new Error('unreachable');
        return opts.statusFetch(fetches.filter((f) => String(f).includes('provision-status')).length);
      }
      return { ok: true, json: async () => ({}) };
    }
  };
  sandbox.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    body: { classList: { add() {}, remove() {} } }
  };
  sandbox.window = sandbox;
  sandbox.location = {
    origin: 'http://localhost:3102',
    set href(v) { nav.push(v); },
    get href() { return nav[nav.length - 1] || null; }
  };

  vm.createContext(sandbox);
  vm.runInContext(SETUP_JS_SRC, sandbox);
  sandbox.__elements = elements;
  sandbox.__fetches = fetches;
  sandbox.__nav = nav;
  return sandbox;
}

/** Let queued microtasks (the probe, the poll) run to completion. */
async function settle(rounds = 200) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe('Setup wizard — the login gate is the default (#710)', () => {
  describe('the admin step follows the server\'s plan, not the browser\'s guess', () => {
    it('shows the step on a machine where a gate can be provisioned — in DIRECT mode', async () => {
      // The flip. Before, the step appeared only when config already said
      // ingressMode: 'caddy', so a fresh install never saw it and finished with
      // no login at all.
      const ctx = loadSetup({ plan: PROVISION_PLAN, config: { ingressMode: 'direct' } });
      ctx.showWizard();
      await settle();
      assert.ok(ctx.wizardStepKeys().includes('admin'));
    });

    it('skips the step when an existing login will be adopted', async () => {
      // Collecting a second credential would either clobber a working gate or
      // leave two.
      const ctx = loadSetup({ plan: ADOPT_PLAN, config: { ingressMode: 'direct' } });
      ctx.showWizard();
      await settle();
      assert.ok(!ctx.wizardStepKeys().includes('admin'));
    });

    it('skips the step when no gate can be put up', async () => {
      const ctx = loadSetup({ plan: REFUSE_PLAN });
      ctx.showWizard();
      await settle();
      assert.ok(!ctx.wizardStepKeys().includes('admin'));
    });

    it('does not show the step in caddy mode when the server says it must not', async () => {
      // The old predicate was `ingressMode === 'caddy'`. An install already in
      // caddy mode whose Caddyfile must not be touched has to skip, so the
      // config value cannot be the deciding fact any more.
      const ctx = loadSetup({ plan: REFUSE_PLAN, config: { ingressMode: 'caddy' } });
      ctx.showWizard();
      await settle();
      assert.ok(!ctx.wizardStepKeys().includes('admin'));
    });

    it('does not collect a credential while the plan is unknown', async () => {
      // A failed probe must not fail OPEN into asking for a password nothing
      // may enforce.
      const ctx = loadSetup({ plan: null });
      ctx.showWizard();
      await settle();
      assert.equal(ctx.wizard.ingressPlan, null);
      assert.ok(ctx.wizard.ingressPlanError, 'the failure is recorded, not swallowed');
      assert.ok(!ctx.wizardStepKeys().includes('admin'));
    });

    it('hides Skip when a credential is mandatory, and offers it otherwise', async () => {
      const gated = loadSetup({ plan: PROVISION_PLAN });
      gated.showWizard();
      await settle();
      assert.equal(gated.document.getElementById('setupSkipBtn').style.display, 'none',
        'Skip must not offer a way past the login gate');

      const open = loadSetup({ plan: REFUSE_PLAN });
      open.showWizard();
      await settle();
      assert.equal(open.document.getElementById('setupSkipBtn').style.display, '');
    });
  });

  describe('the confirm summary states what will actually be true', () => {
    it('names the credential that will be created', async () => {
      const ctx = loadSetup({ plan: PROVISION_PLAN });
      ctx.showWizard();
      await settle();
      ctx.wizard.adminUser = 'jason';
      assert.match(ctx._loginSummaryLabel(), /jason/);
    });

    it('says an existing login is kept', async () => {
      const ctx = loadSetup({ plan: ADOPT_PLAN });
      ctx.showWizard();
      await settle();
      assert.match(ctx._loginSummaryLabel(), /Existing login kept/);
    });

    it('says "None — not protected" rather than staying silent', async () => {
      // The row used to render only in caddy mode, so the summary of an
      // unprotected install simply omitted the subject.
      const ctx = loadSetup({ plan: REFUSE_PLAN });
      ctx.showWizard();
      await settle();
      assert.match(ctx._loginSummaryLabel(), /None/);
      const body = ctx.document.getElementById('setupBody');
      ctx.renderConfirm(body);
      assert.match(body.innerHTML, /Login/);
      assert.match(body.innerHTML, /not protected/);
    });

    it('admits when it could not check', async () => {
      const ctx = loadSetup({ plan: null });
      ctx.showWizard();
      await settle();
      assert.match(ctx._loginSummaryLabel(), /could not check/);
    });
  });

  describe('the credential is sent under the same predicate that collected it', () => {
    /** Run wizardComplete against a stubbed complete route and return the body sent. */
    async function submit(plan, ingressResponse) {
      let sent = null;
      const ctx = loadSetup({
        plan,
        apiMutate: async (_url, _method, body) => {
          sent = body;
          return { ok: true, setupComplete: true, attached: [], warnings: [], restart: false,
            ingress: ingressResponse || { action: 'refuse', provisioning: false, protection: 'unchanged' } };
        }
      });
      ctx.showWizard();
      await settle();
      ctx.wizard.adminUser = 'jason';
      ctx.wizard.adminPassword = 'correct-horse-battery';
      ctx.wizard.adminPasswordConfirm = 'correct-horse-battery';
      await ctx.wizardComplete();
      await settle();
      return { sent, ctx };
    }

    it('sends the credential when the step was shown', async () => {
      const { sent } = await submit(PROVISION_PLAN,
        { action: 'provision', provisioning: true, protection: 'pending', url: 'https://host:8443', user: 'jason' });
      assert.equal(sent.adminUser, 'jason');
      assert.equal(sent.adminPassword, 'correct-horse-battery');
    });

    it('does not send one when the step was skipped', async () => {
      // Sending here would ask the server to store a credential the operator was
      // never shown a field for.
      const { sent } = await submit(ADOPT_PLAN);
      assert.equal(sent.adminUser, undefined);
      assert.equal(sent.adminPassword, undefined);
    });
  });

  describe('the provisioning outcome is reported, never assumed', () => {
    /** Start provisioning with a status route that answers `answers[n-1]` on poll n. */
    async function provisionWith(answers) {
      const ctx = loadSetup({
        plan: PROVISION_PLAN,
        statusFetch: (n) => {
          const a = answers[Math.min(n, answers.length) - 1];
          if (a === 'unreachable') throw new Error('ECONNREFUSED');
          return { ok: true, json: async () => a };
        },
        apiMutate: async () => ({
          ok: true, setupComplete: true, attached: [], warnings: [], restart: false,
          ingress: { action: 'provision', provisioning: true, protection: 'pending',
            url: 'https://host:8443', user: 'jason' }
        })
      });
      ctx.showWizard();
      await settle();
      await ctx.wizardComplete();
      await settle(2000);
      return ctx;
    }

    it('reports the login as in force only when the outcome says ok', async () => {
      const ctx = await provisionWith([{ state: 'done', ok: true, code: 'ok' }]);
      assert.equal(ctx.wizard.provision.phase, 'gated');
      const html = ctx.document.getElementById('setupBody').innerHTML;
      // The affirmative heading specifically — /login is in force/i would also
      // match the "No login is in force" failure screen.
      assert.match(html, /Your login is in force/);
      assert.match(html, /jason/);
      assert.match(html, /host:8443/);
    });

    it('treats an unreachable origin as still restarting, not as failure', async () => {
      // The server being polled is the one the cutover is kicking.
      const ctx = await provisionWith([
        'unreachable', 'unreachable', { state: 'done', ok: true, code: 'ok' }
      ]);
      assert.equal(ctx.wizard.provision.phase, 'gated');
    });

    it('says plainly that nothing is asking for a password when the cutover failed', async () => {
      const ctx = await provisionWith([
        { state: 'done', ok: false, code: 'ungate-refused', error: 'no credential in config' }
      ]);
      assert.equal(ctx.wizard.provision.phase, 'failed');
      const html = ctx.document.getElementById('setupBody').innerHTML;
      assert.match(html, /No login is in force/);
      assert.match(html, /Nothing is asking for a password/);
      assert.match(html, /ungate-refused/);
      assert.match(html, /ingress-cutover\.js/, 'the operator needs the command that fixes it');
    });

    it('treats a corrupt outcome as a failure to confirm, not as success', async () => {
      const ctx = await provisionWith([{ state: 'unparseable-result', hasError: true, logLocation: '~/.tangleclaw/logs/ingress-cutover.log' }]);
      assert.equal(ctx.wizard.provision.phase, 'failed');
      assert.match(ctx.document.getElementById('setupBody').innerHTML, /No login is in force/);
    });

    it('ends in "cannot see the result" when the origin never comes back', async () => {
      // The common case for a remote operator: the restart closes the address
      // this page was served from, and the new one is cross-origin.
      const ctx = await provisionWith(['unreachable']);
      assert.equal(ctx.wizard.provision.phase, 'unconfirmed');
      const html = ctx.document.getElementById('setupBody').innerHTML;
      assert.match(html, /can't see the result/);
      assert.match(html, /asks for a username and password/,
        'the operator needs the check that settles it');
      assert.match(html, /--rollback/, 'and the way back if nothing loads');
    });

    it('never claims success it did not observe', async () => {
      // "Your login is in force" is the affirmative heading, and only the
      // observed-ok path may render it. Matching on a looser phrase would pass
      // against "NO login is in force" and prove nothing.
      for (const answers of [['unreachable'], [{ state: 'done', ok: false, code: 'failed' }]]) {
        const ctx = await provisionWith(answers);
        const html = ctx.document.getElementById('setupBody').innerHTML;
        assert.ok(!/Your login is in force/.test(html),
          `unconfirmed or failed provisioning must not read as protected: ${html.slice(0, 200)}`);
        assert.match(html, /Nothing is asking for a password|If it asks for a username/,
          'the operator must be told what is actually true');
      }
    });

    it('does not navigate or dismiss on its own — every end state waits for a click', async () => {
      // #98/#268: no timer-driven UI lifecycle. The poll's interval advances the
      // poll and nothing else.
      for (const answers of [
        [{ state: 'done', ok: true, code: 'ok' }],
        [{ state: 'done', ok: false, code: 'failed' }],
        ['unreachable']
      ]) {
        const ctx = await provisionWith(answers);
        assert.deepEqual(ctx.__nav, [], 'provisioning redirected without being asked');
      }
    });
  });

  describe('how exposed an ungated install is, stated from the server\'s own answer', () => {
    // An install whose config predates the loopback default is deliberately held
    // on a WIDE binding until its operator chooses (lib/bind-policy.js grace
    // state). Telling that operator "reachable from this machine only" would be a
    // false reassurance handed to exactly the person at risk: ungated AND
    // reachable.
    it('says "this machine only" when the server reports a loopback bind', () => {
      const ctx = loadSetup({ plan: REFUSE_PLAN });
      assert.match(ctx._exposureSentence(false), /this machine only/);
      assert.doesNotMatch(ctx._exposureSentence(false), /reachable from your network/);
    });

    it('warns plainly when the server reports a wide bind with no gate', () => {
      const ctx = loadSetup({ plan: REFUSE_PLAN });
      const s = ctx._exposureSentence(true);
      assert.match(s, /reachable from your network/);
      assert.match(s, /run commands as you/);
      assert.doesNotMatch(s, /this machine only/);
    });

    it('carries the server\'s exposure answer onto the unprotected screen', async () => {
      const ctx = loadSetup({
        plan: REFUSE_PLAN,
        apiMutate: async () => ({
          ok: true, setupComplete: true, attached: [], warnings: [], restart: false,
          ingress: { action: 'refuse', provisioning: false, protection: 'none',
            reason: REFUSE_PLAN.reason, remedy: REFUSE_PLAN.remedy, networkExposed: true }
        })
      });
      ctx.showWizard();
      await settle();
      await ctx.wizardComplete();
      await settle();
      assert.match(ctx.document.getElementById('setupBody').innerHTML, /reachable from your network/);
    });
  });

  describe('the deadline distinguishes "cannot see it" from "it has not answered"', () => {
    /** Provision, answering the status route with `answers[n-1]` on poll n. */
    async function provisionWith(answers) {
      const ctx = loadSetup({
        plan: PROVISION_PLAN,
        statusFetch: (n) => {
          const a = answers[Math.min(n, answers.length) - 1];
          if (a === 'unreachable') throw new Error('ECONNREFUSED');
          return { ok: true, json: async () => a };
        },
        apiMutate: async () => ({
          ok: true, setupComplete: true, attached: [], warnings: [], restart: false,
          ingress: { action: 'provision', provisioning: true, protection: 'pending',
            url: 'https://host:8443', user: 'jason' }
        })
      });
      ctx.showWizard();
      await settle();
      await ctx.wizardComplete();
      await settle(2000);
      return ctx;
    }

    it('says the origin closed only when the origin actually closed', async () => {
      const ctx = await provisionWith(['unreachable']);
      assert.equal(ctx.wizard.provision.phase, 'unconfirmed');
      assert.equal(ctx.wizard.provision.reachable, false);
      assert.match(ctx.document.getElementById('setupBody').innerHTML, /can't see the result/);
    });

    it('says it has not reported back when the origin stayed reachable', async () => {
      // Reachable + no result means the child died before writing, or the cutover
      // ran past the deadline. Neither is "the address this page used has closed",
      // and claiming it would send the operator to --rollback for no reason.
      const ctx = await provisionWith([{ state: 'pending', ok: null, code: null }]);
      assert.equal(ctx.wizard.provision.phase, 'unconfirmed');
      assert.equal(ctx.wizard.provision.reachable, true);
      const html = ctx.document.getElementById('setupBody').innerHTML;
      assert.match(html, /hasn't reported back/);
      assert.doesNotMatch(html, /an address the restart closes/,
        'a reachable origin must not be described as gone');
      assert.match(html, /may or may not have finished/, 'and it must not guess either way');
    });
  });

  describe('a stored-but-unconfirmed login gets its own screen', () => {
    /** Complete setup with the given ingress block and report the rendered body. */
    async function completeWith(ingress, warnings) {
      let dismissed = false;
      const ctx = loadSetup({
        plan: REFUSE_PLAN,
        apiMutate: async () => ({
          ok: true, setupComplete: true, attached: [], warnings: warnings || [],
          restart: false, ingress
        })
      });
      ctx.showWizard();
      await settle();
      ctx.dismissWizard = () => { dismissed = true; };
      await ctx.wizardComplete();
      await settle();
      return { html: ctx.document.getElementById('setupBody').innerHTML, dismissed, ctx };
    }

    it('does not dismiss into a dashboard that looks protected', async () => {
      // 'unchanged' means the credential is stored and the Caddy config was left
      // alone, so nothing is known to be enforcing it. Dismissing closed the
      // overlay that carried the server's own warning about exactly that.
      const { html, dismissed } = await completeWith({
        action: 'refuse', provisioning: false, protection: 'unchanged',
        remedy: 'Run `node scripts/ingress-cutover.js --to caddy`.'
      });
      assert.equal(dismissed, false);
      assert.match(html, /saved, but not confirmed/);
      assert.doesNotMatch(html, /Nothing is asking for a password/,
        'a stored credential must not be reported as no login at all');
    });

    it('gives the same treatment to an adoption that could not be verified', async () => {
      const { html, dismissed } = await completeWith({
        action: 'adopt', provisioning: false, protection: 'existing-unverified',
        reason: 'TangleClaw cannot tell whether they carry the same credential.'
      });
      assert.equal(dismissed, false);
      assert.match(html, /saved, but not confirmed/);
      assert.match(html, /cannot tell whether/);
    });

    it('carries the server\'s warnings onto the screen that replaces the one reporting them', async () => {
      // The warnings were written into an element inside the confirm step's body,
      // and every terminal screen replaces that body.
      const { html } = await completeWith(
        { action: 'refuse', provisioning: false, protection: 'none', reason: 'no caddy' },
        ['Skipped "old-project": path does not exist or is not a directory']
      );
      assert.match(html, /Skipped &quot;old-project&quot;|Skipped "old-project"/);
    });
  });

  describe('one screen owns the body at a time', () => {
    it('a late ingress probe does not repaint a live terminal screen', async () => {
      // The probe and the poll both re-render asynchronously. Without an explicit
      // view, whichever resolved last won — and a probe returning after setup
      // finished would replace "no login is in force" with a wizard step while the
      // poll kept writing into a body it no longer owned.
      const ctx = loadSetup({
        plan: REFUSE_PLAN,
        apiMutate: async () => ({
          ok: true, setupComplete: true, attached: [], warnings: [], restart: false,
          ingress: { action: 'refuse', provisioning: false, protection: 'none', reason: 'no caddy' }
        })
      });
      ctx.showWizard();
      await settle();
      await ctx.wizardComplete();
      await settle();
      assert.equal(ctx.wizard.view, 'unprotected');
      const before = ctx.document.getElementById('setupBody').innerHTML;

      await ctx.loadIngressPlan();
      await settle();
      assert.equal(ctx.document.getElementById('setupBody').innerHTML, before,
        'the probe repainted a terminal screen');
    });

    it('a step index left past the end of a shrunken list cannot blank the wizard', async () => {
      // The admin step appears when the plan says provision and would disappear
      // again if a re-probe failed. An index into that list can outlive it; the
      // switch had no default, so the body was left as a stale Confirm screen
      // whose button re-submitted into the same refusal forever.
      const ctx = loadSetup({ plan: PROVISION_PLAN });
      ctx.showWizard();
      await settle();
      assert.equal(ctx.wizardStepKeys().length, 8);
      ctx.wizard.step = 7;

      ctx.wizard.ingressPlan = null;   // as a failed re-probe leaves it
      ctx.renderWizardStep();
      assert.ok(ctx.wizard.step <= ctx.wizardStepKeys().length - 1, 'the index must be clamped');
      assert.ok(ctx.document.getElementById('setupBody').innerHTML.length > 0,
        'the body must never be left with nothing the operator can act on');
    });
  });

  describe('recovery from the server\'s refusal', () => {
    it('routes back to the admin step on the error CODE, not on message text', async () => {
      const ctx = loadSetup({
        plan: PROVISION_PLAN,
        apiMutate: async () => null
      });
      ctx.showWizard();
      await settle();
      ctx.wizard.ingressPlan = null;          // as a failed probe leaves it
      ctx.api.lastError = 'An admin username and password are required to finish setup.';
      ctx.api.lastErrorCode = 'ADMIN_REQUIRED';
      await ctx.wizardComplete();
      await settle();
      assert.equal(ctx.wizardStepKeys().includes('admin'), true, 're-probe restored the plan');
      assert.equal(ctx.wizardStepKeys()[ctx.wizard.step], 'admin');
    });

    it('does not re-route on an unrelated error that merely mentions "admin"', async () => {
      // 'adminUser is required…' (BAD_REQUEST) and 'Could not hash admin
      // password…' (HASH_FAILED) both contain the word.
      const ctx = loadSetup({ plan: PROVISION_PLAN, apiMutate: async () => null });
      ctx.showWizard();
      await settle();
      const stepBefore = ctx.wizard.step;
      ctx.api.lastError = 'Could not hash admin password: caddy exited 1';
      ctx.api.lastErrorCode = 'HASH_FAILED';
      await ctx.wizardComplete();
      await settle();
      assert.equal(ctx.wizard.step, stepBefore, 'an unrelated failure must not navigate');
    });
  });

  describe('the screens that change without a click announce themselves', () => {
    // Every state here is reached by a poll resolving, not by the operator doing
    // something — so a screen reader user would otherwise have to go looking to
    // find out whether a login is in force, which is the one fact this slice
    // exists to state plainly.
    async function provisionWith(answers) {
      const ctx = loadSetup({
        plan: PROVISION_PLAN,
        statusFetch: (n) => {
          const a = answers[Math.min(n, answers.length) - 1];
          if (a === 'unreachable') throw new Error('ECONNREFUSED');
          return { ok: true, json: async () => a };
        },
        apiMutate: async () => ({
          ok: true, setupComplete: true, attached: [], warnings: [], restart: false,
          ingress: { action: 'provision', provisioning: true, protection: 'pending',
            url: 'https://host:8443', user: 'jason' }
        })
      });
      ctx.showWizard();
      await settle();
      await ctx.wizardComplete();
      await settle(2000);
      return ctx;
    }

    it('announces the in-progress state politely, and marks it busy', async () => {
      // Rendered directly: driving it through the poll resolves past this screen,
      // so a case that only awaited the outcome was titled for two states while
      // exercising one.
      const ctx = loadSetup({ plan: PROVISION_PLAN });
      ctx.showWizard();
      await settle();
      ctx._showProvisioningScreen({ provisioning: true, url: 'https://host:8443', user: 'jason' }, []);
      const html = ctx.document.getElementById('setupBody').innerHTML;
      assert.match(html, /aria-live="polite"/);
      assert.match(html, /aria-busy="true"/);
      assert.match(html, /Putting your login in place/);
    });

    it('announces the success state politely', async () => {
      const ctx = await provisionWith([{ state: 'done', ok: true, code: 'ok' }]);
      const html = ctx.document.getElementById('setupBody').innerHTML;
      assert.match(html, /Your login is in force/, 'must actually be on the success screen');
      assert.match(html, /aria-live="polite"/);
    });

    it('announces a failure assertively, since it changes what the operator must do', async () => {
      for (const answers of [[{ state: 'done', ok: false, code: 'failed' }], ['unreachable']]) {
        const ctx = await provisionWith(answers);
        assert.match(ctx.document.getElementById('setupBody').innerHTML, /role="alert"/);
      }
    });
  });

  describe('every terminal screen owes the same three things', () => {
    // The Critic named the pattern: three fixes in one changeset applied at one
    // call site and not its family (view ownership, warnings, aria), and three
    // shipped with no assertion at all — revert the lines and the suite stayed
    // green. These cases cover the family, not a member.
    // Each entry must actually REACH the screen it names. Two earlier versions of
    // this table did not: a `restarting` row carrying `protection: 'unchanged'`
    // returned at the unprotected branch before the restart check, and a
    // `provisioning` row with an unreachable status route ended on 'unconfirmed'
    // rather than the success screen — so two mutations survived a suite that
    // claimed to cover them. `expect` pins which screen each row lands on.
    const SCREENS = [
      { name: 'provisioning (success)', expect: /Your login is in force/,
        status: { state: 'done', ok: true, code: 'ok' },
        ingress: { action: 'provision', provisioning: true, protection: 'pending', url: 'https://host:8443', user: 'jason' } },
      { name: 'provisioning (failed)', expect: /No login is in force/,
        status: { state: 'done', ok: false, code: 'failed' },
        ingress: { action: 'provision', provisioning: true, protection: 'pending', url: 'https://host:8443', user: 'jason' } },
      { name: 'provisioning (unconfirmed)', expect: /can't see the result|hasn't reported back/,
        status: 'unreachable',
        ingress: { action: 'provision', provisioning: true, protection: 'pending', url: 'https://host:8443', user: 'jason' } },
      { name: 'unprotected', expect: /TangleClaw has no login/,
        ingress: { action: 'refuse', provisioning: false, protection: 'none', reason: 'no caddy' } },
      { name: 'stored-unconfirmed', expect: /saved, but not confirmed/,
        ingress: { action: 'refuse', provisioning: false, protection: 'unchanged' } },
      { name: 'adopted', expect: /Setup finished/,
        ingress: { action: 'adopt', provisioning: false, protection: 'existing', user: 'jason' } },
      { name: 'restarting', expect: /Restarting TangleClaw/, restart: true,
        ingress: { action: 'adopt', provisioning: false, protection: 'existing', user: 'jason' } }
    ];

    /** Finish setup with the given ingress block and report what the body became. */
    async function endOn(screen, warnings, opts = {}) {
      const ctx = loadSetup({
        plan: REFUSE_PLAN,
        statusFetch: () => {
          if (!screen.status || screen.status === 'unreachable') throw new Error('ECONNREFUSED');
          return { ok: true, json: async () => screen.status };
        },
        apiMutate: async () => ({
          ok: true, setupComplete: true, attached: [], warnings: warnings || [],
          restart: screen.restart === true,
          redirectUrl: screen.restart ? 'https://host:3102' : null,
          ingress: screen.ingress
        })
      });
      ctx.showWizard();
      await settle();
      let dismissed = false;
      ctx.dismissWizard = () => { dismissed = true; };
      await ctx.wizardComplete();
      await settle(2000);
      const html = ctx.document.getElementById('setupBody').innerHTML;
      // The row is only evidence about the screen it claims. Skipped for the case
      // that deliberately asserts the DISMISS path, where no screen is expected.
      if (!opts.expectDismiss) {
        assert.match(html, screen.expect, `fixture for "${screen.name}" landed on a different screen`);
      }
      return { ctx, html, dismissed };
    }

    it('prints an ingress reason once, though the server sends it in both fields', async () => {
      // The server puts the reason in `warnings` as well as `reason`, deliberately: a
      // client that reads only `warnings` must still learn the install is ungated. So a
      // screen that prints the prose itself has to drop the duplicate, or the operator
      // reads the identical sentence twice — once as the explanation, once under "Also
      // worth knowing". De-duplicating at the render is what lets the API stay complete.
      const REASON = 'A login is already configured and a hand-maintained Caddy config is in '
        + 'front of TangleClaw.';
      const OTHER = 'Skipped a project: path does not exist';
      const printsTheReason = [
        { name: 'unprotected', expect: /TangleClaw has no login/,
          ingress: { action: 'refuse', provisioning: false, protection: 'none', reason: REASON } },
        { name: 'stored-unconfirmed', expect: /saved, but not confirmed/,
          ingress: { action: 'refuse', provisioning: false, protection: 'existing-unverified', reason: REASON } }
      ];
      for (const screen of printsTheReason) {
        const { html } = await endOn(screen, [REASON, OTHER]);
        assert.equal(html.split(REASON).length - 1, 1,
          `${screen.name} printed the reason ${html.split(REASON).length - 1} times, not once`);
        assert.match(html, new RegExp(OTHER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          `${screen.name} dropped an unrelated warning while de-duplicating`);
      }
    });

    it('keeps a warning repeating a reason the screen never printed', async () => {
      // The de-duplication is keyed on what the CALLER rendered, not on the reason
      // field's existence. The adopted screen prints no reason, so suppressing there
      // would delete the operator's only copy instead of removing a second one.
      const REASON = 'An existing Caddy login was found but could not be adopted';
      const { html } = await endOn(
        // NOT /Setup finished/ — that string also appears on the failed-provisioning
        // screen, so it cannot prove this fixture landed on the adopted one.
        { name: 'adopted', expect: /did not change it/,
          ingress: { action: 'adopt', provisioning: false, protection: 'existing', user: 'jason', reason: REASON } },
        [REASON]
      );
      assert.equal(html.split(REASON).length - 1, 1,
        'a screen that never printed the reason must still show it as a warning');
    });

    it('claims the view, so an async re-render cannot repaint any of them', async () => {
      for (const screen of SCREENS) {
        const { ctx } = await endOn(screen, ['a warning keeps this screen up']);
        assert.notEqual(ctx.wizard.view, 'steps', `${screen.name} left the view as the step flow`);
      }
    });

    it('announces itself, since none of them is reached by an operator action', async () => {
      for (const screen of SCREENS) {
        const { html } = await endOn(screen, ['a warning keeps this screen up']);
        // The role must be on the SCREEN's own container. Matching `role=` anywhere
        // in the body is blind: `_warningsBlock` emits its own `role="status"` and
        // `endOn` always passes a warning, so deleting the screen's role left this
        // green. Third instance in this changeset of an assertion that cannot fail.
        const step = html.match(/<div class="setup-step"[^>]*>/);
        assert.ok(step, `${screen.name} rendered no setup-step container`);
        assert.match(step[0], /role="(status|alert)"/, `${screen.name} announced nothing`);
      }
    });

    it('carries the server\'s warnings rather than closing the overlay holding them', async () => {
      for (const screen of SCREENS) {
        const { html, dismissed } = await endOn(screen, ['Skipped "old-project": path does not exist']);
        assert.equal(dismissed, false, `${screen.name} dismissed over its own warnings`);
        assert.match(html, /old-project/, `${screen.name} dropped the warnings`);
      }
    });

    it('still dismisses normally when there is nothing to report', async () => {
      // The warnings carry-through must not turn an uneventful adopt into an extra
      // click for everyone.
      const { dismissed } = await endOn(
        SCREENS.find((s) => s.name === 'adopted'), [], { expectDismiss: true });
      assert.equal(dismissed, true);
    });
  });

  describe('Skip cannot report a success the server refused', () => {
    it('routes a credential refusal to the step that collects one', async () => {
      // apiMutate returns null on a non-2xx rather than throwing, so ignoring it set
      // setupComplete locally and dismissed — the operator landed on a dashboard as
      // though setup had finished while the server said it had not.
      //
      // And the fix must not swing the other way. Skip is only visible when the plan
      // does NOT demand a credential, so every refusal reaching here comes from an
      // install already in caddy mode — where a gate may be live (adopt, ambiguous),
      // and where an ungated Caddyfile is network-reachable. Rendering an
      // "unprotected" verdict from an invented ingress block told the first group
      // nothing was asking for a password and the second that it was not exposed:
      // the false reassurance the screen exists to prevent, produced by the screen.
      let dismissed = false;
      const ctx = loadSetup({ plan: ADOPT_PLAN, apiMutate: async () => null });
      ctx.showWizard();
      await settle();
      ctx.dismissWizard = () => { dismissed = true; };
      ctx.api.lastError = 'Cannot finish setup without an admin credential.';
      ctx.api.lastErrorCode = 'ADMIN_REQUIRED';
      await ctx.wizardSkip();
      await settle();
      assert.equal(dismissed, false, 'a refused Skip must not dismiss');
      assert.equal(ctx.state.config.setupComplete, false, 'nor claim completion locally');
      const html = ctx.document.getElementById('setupBody').innerHTML;
      assert.match(html, /Admin Login/, 'must land on the step that fixes it');
      assert.doesNotMatch(html, /Nothing is asking for a password/,
        'must not assert an unprotected state it did not measure');
      assert.doesNotMatch(html, /not exposed to your network/,
        'must not assert an exposure state it did not measure');
      assert.equal(ctx.document.getElementById('setupSkipBtn').style.display, 'none',
        'Skip must stop offering the way past the gate the server just refused');
    });

    it('surfaces an unrelated failure without inventing a verdict about the gate', async () => {
      const ctx = loadSetup({ plan: ADOPT_PLAN, apiMutate: async () => null });
      ctx.showWizard();
      await settle();
      let dismissed = false;
      ctx.dismissWizard = () => { dismissed = true; };
      ctx.api.lastError = 'Disk is full';
      ctx.api.lastErrorCode = 'INTERNAL';
      await ctx.wizardSkip();
      await settle();
      assert.equal(dismissed, false);
      assert.equal(ctx.document.getElementById('setupOverlayError').textContent, 'Disk is full');
    });

    it('writes that failure somewhere that exists on every step, not just the confirm step', () => {
      // The harness's getElementById AUTO-CREATES a stub for any id, so the case
      // above proves the write happened and says nothing about whether the target
      // is in the markup. Skip lives in the overlay header and is reachable from
      // every step, so an id rendered only by `renderConfirm` would be silent on the
      // other six — a click that does nothing at all. Assert against the real HTML.
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
      assert.match(html, /id="setupOverlayError"/,
        'the persistent error target must exist in the overlay markup');
      // And it must be OUTSIDE the step body, which every render replaces.
      const overlay = html.slice(html.indexOf('id="setupOverlay"'));
      const errAt = overlay.indexOf('id="setupOverlayError"');
      const bodyAt = overlay.indexOf('id="setupBody"');
      assert.ok(errAt >= 0 && bodyAt >= 0 && errAt < bodyAt,
        'the error target must sit outside the body that step renders overwrite');
      // The confirm-only id must NOT be what the persistent control writes to.
      const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'setup.js'), 'utf8');
      const skipFn = src.slice(src.indexOf('async function wizardSkip'), src.indexOf('// ── Step Rendering'));
      // The CALL, not any mention — the comment above it names the wrong id
      // deliberately, to explain why it is the wrong one.
      assert.ok(!/getElementById\(\s*['"]setupCompleteError['"]/.test(skipFn),
        'wizardSkip must not report into an element only the confirm step renders');
      assert.ok(/getElementById\(\s*['"]setupOverlayError['"]/.test(skipFn),
        'wizardSkip must report into the persistent overlay target');
    });

    it('still dismisses when the server accepts', async () => {
      let dismissed = false;
      const ctx = loadSetup({ plan: REFUSE_PLAN, apiMutate: async () => ({ ok: true }) });
      ctx.showWizard();
      await settle();
      ctx.dismissWizard = () => { dismissed = true; };
      await ctx.wizardSkip();
      await settle();
      assert.equal(dismissed, true);
      assert.equal(ctx.state.config.setupComplete, true);
    });
  });

  describe('a server-forced credential does not overwrite the server\'s own plan', () => {
    /** Drive a refusal that forces the admin step even though the probe said adopt. */
    async function forced() {
      const ctx = loadSetup({ plan: ADOPT_PLAN, apiMutate: async () => null });
      ctx.showWizard();
      await settle();
      ctx.api.lastError = 'Cannot finish setup without an admin credential.';
      ctx.api.lastErrorCode = 'ADMIN_REQUIRED';
      await ctx.wizardSkip();
      await settle();
      return ctx;
    }

    it('leaves ingressPlan as the server sent it', async () => {
      // `plan.action` is the one field documented as never client-derived.
      // Synthesizing 'provision' into it is what made the summary lie.
      const ctx = await forced();
      assert.equal(ctx.wizard.ingressPlan.action, 'adopt', 'the server\'s answer was overwritten');
      assert.equal(ctx.wizard.adminStepForcedByServer, true, 'the override is its own signal');
      assert.equal(ctx.wizardStepKeys().includes('admin'), true);
    });

    it('does not tell the operator a login "will be created" when it will only be saved', async () => {
      const ctx = await forced();
      ctx.wizard.adminUser = 'jason';
      const label = ctx._loginSummaryLabel();
      assert.doesNotMatch(label, /Will be created/,
        'the server will store this credential and report the ingress unchanged');
      assert.match(label, /not confirmed as enforced/);
      assert.match(label, /jason/);
    });
  });

  describe('the overlay banner does not outlive the failure it reports', () => {
    it('is cleared when the operator navigates on', async () => {
      // It sits ABOVE #setupBody, so unlike a message inside a step it is not removed
      // by the next render.
      const ctx = loadSetup({ plan: ADOPT_PLAN, apiMutate: async () => null });
      ctx.showWizard();
      await settle();
      ctx.api.lastError = 'Disk is full';
      ctx.api.lastErrorCode = 'INTERNAL';
      await ctx.wizardSkip();
      await settle();
      assert.equal(ctx.document.getElementById('setupOverlayError').textContent, 'Disk is full');
      ctx.wizardNext();
      assert.equal(ctx.document.getElementById('setupOverlayError').textContent, '');
    });

    it('is cleared by every terminal screen, so it cannot sit under a success message', async () => {
      // All FOUR terminal screens, each pinned to the one it names — an earlier
      // version covered three and asserted nothing about which screen it landed on,
      // so a row could stop being evidence about its subject without failing.
      const CASES = [
        { name: 'in force', expect: /Your login is in force/, restart: false,
          ingress: { action: 'provision', provisioning: true, protection: 'pending', url: 'https://host:8443' } },
        { name: 'no login', expect: /TangleClaw has no login/, restart: false,
          ingress: { action: 'refuse', provisioning: false, protection: 'none', reason: 'no caddy' } },
        { name: 'adopted', expect: /Setup finished/, restart: false,
          ingress: { action: 'adopt', provisioning: false, protection: 'existing', user: 'jason' } },
        { name: 'restarting', expect: /Restarting TangleClaw/, restart: true,
          ingress: { action: 'adopt', provisioning: false, protection: 'existing', user: 'jason' } }
      ];
      for (const c of CASES) {
        const ctx = loadSetup({
          plan: REFUSE_PLAN,
          statusFetch: () => ({ ok: true, json: async () => ({ state: 'done', ok: true, code: 'ok' }) }),
          apiMutate: async () => ({
            ok: true, setupComplete: true, attached: [],
            warnings: ['Skipped "x": path does not exist'], restart: c.restart,
            redirectUrl: c.restart ? 'https://host:3102' : null,
            ingress: c.ingress
          })
        });
        ctx.showWizard();
        await settle();
        const banner = ctx.document.getElementById('setupOverlayError');
        banner.textContent = 'Could not finish setup.';
        banner.classList.remove('hidden');
        await ctx.wizardComplete();
        await settle(2000);
        assert.match(ctx.document.getElementById('setupBody').innerHTML, c.expect,
          `fixture for "${c.name}" landed on a different screen`);
        assert.equal(banner.textContent, '',
          `${c.name}: a stale failure banner survived onto a terminal screen`);
      }
    });
  });

  describe('Skip is offered only when the answer is known', () => {
    it('stays hidden while the plan is unknown, not just when it demands a credential', async () => {
      // Unknown is not "not required". The probe is unawaited, so there is a window
      // at startup — and forever on a failed probe — where showing Skip offers a way
      // past the gate on exactly the machines whose answer has not arrived.
      const ctx = loadSetup({ plan: null });
      ctx.showWizard();
      assert.equal(ctx.document.getElementById('setupSkipBtn').style.display, 'none',
        'Skip was visible before the plan arrived');
      await settle();
      assert.equal(ctx.wizard.ingressPlan, null, 'the probe failed, so the plan stays unknown');
      assert.equal(ctx.document.getElementById('setupSkipBtn').style.display, 'none',
        'Skip stayed visible after a failed probe');
    });
  });

  describe('a setup that never attempts a gate says so', () => {
    it('shows an unprotected screen instead of dismissing into a normal dashboard', async () => {
      let dismissed = false;
      const ctx = loadSetup({
        plan: REFUSE_PLAN,
        apiMutate: async () => ({
          ok: true, setupComplete: true, attached: [], warnings: [], restart: false,
          ingress: { action: 'refuse', provisioning: false, protection: 'none',
            reason: REFUSE_PLAN.reason, remedy: REFUSE_PLAN.remedy }
        })
      });
      ctx.showWizard();
      await settle();
      ctx.dismissWizard = () => { dismissed = true; };
      await ctx.wizardComplete();
      await settle();

      const html = ctx.document.getElementById('setupBody').innerHTML;
      assert.match(html, /TangleClaw has no login/);
      assert.match(html, /Nothing is asking for a password/);
      assert.match(html, /brew install caddy/);
      assert.equal(dismissed, false, 'an unprotected install must not slip past unremarked');
    });

    it('dismisses normally when an existing login was adopted', async () => {
      const ctx = loadSetup({
        plan: ADOPT_PLAN,
        apiMutate: async () => ({
          ok: true, setupComplete: true, attached: [], warnings: [], restart: false,
          ingress: { action: 'adopt', provisioning: false, protection: 'existing', user: 'jason' }
        })
      });
      ctx.showWizard();
      await settle();
      await ctx.wizardComplete();
      await settle();
      assert.equal(ctx.wizard.provision, null, 'nothing to poll — the gate already exists');
    });
  });
});
