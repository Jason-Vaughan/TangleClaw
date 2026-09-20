'use strict';

/**
 * `tc.handoff/1` document contract (Train 21, #1585).
 *
 * The invariant every other part of the handoff rests on: the bytes are frozen
 * at staging, so the digest taken at staging is the digest of what is later
 * published. These tests pin that, plus the two honesty rules the document
 * enforces on its own contents.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  HANDOFF_SCHEMA,
  newPublicationId,
  serializeDocument,
  digestOf,
  buildHandoffDocument,
  readDocument
} = require('../lib/handoff-publication.js');

/**
 * A complete, valid document input. Tests override one field at a time so a
 * failure names the field rather than the fixture.
 * @param {object} [over] - Fields to override
 * @returns {object} Input for `buildHandoffDocument`
 */
function input(over = {}) {
  return {
    publicationId: 'pub-fixed-id',
    projectId: 14,
    workspaceId: 'tangleclaw-builder-b714315f',
    sessionId: 1018,
    wrapRunId: 'run-1',
    engineId: 'claude',
    kind: 'final',
    stagedAt: '2026-09-17T21:00:00.000Z',
    worktree: {
      path: '/abs', toplevel: '/abs', gitDir: '/abs/.git',
      branch: 'main', headSha: 'deadbeef', dirty: false
    },
    rules: [{ id: 12, source: 'project', revision: 3, contentHash: 'abc' }],
    globalRulesHash: 'g1',
    engineConfigHash: 'e1',
    continuityIndexHash: 'c1',
    wrapOutcome: 'complete',
    missingEvidence: [],
    nextAction: 'build chunk 03',
    planRef: '/abs/plan.md',
    ...over
  };
}

describe('the tc.handoff/1 document (Train 21, #1585)', () => {
  it('tags its schema so a reader never has to infer what it is', () => {
    assert.equal(buildHandoffDocument(input()).schema, HANDOFF_SCHEMA);
  });

  it('serializes the same input to the same bytes, which is what makes the staged digest the published digest', () => {
    const a = serializeDocument(buildHandoffDocument(input()));
    const b = serializeDocument(buildHandoffDocument(input()));
    assert.equal(a, b);
    assert.equal(digestOf(a), digestOf(b));
  });

  it('carries no publication time, so publishing never has to rewrite the bytes', () => {
    const doc = buildHandoffDocument(input());
    assert.ok(!('publishedAt' in doc), 'publication time belongs in the DB, not the frozen document');
    assert.equal(doc.stagedAt, '2026-09-17T21:00:00.000Z');
  });

  it('refuses a degraded wrap that does not name what degraded', () => {
    assert.throws(
      () => buildHandoffDocument(input({ wrapOutcome: 'degraded', missingEvidence: [] })),
      /must name what degraded/
    );
  });

  it('refuses a complete wrap that carries missing evidence', () => {
    assert.throws(
      () => buildHandoffDocument(input({ wrapOutcome: 'complete', missingEvidence: ['learnings-capture: failed'] })),
      /cannot carry missing evidence/
    );
  });

  it('accepts a degraded wrap that names its non-ok steps', () => {
    const doc = buildHandoffDocument(input({
      wrapOutcome: 'degraded',
      missingEvidence: ['learnings-capture: failed']
    }));
    assert.deepEqual(doc.missingEvidence, ['learnings-capture: failed']);
  });

  it('refuses a kind that is not final or checkpoint', () => {
    assert.throws(() => buildHandoffDocument(input({ kind: 'draft' })), /handoff kind must be one of/);
  });

  it('copies the caller\'s arrays, so a later mutation cannot change bytes already digested', () => {
    const rules = [{ id: 1, source: 'project', revision: 1, contentHash: 'x' }];
    const doc = buildHandoffDocument(input({ rules }));
    const before = digestOf(serializeDocument(doc));
    rules.push({ id: 2, source: 'global', revision: 1, contentHash: 'y' });
    assert.equal(digestOf(serializeDocument(doc)), before, 'the document must not alias the caller\'s array');
  });

  it('defaults the optional references to null rather than dropping the keys', () => {
    const doc = buildHandoffDocument(input({
      workspaceId: undefined, worktree: undefined,
      globalRulesHash: undefined, nextAction: undefined, planRef: undefined
    }));
    assert.equal(doc.workspaceId, null);
    assert.equal(doc.worktree, null, 'a non-git root is null, not absent');
    assert.equal(doc.globalRulesHash, null);
    assert.equal(doc.nextAction, null);
    assert.equal(doc.planRef, null);
  });
});

describe('minting a publication id', () => {
  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newPublicationId()));
    assert.equal(ids.size, 500);
  });

  it('is base64url, so it is safe in a filename', () => {
    assert.match(newPublicationId(), /^[A-Za-z0-9_-]+$/);
  });
});

describe('reading handoff bytes back', () => {
  const bytes = serializeDocument(buildHandoffDocument(input()));

  it('reports ok with the parsed document and its digest', () => {
    const read = readDocument(bytes);
    assert.equal(read.outcome, 'ok');
    assert.equal(read.doc.publicationId, 'pub-fixed-id');
    assert.equal(read.digest, digestOf(bytes));
    assert.equal(read.reason, null);
  });

  it('tells absent apart from corrupt, because only one of them is repairable', () => {
    assert.equal(readDocument(null).outcome, 'absent');
    assert.equal(readDocument('{not json').outcome, 'corrupt');
  });

  it('names WHY a file is corrupt rather than answering with a bare false', () => {
    assert.match(readDocument('{not json').reason, /not JSON/);
    assert.match(readDocument('{"schema":"tc.handoff/0"}').reason, /expected tc\.handoff\/1/);
    assert.match(readDocument(`{"schema":"${HANDOFF_SCHEMA}"}`).reason, /no publicationId/);
    assert.match(
      readDocument(`{"schema":"${HANDOFF_SCHEMA}","publicationId":"p","kind":"draft"}`).reason,
      /kind is "draft"/
    );
  });

  it('digests corrupt bytes too, so a caller can tell one bad file from another', () => {
    assert.equal(readDocument('{not json').digest, digestOf('{not json'));
  });

  it('treats a JSON non-object as corrupt rather than reading fields off it', () => {
    assert.equal(readDocument('"a string"').outcome, 'corrupt');
    assert.equal(readDocument('null').outcome, 'corrupt');
  });
});

/*
 * #1649 — the document must say which kind of "no worktree" it means.
 *
 * `worktree: null` is defined as "this root is not a git repository", and the
 * launch reads it as licence to skip both workspace checks on the way to `ok`.
 * The producer wrote the same null when its git probe merely failed, so a
 * timed-out probe froze the most reassuring possible claim about a tree nobody
 * measured. `worktreeProblem` is the discriminator; these pin both ends of it.
 */
describe('worktree: null says which kind of nothing it is (#1649)', () => {
  it('carries a probe failure beside the null', () => {
    const doc = buildHandoffDocument(input({ worktree: null, worktreeProblem: 'git could not be run: timed out' }));
    assert.equal(doc.worktree, null);
    assert.equal(doc.worktreeProblem, 'git could not be run: timed out');
    assert.equal(readDocument(serializeDocument(doc)).outcome, 'ok');
  });

  it('writes a bare null for a project that simply has no git', () => {
    const doc = buildHandoffDocument(input({ worktree: null }));
    assert.equal(doc.worktree, null);
    assert.equal(doc.worktreeProblem, null,
      'the field must be present and null, so a reader never has to guess at an absent key');
  });

  it('normalizes a blank reason to none, so a null is never ambiguous a third way', () => {
    // A producer that meant to name a reason and had nothing to say would
    // otherwise write a value that reads as a failure to anything testing
    // presence and as a non-repo to anything reading the text.
    for (const blank of ['', '   ']) {
      assert.equal(buildHandoffDocument(input({ worktree: null, worktreeProblem: blank })).worktreeProblem, null);
    }
  });

  it('refuses a document claiming it both read the tree and could not', () => {
    assert.throws(
      () => buildHandoffDocument(input({ worktreeProblem: 'git could not be run' })),
      /cannot record worktree facts and a probe failure at once/
    );
  });

  it('reads a pre-#1649 document, which has no such field at all, as a non-git project', () => {
    // Every document written before this change omits the key. Absent must keep
    // meaning what it has always meant, or the fix would push every existing
    // handoff into reconciliation on first read.
    const doc = buildHandoffDocument(input({ worktree: null }));
    const legacy = JSON.parse(serializeDocument(doc));
    delete legacy.worktreeProblem;
    const read = readDocument(JSON.stringify(legacy));
    assert.equal(read.outcome, 'ok');
    assert.equal(read.doc.worktreeProblem, undefined);
  });
});

describe('the worktree block is validated, not trusted (#1649)', () => {
  /** Serialize a valid document with its worktree block replaced.
   * @param {object} over - fields to splice into the parsed document
   * @returns {string} the mutated bytes */
  function bytesWith(over) {
    const doc = JSON.parse(serializeDocument(buildHandoffDocument(input())));
    return JSON.stringify({ ...doc, ...over });
  }

  it('rejects a worktree object missing the paths every reader indexes into it for', () => {
    // A truthy `worktree` sends the launch into checks 13/14, which read
    // `toplevel` to report which tree moved. Undefined there names a worktree
    // the document never had — and the bytes are frozen, so nothing can ask.
    assert.match(readDocument(bytesWith({ worktree: { path: '/abs' } })).reason, /worktree\.toplevel/);
    assert.match(readDocument(bytesWith({ worktree: { toplevel: '/abs' } })).reason, /worktree\.path/);
    assert.match(readDocument(bytesWith({ worktree: { path: '', toplevel: '' } })).reason, /expected a path/);
  });

  it('rejects a worktree that is not an object at all', () => {
    for (const bad of ['/abs', 42, true, ['/abs']]) {
      assert.equal(readDocument(bytesWith({ worktree: bad })).outcome, 'corrupt', `worktree: ${JSON.stringify(bad)}`);
    }
  });

  it('rejects a non-reason worktreeProblem', () => {
    assert.match(readDocument(bytesWith({ worktree: null, worktreeProblem: 7 })).reason, /expected a reason or null/);
    assert.match(readDocument(bytesWith({ worktree: null, worktreeProblem: '  ' })).reason, /expected a reason or null/);
  });

  it('rejects bytes carrying both facts and a failure, whatever produced them', () => {
    // `buildHandoffDocument` refuses to write this pair, so a reader meets it
    // only in bytes something else made — and has no safe way to pick a side.
    assert.match(readDocument(bytesWith({ worktreeProblem: 'git timed out' })).reason, /records facts and worktreeProblem/);
  });
});
