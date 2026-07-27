'use strict';

/*
 * #731 — every flag an engine profile declares must still exist in that
 * engine's installed CLI.
 *
 * The existing per-engine tests (e.g. test/antigravity-engine.test.js) assert
 * that a profile's `launchModes` args equal a literal list. That pins the JSON
 * against an accidental edit, but it is self-referential: it cannot notice the
 * upstream CLI *removing* a flag, because both sides of the assertion are the
 * same file. `data/engines/codex.json` declared `--full-auto` from #211, Codex
 * later dropped the flag, and every test stayed green for months while the
 * "Full Auto" mode could not start a session at all — `codex --full-auto` exits
 * 2 with "unexpected argument". A first-time Codex-only installer found it.
 *
 * This is the check #209's success criteria asked for and #211 did not deliver:
 * "Tests pin each engine's flag mapping so a future flag rename gets caught."
 *
 * Necessarily host-dependent. An engine that is not installed is skipped, not
 * failed — CI has no engines, so this can never be the only guard. What it does
 * buy is that the rot surfaces on any developer or operator machine that has the
 * engine, instead of surfacing as a dead session on a stranger's first install.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ENGINES_DIR = path.join(__dirname, '..', 'data', 'engines');

/**
 * Resolve an engine's binary, or null when it isn't installed on this host.
 * @param {string} command - Binary name from the profile
 * @returns {string|null}
 */
function resolveBinary(command) {
  try {
    return execFileSync('which', [command], { encoding: 'utf8', timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Ask the CLI's own parser whether it accepts these args.
 *
 * Searching `--help` text was the obvious oracle and it is wrong: Claude Code
 * accepts `--enable-auto-mode` but does not list it, so a help-text check
 * reports a false failure on a perfectly good profile. Only the parser knows
 * what the parser takes.
 *
 * `--help` is appended so the parser runs and then short-circuits — nothing is
 * executed, no agent starts, no session is created. That matters: these are the
 * exact argv TangleClaw would use to launch a real session.
 *
 * @param {string} command - Binary name
 * @param {string[]} args - Mode args to probe
 * @returns {{accepted: boolean, error: string}}
 */
function probeArgs(command, args) {
  try {
    execFileSync(command, [...args, '--help'], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { accepted: true, error: '' };
  } catch (err) {
    const stderr = String((err && err.stderr) || '');
    // A timeout or a missing binary is an inconclusive probe, not a rejection —
    // only an argument-parse complaint counts as a real failure.
    if (err && (err.code === 'ETIMEDOUT' || err.code === 'ENOENT')) {
      return { accepted: true, error: '' };
    }
    return { accepted: false, error: stderr.split('\n').find(Boolean) || `exit ${err && err.status}` };
  }
}

/**
 * Launch-mode arg lists worth probing — base launch args combined with each
 * mode's args, exactly as `_buildLaunchCommand` assembles them.
 * @param {object} profile - Parsed engine profile
 * @returns {Array<{mode: string, args: string[]}>}
 */
function modeArgSets(profile) {
  const base = (profile.launch && profile.launch.args) || [];
  return Object.entries(profile.launchModes || {})
    .map(([mode, cfg]) => ({ mode, args: [...base, ...((cfg && cfg.args) || [])] }))
    .filter((m) => m.args.length > 0);
}

const profiles = fs.readdirSync(ENGINES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(ENGINES_DIR, f), 'utf8')));

describe('engine launch flags exist in the installed CLI (#731)', () => {
  for (const profile of profiles) {
    describe(profile.id, () => {
      // The detection target, not `launch.shellCommand`. They agree for every
      // local engine, but OpenClaw dispatches over `ssh` — probing its modes
      // against the ssh binary would be meaningless. It declares no CLI args
      // today (its modes carry `bridgePermissionMode` instead, handled by
      // ClawBridge), so nothing is probed; keying on detection keeps that true
      // if args are ever added, rather than silently probing the wrong binary.
      const command = (profile.detection && profile.detection.strategy === 'which')
        ? profile.detection.target
        : null;

      for (const { mode, args } of modeArgSets(profile)) {
        it(`launch mode "${mode}" uses args the installed CLI accepts`, (t) => {
          if (!command || !resolveBinary(command)) {
            t.skip(`${command || profile.id} not installed on this host`);
            return;
          }

          const { accepted, error } = probeArgs(command, args);
          assert.ok(
            accepted,
            `${profile.id} launch mode "${mode}" declares \`${args.join(' ')}\` in `
            + `data/engines/${profile.id}.json, but \`${command}\` rejects it: ${error}\n`
            + 'The CLI has changed. A launch mode whose args the binary rejects cannot start a '
            + 'session at all — the pane dies immediately and the operator sees a session that '
            + 'never came up.'
          );
        });
      }
    });
  }

  it('covers at least one installed engine on this host', (t) => {
    // Guards the guard: if resolveBinary ever broke, every engine would skip and
    // the file would report green while checking nothing. On a machine with no
    // engines at all (CI) this legitimately skips too.
    const installed = profiles.filter((p) => {
      const command = (p.launch && p.launch.shellCommand) || p.command;
      return command && resolveBinary(command);
    });
    if (installed.length === 0) {
      t.skip('no engines installed on this host (expected in CI)');
      return;
    }
    assert.ok(installed.length > 0);
  });
});
