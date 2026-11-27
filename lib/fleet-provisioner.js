'use strict';

/**
 * Fleet Coordinator / Decider self-service provisioning (#2937).
 *
 * A project the Operator has marked `fleetCoordinator: true` (and granted an
 * active `project-manager` coordinator role) may provision its own
 * `<Prefix>-*` sibling fleet without a repeated per-project Operator
 * approval: clone a sibling checkout from its own git remote, register it,
 * configure it, and seed its starting startup rules.
 *
 * Two pieces of the originally proposed design were escalated to the
 * Architect rather than built as first proposed, after verifying the real
 * code against the issue's "How" section — both resolved, rulings below:
 *
 *   - Binding `control_assignments` to the new children (Ruling
 *     A506-W2A-ARCH-R1, receipt A506-W2A-ARCH-R1). `lib/control-state.js#create`
 *     unconditionally refuses any caller whose resolved principal is not the
 *     operator (`_unauthorized('only the operator creates assignments')`),
 *     with no override parameter, BECAUSE creating an assignment can also
 *     supersede a stopped one in the same transaction (#1861). This module
 *     never satisfies that check by impersonating the operator principal —
 *     the same self-referential-authorization shape a prior feature
 *     (PR #2820) had to remove self-answering over, and `lib/control-state.js`
 *     is intentionally outside this car's file envelope. Instead,
 *     {@link provisionFleet} returns `pendingControlBinds`: a ready-to-bind
 *     `{projectId, projectName, issueRef, authority, status:
 *     'operator_bind_required'}` spec per provisioned child, in the exact
 *     shape `controlState.create`'s own `normalizeAuthority` expects (note:
 *     `releaseDelegations` must be `{}`, an object — the ruling's own example
 *     wrote `[]`, which `normalizeAuthority` explicitly rejects via
 *     `Array.isArray`; corrected here after checking the real validator).
 *   - Authoring "TEAM COMMON CORE + ROLE OVERLAY" startup-rule CONTENT
 *     (Ruling A506-W2A-ARCH-R2, receipt A506-W2A-ARCH-R2). No such reusable
 *     team-specific template exists anywhere in this repo (verified by
 *     search) — this module never invents one. The caller may supply its own
 *     team-wide rule content (`commonRules`/`teamCommonCore`, top-level) and
 *     per-member content (`rules`/`roleOverlay`); both accept a string or an
 *     array of strings, seeded with `createdBy: 'system'`. As the built-in
 *     floor every provisioned child gets regardless, {@link provisionFleet}
 *     reuses the already Architect-ratified onboarding trust rule
 *     (`lib/project-onboarding-rules.js`, Ruling A491-W1C-PR2776-R2/R3,
 *     #2125) rather than inventing new governance prose, deduplicated by its
 *     own tag via `hasTrustRule` so a re-run stays idempotent.
 *
 * The grant that turns `fleetCoordinator` on is intentionally NOT this
 * module's concern either: it lives behind the Operator-gated
 * `POST /api/tc/fleet/coordinator` route (`lib/routes/tc.js`), the only
 * writer of that flag. This module only ever READS it, as the precondition
 * {@link verifyCoordinatorAuthority} checks — the project exercising the
 * delegated capability can never also be the one granting it to itself.
 *
 * @module lib/fleet-provisioner
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const store = require('./store');
const projects = require('./projects');
const onboardingRules = require('./project-onboarding-rules');

class FleetProvisionerError extends Error {
  /**
   * @param {string} code - A stable machine-readable reason.
   * @param {string} message - Human-readable detail.
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * The prefix a PM project's own name implies for its fleet, e.g.
 * `"Ariadne-PM"` -> `"Ariadne"`. The PM project's name MUST end with `-PM`
 * (case-sensitive, matching the existing fleet naming convention this
 * server's own panes use) — a project not named that way cannot derive a
 * fleet namespace at all, so {@link verifyCoordinatorAuthority} refuses it
 * rather than guess one.
 * @param {string} pmProjectName - The calling project's own `name`.
 * @returns {string|null} The prefix, or null if the name does not end `-PM`.
 */
function derivePrefix(pmProjectName) {
  if (typeof pmProjectName !== 'string' || !pmProjectName.endsWith('-PM')) return null;
  const prefix = pmProjectName.slice(0, -'-PM'.length);
  return prefix.length > 0 ? prefix : null;
}

/**
 * Whether `name` sits inside `prefix`'s fleet namespace: `<prefix>-<rest>`,
 * `<rest>` non-empty. Strict prefix-plus-hyphen match — `prefix` alone (no
 * trailing segment) and a different project that merely starts with the same
 * letters but no separating hyphen (e.g. `"Ariadnex"` against `"Ariadne"`)
 * both fail this, which is the point: "strictly matching the `<Prefix>-*`
 * namespace" (#2937 acceptance criteria) means no partial-string match.
 * @param {string} name - Candidate project name.
 * @param {string} prefix - The fleet's own prefix (from {@link derivePrefix}).
 * @returns {boolean}
 */
// PRR-A R-Gate HOLD `d02ed20a` on PR #2952: `startsWith` alone let
// `"${prefix}-../../../tmp/outside"` pass as "in namespace" — a
// `path.join(projectsDir, name)` of that string resolves OUTSIDE
// `projectsDir` entirely, and `_cloneSibling` ran on it before
// `attachProject`'s own name validation ever got a chance to refuse it.
// No dots, slashes or backslashes at all: these are synthetic role-suffix
// names this module itself builds requests around, never free-text a
// human needs spaces or punctuation in, so excluding `.` entirely (not
// just `..`) closes the class rather than one member of it. Stricter than
// `store.js#PROJECT_NAME_REGEX` (which allows spaces) on purpose — that
// regex exists for human-chosen project names, this one for role suffixes.
const FLEET_MEMBER_NAME_RE = /^[A-Za-z0-9_-]+$/;

function isInFleetNamespace(name, prefix) {
  return typeof name === 'string' && FLEET_MEMBER_NAME_RE.test(name)
    && name.startsWith(`${prefix}-`) && name.length > prefix.length + 1;
}

/**
 * The second, independent check `_provisionOne` runs before any clone: that
 * `name` resolves to a DIRECT CHILD of `projectsDir`, never a traversal out
 * of it. Deliberately separate from {@link isInFleetNamespace} — a regex is
 * a claim about the STRING; this is a claim about the PATH it resolves to,
 * and the second is the one that actually matters to the filesystem. Defense
 * in depth: with `FLEET_MEMBER_NAME_RE` in place this should never trip, but
 * a future loosening of that regex must not silently regain the hole this
 * closes.
 * @param {string} name - Already passed {@link isInFleetNamespace}.
 * @param {string} projectsDir - Resolved `projectsDir`.
 * @returns {boolean}
 */
function _resolvesInsideProjectsDir(name, projectsDir) {
  const resolvedDir = path.resolve(projectsDir);
  const resolvedTarget = path.resolve(projectsDir, name);
  return path.dirname(resolvedTarget) === resolvedDir;
}

/**
 * The precondition every delegated fleet action requires: the caller's own
 * project (identified by a server-verified id, never a client-supplied
 * claim — the launch-binding guard already verifies it for every mutating
 * route before a handler runs) has `fleetCoordinator: true` on disk AND an
 * active `project-manager` coordinator role in the DB. Both reads are
 * server-owned state; neither is ever taken from the request body. The
 * second check is the real defense-in-depth (Ruling A506-W2A-ARCH-R3): even
 * a direct on-disk edit of `project.json` cannot alone satisfy this
 * precondition, because `coordinator_roles` is a DB table only the
 * Operator-gated `POST /api/tc/fleet/coordinator` route ever writes.
 * @param {number} callerProjectId - The verified caller project id.
 * @returns {{project: object, prefix: string}} The caller project and its
 *   derived fleet prefix.
 * @throws {FleetProvisionerError} NOT_FOUND, NOT_FLEET_COORDINATOR,
 *   NO_COORDINATOR_ROLE, or BAD_PM_NAME.
 */
function verifyCoordinatorAuthority(callerProjectId) {
  const project = store.projects.get(callerProjectId);
  if (!project) throw new FleetProvisionerError('NOT_FOUND', `no project with id ${callerProjectId}`);
  const config = store.projectConfig.load(project.path);
  if (config.fleetCoordinator !== true) {
    throw new FleetProvisionerError('NOT_FLEET_COORDINATOR',
      `project "${project.name}" is not a Fleet Coordinator — an Operator must enable it first `
      + '(POST /api/tc/fleet/coordinator)');
  }
  const role = store.coordinatorRoles.getActiveForProject(callerProjectId);
  if (!role || role.role !== 'project-manager') {
    throw new FleetProvisionerError('NO_COORDINATOR_ROLE',
      `project "${project.name}" has no active project-manager coordinator role`);
  }
  const prefix = derivePrefix(project.name);
  if (!prefix) {
    throw new FleetProvisionerError('BAD_PM_NAME',
      `project "${project.name}" does not end "-PM" — cannot derive a fleet namespace`);
  }
  return { project, prefix };
}

/**
 * Whether an existing project named `name` may be reused as a provisioning
 * target rather than refused as a collision: the acceptance criteria's own
 * carve-out — "or projects where `control_assignments` already names
 * `project:<pmProjectId>` in `lifecycle`" (#2937) — makes re-running
 * provisioning on an already-bound sibling idempotent, while still refusing
 * an unrelated pre-existing project of the same name.
 * @param {object} existing - The existing project row (`store.projects.get`-shaped).
 * @param {number} pmProjectId - The calling PM's own project id.
 * @returns {boolean}
 */
function _mayReuseExisting(existing, pmProjectId) {
  const assignment = store.control.getOpenForProject(existing.id);
  if (!assignment) return false;
  let authority;
  try {
    authority = JSON.parse(assignment.authority_json);
  } catch {
    return false;
  }
  const principal = `project:${pmProjectId}`;
  return Array.isArray(authority && authority.lifecycle) && authority.lifecycle.includes(principal);
}

/**
 * Clone `originUrl` into `destPath` with a plain `git clone`. Synchronous and
 * narrow on purpose: this is server-side provisioning of a handful of sibling
 * checkouts, not a hot path, and a thrown `Error` from `execFileSync` already
 * carries the git CLI's own stderr, which is the honest failure to surface.
 *
 * Checks `destPath` itself first (#3322): a bare `git clone` into an
 * already-existing, non-empty directory fails with git's own opaque "fatal:
 * destination path ... already exists" — the exact shape a leftover partial
 * clone from an earlier interrupted `tc fleet provision` call (a batch
 * timeout, a server restart mid-clone) leaves behind, with no SQLite row yet
 * to resolve it against (that only happens after a successful clone, below).
 * Refusing it by name here, rather than letting git's stderr bubble up
 * unexplained, is the "handle it cleanly" half of #3322; removing the stale
 * directory automatically is not attempted — this module has no way to tell
 * a leftover clone apart from an operator's own unrelated directory of the
 * same name, so it reports the collision instead of guessing.
 * @param {string} originUrl - A git remote URL (never shell-interpreted —
 *   `execFileSync` with an argv array, no shell).
 * @param {string} destPath - Absolute destination path (must not exist).
 * @returns {void}
 * @throws {FleetProvisionerError} DEST_DIR_EXISTS if `destPath` is already there.
 */
function _cloneSibling(originUrl, destPath) {
  if (fs.existsSync(destPath)) {
    throw new FleetProvisionerError('DEST_DIR_EXISTS',
      `"${destPath}" already exists — an earlier provisioning attempt may have left a partial clone there; `
      + 'remove it before retrying');
  }
  execFileSync('git', ['clone', '--quiet', originUrl, destPath], { stdio: 'pipe' });
}

/**
 * This PM project's own `origin` remote URL, read from its live git checkout
 * — never a client-supplied claim, since a provisioning call that could name
 * an arbitrary remote would defeat the whole namespace guardrail.
 * @param {string} pmProjectPath - The PM project's absolute path.
 * @returns {string} The origin URL.
 * @throws {FleetProvisionerError} NO_ORIGIN if the checkout has none.
 */
function _ownOriginUrl(pmProjectPath) {
  let url;
  try {
    url = execFileSync('git', ['-C', pmProjectPath, 'remote', 'get-url', 'origin'], { stdio: 'pipe' })
      .toString('utf8').trim();
  } catch (err) {
    throw new FleetProvisionerError('NO_ORIGIN', `could not read this project's own origin remote: ${err.message}`);
  }
  if (!url) throw new FleetProvisionerError('NO_ORIGIN', "this project's own checkout has no origin remote");
  return url;
}

/**
 * Merge this fleet's shared initial config into a member's
 * `.tangleclaw/project.json`: `medusaEnabled`/`medusaWake` true, a
 * hands-off `defaultLaunchMode`, and `workloadNudge.coordinatorProject`
 * pointed at the PM — the exact fields #2937's acceptance criteria name,
 * written through the existing reader/writer pair
 * (`store.projectConfig.load`/`.save`) rather than a raw `fs` write, so an
 * already-present override on an existing sibling survives the merge.
 * @param {object} memberProject - The member's project row.
 * @param {object} pmProject - The PM's own project row.
 * @returns {void}
 */
function _seedMemberConfig(memberProject, pmProject) {
  const current = store.projectConfig.load(memberProject.path);
  const currentNudge = (current.workloadNudge && typeof current.workloadNudge === 'object')
    ? current.workloadNudge : {};
  const next = {
    ...current,
    medusaEnabled: true,
    medusaWake: true,
    // `'default'` is `DEFAULT_PROJECT_CONFIG`'s own unset value for this
    // field (project-config.js's comment on it) — not falsy, so an explicit
    // `=== 'default'` check is required; `||` would never fire.
    defaultLaunchMode: current.defaultLaunchMode === 'default' ? 'bypassPermissions' : current.defaultLaunchMode,
    // #3331 item 2: left at the shipped defaults, every freshly-provisioned
    // member still paused on a manual launch-mode picker and an unaccepted
    // folder-trust prompt despite ALSO being seeded straight onto
    // `bypassPermissions` above — exactly the two things an unattended fleet
    // lane cannot click through itself, requiring the Operator/PM to flip
    // both by hand on every single member. Same guard as `defaultLaunchMode`
    // just above: compares against the SHIPPED default specifically, so an
    // already-present override on an existing sibling still survives the
    // merge rather than being silently reset by a re-run.
    showLaunchModePicker: current.showLaunchModePicker === true ? false : current.showLaunchModePicker,
    acceptFolderTrust: current.acceptFolderTrust === false ? true : current.acceptFolderTrust,
    workloadNudge: { enabled: true, coordinatorProject: pmProject.name, ...currentNudge }
  };
  store.projectConfig.save(memberProject.path, next);
}

/**
 * Normalize a caller-supplied rule field to an array of non-empty strings.
 * Accepts a single string or an array of strings; anything else is a
 * BAD_REQUEST rather than a silent drop.
 * @param {*} value - `undefined`, a string, or an array of strings.
 * @param {string} fieldName - For the error message.
 * @returns {string[]}
 * @throws {FleetProvisionerError} BAD_REQUEST.
 */
function _normalizeRuleField(value, fieldName) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (!list.every((v) => typeof v === 'string' && v.trim())) {
    throw new FleetProvisionerError('BAD_REQUEST', `${fieldName} must be a string or an array of non-empty strings`);
  }
  return list;
}

/**
 * Seed one `system`-authored active startup rule on a member project, unless
 * one with identical content is already active there (idempotent on replay).
 * @param {number} memberProjectId - The member's project id.
 * @param {string} content - Rule text the caller supplied (never authored here).
 * @returns {void}
 */
function _seedMemberRule(memberProjectId, content) {
  const already = store.sessionRules.listActiveForProject(memberProjectId)
    .some((r) => r.content === content);
  if (already) return;
  store.sessionRules.create({
    projectId: memberProjectId,
    content,
    createdBy: 'system',
    kind: 'startup',
    owner: 'fleet-provisioner'
  });
}

/**
 * The built-in floor every provisioned child gets: the Architect-ratified
 * onboarding trust rule (#2125), reused rather than reinvented (Ruling
 * A506-W2A-ARCH-R2). Deduplicated by its own tag via `hasTrustRule`, so a
 * re-run over an already-seeded child is a no-op.
 * @param {number} memberProjectId - The member's project id.
 * @returns {void}
 */
function _seedTrustRuleFloor(memberProjectId) {
  // `hasTrustRule` treats any non-stale status (including 'proposed') as
  // "present" — correct for ITS caller (don't re-propose over a pending
  // review), wrong for this one: `projects.attachProject` already calls
  // `ensureOnboardingTrustRule` on every new attach, which PROPOSES this
  // same rule ('ai'-authored, status 'proposed') unconditionally. Checking
  // `hasTrustRule` directly here would read that unrelated proposal as
  // "already seeded" and never activate anything. This module wants an
  // ACTIVE floor on a freshly-provisioned child, so it checks active rows
  // specifically — the dedup condition matches `_seedMemberRule`'s own.
  const active = store.sessionRules.listActiveForProject(memberProjectId);
  if (!onboardingRules.hasTrustRule(active).present) {
    const payload = onboardingRules.buildSeedPayload(memberProjectId, { createdBy: 'system' });
    store.sessionRules.create(payload);
  }
  _rejectDuplicateProposedTrustRule(memberProjectId);
}

/**
 * Reject the 'proposed' onboarding trust rule `attachProject`'s own
 * `ensureOnboardingTrustRule` unconditionally seeds on every new attach, now
 * that {@link _seedTrustRuleFloor} (above) has confirmed an active copy is in
 * force — leaving both would seed every fleet-provisioned member with two
 * rows carrying the identical rule (#3322). `setStatus` only allows
 * `proposed -> rejected` (never a straight delete), which is the correct
 * record here: it was reviewed and found redundant, not erased.
 * @param {number} memberProjectId - The member's project id.
 * @returns {void}
 */
function _rejectDuplicateProposedTrustRule(memberProjectId) {
  const proposed = store.sessionRules.list({ projectId: memberProjectId, status: 'proposed' })
    .find((r) => onboardingRules.hasTrustRule([r]).present);
  if (!proposed) return;
  store.sessionRules.setStatus(proposed.id, 'rejected', {
    changedBy: 'system',
    changeReason: 'superseded by the fleet-provisioner active trust-rule floor (#3322)'
  });
}

/**
 * The relative path of the provisioning marker {@link _writeProvisioningMarker}
 * writes and {@link _isIncompleteAttach} reads — a durable, per-OPERATION
 * record of which PM project id's own `_cloneSibling` call produced this
 * checkout, written into the clone itself before anything else touches it.
 * @type {string}
 */
const PROVISIONING_MARKER_RELPATH = path.join('.tangleclaw', '.fleet-provisioner-marker.json');

/**
 * Write the durable ownership marker into a just-cloned checkout, before
 * `projects.attachProject` runs (PRR-B R-Gate Round 2 BLOCKING on PR #3334):
 * an `origin` URL match alone proves the checkout came from the SAME shared
 * repository, never that THIS specific provisioning call (by THIS PM) is
 * the one that produced it — a different coordinator's own interrupted
 * checkout of the identical repository, or an unrelated/stale clone of it,
 * would pass an origin-only check too. The marker instead records exactly
 * which `pmProjectId` this clone belongs to, at the one moment this module
 * can be certain: right after its own `_cloneSibling` succeeded.
 * @param {string} destPath - The just-cloned checkout's path.
 * @param {number} pmProjectId - The calling PM's own project id.
 * @returns {void}
 */
function _writeProvisioningMarker(destPath, pmProjectId) {
  const markerPath = path.join(destPath, PROVISIONING_MARKER_RELPATH);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({ pmProjectId, createdAt: new Date().toISOString() }) + '\n');
}

/**
 * Read back {@link _writeProvisioningMarker}'s marker, or `null` if absent,
 * unreadable, or malformed — every caller treats `null` as "no proof",
 * never as "trust it anyway".
 * @param {string} existingPath - The existing project's path.
 * @returns {{pmProjectId: number, createdAt: string}|null}
 */
function _readProvisioningMarker(existingPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(existingPath, PROVISIONING_MARKER_RELPATH), 'utf8'));
    return (parsed && Number.isInteger(parsed.pmProjectId)) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Remove the provisioning marker once the WHOLE operation it was standing
 * in for — reconcile/attach AND every seeding step after it — has actually
 * finished (PRR-B R-Gate Round 3 WARNING on PR #3334): removing it any
 * earlier (e.g. right after `project.json` is written, before config/trust-
 * rule/rule seeding runs) loses the only evidence a retry needs if THAT
 * later step is what gets interrupted instead, and `project.json` existing
 * by then means {@link _isIncompleteAttach} could no longer recognize it —
 * stranding an unbound member retries can neither resume nor reuse. Safe to
 * call even when nothing was ever written this way.
 * @param {string} existingPath - The project's path.
 * @returns {void}
 */
function _removeProvisioningMarker(existingPath) {
  try {
    fs.unlinkSync(path.join(existingPath, PROVISIONING_MARKER_RELPATH));
  } catch {
    // Already gone, or never written this way — nothing to clean up.
  }
}

/**
 * Whether `existing` is this module's OWN half-finished artifact from an
 * earlier `_provisionOne` call interrupted ANYWHERE between `_cloneSibling`
 * succeeding and the whole operation's own marker removal at the end (#3322;
 * widened per PRR-B R-Gate Round 3 WARNING from "before `project.json` is
 * written" to "before every seeding step after it too" — a crash during
 * config/trust-rule/rule seeding, with `project.json` already written by a
 * PRIOR retry's {@link _finishInterruptedAttach}, must still be recognized
 * as resumable). Never true for a genuinely unrelated pre-existing project
 * of the same name: shape alone (a `.git` directory) is not durable proof of
 * ownership, and neither, on its own, is an `origin` remote match — that
 * proves the checkout came from the SAME shared repository, not that THIS
 * PM's own call produced it; multiple fleets on the same host can clone the
 * identical upstream repo under different coordinators (PRR-B R-Gate Rounds
 * 1 and 2 BLOCKING). The mandatory proof is BOTH: the `origin` match
 * (defense against a forged or copied marker landing on an unrelated
 * checkout) AND {@link _readProvisioningMarker} naming THIS exact
 * `pmProjectId` (defense against a same-origin checkout this PM never
 * cloned) — the marker's presence IS the signal, not `project.json`'s
 * absence, which is why this no longer checks `project.json` at all: it is
 * exactly as likely to already exist (a retry resuming mid-seeding) as not
 * (a retry resuming right after the clone), and either way the marker
 * surviving is what proves there is still unfinished work of THIS PM's own.
 * @param {object} existing - The existing project row.
 * @param {string} originUrl - This PM's own origin remote URL
 *   ({@link _ownOriginUrl}), the exact value a genuine interrupted attach of
 *   THIS fleet would have been cloned from.
 * @param {number} pmProjectId - The calling PM's own project id.
 * @returns {boolean}
 */
function _isIncompleteAttach(existing, originUrl, pmProjectId) {
  if (!fs.existsSync(path.join(existing.path, '.git'))) return false;
  let remote;
  try {
    remote = execFileSync('git', ['-C', existing.path, 'remote', 'get-url', 'origin'], { stdio: 'pipe' })
      .toString('utf8').trim();
  } catch {
    return false;
  }
  if (remote !== originUrl) return false;
  const marker = _readProvisioningMarker(existing.path);
  return marker !== null && marker.pmProjectId === pmProjectId;
}

/**
 * Finish an attach {@link _isIncompleteAttach} found interrupted: write the
 * missing `.tangleclaw/project.json`, carrying over the engine SQLite already
 * recorded (set at `store.projects.create()` time, before the point this
 * module's own call into `projects.attachProject` was cut off) — so the
 * config/trust-rule seeding that runs right after has a real file to merge
 * onto instead of silently re-reading `DEFAULT_PROJECT_CONFIG` every retry.
 * Idempotent — a retry that resumes here a second time (because THIS step
 * completed before but a later seeding step was what actually got
 * interrupted) just re-applies the same engine, which is already correct.
 * Does NOT touch the provisioning marker: {@link _removeProvisioningMarker}
 * is the caller's job, once every step after this one has also finished.
 * @param {object} existing - The existing, incompletely-attached project row.
 * @returns {void}
 */
function _finishInterruptedAttach(existing) {
  const config = store.projectConfig.load(existing.path);
  config.engine = existing.engineId;
  store.projectConfig.save(existing.path, config);
}

/**
 * Provision one fleet member: reuse it if it is already a bound sibling,
 * otherwise clone it from the PM's own origin and register it. Seeds the
 * trust-rule floor plus any team-wide and per-member rule content either way
 * (Ruling A506-W2A-ARCH-R2).
 * @param {object} opts
 * @param {object} opts.pmProject - The calling PM's own project row.
 * @param {string} opts.prefix - The PM's fleet prefix.
 * @param {string} opts.originUrl - The PM's own origin remote URL.
 * @param {string[]} opts.commonRules - Team-wide rule content, every member gets each one.
 * @param {{name: string, engine?: string, rules?: (string|string[])}} opts.member - One
 *   fleet member to provision. `rules`/`roleOverlay` (both accepted, merged)
 *   is this member's own rule content, in addition to `commonRules`.
 * @returns {Promise<{name: string, projectId: number, created: boolean}>}
 * @throws {FleetProvisionerError} OUT_OF_NAMESPACE, NAME_COLLISION, BAD_REQUEST, or
 *   whatever `projects.attachProject` reports as its first error.
 */
async function _provisionOne({ pmProject, prefix, originUrl, commonRules, member }) {
  const name = member.name;
  if (!isInFleetNamespace(name, prefix)) {
    throw new FleetProvisionerError('OUT_OF_NAMESPACE',
      `"${name}" is outside the "${prefix}-*" fleet namespace`);
  }
  const memberRules = [
    ..._normalizeRuleField(member.rules, 'member.rules'),
    ..._normalizeRuleField(member.roleOverlay, 'member.roleOverlay')
  ];

  const existing = store.projects.getByNameCaseInsensitive(name);
  if (existing) {
    const incompleteAttach = _isIncompleteAttach(existing, originUrl, pmProject.id);
    if (!incompleteAttach && !_mayReuseExisting(existing, pmProject.id)) {
      throw new FleetProvisionerError('NAME_COLLISION',
        `"${name}" already exists and is not already bound to this Fleet Coordinator`);
    }
    if (incompleteAttach) _finishInterruptedAttach(existing);
    _seedMemberConfig(existing, pmProject);
    _seedTrustRuleFloor(existing.id);
    for (const content of [...commonRules, ...memberRules]) _seedMemberRule(existing.id, content);
    // Only now — every step this operation owns has actually finished — is
    // the marker's job done (PRR-B R-Gate Round 3 WARNING). Unconditional
    // and safe even on the ordinary already-bound-reuse path, which never
    // wrote one.
    _removeProvisioningMarker(existing.path);
    return { name, projectId: existing.id, created: false };
  }

  const config = store.config.load();
  const projectsDir = projects.resolveProjectsDir(config.projectsDir);
  if (!_resolvesInsideProjectsDir(name, projectsDir)) {
    throw new FleetProvisionerError('OUT_OF_NAMESPACE',
      `"${name}" does not resolve to a direct child of the projects directory`);
  }
  const destPath = path.join(projectsDir, name);
  _cloneSibling(originUrl, destPath);
  // Written immediately after a successful clone, before attachProject runs
  // — the earliest point this module can durably record whose provisioning
  // call this checkout belongs to, so a later retry's _isIncompleteAttach
  // check has real per-operation evidence rather than origin-match alone.
  _writeProvisioningMarker(destPath, pmProject.id);

  // #3322: pass the member's engine straight into `attachProject` (its own
  // `options.engine`, supported since #3289) rather than cloning with no
  // engine and patching SQLite's `engine_id` afterward — that left
  // `.tangleclaw/project.json` (written by `attachProject` itself, using
  // whatever engine IT resolved) permanently disagreeing with SQLite for
  // every provisioned member, since nothing ever went back to fix the file.
  const attached = await projects.attachProject(name, { engine: member.engine });
  if (!attached.project) {
    throw new FleetProvisionerError('ATTACH_FAILED', attached.errors[0] || `could not attach "${name}"`);
  }
  _seedMemberConfig(attached.project, pmProject);
  _seedTrustRuleFloor(attached.project.id);
  for (const content of [...commonRules, ...memberRules]) _seedMemberRule(attached.project.id, content);
  // The marker written above has now done its job for the whole operation,
  // not just the attach step (PRR-B R-Gate Round 3 WARNING) — this was the
  // one successful path that used to leave it behind forever.
  _removeProvisioningMarker(attached.project.path);
  return { name, projectId: attached.project.id, created: true };
}

/**
 * The ready-to-bind `control_assignments` spec for one provisioned child —
 * never created here (Ruling A506-W2A-ARCH-R1; see module doc). The shape
 * matches `lib/control-state.js#normalizeAuthority` exactly, so the
 * Operator's real `create` call can take it unchanged.
 * @param {{name: string, projectId: number}} provisioned - One entry from
 *   {@link provisionFleet}'s own result.
 * @param {number} pmProjectId - The Fleet Coordinator's own project id.
 * @returns {object}
 */
function _pendingBindFor(provisioned, pmProjectId) {
  const principal = `project:${pmProjectId}`;
  return {
    projectId: provisioned.projectId,
    projectName: provisioned.name,
    issueRef: null,
    authority: { hold: [principal], stop: [principal], lifecycle: [principal], releaseDelegations: {} },
    status: 'operator_bind_required'
  };
}

/**
 * Provision a Fleet Coordinator's `<Prefix>-*` sibling fleet (#2937).
 * @param {number} callerProjectId - The verified caller project id.
 * @param {{name: string, engine?: string, rules?: (string|string[]), roleOverlay?: (string|string[])}[]} members -
 *   Up to 8 fleet members (the fixed role roster: `Arc`, `PRR-A`, `PRR-B`,
 *   `INT`, `Obsr`, `Lane-A`..`Lane-D` — the caller names which; this module
 *   does not assume all 8 are always requested in one call).
 * @param {object} [options]
 * @param {(string|string[])} [options.commonRules] - Team-wide rule content
 *   every member gets, in addition to its own.
 * @param {(string|string[])} [options.teamCommonCore] - Alias of `commonRules`
 *   (both accepted, merged) — the name the issue's acceptance criteria used.
 * @returns {Promise<{provisioned: {name: string, projectId: number, created: boolean}[],
 *   pendingControlBinds: object[]}>} `pendingControlBinds` names every
 *   provisioned member that still needs its `control_assignments` row bound
 *   by a real Operator action (see module doc) — never silently dropped.
 * @throws {FleetProvisionerError}
 */
async function provisionFleet(callerProjectId, members, options = {}) {
  if (!Array.isArray(members) || members.length === 0) {
    throw new FleetProvisionerError('BAD_REQUEST', 'members must be a non-empty array');
  }
  if (members.length > 8) {
    throw new FleetProvisionerError('BAD_REQUEST', 'at most 8 members per call');
  }
  const commonRules = [
    ..._normalizeRuleField(options.commonRules, 'commonRules'),
    ..._normalizeRuleField(options.teamCommonCore, 'teamCommonCore')
  ];
  const { project: pmProject, prefix } = verifyCoordinatorAuthority(callerProjectId);
  const originUrl = _ownOriginUrl(pmProject.path);

  const provisioned = [];
  for (const member of members) {
    if (!member || typeof member.name !== 'string' || !member.name) {
      throw new FleetProvisionerError('BAD_REQUEST', 'every member needs a name');
    }
    // Sequential, not `Promise.all` — members commonly share the same
    // `projectsDir` and clone from the same origin; serializing keeps two
    // concurrent `git clone` processes from racing over disk I/O for no
    // benefit (a handful of small repos, not a hot path).
    // eslint-disable-next-line no-await-in-loop
    provisioned.push(await _provisionOne({ pmProject, prefix, originUrl, commonRules, member }));
  }

  return {
    provisioned,
    // PRR-A R-Gate HOLD `d02ed20a` on PR #2952: a reused, already-bound
    // sibling (`created: false`) by definition already passed
    // `_mayReuseExisting`'s own-control-assignment check — listing it here
    // too would tell the Operator a real bind is still needed when one
    // already exists.
    pendingControlBinds: provisioned.filter((p) => p.created).map((p) => _pendingBindFor(p, pmProject.id))
  };
}

module.exports = {
  FleetProvisionerError,
  derivePrefix,
  isInFleetNamespace,
  verifyCoordinatorAuthority,
  provisionFleet,
  // Exported for tests only.
  _mayReuseExisting,
  _seedMemberConfig,
  _seedMemberRule,
  _isIncompleteAttach
};
