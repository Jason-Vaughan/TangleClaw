'use strict';

// Startup rules delivery channel (#749) — the second channel that stops rules
// competing with the prime for one hook's output.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

const channel = require('../lib/session-rules-channel');

setLevel('error');

/** Rules with predictable sizes, in a deliberately non-sorted id order. */
function makeRules(specs) {
  return specs.map(([id, len]) => ({ id, content: `rule-${id}-` + 'x'.repeat(len) }));
}

describe('session rules channel (#749)', () => {
  describe('resolveChannelBudget', () => {
    it('uses what the engine declares', () => {
      assert.equal(
        channel.resolveChannelBudget({ capabilities: { startupInjection: { maxChars: 1234 } } }),
        1234
      );
    });

    it('falls back when nothing is declared, so one engine\'s declaration never moves another', () => {
      assert.equal(channel.resolveChannelBudget(null), channel.FALLBACK_CHANNEL_CHARS);
      assert.equal(channel.resolveChannelBudget({ capabilities: {} }), channel.FALLBACK_CHANNEL_CHARS);
    });

    it('refuses a malformed declaration rather than trusting it', () => {
      for (const bad of [0, -1, '10000', null]) {
        assert.equal(
          channel.resolveChannelBudget({ id: 'x', capabilities: { startupInjection: { maxChars: bad } } }),
          channel.FALLBACK_CHANNEL_CHARS,
          `${JSON.stringify(bad)} is not a budget`
        );
      }
    });

    it('does not apply a startup-hook limit to a payload that will not ride the hook', () => {
      const engine = { capabilities: { startupInjection: { maxChars: 500 } } };
      assert.equal(channel.resolveChannelBudget(engine, { viaStartupHook: false }),
        channel.FALLBACK_CHANNEL_CHARS);
    });
  });

  it('agrees with sessions.PRIME_MAX_TOKENS — two copies of one number', () => {
    // The fallback exists in token form in sessions.js and character form here.
    // Editing one alone would silently change what an undeclared engine gets.
    const sessions = require('../lib/sessions');
    assert.equal(sessions.PRIME_MAX_TOKENS * 4, channel.FALLBACK_CHANNEL_CHARS);
  });

  describe('buildShards', () => {
    it('keeps a set that fits in a single shard', () => {
      const shards = channel.buildShards(makeRules([[1, 100], [2, 100]]), 10000);
      assert.equal(shards.length, 1);
      assert.deepEqual(shards[0].ruleIds, [1, 2]);
      assert.equal(shards[0].total, 1);
    });

    it('splits across shards when the set outgrows one channel', () => {
      const shards = channel.buildShards(makeRules([[1, 400], [2, 400], [3, 400]]), 900);
      assert.ok(shards.length > 1, 'a set larger than one channel must shard');
      assert.ok(shards.every((s) => s.total === shards.length),
        'every shard reports the same total, so a missing one is visible');
    });

    it('never splits a rule across two shards', () => {
      const rules = makeRules([[1, 400], [2, 400], [3, 400]]);
      const shards = channel.buildShards(rules, 900);
      const delivered = shards.map((s) => s.body).join('\n');
      for (const rule of rules) {
        assert.ok(delivered.includes(rule.content),
          `rule ${rule.id} must arrive whole — half a rule reads as complete and is worse than a missing one`);
      }
    });

    it('delivers every rule exactly once across the shards', () => {
      const rules = makeRules([[3, 300], [1, 300], [2, 300], [4, 300]]);
      const shards = channel.buildShards(rules, 800);
      const ids = shards.flatMap((s) => s.ruleIds);
      assert.deepEqual([...ids].sort((a, b) => a - b), [1, 2, 3, 4]);
      assert.equal(new Set(ids).size, ids.length, 'no rule is delivered twice');
    });

    it('produces the same split for the same set, every time', () => {
      const rules = makeRules([[5, 300], [1, 300], [3, 300], [2, 300]]);
      const a = channel.buildShards(rules, 800).map((s) => s.ruleIds);
      const b = channel.buildShards(rules.slice().reverse(), 800).map((s) => s.ruleIds);
      assert.deepEqual(a, b,
        'ordering is by rule id, so input order cannot change what a session receives');
    });

    it('gives an oversized rule its own shard rather than dropping it', () => {
      const rules = makeRules([[1, 50], [2, 5000]]);
      const shards = channel.buildShards(rules, 900);
      const delivered = shards.map((s) => s.body).join('\n');
      assert.ok(delivered.includes(rules[1].content),
        'a rule too large for any shard is still delivered whole');
    });

    it('returns nothing for an empty or blank-only set', () => {
      assert.deepEqual(channel.buildShards([], 10000), []);
      assert.deepEqual(channel.buildShards([{ id: 1, content: '   \n\t ' }], 10000), []);
      assert.deepEqual(channel.buildShards(null, 10000), []);
    });
  });

  describe('renderShardPayload', () => {
    it('is valid JSON even when a rule contains quotes, backslashes and newlines', () => {
      // The reason TangleClaw writes the envelope and the hook only cats it:
      // escaping operator prose in shell is where a naive version corrupts a rule.
      const nasty = 'Never write "x" \\ y\nor `z` — use $VAR, — and 😀';
      const shards = channel.buildShards([{ id: 1, content: nasty }], 10000);
      const payload = channel.renderShardPayload(channel.renderShardText(shards[0], 1));
      const parsed = JSON.parse(payload);
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.ok(parsed.hookSpecificOutput.additionalContext.includes(nasty));
    });

    it('carries additionalContext, the field documented to accumulate across hooks', () => {
      const shards = channel.buildShards(makeRules([[1, 10]]), 10000);
      const parsed = JSON.parse(channel.renderShardPayload(channel.renderShardText(shards[0], 1)));
      assert.ok(typeof parsed.hookSpecificOutput.additionalContext === 'string');
    });
  });

  describe('renderShardText', () => {
    it('names the slice it carries so a missing shard is visible in what arrived', () => {
      const shards = channel.buildShards(makeRules([[1, 400], [2, 400], [3, 400]]), 900);
      const texts = shards.map((s) => channel.renderShardText(s, 3));
      texts.forEach((t, i) => {
        assert.match(t, new RegExp(`part ${i + 1} of ${shards.length}`));
      });
    });

    it('states the total when a single shard carries everything', () => {
      const shards = channel.buildShards(makeRules([[1, 10], [2, 10]]), 10000);
      assert.match(channel.renderShardText(shards[0], 2), /all 2/);
    });
  });

  describe('writeShards / pruneShards', () => {
    let dir;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rules-chan-')); });
    after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

    it('writes one payload per shard, readable as JSON', () => {
      const shards = channel.buildShards(makeRules([[1, 400], [2, 400], [3, 400]]), 900);
      const res = channel.writeShards(dir, shards, 3);
      assert.equal(res.written, shards.length);
      for (let i = 1; i <= shards.length; i += 1) {
        const parsed = JSON.parse(fs.readFileSync(channel.shardPath(dir, i), 'utf8'));
        assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
      }
    });

    it('prunes shards left by a larger previous set', () => {
      // A stale shard is a live hook delivering rules the operator has since
      // changed, with nothing in the session to say the text is old.
      const many = channel.buildShards(makeRules([[1, 400], [2, 400], [3, 400], [4, 400]]), 900);
      channel.writeShards(dir, many, 4);
      const before = many.length;

      const few = channel.buildShards(makeRules([[1, 50]]), 10000);
      const res = channel.writeShards(dir, few, 1);

      assert.equal(res.written, 1);
      assert.equal(res.pruned, before - 1, 'every shard beyond the new set is removed');
      assert.equal(fs.existsSync(channel.shardPath(dir, 2)), false);
      assert.equal(fs.existsSync(channel.shardPath(dir, 1)), true);
    });

    it('removes everything when the project has no rules left', () => {
      channel.writeShards(dir, channel.buildShards(makeRules([[1, 50]]), 10000), 1);
      const removed = channel.pruneShards(dir, 0);
      assert.ok(removed >= 1);
      assert.equal(fs.existsSync(channel.shardPath(dir, 1)), false);
    });

    it('is silent about a project directory that has no .tangleclaw yet', () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rules-none-'));
      assert.equal(channel.pruneShards(empty, 0), 0);
      fs.rmSync(empty, { recursive: true, force: true });
    });
  });
});
