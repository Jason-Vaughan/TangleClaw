'use strict';

/*
 * Shell safety of the hook commands TangleClaw generates (#1062).
 *
 * These commands are run by the engine through `/bin/sh -c`, and the install
 * path inside them is chosen by the operator. A directory name may legally
 * contain a space, `$`, a backtick, a double quote, a backslash and a single
 * quote — on macOS all six — so every one of them has to survive the trip.
 *
 * **The assertions run a real `/bin/sh`.** The failure mode here is "the string
 * looked quoted", and only a shell can say whether it was: the previous guards
 * asserted the command STARTED with a double quote, which is true of
 * `"$HOME/x"` — a string that still expands. An assertion on the shape of the
 * quoting can only ever confirm the quoting someone chose; an assertion on what
 * the script RECEIVED confirms the thing that matters. That distinction is the
 * whole content of the defect these tests replace, and the reason the older
 * shape-matching cases were rewritten rather than kept alongside.
 *
 * The command family is read from `_buildBaselineHooks` rather than listed, so
 * a third hook is covered the day it is added instead of the day someone
 * remembers to extend this file (#749: a guard for a class must exercise every
 * member the producer emits, not a sampled one).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const engines = require('../lib/engines');
const { shellWord, firstWord } = require('../lib/shell-word');
const { guardCommand, pinnedScript, GUARD_REL } = require('../scripts/install-primary-guard');

// Every character that breaks one of the quoting styles, in one directory name:
// a space (breaks bare), `$` and a backtick (survive single quotes only), a
// double quote and a backslash (break double quotes), and a single quote (the
// one character single-quoting must escape rather than contain).
const HOSTILE = `ho stile $HOME \`id\` "dq" back\\slash it's`;

const supportingProfile = {
  id: 'claude',
  silentPrimeScript: 'sessionstart-prime-claude.sh',
  silentRulesScript: 'sessionstart-rules-claude.sh',
  capabilities: { supportsSilentPrime: true }
};

describe('generated hook commands survive a hostile install path (#1062)', () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hooks-'));
    const installDir = path.join(root, HOSTILE);
    const hooksDir = path.join(installDir, 'data', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    // A stand-in for each real hook script: it reports the path it was invoked
    // as and its first argument, which is exactly what must arrive intact.
    for (const name of ['sessionstart-prime-claude.sh', 'sessionstart-rules-claude.sh']) {
      const p = path.join(hooksDir, name);
      fs.writeFileSync(p, '#!/bin/sh\nprintf "SELF=%s\\nARG=%s\\n" "$0" "$1"\n');
      fs.chmodSync(p, 0o755);
    }
  });

  after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  /**
   * Every command `_buildBaselineHooks` emits, resolved against the hostile
   * install directory — the real producer, not a hand-written sample.
   * @param {number} ruleShardCount - How many rules hooks to emit
   * @returns {string[]} Resolved command lines
   */
  function emittedCommands(ruleShardCount) {
    const installDir = path.join(root, HOSTILE);
    const baseline = engines._buildBaselineHooks(
      { silentPrime: true }, supportingProfile, ruleShardCount
    );
    const resolved = engines._resolveHooksObject(baseline, installDir);
    return resolved.SessionStart.flatMap((entry) => entry.hooks.map((h) => h.command));
  }

  it('emits at least the prime hook and one rules hook, so the sweep below is not empty', () => {
    // A vacuous harness is the failure this project keeps meeting: a loop over
    // an empty list passes every assertion inside it.
    assert.equal(emittedCommands(1).length, 2);
  });

  it('every emitted command runs, with the script path arriving whole', () => {
    const installDir = path.join(root, HOSTILE);
    const commands = emittedCommands(2);
    assert.equal(commands.length, 3, 'prime plus two rules shards');

    for (const cmd of commands) {
      const out = execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
      const self = /^SELF=(.*)$/m.exec(out)[1];

      assert.ok(self.startsWith(installDir),
        `the script must be invoked under the real install dir, got ${self}`);
      assert.ok(self.includes(HOSTILE),
        'every hostile character must survive into the path the script sees');
      assert.ok(fs.existsSync(self), 'and that path must be the file that exists on disk');
    }
  });

  it('the rules hook still receives its shard number as a separate argument', () => {
    // The quoting must make the PATH one word without swallowing the argument
    // after it — a fix that quoted the whole command line would pass every
    // assertion above and break this one.
    const commands = emittedCommands(2);
    const args = commands
      .map((cmd) => execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' }))
      .map((out) => /^ARG=(.*)$/m.exec(out)[1]);

    assert.deepEqual(args, ['', '1', '2'], 'prime takes none; each rules shard takes its index');
  });

  it('nothing in the path is expanded by the shell', () => {
    // `$HOME` and `` `id` `` are in the directory name. Under double quotes
    // both expand, and the resulting path does not exist — so this case fails
    // for the quoting style that shipped before, not merely for no quoting.
    const [primeCmd] = emittedCommands(0);
    const out = execFileSync('/bin/sh', ['-c', primeCmd], { encoding: 'utf8' });
    const self = /^SELF=(.*)$/m.exec(out)[1];

    assert.ok(self.includes('$HOME'), '`$HOME` must reach the script as four literal characters');
    assert.ok(self.includes('`id`'), 'and the backticks must not have been executed');
    assert.ok(!self.includes(os.homedir()), 'the tell that expansion happened');
  });

  it('no emitted command carries quoting of its own', () => {
    // The invariant this change exists to establish: the substitution owns the
    // quoting, so a site that adds its own would double-quote the path and
    // break it. Read from the UNRESOLVED producer, where a stray quote is
    // visible as a quote rather than as part of a rendered path.
    const baseline = engines._buildBaselineHooks({ silentPrime: true }, supportingProfile, 2);
    for (const entry of baseline.SessionStart) {
      for (const hook of entry.hooks) {
        assert.ok(!/["']/.test(hook.command),
          `an emission site must not quote the placeholder itself: ${hook.command}`);
      }
    }
  });
});

describe('the quoting change is safe for installs written before it (#1062)', () => {
  it('an already-written double-quoted entry is still recognised as TangleClaw\'s', () => {
    // Every project configured before this change carries the old form on disk.
    // If reconciliation stopped recognising it, the stale entry would be
    // preserved as foreign and the new one added beside it — two prime hooks,
    // firing twice per session. Ownership is a substring match on the script's
    // `data/hooks/` path, so it does not see quoting either way; this pins that
    // it does not start to.
    const legacy = {
      matcher: 'startup',
      hooks: [{ type: 'command', command: '"/old/install/data/hooks/sessionstart-prime-claude.sh"' }]
    };
    assert.ok(engines._isTangleClawHookEntry(legacy),
      'the pre-#1062 double-quoted entry must still read as ours, or it is never retired');

    const merged = engines._mergeBaselineHooks(
      { SessionStart: [legacy] },
      engines._resolveHooksObject(
        engines._buildBaselineHooks({ silentPrime: true }, supportingProfile, 0),
        '/new/install'
      )
    );
    assert.equal(merged.replacedOwn, 1, 'the old entry is replaced, not preserved beside the new one');
    assert.equal(merged.hooks.SessionStart.length, 1, 'exactly one prime hook survives');
    assert.ok(!merged.hooks.SessionStart[0].hooks[0].command.includes('/old/install'));
  });
});

describe('the OTHER generator of a hooks[].command is in the same family (#1062)', () => {
  it('the primary-checkout guard survives a hostile checkout path too', () => {
    // Found by review: this generator lives in `scripts/`, so a sweep scoped to
    // `lib/` missed it while it carried the identical double-quoted defect.
    // The family is "generates a hooks[].command", not "lives in lib".
    const primary = path.join(os.tmpdir(), HOSTILE);
    const cmd = guardCommand(primary);

    // `node <path> || true` with a path that does not resolve exits 0 via the
    // `|| true`, so run the argv through a shell that just echoes it instead.
    const echoed = execFileSync('/bin/sh', ['-c', cmd.replace(/^node /, 'printf %s ').replace(/ \|\| true$/, '')],
      { encoding: 'utf8' });
    assert.ok(echoed.startsWith(primary),
      `the guard path must reach node whole, got ${echoed}`);
    assert.ok(!echoed.includes(os.homedir()), '`$HOME` in the path must not have expanded');
  });
});

describe('the guard command round-trips through its own reader (#1062)', () => {
  // The generator and the reader are two halves of ONE invariant, in one file,
  // and changing the quoting broke the reader while leaving the writer correct:
  // `--check` then called a freshly-wired install STALE. A test of either half
  // alone cannot see that.
  for (const [label, dir] of [
    ['a hostile path', path.join(os.tmpdir(), HOSTILE)],
    ['an ordinary path', '/opt/tangleclaw'],
    ['a path with a single quote', "/opt/it's"]
  ]) {
    it(`reads back what it wrote for ${label}`, () => {
      const cmd = guardCommand(dir);
      assert.equal(pinnedScript(cmd), path.join(dir, GUARD_REL));
    });
  }

  it('still reads the double-quoted form already wired on existing machines', () => {
    // Those entries live in gitignored settings files that nothing migrates, so
    // the reader has to keep understanding them or it reports a working install
    // as broken.
    const legacy = `node "${path.join('/opt/tangleclaw', GUARD_REL)}" || true`;
    assert.equal(pinnedScript(legacy), path.join('/opt/tangleclaw', GUARD_REL));
  });

  it('reads nothing out of a command that invokes something else', () => {
    // The falsifying half: a reader that returned the first word regardless
    // would pass every case above while reporting a foreign hook as the guard.
    assert.equal(pinnedScript('node /somewhere/else.js || true'), null);
    assert.equal(pinnedScript(''), null);
  });
});

describe('shellWord round-trips through firstWord (#1062)', () => {
  // The property that makes the reader trustworthy: whatever the quoter emits,
  // the reader returns unchanged. Asserted over the same hostile set, because a
  // quoter and a reader that disagree on ONE character is exactly what turned a
  // freshly-wired guard into a STALE report.
  for (const [label, value] of [
    ['a space', 'a b'],
    ['a variable reference', '$HOME'],
    ['a backtick', '`id`'],
    ['a double quote', 'a"b'],
    ['a backslash', 'a\\b'],
    ['a single quote', "it's"],
    ['two single quotes', "it's o'clock"],
    ['all of them', HOSTILE],
    ['nothing at all', '']
  ]) {
    it(`survives ${label}`, () => {
      assert.equal(firstWord(shellWord(value)), value);
    });
  }
});

describe('shellWord (#1062)', () => {
  /**
   * Round-trip a value through the quoter and a real shell.
   * @param {string} value - The value to quote
   * @returns {string} What the shell passed to the command
   */
  function roundTrip(value) {
    const cmd = `printf %s ${shellWord(value)}`;
    return execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
  }

  for (const [label, value] of [
    ['a space', 'a b'],
    ['a variable reference', '$HOME'],
    ['a command substitution', '$(id)'],
    ['a backtick substitution', '`id`'],
    ['a double quote', 'a"b'],
    ['a backslash', 'a\\b'],
    ['a single quote', "it's"],
    ['several at once', HOSTILE],
    ['nothing at all', '']
  ]) {
    it(`passes ${label} through unchanged`, () => {
      assert.equal(roundTrip(value), value);
    });
  }
});
