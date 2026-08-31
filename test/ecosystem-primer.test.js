'use strict';

// Tests for lib/ecosystem-primer.js (#1122 — birth-awareness primer).
// The section exists so a brand-new session needs no cross-session tutorial:
// it must carry the API origin, the NUMERIC project id (the #1121 trap), the
// MagicDNS link convention, the Project Rules gate, the learnings loop, and
// PortHub — rendered from the declared roster, engine-agnostic, budget-small.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const primer = require('../lib/ecosystem-primer');

const CTX = {
  projectId: 77,
  projectName: 'Some-Project',
  apiOrigin: 'http://localhost:3102',
  operatorHost: 'example-host.tail0000.ts.net'
};

describe('lib/ecosystem-primer (#1122)', () => {
  it('roster items are well-formed with unique ids', () => {
    assert.ok(primer.ECOSYSTEM_ROSTER.length >= 5, 'the ratified roster has at least its five founding facts');
    const ids = primer.ECOSYSTEM_ROSTER.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, 'roster ids must be unique');
    for (const item of primer.ECOSYSTEM_ROSTER) {
      assert.equal(typeof item.id, 'string');
      assert.equal(typeof item.render, 'function');
      assert.equal(typeof item.render(CTX), 'string');
    }
  });

  it('renders one bullet per roster item under the section heading', () => {
    const lines = primer.buildEcosystemPrimerSection(CTX);
    assert.equal(lines[0], '## TangleClaw Ecosystem');
    const bullets = lines.filter((l) => l.startsWith('- '));
    assert.equal(bullets.length, primer.ECOSYSTEM_ROSTER.length,
      'every roster item renders exactly one bullet — the roster IS the section');
  });

  it('interpolates the numeric project id, API origin, and operator host', () => {
    const text = primer.buildEcosystemPrimerSection(CTX).join('\n');
    assert.match(text, /numeric project id is 77/,
      'the #1121 trap: the id must be handed to the session, stated as numeric');
    assert.ok(text.includes('http://localhost:3102'));
    assert.ok(text.includes('example-host.tail0000.ts.net'),
      'the MagicDNS convention must name the real host, not describe it abstractly');
    assert.match(text, /projectId":77|projectId=77/,
      'the session-rules examples must carry the resolved id, ready to use');
  });

  it('states the rules approval gate honestly', () => {
    const text = primer.buildEcosystemPrimerSection(CTX).join('\n');
    assert.match(text, /proposed/, 'AI-authored rules land as proposals');
    assert.match(text, /operator approves/i, 'and inject nothing until approved');
  });

  it('is engine-agnostic — no engine config filename or engine-specific capability named', () => {
    const text = primer.buildEcosystemPrimerSection(CTX).join('\n');
    assert.doesNotMatch(text, /CLAUDE\.md|GEMINI\.md|\.aider|codex|antigravity/i,
      'per the engine-agnostic rule, prompt text must not bake in one engine\'s filename');
  });

  it('stays within the prime budget it claims (~1KB order, hard cap 2000 chars)', () => {
    const text = primer.buildEcosystemPrimerSection(CTX).join('\n');
    assert.ok(text.length < 2000,
      `section is ${text.length} chars — growing past 2000 needs a deliberate budget decision, not drift`);
  });

  it('the yield pointer preserves the two non-rediscoverable identifiers', () => {
    const pointer = primer.ecosystemPrimerPointer(CTX);
    assert.match(pointer, /numeric project id is 77/);
    assert.ok(pointer.includes('http://localhost:3102'));
    assert.ok(pointer.length < 400, 'a pointer that needs no yield is not a pointer');
  });
});
