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

  it('stays within the prime budget it claims (~1KB order, hard cap 2700 chars)', () => {
    // Cap raised 2000 → 2600 for the tc bootstrap line (ambient-awareness
    // Chunk 04) — a deliberate budget decision, not drift: the live probe
    // proved PATH presence alone creates zero discovery intent, so the one
    // roster entry that names the discovery surface is the load-bearing one.
    // Raised again 2600 → 2700 on 2026-09-17 (Train 21): the bootstrap line
    // lists the verb roster, so `tc start` cost it seven characters. The list
    // grows with the roster by design — one source, every carrier — and this
    // headroom is for the next verb or two, not for prose.
    //
    // Raised again 2700 → 2800 on 2026-09-18 (#1619), and this one IS prose —
    // so it is recorded rather than absorbed. The bootstrap line used to tell a
    // session that a missing `tc` proved the pane was unmanaged. That is false:
    // the PATH floor is derived from the running installation directory, so
    // renaming it under a live server drops `tc` from PATH in a managed pane. A
    // session read the old wording, concluded its pane was unmanaged, and
    // reported that to two others. The replacement has to say three things the
    // old sentence did not — check the launch env, act only on verified
    // identity, and STOP rather than guess when the context is missing or
    // inconsistent — and it costs 28 characters more than the cap allowed.
    // ~150 characters of filler were cut from the same line first; the rest of
    // the increase buys the instruction that prevents the failure. Trimming the
    // stop-and-report clause to hit a round number would restore the defect in
    // a shorter sentence.
    const text = primer.buildEcosystemPrimerSection(CTX).join('\n');
    assert.ok(text.length < 2800,
      `section is ${text.length} chars — growing past 2800 needs a deliberate budget decision, not drift`);
  });

  it('carries the tc bootstrap line as an instruction with a stated consequence', () => {
    const text = primer.buildEcosystemPrimerSection(CTX).join('\n');
    assert.match(text, /tc capabilities/,
      'the roster must name the discovery verb — the probe proved PATH presence alone creates no intent');
    assert.match(text, /BEFORE concluding/,
      'an instruction, not a footnote — a line the agent skims is a vacuum too');
    assert.match(text, /fabricate/,
      'the consequence of skipping the check is stated, not implied');
    // #1619: this used to pin the opposite claim — that a missing `tc` MEANS
    // the pane is not TangleClaw-launched. It does not. The PATH floor is
    // derived from the running installation directory, so renaming that
    // directory under a live server drops `tc` from PATH in a pane that is
    // fully managed. A real session read the old wording, concluded its pane
    // was unmanaged, and reported that to two other sessions. What the line
    // must carry is the check that settles it.
    assert.match(text, /TANGLECLAW_API/,
      'the absence case must send the session to the launch context, not to a conclusion');
    assert.doesNotMatch(text, /is not found, this pane was not launched by TangleClaw/,
      'the false inference must not come back');
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

  it('a verb the operator switches on is primed while the switch is on, and the section stays within its budget (#2031)', () => {
    const { verbsFor } = require('../lib/tc-verbs');
    const switched = verbsFor('unprimed').filter((v) => v.primedBy);
    assert.deepEqual(switched.map((v) => [v.id, v.primedBy]), [['candidate', 'bridge-candidates']]);
    assert.ok(!primer.tcBootstrapLines('md').join('\n').includes('`candidate`'), 'off by default: nothing says how to find out, so nothing is switched on');
    try {
      primer.setSwitchReader(() => ['bridge-candidates']);
      assert.ok(verbsFor('pane', { switches: ['bridge-candidates'] }).some((v) => v.id === 'candidate'));
      // What is left unprimed with the switch on has no switch at all: `queue`
      // belongs to one project's group and is never in the list every pane carries.
      assert.deepEqual(verbsFor('unprimed', { switches: ['bridge-candidates'] }).map((v) => v.id), ['queue']);
      assert.ok(!verbsFor('pane', { switches: ['bridge-candidates'] }).some((v) => v.id === 'queue'));
      // The line itself follows only the switches it is handed. With none it
      // is the same whatever this install's switch says, which is what every
      // carrier written into a project gets.
      assert.ok(!primer.tcBootstrapLines('md').join('\n').includes('`candidate`'));
      assert.ok(!/\bcandidate\b/.test(primer.tcBootstrapLines('comment').join('\n')));
      assert.ok(primer.tcBootstrapLines('md', ['bridge-candidates']).join('\n').includes('`candidate`'));
      assert.ok(/\bcandidate\b/.test(primer.tcBootstrapLines('comment', ['bridge-candidates']).join('\n')));
      const on = primer.buildEcosystemPrimerSection(CTX).join('\n');
      assert.ok(on.length <= 2820, `with the switch on the section is ${on.length} chars; its cap is 2820`);
      assert.ok(on.includes('`candidate`'));
      // A switch nobody declared primes nothing.
      primer.setSwitchReader(() => ['something-else']);
      assert.ok(!primer.buildEcosystemPrimerSection(CTX).join('\n').includes('`candidate`'));
    } finally {
      primer.setSwitchReader(() => []);
    }
  });

  it('the switch has a budget of its own, named and bounded; the base budget is untouched (#2031)', () => {
    assert.deepEqual(primer.SECTION_BUDGET, { base: 2800, bySwitch: { 'bridge-candidates': 2820 } });
    assert.deepEqual([primer.sectionBudget([]), primer.sectionBudget(['bridge-candidates']), primer.sectionBudget(['something-else']),
      primer.sectionBudget(['something-else', 'bridge-candidates'])], [2800, 2820, 2800, 2820]);
    const section = (ctx) => primer.buildEcosystemPrimerSection(ctx).join('\n');
    const raw = (ctx, switches) => primer.renderEcosystemPrimerSection(ctx, switches).join('\n');
    try {
      // (1) Switched off: within the base budget, and exactly what it is with no switch reader at all.
      const off = section(CTX);
      assert.ok(off.length <= 2800, `${off.length}`);
      assert.equal(off, raw(CTX, []));
      assert.ok(!off.includes('`candidate`'));

      // (2) Switched on: within the switch's budget, names the verb, and differs in nothing else.
      primer.setSwitchReader(() => ['bridge-candidates']);
      const on = section(CTX);
      assert.ok(on.length <= 2820 && on.length > 2800, `${on.length}: over the base budget, within its own`);
      assert.equal(on.replace(', `candidate`', ''), off, 'the one difference is the verb in the list');

      // (3) Switched off again: back to the base budget, the verb gone.
      primer.setSwitchReader(() => []);
      assert.equal(section(CTX), off);

      // (4) Past its own budget the switch gives way: the section is rendered as if it were off.
      primer.setSwitchReader(() => ['bridge-candidates']);
      // A longer API origin makes the section longer; find where it crosses the cap.
      const padded = (n) => ({ ...CTX, apiOrigin: `${CTX.apiOrigin}/${'x'.repeat(n)}` });
      assert.ok(raw(padded(40), ['bridge-candidates']).length > raw(padded(0), ['bridge-candidates']).length, 'padding lengthens the section');
      let pad = 0;
      while (pad < 200 && raw(padded(pad + 1), ['bridge-candidates']).length <= 2820) pad += 1;
      const atCap = raw(padded(pad), ['bridge-candidates']).length;
      const overCap = raw(padded(pad + 1), ['bridge-candidates']).length;
      assert.ok(atCap <= 2820 && overCap >= 2821, `${atCap} then ${overCap}`);
      const logger = require('../lib/logger');
      const level = logger.getLevel();
      const lines = [];
      logger.setLevel('warn');
      logger.setConsoleStream({ write: (s) => { lines.push(String(s)); return true; } });
      try {
        const fellBack = primer.lastSwitchFallback();
        assert.ok(section(padded(pad)).includes('`candidate`'), 'at the cap it is still primed');
        assert.deepEqual([lines.length, primer.lastSwitchFallback()], [0, fellBack], 'and nothing is said: nothing was left out');
        assert.equal(section(padded(pad + 1)), raw(padded(pad + 1), []), 'one character past it, the verb is left out and nothing else changes');
        assert.ok(!section(padded(pad + 1)).includes('`candidate`'));
        // Leaving it out is said aloud, in numbers: the switch still reads as on.
        const said = lines.filter((l) => l.includes('rendered without the switch'));
        assert.equal(said.length, 2, 'once for each launch that fell back');
        assert.ok(said[0].includes('bridge-candidates') && said[0].includes(String(overCap)) && said[0].includes('2820') && said[0].includes('77'), said[0]);
        assert.ok(!said[0].includes('Operating basics'), 'none of the section\'s text is logged');
        const last = primer.lastSwitchFallback();
        assert.deepEqual([last.projectId, last.switches, last.length, last.cap], [77, ['bridge-candidates'], overCap, 2820]);
        // With no switch on there is nothing to leave out, however long the section is.
        primer.setSwitchReader(() => []);
        lines.length = 0;
        section(padded(pad + 400));
        assert.deepEqual([lines.length, primer.lastSwitchFallback()], [0, last]);
      } finally {
        logger.setConsoleStream(null);
        logger.setLevel(level);
      }
    } finally {
      primer.setSwitchReader(() => []);
    }
  });

  it('the bootstrap line derives its verb list from VERB_ROSTER — a new verb reaches every carrier by existing', () => {
    const { VERB_ROSTER } = require('../lib/tc-verbs');
    const md = primer.tcBootstrapLines('md').join('\n');
    const comment = primer.tcBootstrapLines('comment').join('\n');
    // Every verb a project pane can use is named. A verb only the Project
    // Master can use (#2031) is deliberately not: it would be refused in every
    // pane this line is read in.
    const { verbsFor } = require('../lib/tc-verbs');
    const forPanes = verbsFor('pane');
    assert.equal(forPanes.length + verbsFor('master').length + verbsFor('unprimed').length, VERB_ROSTER.length,
      'every roster entry belongs to exactly one audience');
    for (const v of verbsFor('unprimed')) {
      assert.ok(!md.includes(`\`${v.id}\``), `md form does not yet name the unprimed ${v.id}`);
    }
    assert.ok(forPanes.length > 0);
    for (const v of forPanes) {
      assert.ok(md.includes(`\`${v.id}\``), `md form names ${v.id}`);
      assert.ok(comment.includes(v.id), `comment form names ${v.id}`);
    }
    for (const v of VERB_ROSTER.filter((x) => x.audience === 'master')) {
      assert.ok(!md.includes(`\`${v.id}\``), `md form does not advertise the Master-only ${v.id}`);
      assert.ok(!new RegExp(`\\b${v.id}\\b`).test(comment), `comment form does not advertise the Master-only ${v.id}`);
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
