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
function isInFleetNamespace(name, prefix) {
  return typeof name === 'string' && name.startsWith(`${prefix}-`) && name.length > prefix.length + 1;
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
 * @param {string} originUrl - A git remote URL (never shell-interpreted —
 *   `execFileSync` with an argv array, no shell).
 * @param {string} destPath - Absolute destination path (must not exist).
 * @returns {void}
 */
function _cloneSibling(originUrl, destPath) {
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
  if (onboardingRules.hasTrustRule(active).present) return;
  const payload = onboardingRules.buildSeedPayload(memberProjectId, { createdBy: 'system' });
  store.sessionRules.create(payload);
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
    if (!_mayReuseExisting(existing, pmProject.id)) {
      throw new FleetProvisionerError('NAME_COLLISION',
        `"${name}" already exists and is not already bound to this Fleet Coordinator`);
    }
    _seedMemberConfig(existing, pmProject);
    _seedTrustRuleFloor(existing.id);
    for (const content of [...commonRules, ...memberRules]) _seedMemberRule(existing.id, content);
    return { name, projectId: existing.id, created: false };
  }

  const config = store.config.load();
  const projectsDir = projects.resolveProjectsDir(config.projectsDir);
  const destPath = path.join(projectsDir, name);
  _cloneSibling(originUrl, destPath);

  const attached = await projects.attachProject(name);
  if (!attached.project) {
    throw new FleetProvisionerError('ATTACH_FAILED', attached.errors[0] || `could not attach "${name}"`);
  }
  if (member.engine) {
    // `projects.update` keys the column `engine_id`, not `engine` — the
    // latter is a BAD_REQUEST, not the silent no-op an older doc comment on
    // that function warns about (#1225 tightened it to fail loud).
    store.projects.update(attached.project.id, { engine_id: member.engine });
  }
  _seedMemberConfig(attached.project, pmProject);
  _seedTrustRuleFloor(attached.project.id);
  for (const content of [...commonRules, ...memberRules]) _seedMemberRule(attached.project.id, content);
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
    pendingControlBinds: provisioned.map((p) => _pendingBindFor(p, pmProject.id))
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
  _seedMemberRule
};
