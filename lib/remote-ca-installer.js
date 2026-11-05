'use strict';

/**
 * Assisted remote CA-trust install (#400): a per-OS plan for trusting
 * TangleClaw's mkcert root CA on a remote machine, plus an executor that
 * draws a hard line between what the cross-session / Project Master
 * assistant may run itself and what it must hand a human.
 *
 * The constraint, from the issue: the trust-install step is privileged
 * (`sudo security add-trusted-cert`, `sudo update-ca-certificates`, an
 * elevated `Import-Certificate`) and needs a real terminal or admin on the
 * TARGET machine — a headless agent cannot answer a password prompt
 * (#399's no-TTY boundary). So the assistant may stage the non-privileged
 * part (copying `rootCA.pem` to the target) itself, but the privileged
 * command is always handed to a human to run, or to a pre-authorized
 * elevation path a caller supplies explicitly and names as such. Nothing
 * here silently escalates: `executeStep` refuses a privileged step unless
 * the caller passes both a `runPrivileged` hook AND a separate, explicit
 * `acknowledgePrivileged: true` in the same call.
 *
 * Self-contained: no SSH, no Tailscale, no real remote execution. The
 * `copyFile`/`runPrivileged` hooks are the caller's own transport,
 * supplied at the call site — Slice 2 (`#2886`) is where a real one gets
 * wired to the cross-session assistant and the setup wizard.
 *
 * The per-OS command text itself is not duplicated here: it is read from
 * `lib/https-setup.js#getRemoteTrustInstructions`, the wizard's own
 * existing source for it, so the two surfaces can never drift apart.
 *
 * @module lib/remote-ca-installer
 */

const { getRemoteTrustInstructions } = require('./https-setup');

/** The platforms a trust-install step can target, as `lib/https-setup.js` names them. */
const PLATFORMS = Object.freeze(['macOS', 'Linux', 'Windows']);

/**
 * Build the install plan for one target: a non-privileged staging step,
 * then the privileged trust-install command(s). When `platform` is one of
 * `PLATFORMS`, the plan carries only that platform's trust-install step;
 * omitted or unrecognized, it carries all three, for a caller that does not
 * yet know the target's OS.
 *
 * @param {object} input - `{caRootPath, platform?}`. `caRootPath` is the
 *   mkcert CAROOT directory on THIS (the TangleClaw host) machine.
 * @returns {{caRootPath: string, rootCaPath: string, steps: Array<object>}}
 */
function planInstall(input) {
  const i = input || {};
  const trust = getRemoteTrustInstructions(i.caRootPath);
  const trustSteps = (PLATFORMS.includes(i.platform) ? trust.steps.filter((s) => s.platform === i.platform) : trust.steps)
    .map((s) => ({ kind: 'trust-install', privileged: true, platform: s.platform, label: s.label, command: s.command }));
  const stageStep = {
    kind: 'stage-ca-file', privileged: false,
    label: 'Copy the root CA to the target machine',
    detail: { caRootPath: trust.caRootPath, rootCaPath: trust.rootCaPath }
  };
  return { caRootPath: trust.caRootPath, rootCaPath: trust.rootCaPath, steps: [stageStep, ...trustSteps] };
}

/**
 * Execute one step of a plan from `planInstall`.
 *
 * A non-privileged step (`stage-ca-file`) runs through `hooks.copyFile`,
 * the caller's own transport — this module never reaches a network or a
 * filesystem itself. A privileged step (`trust-install`) is refused by
 * default: it is handed back as the command for a human to run, never
 * executed. The ONLY way it runs here is both of: `hooks.runPrivileged`
 * supplied, AND `input.acknowledgePrivileged === true` passed in the SAME
 * call — a caller that wires up `runPrivileged` without also setting this
 * flag still gets the handoff refusal, by design.
 *
 * @param {object} step - One entry from `planInstall(...).steps`.
 * @param {object} hooks - `{copyFile?(step): *, runPrivileged?(command: string): *}`.
 * @param {object} [input] - `{acknowledgePrivileged?: boolean}`.
 * @returns {{ok: true, executed: 'stage-ca-file'|'trust-install', result: *}
 *   |{ok: false, code: 'PRIVILEGED_STEP_REQUIRES_HUMAN', command: string, message: string}
 *   |{ok: false, code: string, message: string}}
 */
function executeStep(step, hooks, input) {
  const h = hooks || {};
  if (!step || typeof step !== 'object') {
    return { ok: false, code: 'INVALID_INPUT', message: 'step must be one entry from planInstall(...).steps.' };
  }
  if (step.kind === 'stage-ca-file') {
    if (typeof h.copyFile !== 'function') {
      return { ok: false, code: 'MISSING_HOOK', message: 'A stage-ca-file step needs hooks.copyFile.' };
    }
    return { ok: true, executed: 'stage-ca-file', result: h.copyFile(step) };
  }
  if (step.kind === 'trust-install') {
    const acknowledged = !!(input && input.acknowledgePrivileged === true);
    if (typeof h.runPrivileged !== 'function' || !acknowledged) {
      return {
        ok: false, code: 'PRIVILEGED_STEP_REQUIRES_HUMAN', command: step.command,
        message: 'This step needs admin/sudo on the target machine. Run it there yourself, or supply both '
          + 'hooks.runPrivileged and acknowledgePrivileged: true to use a pre-authorized elevation path.'
      };
    }
    return { ok: true, executed: 'trust-install', result: h.runPrivileged(step.command) };
  }
  return { ok: false, code: 'UNKNOWN_STEP_KIND', message: `step.kind must be one of "stage-ca-file" or "trust-install", got ${JSON.stringify(step.kind)}.` };
}

module.exports = {
  PLATFORMS,
  planInstall,
  executeStep
};
