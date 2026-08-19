'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ENGINES_DIR = path.join(__dirname, '..', 'data', 'engines');

const profiles = fs.readdirSync(ENGINES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(ENGINES_DIR, f), 'utf8')));

const sessionsLib = require('../lib/sessions');

describe('Engine Launch Modes (#596)', () => {
  it('every engine with launchModes has a default mode', () => {
    for (const profile of profiles) {
      if (profile.launchModes) {
        assert.ok(profile.launchModes['default'], `${profile.id} is missing a 'default' launch mode`);
        assert.ok(profile.defaultLaunchMode, `${profile.id} is missing 'defaultLaunchMode' key`);
        assert.ok(profile.launchModes[profile.defaultLaunchMode], `${profile.id} defaultLaunchMode points to missing mode`);
      }
    }
  });

  it('maps each listed mode to the actual launch flags the engine binary accepts', () => {
    // Assert against _buildLaunchCommand so we prove the mode actually controls the flags,
    // not just that the JSON parsed correctly.
    for (const profile of profiles) {
      if (!profile.launchModes) continue;
      
      const baseCmd = profile.launch && profile.launch.shellCommand ? profile.launch.shellCommand : profile.id;
      
      for (const [key, mode] of Object.entries(profile.launchModes)) {
        if (mode.disabled) continue;
        const cmd = sessionsLib._buildLaunchCommand(profile, null, key);
        // It must return a string (something real)
        assert.ok(typeof cmd === 'string', `${profile.id} mode '${key}' must build a valid command`);
        
        // It must contain the base command
        assert.ok(cmd.startsWith(baseCmd), `${profile.id} mode '${key}' command must start with base binary`);
        
        // It must contain all the declared args
        const args = mode.args || [];
        for (const arg of args) {
          assert.ok(cmd.includes(arg), `${profile.id} mode '${key}' command must include arg: ${arg}`);
        }
      }
    }
  });

  it('Claude defines all 5 permission modes with correct flags', () => {
    const claude = profiles.find(p => p.id === 'claude');
    assert.ok(claude, 'Claude profile not found');
    const modes = claude.launchModes;
    
    // Test the actual commands built
    const cmdDefault = sessionsLib._buildLaunchCommand(claude, null, 'default');
    assert.equal(cmdDefault.includes('--permission-mode'), false, 'default must not pass a permission mode');
    
    const cmdAccept = sessionsLib._buildLaunchCommand(claude, null, 'acceptEdits');
    assert.ok(cmdAccept.includes('--permission-mode acceptEdits'), 'acceptEdits maps correctly');
    
    const cmdPlan = sessionsLib._buildLaunchCommand(claude, null, 'plan');
    assert.ok(cmdPlan.includes('--permission-mode plan'), 'plan maps correctly');
    
    const cmdAuto = sessionsLib._buildLaunchCommand(claude, null, 'auto');
    assert.ok(cmdAuto.includes('--permission-mode auto'), 'auto maps correctly');
    assert.ok(cmdAuto.includes('--enable-auto-mode'), 'auto includes --enable-auto-mode');
    
    const cmdBypass = sessionsLib._buildLaunchCommand(claude, null, 'bypassPermissions');
    assert.ok(cmdBypass.includes('--dangerously-skip-permissions'), 'bypass maps correctly');
    
    // Check bypass warning
    assert.match(modes.bypassPermissions.warning || '', /isolated environments/i);
    // Auto's description is SAFETY text — it is what an operator reads when
    // deciding how much autonomy to hand a session — so it is pinned on
    // substance rather than on exact prose, and the substance comes from the
    // binary rather than from intuition:
    //
    //   $ claude auto-mode defaults
    //     allow      -> 17 rules
    //     soft_deny  -> 66 rules
    //     hard_deny  ->  1 rule
    //
    // THREE outcomes, not two. Both previous descriptions got this wrong in
    // opposite directions: "Full autonomy with safety classifier" overstates
    // the autonomy (66 soft-deny rules is not full autonomy), and
    // "Auto-approves safe actions; prompts for dangerous ones" silently drops
    // hard_deny — actions the classifier REFUSES outright rather than prompting
    // for, which tells an operator they will be asked about anything risky when
    // they will not. The second was worse precisely because it was more
    // specific: a confident sentence is harder to doubt than a vague one.
    //
    // So: it must name the classifier (the binary's own vocabulary, and the
    // pointer to `claude auto-mode config` where the real rules live), and it
    // must not resurrect the full-autonomy claim.
    //
    // THE MUTATION THIS CATCHES: rewriting this description from intuition
    // without reading `claude auto-mode defaults` first.
    assert.match(modes.auto.description || '', /classifier/i,
      'auto is classifier-gated — the description must say so, so an operator knows where to look');
    assert.doesNotMatch(modes.auto.description || '', /full autonomy/i,
      'auto is not full autonomy: `claude auto-mode defaults` ships 66 soft-deny and 1 hard-deny rules');
  });
});
