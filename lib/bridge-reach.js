'use strict';

// Which projects the operator bridge may reach, and how one is named (#2031,
// ADR 0023 Decision 9a). One answer, asked by everything that needs it: what
// the gateway suggests for an inbound message, what the Project Master may
// route to or ask to have launched, and what `tc bridge destinations` lists.
//
// Nothing here is stored or cached. Each answer is worked out from the
// project registry at the moment it is asked for, so a project created a
// second ago is reachable now, and one archived, deleted, opted out or moved
// out of the Master's scope a second ago is not.

const store = require('./store');
const bridgeStore = require('./bridge-store');
const { createLogger } = require('./logger');

const log = createLogger('bridge-reach');

/** Seams, so tests set the Master's scope and a session's listener without a Master or a Hub. */
const _deps = {
  /** @returns {string|{type: string, groupId: string}} The Master's configured scope. */
  masterScope: () => require('./master').masterSettings(store.config.load()).scope,
  medusa: () => require('./medusa'),
  /** @returns {boolean} Whether a session has the launch record a message's reply is later proven against. */
  hasLaunch: (sessionId) => Boolean(store.launchSequences.getBySession(Number(sessionId)))
};

/** Why a scope could not be resolved, in words, by its closed cause. */
const SCOPE_CAUSES = Object.freeze({
  'group-missing': 'it names a project group that no longer exists',
  malformed: 'it is not a scope the bridge understands',
  unreadable: 'the Master settings could not be read'
});

/**
 * A project's slug: its name in lower case, with each run of anything but a
 * letter or a digit made one dash, and no dash at either end. A convenience
 * for typing a name that has spaces in it; it identifies a project only while
 * exactly one reachable project has it.
 * @param {string} name - Project name.
 * @returns {string}
 */
function slugOf(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The Master's scope, as the bridge reads it. It fails closed: a scope that
 * names a group which no longer exists, or that cannot be read or understood,
 * reaches nothing. (The Master's own identity text falls back to every project
 * in that case. That is a focus setting; this decides where a message can go.)
 * Unresolved, it says which of three things went wrong, so that what the
 * operator is told to put right is the thing that is wrong.
 * @returns {{kind: 'all'}|{kind: 'group', groupId: string, groupName: string, projectIds: Set<number>}|{kind: 'unresolved', cause: ('group-missing'|'malformed'|'unreadable')}}
 */
function scope() {
  let raw;
  try {
    raw = _deps.masterScope();
  // prawduct:allow prawduct/broad-except -- a scope that cannot be read is one answer here: unresolved, so nothing is reachable
  } catch (err) {
    log.warn('Bridge could not read the Project Master\'s scope', { error: err && (err.code || err.name) });
    return { kind: 'unresolved', cause: 'unreadable' };
  }
  if (raw === 'all') return { kind: 'all' };
  if (raw && typeof raw === 'object' && raw.type === 'group' && raw.groupId) {
    const group = store.projectGroups.get(raw.groupId);
    if (!group) return { kind: 'unresolved', cause: 'group-missing' };
    return { kind: 'group', groupId: raw.groupId, groupName: group.name, projectIds: new Set(store.projectGroups.listMembers(raw.groupId)) };
  }
  return { kind: 'unresolved', cause: 'malformed' };
}

/**
 * The scope as it is shown: its kind, the group's name, or why it could not be resolved.
 * @param {object} [within] - A scope; read afresh by default.
 * @returns {{kind: string, groupName?: string, cause?: string, why?: string}}
 */
function scopeSummary(within = scope()) {
  if (within.kind === 'group') return { kind: 'group', groupName: within.groupName };
  if (within.kind === 'unresolved') return { kind: 'unresolved', cause: within.cause, why: SCOPE_CAUSES[within.cause] };
  return { kind: 'all' };
}

/**
 * Why a project is out of the bridge's reach, as a closed code, or null when
 * it is within it.
 * @param {object|null} project - A project row, or null for one that does not exist.
 * @param {object} [within] - The scope to judge by; read afresh by default.
 * @returns {('unknown'|'archived'|'scope-unresolved'|'out-of-scope'|'opted-out'|null)}
 */
function outOfReach(project, within = scope()) {
  if (!project) return 'unknown';
  if (project.archived) return 'archived';
  if (within.kind === 'unresolved') return 'scope-unresolved';
  if (within.kind === 'group' && !within.projectIds.has(project.id)) return 'out-of-scope';
  if (bridgeStore.optouts.has(project.id)) return 'opted-out';
  return null;
}

/**
 * Every project the bridge may reach right now, by name.
 * @returns {{scope: object, projects: object[]}} The scope they were judged by, and the project rows.
 */
function reachable() {
  const within = scope();
  // An unresolved scope needs no case of its own: every project is out of reach by it.
  const projects = store.projects.list().filter((project) => outOfReach(project, within) === null);
  return { scope: within, projects: projects.sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id - b.id) };
}

/**
 * How a project stands as somewhere to send a message, from what the server
 * itself holds: its active sessions, and which of them it has a Medusa
 * listener for.
 *
 * A session a message can be sent to is one the server has a listener for
 * AND a launch record for: the reply to a message is proven against that
 * record, so a session without one can be sent nothing. This is the one
 * definition, for the question "may I route to it" and the question "may I
 * launch it" alike, so the two never disagree.
 *
 * - `live`: exactly one such session. A message can be sent to it.
 * - `not-running`: no session. One may be launched, on the operator's consent.
 * - `unreachable`: a session is running and none can be sent to. Nothing can
 *   be sent, and a launch would start nothing.
 * - `several-live`: more than one. Launch policy allows one, so this is an
 *   anomaly, and which of them a message is for is never guessed.
 * @param {number} projectId - Project id.
 * @returns {{state: ('live'|'not-running'|'unreachable'|'several-live'), sessions: number, listening: number[]}} `listening` is the sessions a message can be sent to.
 */
function liveness(projectId) {
  const active = store.sessions.list(projectId, { status: 'active', limit: 50 });
  const listening = active.filter((session) => Boolean(_deps.medusa().getStatus(session.id).workspaceId) && _deps.hasLaunch(session.id)).map((session) => session.id);
  const state = active.length === 0 ? 'not-running' : (listening.length === 0 ? 'unreachable' : (listening.length === 1 ? 'live' : 'several-live'));
  return { state, sessions: active.length, listening };
}

/**
 * What `tc bridge destinations` shows: each reachable project with every way
 * of naming it and how it stands, and whether the scope could be resolved at
 * all, so that an empty list is never mistaken for "there are no projects".
 * @returns {{scope: {kind: string, groupName?: string}, destinations: object[], optedOut: number}}
 */
function destinations() {
  const { scope: within, projects } = reachable();
  const nicknames = bridgeStore.aliases.list();
  const slugs = new Map();
  for (const project of projects) slugs.set(slugOf(project.name), (slugs.get(slugOf(project.name)) || 0) + 1);
  return {
    scope: scopeSummary(within),
    destinations: projects.map((project) => {
      const slug = slugOf(project.name);
      return {
        projectId: project.id, name: project.name,
        // A slug two reachable projects share names neither of them.
        slug: slug && slugs.get(slug) === 1 ? slug : null,
        nicknames: nicknames.filter((n) => n.destination.kind === 'project' && n.destination.projectId === project.id).map((n) => n.alias),
        live: liveness(project.id).state
      };
    }),
    optedOut: bridgeStore.optouts.list().length
  };
}

/**
 * Every distinct destination a typed name could mean, among what is
 * reachable: the reserved `master`, a nickname, a project's exact name without
 * regard to case, its slug when no other reachable project shares it, or its
 * id. One result is an address; none or several is not, and is never guessed
 * at. A nickname whose project is out of reach names nothing.
 * @param {string} name - The token as typed, without any `@`.
 * @returns {{kind: string, projectId: (number|null)}[]}
 */
function named(name) {
  const key = String(name).toLowerCase();
  if (key === 'master') return [{ kind: 'master', projectId: null }];
  const { projects } = reachable();
  const byId = new Map(projects.map((project) => [project.id, project]));
  const found = new Map();
  const add = (destination) => found.set(`${destination.kind}:${destination.projectId}`, destination);
  const nickname = bridgeStore.aliases.get(key);
  if (nickname && (nickname.kind === 'master' || byId.has(nickname.projectId))) add({ kind: nickname.kind, projectId: nickname.projectId });
  const sharingSlug = projects.filter((project) => slugOf(project.name) === key);
  for (const project of projects) {
    const isName = String(project.name).toLowerCase() === key;
    const isId = /^\d+$/.test(key) && project.id === Number(key);
    const isSlug = sharingSlug.length === 1 && sharingSlug[0].id === project.id;
    if (isName || isId || isSlug) add({ kind: 'project', projectId: project.id });
  }
  return [...found.values()];
}

/** Names no nickname may have: the Master's own, and the words `tc bridge nickname` takes as what to do. */
const RESERVED_NICKNAMES = Object.freeze(['master', 'set', 'rename', 'forget']);

/**
 * Why a nickname may not be given a name, as a closed code, or null when it
 * may. A nickname must never make a name mean two things, so it cannot be the
 * reserved `master`, a word `tc bridge nickname` reads as a verb, another
 * nickname, or the name, slug or id by which a reachable project is known.
 * Digits alone are never a nickname: a number is a project's id, to the Master
 * and to `tc bridge`, whether or not a project has that id yet.
 * @param {string} key - The normalised nickname.
 * @param {string|null} [replacing] - A nickname this one replaces (a rename), which does not collide with itself.
 * @returns {('reserved'|'exists'|'collides'|null)}
 */
function nicknameClash(key, replacing = null) {
  if (RESERVED_NICKNAMES.includes(key)) return 'reserved';
  if (/^\d+$/.test(key)) return 'collides';
  if (key !== replacing && bridgeStore.aliases.get(key)) return 'exists';
  const { projects } = reachable();
  const taken = projects.some((project) => String(project.name).toLowerCase() === key || slugOf(project.name) === key);
  return taken ? 'collides' : null;
}

/**
 * Why a typed name names nothing, when the reason is that what it would name
 * is out of the bridge's reach: a nickname whose project is, or a project of
 * exactly that name that is. Null when it simply names nothing.
 * @param {string} name - The token as typed, without any `@`.
 * @returns {('archived'|'scope-unresolved'|'out-of-scope'|'opted-out'|null)}
 */
function whyUnnamed(name) {
  const key = String(name).toLowerCase();
  const nickname = bridgeStore.aliases.get(key);
  const project = nickname && nickname.kind === 'project' ? store.projects.get(nickname.projectId)
    : store.projects.list().find((p) => String(p.name).toLowerCase() === key || (/^\d+$/.test(key) && p.id === Number(key)));
  const why = project ? outOfReach(project) : null;
  return why && why !== 'unknown' ? why : null;
}

/**
 * Read a destination the Project Master named in a write: `master`, a project
 * id, or a project's name, slug or nickname. It must name exactly one thing
 * the bridge may reach, and the answer says why when it does not.
 * @param {*} to - What the caller sent.
 * @returns {{destination: {kind: string, projectId: (number|null), label: string}}|{refusal: ('unknown'|'ambiguous'|'archived'|'scope-unresolved'|'out-of-scope'|'opted-out')}}
 */
function resolve(to) {
  if (to === 'master') return { destination: { kind: 'master', projectId: null, label: 'Project Master' } };
  if (Number.isInteger(to)) {
    const project = store.projects.get(to);
    const why = outOfReach(project);
    return why ? { refusal: why } : { destination: { kind: 'project', projectId: project.id, label: project.name } };
  }
  if (typeof to !== 'string' || !to) return { refusal: 'unknown' };
  const matches = named(to);
  if (matches.length > 1) return { refusal: 'ambiguous' };
  if (matches.length === 1) {
    if (matches[0].kind === 'master') return { destination: { kind: 'master', projectId: null, label: 'Project Master' } };
    const project = store.projects.get(matches[0].projectId);
    return { destination: { kind: 'project', projectId: project.id, label: project.name } };
  }
  // Nothing reachable has that name. If it is a nickname or a project that is out of reach, say why:
  // the same answer the gateway gives when it declines to suggest it.
  return { refusal: whyUnnamed(to) || 'unknown' };
}

module.exports = { slugOf, scope, scopeSummary, RESERVED_NICKNAMES, nicknameClash, whyUnnamed, outOfReach, reachable, liveness, destinations, named, resolve, _deps };
