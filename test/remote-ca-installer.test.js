'use strict';

/**
 * `lib/remote-ca-installer.js` + `public/remote-ca-assist.js` (#400).
 *
 * Self-contained by design: no SSH, no Tailscale, no real remote process.
 * `executeStep`'s privilege boundary ("no silent escalation") is the part
 * worth the most scrutiny, so it gets the most cases.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const installer = require('../lib/remote-ca-installer');
const assist = require('../public/remote-ca-assist');
const https = require('../lib/https-setup');

describe('planInstall', () => {
  it('leads with a non-privileged staging step, then every platform\'s privileged trust-install step', () => {
    const plan = installer.planInstall({ caRootPath: '/Users/t/Library/Application Support/mkcert' });
    assert.equal(plan.steps[0].kind, 'stage-ca-file');
    assert.equal(plan.steps[0].privileged, false);
    const trust = plan.steps.slice(1);
    assert.equal(trust.length, installer.PLATFORMS.length);
    for (const step of trust) {
      assert.equal(step.kind, 'trust-install');
      assert.equal(step.privileged, true);
      assert.ok(installer.PLATFORMS.includes(step.platform));
    }
  });

  it('narrows to one platform\'s trust-install step when asked', () => {
    for (const platform of installer.PLATFORMS) {
      const plan = installer.planInstall({ caRootPath: '/caroot', platform });
      const trust = plan.steps.filter((s) => s.kind === 'trust-install');
      assert.equal(trust.length, 1);
      assert.equal(trust[0].platform, platform);
    }
  });

  it('falls back to every platform for an unrecognized or omitted platform', () => {
    assert.equal(installer.planInstall({ caRootPath: '/c' }).steps.filter((s) => s.kind === 'trust-install').length, 3);
    assert.equal(installer.planInstall({ caRootPath: '/c', platform: 'FreeBSD' }).steps.filter((s) => s.kind === 'trust-install').length, 3);
  });

  it('reads caRootPath and rootCaPath, and every trust command, from lib/https-setup.js — never duplicated here', () => {
    const trust = https.getRemoteTrustInstructions('/caroot');
    const plan = installer.planInstall({ caRootPath: '/caroot' });
    assert.equal(plan.caRootPath, trust.caRootPath);
    assert.equal(plan.rootCaPath, trust.rootCaPath);
    for (const step of plan.steps.filter((s) => s.kind === 'trust-install')) {
      const matching = trust.steps.find((s) => s.platform === step.platform);
      assert.equal(step.command, matching.command);
      assert.equal(step.label, matching.label);
    }
  });

  it('carries the staging step\'s caRootPath/rootCaPath in its detail', () => {
    const plan = installer.planInstall({ caRootPath: '/caroot' });
    assert.equal(plan.steps[0].detail.caRootPath, '/caroot');
    assert.match(plan.steps[0].detail.rootCaPath, /rootCA\.pem$/);
  });
});

describe('executeStep — the privilege boundary', () => {
  const plan = installer.planInstall({ caRootPath: '/caroot', platform: 'macOS' });
  const stageStep = plan.steps[0];
  const trustStep = plan.steps[1];

  it('runs a non-privileged step through hooks.copyFile', () => {
    let called = null;
    const result = installer.executeStep(stageStep, { copyFile: (s) => { called = s; return 'copied'; } });
    assert.equal(result.ok, true);
    assert.equal(result.executed, 'stage-ca-file');
    assert.equal(result.result, 'copied');
    assert.equal(called, stageStep);
  });

  it('refuses a non-privileged step with no copyFile hook', () => {
    assert.equal(installer.executeStep(stageStep, {}).code, 'MISSING_HOOK');
  });

  it('refuses a privileged step by default, handing back the exact command for a human', () => {
    const result = installer.executeStep(trustStep, {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PRIVILEGED_STEP_REQUIRES_HUMAN');
    assert.equal(result.command, trustStep.command);
  });

  it('refuses a privileged step even with runPrivileged supplied, if acknowledgePrivileged is not explicitly true', () => {
    let ran = false;
    const result = installer.executeStep(trustStep, { runPrivileged: () => { ran = true; } });
    assert.equal(result.code, 'PRIVILEGED_STEP_REQUIRES_HUMAN');
    assert.equal(ran, false, 'supplying the hook alone must never be enough to run it');

    const result2 = installer.executeStep(trustStep, { runPrivileged: () => { ran = true; } }, { acknowledgePrivileged: false });
    assert.equal(result2.code, 'PRIVILEGED_STEP_REQUIRES_HUMAN');
    assert.equal(ran, false);
  });

  it('refuses a privileged step when acknowledgePrivileged is true but no runPrivileged hook is given', () => {
    const result = installer.executeStep(trustStep, {}, { acknowledgePrivileged: true });
    assert.equal(result.code, 'PRIVILEGED_STEP_REQUIRES_HUMAN');
  });

  it('runs a privileged step only when BOTH runPrivileged and acknowledgePrivileged: true are given together', () => {
    let ranWith = null;
    const result = installer.executeStep(
      trustStep,
      { runPrivileged: (cmd) => { ranWith = cmd; return 'done'; } },
      { acknowledgePrivileged: true }
    );
    assert.equal(result.ok, true);
    assert.equal(result.executed, 'trust-install');
    assert.equal(result.result, 'done');
    assert.equal(ranWith, trustStep.command);
  });

  it('refuses an unrecognized step shape, and a non-object step', () => {
    assert.equal(installer.executeStep({ kind: 'nope' }, {}).code, 'UNKNOWN_STEP_KIND');
    assert.equal(installer.executeStep(null, {}).code, 'INVALID_INPUT');
    assert.equal(installer.executeStep('a string', {}).code, 'INVALID_INPUT');
  });
});

describe('public/remote-ca-assist.js — rendering (not yet wired into the wizard)', () => {
  it('describes a privileged step as needing a human, and a non-privileged one as assistant-runnable', () => {
    assert.match(assist.describePrivilegeBoundary({ privileged: true }), /admin\/sudo/);
    assert.match(assist.describePrivilegeBoundary({ privileged: false }), /assistant can run/);
  });

  it('renders every step with its label, and a command block only when the step has one', () => {
    const plan = installer.planInstall({ caRootPath: '/caroot', platform: 'Linux' });
    const html = assist.renderPlanSteps(plan);
    assert.match(html, /Copy the root CA to the target machine/);
    assert.match(html, /<strong>Linux<\/strong>/);
    assert.match(html, /<pre class="setup-https-code"><code>/);
    assert.equal((html.match(/setup-https-trust-step/g) || []).length, plan.steps.length);
  });

  it('escapes a hostile label and command rather than rendering them raw', () => {
    const hostile = { steps: [{ kind: 'trust-install', privileged: true, platform: '<img src=x onerror=1>', label: '<script>alert(1)</script>', command: '"; rm -rf /' }] };
    const html = assist.renderPlanSteps(hostile);
    assert.doesNotMatch(html, /<img|<script/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&quot;; rm -rf \//);
  });

  it('shows a plain message for an empty or malformed plan, never throwing', () => {
    assert.match(assist.renderPlanSteps({ steps: [] }), /No install steps to show/);
    assert.match(assist.renderPlanSteps({}), /No install steps to show/);
    assert.match(assist.renderPlanSteps(null), /No install steps to show/);
  });

  it('round-trips with the real planner\'s output for every platform', () => {
    for (const platform of installer.PLATFORMS) {
      const plan = installer.planInstall({ caRootPath: '/caroot', platform });
      const html = assist.renderPlanSteps(plan);
      assert.match(html, new RegExp(platform));
      assert.match(html, /Needs admin\/sudo on the target machine/);
      assert.match(html, /The assistant can run this step/);
    }
  });
});
