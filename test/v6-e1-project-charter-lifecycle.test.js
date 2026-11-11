'use strict';

// v6 Train 3 Wave 1 (#2126, V6-16 / E1, Car V60-T3-W1-D): the 3 Native
// Project Charter tables (this module's OWN idempotent ensureCharterTables
// -- not lib/store/_schema.js, which is V60-T3-W1-A's sole envelope) plus
// lib/v6/e1-project-charter-lifecycle.js, against a real node:sqlite-backed
// store.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const e1 = require('../lib/v6/e1-project-charter-lifecycle');

let tmpDir = null;

/** @returns {import('node:sqlite').DatabaseSync} */
function freshStore() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-e1-charter-'));
  store._setBasePath(tmpDir);
  store.init();
  const db = store.getDb();
  e1.ensureCharterTables(db);
  return db;
}

function cleanup() {
  store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
}

function seedProject(db, name) {
  db.prepare('INSERT INTO projects (name, path, archived) VALUES (?, ?, 0)').run(name, path.join(os.tmpdir(), name));
  return db.prepare('SELECT id FROM projects WHERE name = ?').get(name).id;
}

describe('vocabulary constants (#2126)', () => {
  it('STATUSES is exactly the 5 lifecycle states in requirement 1\'s order', () => {
    assert.deepEqual(e1.STATUSES, ['draft', 'approved', 'active', 'amended', 'superseded']);
  });

  it('MINIMUM_REQUIRED_ROLES is exactly sponsor+pm, and both are valid APPROVER_ROLES', () => {
    assert.deepEqual(e1.MINIMUM_REQUIRED_ROLES, ['sponsor', 'pm']);
    for (const role of e1.MINIMUM_REQUIRED_ROLES) assert.ok(e1.APPROVER_ROLES.includes(role));
  });

  it('APPROVER_ROLES matches recordApproval\'s own accepted values', () => {
    assert.deepEqual(e1.APPROVER_ROLES, ['sponsor', 'pm', 'other']);
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-vocab-roles');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      for (const role of e1.APPROVER_ROLES) {
        const res = e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: role, approverActor: `actor-${role}` });
        assert.equal(res.ok, true, `${role} must be an accepted approverRole`);
      }
    } finally {
      cleanup();
    }
  });

  it('CHARTER_FIELDS covers every field exportCharterMarkdown renders', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-vocab-fields');
      const content = Object.fromEntries(e1.CHARTER_FIELDS.map((f) => [f, f === 'title' ? 'Vocab Check' : `value for ${f}`]));
      e1.createDraftCharter(db, { projectId, content });
      const md = e1.exportCharterMarkdown(db, { projectId });
      for (const field of e1.CHARTER_FIELDS) {
        if (field === 'title') continue;
        const heading = field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
        assert.match(md, new RegExp(`## ${heading}`), `CHARTER_FIELDS entry "${field}" must render its own heading`);
      }
    } finally {
      cleanup();
    }
  });

  it('SECTION_DISPOSITIONS is exactly requirement 3\'s 4 visibility states', () => {
    assert.deepEqual(e1.SECTION_DISPOSITIONS, ['required', 'optional', 'hidden', 'omitted']);
  });
});

describe('ensureCharterTables (#2126)', () => {
  it('is idempotent -- calling it twice against the same db does not throw', () => {
    const db = freshStore();
    try {
      assert.doesNotThrow(() => e1.ensureCharterTables(db));
    } finally {
      cleanup();
    }
  });
});

describe('createDraftCharter / getCharter (#2126 requirement 1, 10)', () => {
  it('creates a draft charter with version 1 and reads it back', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-create');
      const res = e1.createDraftCharter(db, { projectId, content: { title: 'Alpha', coreTeam: ['a', 'b'] } });
      assert.equal(res.ok, true);
      assert.equal(res.code, 'CREATED');

      const found = e1.getCharter(db, { projectId });
      assert.equal(found.charter.status, 'draft');
      assert.equal(found.versions.length, 1);
      assert.equal(JSON.parse(found.versions[0].content_json).title, 'Alpha');
    } finally {
      cleanup();
    }
  });

  it('refuses a second charter for a project that already has one', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-dup');
      e1.createDraftCharter(db, { projectId, content: { title: 'Alpha' } });
      const dup = e1.createDraftCharter(db, { projectId, content: { title: 'Beta' } });
      assert.equal(dup.ok, false);
      assert.equal(dup.code, 'ALREADY_EXISTS');
    } finally {
      cleanup();
    }
  });

  it('returns null for a project with no charter (#2126 requirement 10: existing projects keep working)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-none');
      assert.equal(e1.getCharter(db, { projectId }), null);
      assert.equal(e1.getActiveCharter(db, { projectId }), null);
      assert.equal(e1.getStartupSummary(db, { projectId }), null);
    } finally {
      cleanup();
    }
  });
});

describe('saveDraftVersion (#2126 requirement 1, 2)', () => {
  it('adds a new immutable version without touching the first one', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-version');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      const saved = e1.saveDraftVersion(db, { projectId, content: { title: 'v2' } });
      assert.equal(saved.ok, true);
      assert.equal(saved.versionNumber, 2);

      const found = e1.getCharter(db, { projectId });
      assert.equal(found.versions.length, 2);
      assert.equal(JSON.parse(found.versions[0].content_json).title, 'v1', 'version 1 is unchanged');
      assert.equal(JSON.parse(found.versions[1].content_json).title, 'v2');
      assert.notEqual(found.versions[0].content_digest, found.versions[1].content_digest);
      assert.equal(found.versions[1].id !== created.versionId, true);
    } finally {
      cleanup();
    }
  });

  it('saving a new version on an ACTIVE charter moves status to amended, not back to draft', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-amend');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      e1.activateCharter(db, { projectId, versionId: created.versionId, requiredRoles: ['sponsor', 'pm'] });

      e1.saveDraftVersion(db, { projectId, content: { title: 'v2' } });
      const found = e1.getCharter(db, { projectId });
      assert.equal(found.charter.status, 'amended');
      // The ACTIVE pointer still resolves to the old, still-approved version
      // until the amendment is itself activated.
      const active = e1.getActiveCharter(db, { projectId });
      assert.equal(active.content.title, 'v1');
    } finally {
      cleanup();
    }
  });

  it('refuses to add a version to a superseded charter', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-superseded-save');
      e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      e1.supersedeCharter(db, { projectId });
      const res = e1.saveDraftVersion(db, { projectId, content: { title: 'v2' } });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'CHARTER_SUPERSEDED');
    } finally {
      cleanup();
    }
  });
});

describe('recordApproval / revokeApproval / checkApprovalComplete (#2126 requirement 4)', () => {
  it('records approvals from distinct roles and reports completeness', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-approvals');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });

      let check = e1.checkApprovalComplete(db, { versionId: created.versionId, requiredRoles: ['sponsor', 'pm'] });
      assert.equal(check.complete, false);
      assert.deepEqual(check.missingRoles, ['sponsor', 'pm']);

      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      check = e1.checkApprovalComplete(db, { versionId: created.versionId, requiredRoles: ['sponsor', 'pm'] });
      assert.equal(check.complete, false);
      assert.deepEqual(check.missingRoles, ['pm']);

      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      check = e1.checkApprovalComplete(db, { versionId: created.versionId, requiredRoles: ['sponsor', 'pm'] });
      assert.equal(check.complete, true);
    } finally {
      cleanup();
    }
  });

  it('re-approving the same (version, role, actor) is idempotent, never a thrown constraint error', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-reapprove');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      const first = e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      const second = e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      assert.equal(first.code, 'APPROVED');
      assert.equal(second.code, 'ALREADY_APPROVED');
      assert.equal(first.approvalId, second.approvalId);
    } finally {
      cleanup();
    }
  });

  it('revoking an approval removes it from completeness, and it can be re-approved afterward', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-revoke');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });

      const revoked = e1.revokeApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      assert.equal(revoked.ok, true);
      assert.equal(
        e1.checkApprovalComplete(db, { versionId: created.versionId, requiredRoles: ['sponsor'] }).complete,
        false
      );

      const reapproved = e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      assert.equal(reapproved.code, 'APPROVED', 'a fresh approval row after revocation, not blocked by the old one');
    } finally {
      cleanup();
    }
  });

  it('requiredRoles: [] can never report complete on zero approvals -- sponsor+pm is always the floor (Ruling A592-PR3017-R1-HOLD-RECONCILED item 1)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-empty-required');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      const check = e1.checkApprovalComplete(db, { versionId: created.versionId, requiredRoles: [] });
      assert.equal(check.complete, false);
      assert.deepEqual(check.missingRoles.sort(), ['pm', 'sponsor']);
    } finally {
      cleanup();
    }
  });

  it('an unknown role in requiredRoles is refused, not silently ignored (Ruling A592-PR3017-R1-HOLD-RECONCILED item 1)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-unknown-role');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      const check = e1.checkApprovalComplete(db, { versionId: created.versionId, requiredRoles: ['auditor'] });
      assert.equal(check.ok, false);
      assert.equal(check.code, 'INVALID_REQUIRED_ROLES');
      assert.equal(check.complete, false);
    } finally {
      cleanup();
    }
  });

  it('a caller-supplied requiredRoles beyond the minimum still adds to, never replaces, sponsor+pm', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-extra-role');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      const check = e1.checkApprovalComplete(db, { versionId: created.versionId, requiredRoles: ['other'] });
      assert.equal(check.complete, false);
      assert.deepEqual(check.missingRoles, ['other']);
    } finally {
      cleanup();
    }
  });

  it('recording the final required sign-off moves status from draft to approved (Ruling A592-PR3017-R1-HOLD-RECONCILED item 3)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-approved-transition');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      assert.equal(e1.getCharter(db, { projectId }).charter.status, 'draft', 'still draft with only 1 of 2 required sign-offs');

      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      assert.equal(e1.getCharter(db, { projectId }).charter.status, 'approved', 'both minimum sign-offs now present');
    } finally {
      cleanup();
    }
  });

  it('revoking a sign-off that drops an approved charter below complete reverts it to draft (version 1) or amended (a later version)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-revert-on-revoke');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      assert.equal(e1.getCharter(db, { projectId }).charter.status, 'approved');

      e1.revokeApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      assert.equal(e1.getCharter(db, { projectId }).charter.status, 'draft', 'reverts to draft -- this was version 1');
    } finally {
      cleanup();
    }
  });

  it('saving a new UNSIGNED version on an approved charter reverts status, and approving an OLDER (non-latest) version never re-triggers approved (Ruling A596-PR3017-R2-HOLD-RECONCILED item 1)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-approved-then-new-version');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      assert.equal(e1.getCharter(db, { projectId }).charter.status, 'approved');

      const saved = e1.saveDraftVersion(db, { projectId, content: { title: 'v2' } });
      assert.equal(
        e1.getCharter(db, { projectId }).charter.status, 'draft',
        'a fresh, zero-approval version must never leave the charter reading approved'
      );

      // v1 (the now-OLDER version) is still fully approved; a NEW approval
      // on it (a role nobody signed yet) must not resurrect 'approved' --
      // only the charter's current LATEST version (v2) can do that.
      const res = e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'other', approverActor: 'eve' });
      assert.equal(res.ok, true);
      assert.equal(
        e1.getCharter(db, { projectId }).charter.status, 'draft',
        'approving an older, non-latest version must never transition the charter to approved'
      );
      assert.notEqual(saved.versionId, created.versionId);
    } finally {
      cleanup();
    }
  });

  it('revoking a sign-off on the charter\'s ACTIVE version immediately deactivates it -- getActiveCharter/getStartupSummary stop exposing it (Ruling A596-PR3017-R2-HOLD-RECONCILED item 2)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-revoke-active');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      e1.activateCharter(db, { projectId, versionId: created.versionId, requiredRoles: [] });
      assert.ok(e1.getActiveCharter(db, { projectId }), 'precondition: it really is active first');

      e1.revokeApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });

      assert.equal(e1.getActiveCharter(db, { projectId }), null, 'must stop reading as active the instant its own active version loses a required sign-off');
      assert.equal(e1.getStartupSummary(db, { projectId }), null);
      const found = e1.getCharter(db, { projectId });
      assert.equal(found.charter.active_version_id, null);
      assert.equal(found.charter.status, 'draft', 'version 1 reverts to draft, not amended');
    } finally {
      cleanup();
    }
  });

  it('revoking a sign-off on an OLDER, non-latest version never reverts status away from approved when the LATEST version is still fully signed (Ruling A603-PR3017-R3-HOLD-RECONCILED)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-revoke-stale-version');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      assert.equal(e1.getCharter(db, { projectId }).charter.status, 'approved', 'precondition: v1 alone is fully approved');

      const saved = e1.saveDraftVersion(db, { projectId, content: { title: 'v2' } });
      e1.recordApproval(db, { projectId, versionId: saved.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      e1.recordApproval(db, { projectId, versionId: saved.versionId, approverRole: 'pm', approverActor: 'dave' });
      assert.equal(e1.getCharter(db, { projectId }).charter.status, 'approved', 'precondition: v2 (the latest) is now fully approved too');

      // Revoking v1's (the now-STALE version's) pm sign-off must not drop
      // the charter's overall status -- v2, the version 'approved'
      // actually describes, is untouched and still fully signed.
      const res = e1.revokeApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      assert.equal(res.ok, true);
      assert.equal(
        e1.getCharter(db, { projectId }).charter.status, 'approved',
        'status must stay approved -- it reflects v2 (latest), not the now-stale v1 whose approval was just revoked'
      );
    } finally {
      cleanup();
    }
  });
});

describe('activateCharter (#2126 requirement 4, 6)', () => {
  it('fails closed with APPROVALS_INCOMPLETE rather than activating a partially-approved version', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-activate-incomplete');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      const res = e1.activateCharter(db, { projectId, versionId: created.versionId, requiredRoles: ['sponsor', 'pm'] });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'APPROVALS_INCOMPLETE');
      assert.deepEqual(res.missingRoles, ['pm']);
      assert.equal(e1.getActiveCharter(db, { projectId }), null, 'nothing became active');
    } finally {
      cleanup();
    }
  });

  it('activates once every required role has signed off, and getActiveCharter resolves the content', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-activate-complete');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1', purposeAndBusinessCase: 'Ship it' } });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      const res = e1.activateCharter(db, { projectId, versionId: created.versionId, requiredRoles: ['sponsor', 'pm'] });
      assert.equal(res.ok, true);
      assert.equal(res.code, 'ACTIVATED');

      const active = e1.getActiveCharter(db, { projectId });
      assert.equal(active.content.title, 'v1');
      assert.equal(e1.getCharter(db, { projectId }).charter.status, 'active');
    } finally {
      cleanup();
    }
  });
});

describe('getStartupSummary (#2126 requirement 7 -- bounded, never the full charter)', () => {
  it('returns only identity/mission/scope/authority/constraints', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-summary');
      const created = e1.createDraftCharter(db, {
        projectId,
        content: {
          title: 'Alpha', purposeAndBusinessCase: 'Ship v6', scopeIncluded: 'core', scopeExcluded: 'extras',
          pmAuthorityAndReservedDecisions: 'final say on scope', assumptionsAndConstraints: 'no new hires',
          budget: 'secret internal figure'
        }
      });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      e1.activateCharter(db, { projectId, versionId: created.versionId, requiredRoles: ['sponsor', 'pm'] });

      const summary = e1.getStartupSummary(db, { projectId });
      assert.equal(summary.title, 'Alpha');
      assert.equal(summary.mission, 'Ship v6');
      assert.deepEqual(summary.currentScope, { included: 'core', excluded: 'extras' });
      assert.equal(summary.authority, 'final say on scope');
      assert.equal(summary.activeConstraints, 'no new hires');
      assert.equal('budget' in summary, false, 'budget is not part of the bounded summary');
    } finally {
      cleanup();
    }
  });
});

describe('supersedeCharter (#2126 requirement 1 terminal state)', () => {
  it('marks the charter superseded and is a no-op the second time', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-supersede');
      e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      const first = e1.supersedeCharter(db, { projectId });
      assert.equal(first.ok, true);
      const second = e1.supersedeCharter(db, { projectId });
      assert.equal(second.ok, false);
      assert.equal(second.code, 'NOT_FOUND');
    } finally {
      cleanup();
    }
  });

  it('clears the active pointer, so an active charter cannot be read back as active after being superseded (Ruling A592-PR3017-R1-HOLD-RECONCILED item 2)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-supersede-clears-active');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1' } });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      e1.activateCharter(db, { projectId, versionId: created.versionId, requiredRoles: [] });
      assert.ok(e1.getActiveCharter(db, { projectId }), 'precondition: it really is active first');

      e1.supersedeCharter(db, { projectId });
      assert.equal(e1.getActiveCharter(db, { projectId }), null);
      assert.equal(e1.getStartupSummary(db, { projectId }), null);
      assert.equal(e1.getCharter(db, { projectId }).charter.active_version_id, null);
    } finally {
      cleanup();
    }
  });
});

describe('exportCharterJson / exportCharterMarkdown (#2126 requirement 8)', () => {
  it('exports the latest draft when nothing has been activated yet', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-export-draft');
      e1.createDraftCharter(db, { projectId, content: { title: 'Draft Only' } });
      const exported = e1.exportCharterJson(db, { projectId });
      assert.equal(exported.status, 'draft');
      assert.equal(exported.content.title, 'Draft Only');

      const md = e1.exportCharterMarkdown(db, { projectId });
      assert.match(md, /# Draft Only/);
    } finally {
      cleanup();
    }
  });

  it('exports the ACTIVE version, not a later unapproved amendment', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-export-active');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'Approved' } });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      e1.activateCharter(db, { projectId, versionId: created.versionId, requiredRoles: ['sponsor', 'pm'] });
      e1.saveDraftVersion(db, { projectId, content: { title: 'Unapproved amendment' } });

      const exported = e1.exportCharterJson(db, { projectId });
      assert.equal(exported.content.title, 'Approved');
      assert.equal(exported.status, 'amended');
    } finally {
      cleanup();
    }
  });

  it('skips empty/absent fields rather than rendering an empty heading', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-export-skip-empty');
      e1.createDraftCharter(db, { projectId, content: { title: 'Sparse', sponsor: '' } });
      const md = e1.exportCharterMarkdown(db, { projectId });
      assert.doesNotMatch(md, /## Sponsor/);
    } finally {
      cleanup();
    }
  });

  it('returns null when the project has no charter at all', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-export-none');
      assert.equal(e1.exportCharterJson(db, { projectId }), null);
      assert.equal(e1.exportCharterMarkdown(db, { projectId }), null);
    } finally {
      cleanup();
    }
  });
});

describe('checkResourceDrift (#2126 requirement 9 -- narrow comparison only)', () => {
  it('reports no drift when the actual snapshot matches the declared topology', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-drift-none');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1', coreTeam: ['alice', 'bob'] } });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      e1.activateCharter(db, { projectId, versionId: created.versionId, requiredRoles: ['sponsor', 'pm'] });

      const drift = e1.checkResourceDrift(db, { projectId, actual: { coreTeam: ['alice', 'bob'] } });
      assert.equal(drift.drift, false);
      assert.deepEqual(drift.missing, []);
      assert.deepEqual(drift.unexpected, []);
    } finally {
      cleanup();
    }
  });

  it('reports missing and unexpected entries when they diverge', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-drift-some');
      const created = e1.createDraftCharter(db, { projectId, content: { title: 'v1', coreTeam: ['alice', 'bob'], requiredResources: ['db-prod'] } });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      e1.activateCharter(db, { projectId, versionId: created.versionId, requiredRoles: ['sponsor', 'pm'] });

      const drift = e1.checkResourceDrift(db, { projectId, actual: { coreTeam: ['alice', 'carol'], requiredResources: ['db-prod'] } });
      assert.equal(drift.drift, true);
      assert.deepEqual(drift.missing, ['bob']);
      assert.deepEqual(drift.unexpected, ['carol']);
    } finally {
      cleanup();
    }
  });

  it('returns null when there is no active charter to compare against', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-drift-no-active');
      e1.createDraftCharter(db, { projectId, content: { title: 'draft only' } });
      assert.equal(e1.checkResourceDrift(db, { projectId, actual: {} }), null);
    } finally {
      cleanup();
    }
  });

  it('detects drift when a team member and a resource are swapped between categories (Ruling A592-PR3017-R1-HOLD-RECONCILED item 4)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'charter-drift-swap');
      const created = e1.createDraftCharter(db, {
        projectId, content: { title: 'v1', coreTeam: ['alice'], requiredResources: ['db-prod'] }
      });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'sponsor', approverActor: 'carol' });
      e1.recordApproval(db, { projectId, versionId: created.versionId, approverRole: 'pm', approverActor: 'dave' });
      e1.activateCharter(db, { projectId, versionId: created.versionId, requiredRoles: [] });

      // 'alice' and 'db-prod' are the SAME two values the charter declares,
      // just reported under the OPPOSITE category -- a pooled-set
      // comparison would see an identical overall set and report no
      // drift; a category-separated one must not.
      const drift = e1.checkResourceDrift(db, {
        projectId, actual: { coreTeam: ['db-prod'], requiredResources: ['alice'] }
      });
      assert.equal(drift.drift, true);
      assert.ok(drift.missing.includes('alice'), 'alice is missing from the TEAM category specifically');
      assert.ok(drift.missing.includes('db-prod'), 'db-prod is missing from the RESOURCES category specifically');
    } finally {
      cleanup();
    }
  });
});
