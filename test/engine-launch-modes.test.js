'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ENGINES_DIR = path.join(__dirname, '..', 'data', 'engines');

const profiles = fs.readdirSync(ENGINES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(ENGINES_DIR, f), 'utf8')));

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

  it('Claude defines all 5 permission modes with correct flags', () => {
    const claude = profiles.find(p => p.id === 'claude');
    assert.ok(claude, 'Claude profile not found');
    const modes = claude.launchModes;
    
    assert.deepEqual(modes.default.args, []);
    assert.deepEqual(modes.acceptEdits.args, ['--permission-mode', 'acceptEdits']);
    assert.deepEqual(modes.plan.args, ['--permission-mode', 'plan']);
    assert.deepEqual(modes.auto.args, ['--permission-mode', 'auto', '--enable-auto-mode']);
    assert.deepEqual(modes.bypassPermissions.args, ['--dangerously-skip-permissions']);
    
    // Check bypass warning
    assert.match(modes.bypassPermissions.warning || '', /isolated environments/i);
    // Check auto description
    assert.match(modes.auto.description || '', /full autonomy with safety classifier/i);
  });
  
  it('Codex defines the expected launch modes', () => {
    const codex = profiles.find(p => p.id === 'codex');
    if (codex && codex.launchModes) {
      assert.ok(codex.launchModes.default);
    }
  });
});
