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

  it('gives every session Medusa awareness, keyed to its own prime rather than duplicating the full section', () => {
    // Opted-in sessions get the complete '## Medusa Switchboard' section with
    // their workspace id; this roster item exists for the OTHER sessions —
    // they must at least know the switchboard exists, how to tell they are
    // not in it, and that the fix is an operator opt-in, not self-registration.
    const text = primer.buildEcosystemPrimerSection(CTX).join('\n');
    assert.match(text, /Medusa/, 'the switchboard must be birth knowledge on every project');
    assert.match(text, /## Medusa Switchboard/,
      'opt-in status is answered by pointing at the dedicated section, not restating it');
    assert.match(text, /never register your own listener/i,
      'the one hard rule worth carrying even at awareness level');
    assert.match(text, /not opted in/,
      'absence of the section must be explained, or a session invents its own theory');
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

  it('stays within the prime budget it claims (~1KB order, hard cap 2600 chars)', () => {
    // Cap raised 2000 → 2600 for the tc bootstrap line (ambient-awareness
    // Chunk 04) — a deliberate budget decision, not drift: the live probe
    // proved PATH presence alone creates zero discovery intent, so the one
    // roster entry that names the discovery surface is the load-bearing one.
    const text = primer.buildEcosystemPrimerSection(CTX).join('\n');
    assert.ok(text.length < 2600,
      `section is ${text.length} chars — growing past 2600 needs a deliberate budget decision, not drift`);
  });

  it('carries the tc bootstrap line as an instruction with a stated consequence', () => {
    const text = primer.buildEcosystemPrimerSection(CTX).join('\n');
    assert.match(text, /tc capabilities/,
      'the roster must name the discovery verb — the probe proved PATH presence alone creates no intent');
    assert.match(text, /BEFORE concluding/,
      'an instruction, not a footnote — a line the agent skims is a vacuum too');
    assert.match(text, /fabricate/,
      'the consequence of skipping the check is stated, not implied');
    assert.match(text, /not launched by TangleClaw/,
      'the one honest absence case: tc missing means the pane is not TangleClaw-launched');
  });

  it('says a failed localhost tc/curl is not proof of outage, in both forms (#1150)', () => {
    // A Codex session read its own sandbox-blocked loopback as "port 3102 is
    // down" and told the operator so. The guide the session reads carries the
    // correction ahead of the failure.
    for (const form of ['md', 'comment']) {
      // The comment form word-wraps after a variable-length verb list, so the
      // sentence is read with its line breaks and `#` prefixes collapsed —
      // the assertion is about the words, not where the wrap fell.
      const text = primer.tcBootstrapLines(form).join(' ').replace(/(^|\s)#\s*/g, ' ').replace(/\s+/g, ' ');
      assert.match(text, /not proof of outage/, `${form}: the claim is bounded`);
      assert.match(text, /host-context check/, `${form}: and the next step is named`);
    }
  });

  it('the bootstrap line derives its verb list from VERB_ROSTER — a new verb reaches every carrier by existing', () => {
    const { VERB_ROSTER } = require('../lib/tc-verbs');
    const md = primer.tcBootstrapLines('md').join('\n');
    const comment = primer.tcBootstrapLines('comment').join('\n');
    for (const v of VERB_ROSTER) {
      assert.ok(md.includes(`\`${v.id}\``), `md form names ${v.id}`);
      assert.ok(comment.includes(v.id), `comment form names ${v.id}`);
    }
  });

  it('tcBootstrapLines comment form is #-prefixed plain text with the same instruction', () => {
    const lines = primer.tcBootstrapLines('comment');
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.ok(line.startsWith('#'), `comment-form line must be #-prefixed: ${line}`);
      assert.doesNotMatch(line, /\*\*/, 'comment carriers cannot render markdown emphasis');
    }
    const text = lines.join('\n');
    assert.match(text, /tc capabilities/);
    assert.match(text, /fabricate/);
  });

  it('the yield pointer preserves the two non-rediscoverable identifiers and the tc verb (§5)', () => {
    const pointer = primer.ecosystemPrimerPointer(CTX);
    assert.match(pointer, /numeric project id is 77/);
    assert.ok(pointer.includes('http://localhost:3102'));
    assert.match(pointer, /tc capabilities/,
      'omission visible in the payload: the dropped section is replaced by the verb that recovers it');
    assert.ok(pointer.length < 400, 'a pointer that needs no yield is not a pointer');
  });
});
