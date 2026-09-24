'use strict';

/**
 * The context re-entry preamble (#1761): what a session reads first when the
 * engine re-fires the prime hook after `/clear` or a compaction.
 *
 * The properties that matter are the ones a re-entered session acts on: it is
 * told this is not a new launch, it is told how to re-read what it lost, and
 * the text makes no claim about where another hook's output landed, because
 * matching hooks run in parallel and that order is not knowable.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { renderReentryPreamble } = require('../lib/session-reentry');

describe('renderReentryPreamble (#1761)', () => {
  const text = renderReentryPreamble({ name: 'Some-Project' });

  it('says this is a re-entry into a running session, not a new launch', () => {
    assert.match(text, /^# Context re-entry — Some-Project\n/);
    assert.match(text, /\*\*not a new launch\*\*/);
    assert.match(text, /do not re-emit a resume proposal/);
    assert.match(text, /Do not re-emit its banner line/);
  });

  it('names the reads that recover the context, and when each applies', () => {
    assert.match(text, /Run `tc start status`/);
    assert.match(text, /re-read the launch context you attested with `tc start review`/);
    assert.match(text, /do not re-attest/);
    assert.match(text, /finish them with `tc start next`/);
    assert.match(text, /`tc rules` re-reads the project rules/);
  });

  it('keeps every gate binding and names the project the session owns', () => {
    assert.match(text, /ownership of \*\*Some-Project\*\*/);
    assert.match(text, /scope guard/);
    assert.match(text, /project rules and every confirmation gate/);
  });

  it('sends the session to the work in flight, not the launch handoff', () => {
    assert.match(text, /\.prawduct\/\.handoff-notes\.md/);
    assert.match(text, /operator's latest instruction/);
    assert.match(text, /work has moved since/);
  });

  it('stands on its own: nothing points at output from another hook', () => {
    // Matching hooks run in parallel, so the rules shards may land before or
    // after this text. A pointer to them by position would be wrong half the time.
    for (const pointer of [/\bbelow\b/i, /\babove\b/i, /that follow/i, /following rules/i]) {
      assert.doesNotMatch(text, pointer);
    }
  });

  it('survives a project with no name', () => {
    assert.match(renderReentryPreamble(null), /# Context re-entry — this project/);
  });
});
