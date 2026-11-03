'use strict';

// #2016, #2396 (Architect Rulings A2016, A2396): delegated/bulk session-rule
// approvals and in-place rule editing. Also covers #1259 (Ruling A1259,
// lib/adr-viewer.js) per that ruling's own "tests... may be co-located in
// the authorized Car 60-B test files" -- this file and
// test/team-templates.test.js are the two files Car 60-B's envelope
// authorizes.
//
// Every module under test is a pure library: no store, no route, no
// network. Every assertion here drives the real exported function.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const srb = require('../lib/session-rules-bulk');
const adrViewer = require('../lib/adr-viewer');

describe('session-rules-bulk: decideSessionRuleProposal (#2016)', () => {
  const builder = { id: 'builder-1' };
  const architect = { role: 'architect', id: 'arc-1' };
  const pm = { role: 'pm', id: 'pm-1' };
  const operator = { principal: 'operator', id: 'op-1' };

  it('exposes its own policy vocabulary', () => {
    assert.deepEqual(srb.APPROVAL_MODES, ['operator-only', 'delegated-architect', 'delegated-pm', 'custom-delegate']);
    assert.deepEqual(srb.DECISIONS, ['approve', 'reject']);
    assert.deepEqual(srb.EDITABLE_FIELDS, ['title', 'body', 'category', 'scope', 'enabled']);
  });

  it('refuses an unrecognized approval mode', () => {
    const r = srb.decideSessionRuleProposal({
      approvalMode: 'anything-goes', caller: operator, proposal: { id: 'p1' }, decision: 'approve'
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_APPROVAL_INVALID');
  });

  it('refuses an unrecognized decision', () => {
    const r = srb.decideSessionRuleProposal({
      approvalMode: 'operator-only', caller: operator, proposal: { id: 'p1' }, decision: 'maybe'
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_APPROVAL_INVALID');
  });

  it('the operator may always decide, under every approval mode', () => {
    for (const mode of srb.APPROVAL_MODES) {
      const r = srb.decideSessionRuleProposal({
        approvalMode: mode, caller: operator, proposal: { id: 'p1', authoredBy: 'builder-1' }, decision: 'approve'
      });
      assert.equal(r.ok, true, `mode "${mode}"`);
    }
  });

  it('operator-only refuses a non-operator caller, whatever role it claims', () => {
    const r = srb.decideSessionRuleProposal({
      approvalMode: 'operator-only', caller: architect, proposal: { id: 'p1', authoredBy: 'builder-1' }, decision: 'approve'
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_APPROVAL_UNAUTHORIZED');
  });

  it('delegated-architect authorizes an architect caller', () => {
    const r = srb.decideSessionRuleProposal({
      approvalMode: 'delegated-architect', caller: architect, proposal: { id: 'p1', authoredBy: 'builder-1' }, decision: 'approve'
    });
    assert.equal(r.ok, true);
    assert.equal(r.result.approverPrincipal, 'arc-1');
    assert.equal(r.result.approvalMode, 'delegated-architect');
  });

  it('delegated-architect refuses a pm caller -- the modes are not interchangeable', () => {
    const r = srb.decideSessionRuleProposal({
      approvalMode: 'delegated-architect', caller: pm, proposal: { id: 'p1', authoredBy: 'builder-1' }, decision: 'approve'
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_APPROVAL_UNAUTHORIZED');
  });

  it('delegated-pm authorizes a pm caller', () => {
    const r = srb.decideSessionRuleProposal({
      approvalMode: 'delegated-pm', caller: pm, proposal: { id: 'p1', authoredBy: 'builder-1' }, decision: 'reject'
    });
    assert.equal(r.ok, true);
    assert.equal(r.result.decision, 'reject');
  });

  it('custom-delegate authorizes only a caller on the allowlist, by id', () => {
    const allowed = srb.decideSessionRuleProposal({
      approvalMode: 'custom-delegate', caller: { id: 'watcher-7' }, delegateAllowlist: ['watcher-7'],
      proposal: { id: 'p1', authoredBy: 'builder-1' }, decision: 'approve'
    });
    assert.equal(allowed.ok, true);
    const notAllowed = srb.decideSessionRuleProposal({
      approvalMode: 'custom-delegate', caller: { id: 'watcher-8' }, delegateAllowlist: ['watcher-7'],
      proposal: { id: 'p1', authoredBy: 'builder-1' }, decision: 'approve'
    });
    assert.equal(notAllowed.ok, false);
    assert.equal(notAllowed.code, 'RULE_APPROVAL_UNAUTHORIZED');
  });

  it('forbids self-approval, even for an otherwise-authorized delegated approver', () => {
    const r = srb.decideSessionRuleProposal({
      approvalMode: 'delegated-architect', caller: architect, proposal: { id: 'p1', authoredBy: 'arc-1' }, decision: 'approve'
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_SELF_APPROVAL_FORBIDDEN');
  });

  it('authorization is checked before self-approval: an unauthorized self-author gets UNAUTHORIZED, not SELF_APPROVAL_FORBIDDEN', () => {
    const r = srb.decideSessionRuleProposal({
      approvalMode: 'operator-only', caller: builder, proposal: { id: 'p1', authoredBy: 'builder-1' }, decision: 'approve'
    });
    assert.equal(r.code, 'RULE_APPROVAL_UNAUTHORIZED', 'authorization is checked first, not self-authorship');
  });

  it('rejects a stale expectedVersion', () => {
    const r = srb.decideSessionRuleProposal({
      approvalMode: 'operator-only', caller: operator, decision: 'approve',
      proposal: { id: 'p1', authoredBy: 'builder-1', version: 3 }, expectedVersion: 2
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_APPROVAL_STALE');
  });

  it('rejects a stale expectedDigestSha256', () => {
    const r = srb.decideSessionRuleProposal({
      approvalMode: 'operator-only', caller: operator, decision: 'approve',
      proposal: { id: 'p1', authoredBy: 'builder-1', digestSha256: 'new' }, expectedDigestSha256: 'old'
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_APPROVAL_STALE');
  });

  it('a matching expectedVersion/digest does not block the decision', () => {
    const r = srb.decideSessionRuleProposal({
      approvalMode: 'operator-only', caller: operator, decision: 'approve',
      proposal: { id: 'p1', authoredBy: 'builder-1', version: 3, digestSha256: 'x' },
      expectedVersion: 3, expectedDigestSha256: 'x'
    });
    assert.equal(r.ok, true);
  });

  it('fails closed on a proposal missing authoredBy entirely, rather than allowing it through as "no conflict found" (PRR-A R1 #1)', () => {
    const r = srb.decideSessionRuleProposal({
      approvalMode: 'delegated-architect', caller: architect, proposal: { id: 'p1' }, decision: 'approve'
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_APPROVAL_INVALID');
  });

  it('fails closed on a blank authoredBy the same way as a missing one', () => {
    const r = srb.decideSessionRuleProposal({
      approvalMode: 'delegated-architect', caller: architect, proposal: { id: 'p1', authoredBy: '   ' }, decision: 'approve'
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_APPROVAL_INVALID');
  });

});

describe('session-rules-bulk: bulkDecideSessionRuleProposals (#2016)', () => {
  const pm = { role: 'pm', id: 'pm-1' };

  it('refuses a non-array proposals field', () => {
    const r = srb.bulkDecideSessionRuleProposals({ approvalMode: 'delegated-pm', caller: pm, decision: 'approve', proposals: 'nope' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_APPROVAL_INVALID');
  });

  it('sorts a mixed batch into approved/skipped/errors correctly, atomically per item', () => {
    const r = srb.bulkDecideSessionRuleProposals({
      approvalMode: 'delegated-pm', caller: pm, decision: 'approve',
      proposals: [
        { id: 'ok-1', authoredBy: 'builder-1', status: 'pending' },
        { id: 'ok-2', authoredBy: 'builder-2' }, // no status field at all -- treated as pending
        { id: 'self', authoredBy: 'pm-1', status: 'pending' },
        { id: 'already-decided', authoredBy: 'builder-3', status: 'approved' },
        { id: 'stale', authoredBy: 'builder-4', status: 'pending', version: 1, expectedVersion: 2 }
      ]
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.summary.approved.map((x) => x.proposalId), ['ok-1', 'ok-2']);
    assert.deepEqual(r.summary.skipped.map((x) => x.proposalId), ['already-decided']);
    assert.deepEqual(r.summary.errors.map((x) => x.proposalId), ['self', 'stale']);
    assert.equal(r.summary.errors[0].code, 'RULE_SELF_APPROVAL_FORBIDDEN');
    assert.equal(r.summary.errors[1].code, 'RULE_APPROVAL_STALE');
    assert.equal(r.summary.rejected.length, 0);
    assert.equal(r.summary.approverPrincipal, 'pm-1');
    assert.equal(r.summary.approvalMode, 'delegated-pm');
  });

  it('a bulk reject puts its results in "rejected", not "approved"', () => {
    const r = srb.bulkDecideSessionRuleProposals({
      approvalMode: 'delegated-pm', caller: pm, decision: 'reject',
      proposals: [{ id: 'p1', authoredBy: 'builder-1' }]
    });
    assert.equal(r.summary.approved.length, 0);
    assert.equal(r.summary.rejected.length, 1);
    assert.equal(r.summary.rejected[0].decision, 'reject');
  });

  it('one unauthorized caller fails every item the same way, without aborting the batch', () => {
    const r = srb.bulkDecideSessionRuleProposals({
      approvalMode: 'operator-only', caller: { role: 'architect', id: 'arc-1' }, decision: 'approve',
      proposals: [{ id: 'p1', authoredBy: 'x' }, { id: 'p2', authoredBy: 'y' }]
    });
    assert.equal(r.summary.errors.length, 2);
    assert.ok(r.summary.errors.every((e) => e.code === 'RULE_APPROVAL_UNAUTHORIZED'));
  });

  it('a batch item missing authoredBy lands in errors as RULE_APPROVAL_INVALID, not approved (PRR-A R1 #1)', () => {
    const r = srb.bulkDecideSessionRuleProposals({
      approvalMode: 'delegated-pm', caller: pm, decision: 'approve',
      proposals: [
        { id: 'ok-1', authoredBy: 'builder-1', status: 'pending' },
        { id: 'no-author', status: 'pending' }
      ]
    });
    assert.deepEqual(r.summary.approved.map((x) => x.proposalId), ['ok-1']);
    assert.deepEqual(r.summary.errors.map((x) => x.proposalId), ['no-author']);
    assert.equal(r.summary.errors[0].code, 'RULE_APPROVAL_INVALID');
  });
});

describe('session-rules-bulk: editRuleInPlace (#2396)', () => {
  const operator = { principal: 'operator', id: 'op-1' };
  const rule = {
    ruleId: 'r1', title: 'Old title', body: 'Old body', category: 'conduct', scope: 'project',
    enabled: true, version: 2, digestSha256: 'old-digest'
  };

  it('requires at least one editable field in the patch', () => {
    const r = srb.editRuleInPlace({ approvalMode: 'operator-only', caller: operator, rule, patch: {}, expectedVersion: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_EDIT_INVALID');
  });

  it('refuses a patch field not in EDITABLE_FIELDS', () => {
    const r = srb.editRuleInPlace({
      approvalMode: 'operator-only', caller: operator, rule, patch: { ruleId: 'r2' }, expectedVersion: 2
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_EDIT_INVALID');
  });

  it('rejects an empty body or title', () => {
    assert.equal(srb.editRuleInPlace({ approvalMode: 'operator-only', caller: operator, rule, patch: { body: '   ' }, expectedVersion: 2 }).code, 'RULE_EDIT_INVALID');
    assert.equal(srb.editRuleInPlace({ approvalMode: 'operator-only', caller: operator, rule, patch: { title: '' }, expectedVersion: 2 }).code, 'RULE_EDIT_INVALID');
  });

  it('requires expectedVersion or expectedDigestSha256', () => {
    const r = srb.editRuleInPlace({ approvalMode: 'operator-only', caller: operator, rule, patch: { body: 'New body' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_EDIT_INVALID');
  });

  it('refuses an unauthorized caller before checking anything else', () => {
    const r = srb.editRuleInPlace({
      approvalMode: 'operator-only', caller: { role: 'architect', id: 'arc-1' }, rule,
      patch: { body: 'New body' }, expectedVersion: 2
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_APPROVAL_UNAUTHORIZED');
  });

  it('fails closed with RULE_EDIT_CONFLICT on a version mismatch', () => {
    const r = srb.editRuleInPlace({
      approvalMode: 'operator-only', caller: operator, rule, patch: { body: 'New body' }, expectedVersion: 1
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_EDIT_CONFLICT');
  });

  it('fails closed with RULE_EDIT_CONFLICT on a digest mismatch', () => {
    const r = srb.editRuleInPlace({
      approvalMode: 'operator-only', caller: operator, rule, patch: { body: 'New body' }, expectedDigestSha256: 'wrong'
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RULE_EDIT_CONFLICT');
  });

  it('applies a valid edit: preserves ruleId, increments version, recomputes digest, keeps untouched fields', () => {
    const r = srb.editRuleInPlace({
      approvalMode: 'operator-only', caller: operator, rule, patch: { body: 'New body' },
      expectedVersion: 2, reason: 'clarify wording'
    });
    assert.equal(r.ok, true);
    assert.equal(r.rule.ruleId, 'r1');
    assert.equal(r.rule.title, 'Old title', 'untouched field survives the edit');
    assert.equal(r.rule.body, 'New body');
    assert.equal(r.rule.version, 3);
    assert.notEqual(r.rule.digestSha256, 'old-digest');
    assert.equal(r.revision.editedBy, 'op-1');
    assert.equal(r.revision.reason, 'clarify wording');
    assert.match(r.revision.previousText, /Old body/);
    assert.match(r.revision.newText, /New body/);
  });

  it('a rule addressed by "number" instead of "ruleId" is accepted and preserved', () => {
    const numberedRule = { number: 42, title: 'T', body: 'B', category: null, scope: null, enabled: true, version: 1, digestSha256: 'd' };
    const r = srb.editRuleInPlace({
      approvalMode: 'operator-only', caller: operator, rule: numberedRule, patch: { title: 'T2' }, expectedVersion: 1
    });
    assert.equal(r.ok, true);
    assert.equal(r.rule.number, 42);
    assert.equal(r.rule.ruleId, null);
  });

  it('two edits to the same content produce the same digest -- the digest is deterministic', () => {
    const r1 = srb.editRuleInPlace({ approvalMode: 'operator-only', caller: operator, rule, patch: { body: 'X' }, expectedVersion: 2 });
    const r2 = srb.editRuleInPlace({ approvalMode: 'operator-only', caller: operator, rule, patch: { body: 'X' }, expectedVersion: 2 });
    assert.equal(r1.rule.digestSha256, r2.rule.digestSha256);
  });
});

describe('adr-viewer: exported vocabulary (#1259)', () => {
  it('exposes its own status and internal-field vocabulary', () => {
    assert.deepEqual(adrViewer.STATUSES, ['active', 'superseded', 'proposed', 'deprecated']);
    assert.ok(adrViewer.INTERNAL_ONLY_FIELDS.includes('secret'));
    assert.ok(adrViewer.INTERNAL_ONLY_FIELDS.includes('token'));
  });
});

describe('adr-viewer: projectRulesView (#1259)', () => {
  const records = [
    { id: 'r1', title: 'Be Nice', body: 'Always be nice to teammates.', category: 'Conduct', status: 'active', tags: ['core'] },
    { number: 42, title: 'Use SQLite', body: 'We use SQLite everywhere.', category: 'Architecture', status: 'active' },
    { id: 'r2', title: 'Old Rule', body: 'Deprecated text.', status: 'deprecated' }
  ];

  it('refuses a non-array input', () => {
    const r = adrViewer.projectRulesView('nope');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ADR_VIEWER_INPUT_INVALID');
  });

  it('refuses a malformed record and names which one', () => {
    const r = adrViewer.projectRulesView([{ title: 'No id or number', body: 'x', status: 'active' }]);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ADR_VIEWER_RECORD_INVALID');
  });

  it('refuses a record with an unrecognized status', () => {
    const r = adrViewer.projectRulesView([{ id: 'x', title: 'T', body: 'B', status: 'bogus' }]);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ADR_VIEWER_RECORD_INVALID');
  });

  it('projects every valid record with a stable slug and the right route shape', () => {
    const r = adrViewer.projectRulesView(records);
    assert.equal(r.ok, true);
    assert.equal(r.view.total, 3);
    assert.equal(r.view.filtered, 3);
    const byId = Object.fromEntries(r.view.items.map((i) => [i.number !== null ? `adr-${i.number}` : i.id, i]));
    assert.equal(byId['adr-42'].route, '/adr/42');
    assert.equal(byId.r1.route, '/rules/r1');
    assert.ok(byId.r1.slug.length > 0);
  });

  it('is deterministic: the same input always projects to the same order', () => {
    const a = adrViewer.projectRulesView(records);
    const b = adrViewer.projectRulesView(records);
    assert.deepEqual(a.view.items.map((i) => i.title), b.view.items.map((i) => i.title));
  });

  it('filters by status', () => {
    const r = adrViewer.projectRulesView(records, { status: ['deprecated'] });
    assert.equal(r.view.filtered, 1);
    assert.equal(r.view.items[0].title, 'Old Rule');
  });

  it('filters by tag', () => {
    const r = adrViewer.projectRulesView(records, { tags: ['core'] });
    assert.equal(r.view.filtered, 1);
    assert.equal(r.view.items[0].title, 'Be Nice');
  });

  it('filters by case-insensitive search over title and body', () => {
    const r = adrViewer.projectRulesView(records, { search: 'SQLITE' });
    assert.equal(r.view.filtered, 1);
    assert.equal(r.view.items[0].title, 'Use SQLite');
  });

  it('two records that slugify identically get distinct, stable anchors', () => {
    const r = adrViewer.projectRulesView([
      { id: 'a', title: 'Same Title', body: '1', status: 'active' },
      { id: 'b', title: 'Same Title', body: '2', status: 'active' }
    ]);
    const slugs = r.view.items.map((i) => i.slug);
    assert.equal(new Set(slugs).size, 2, 'both anchors must be unique');
  });
});

describe('adr-viewer: buildShareableRulesView / renderShareableRulesMarkdown (#1259)', () => {
  it('strips every internal-only field from the shareable payload', () => {
    const r = adrViewer.buildShareableRulesView([
      { id: 'r1', title: 'T', body: 'B', status: 'active', secret: 'should-not-appear', token: 'also-not' }
    ]);
    assert.equal(r.ok, true);
    const serialized = JSON.stringify(r.payload);
    assert.doesNotMatch(serialized, /should-not-appear/);
    assert.doesNotMatch(serialized, /also-not/);
  });

  it('computes a deterministic digest over the canonical set', () => {
    const records = [{ id: 'r1', title: 'T', body: 'B', status: 'active' }];
    const a = adrViewer.buildShareableRulesView(records);
    const b = adrViewer.buildShareableRulesView(records);
    assert.equal(a.payload.digestSha256, b.payload.digestSha256);
    assert.match(a.payload.digestSha256, /^[0-9a-f]{64}$/);
  });

  it('propagates a malformed-record refusal rather than building a partial payload', () => {
    const r = adrViewer.buildShareableRulesView([{ id: 'x' }]);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ADR_VIEWER_RECORD_INVALID');
  });

  it('renders deterministic Markdown with the digest, headings per category, and route/status lines', () => {
    const built = adrViewer.buildShareableRulesView([
      { id: 'r1', title: 'Be Nice', body: 'Always be nice.', category: 'Conduct', status: 'active', tags: ['core'] }
    ]);
    const rendered = adrViewer.renderShareableRulesMarkdown(built.payload);
    assert.equal(rendered.ok, true);
    assert.match(rendered.markdown, /# Rules & ADRs/);
    assert.match(rendered.markdown, new RegExp(built.payload.digestSha256));
    assert.match(rendered.markdown, /## Conduct/);
    assert.match(rendered.markdown, /Rule r1: Be Nice/);
    assert.match(rendered.markdown, /\/rules\/r1/);
    assert.match(rendered.markdown, /`core`/);
  });

  it('refuses a payload that is not a buildShareableRulesView() result', () => {
    const r = adrViewer.renderShareableRulesMarkdown({ not: 'a payload' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ADR_VIEWER_PAYLOAD_INVALID');
  });
});
