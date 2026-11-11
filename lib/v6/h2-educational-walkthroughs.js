'use strict';

/**
 * v6 (#3000, V6-30 / H2, Car V61-W1-D): the five v6 educational
 * walkthroughs, the architecture glossary, and the publication gate that
 * keeps an unverified walkthrough from shipping.
 *
 * Content is data, not prose in a doc: each walkthrough is a frozen record
 * of prerequisites, ordered steps (an instruction, an optional real `tc`
 * command, and what the learner should see), success criteria, the product
 * surfaces it depends on, and a verification record. A future route or page
 * (Wave 2) renders it; this module only holds it and judges it.
 *
 * The five titles are #3000's own: Install to First Chat, 4-Seat & 10-Role
 * Fleet Setup, Charter to Wave Execution, Multi-Engine Failover, Open Hood
 * Inspection. The PRR-B Phase 6 education kit (a Markdown draft with five
 * differently titled parts) supplied the learner text and its rules, which
 * this module keeps: a walkthrough cites only real `tc` touchpoints and
 * never invents a CLI; delivery, submission and completion stay distinct;
 * and nothing is published until it has been re-run against an actual
 * release build. Every walkthrough here therefore ships `unverified`, and
 * {@link publicationGate} refuses all five until a verification record
 * names the build each step was checked on. Steps that rely on a surface
 * not yet shipped (`proposed`) also block publication until confirmed.
 *
 * Wave 1 scope (Charter A624): no route, no page, no schema.
 *
 * @module lib/v6/h2-educational-walkthroughs
 */

/** Verification states a walkthrough can be in. */
const VERIFICATION_STATUSES = Object.freeze(['unverified', 'verified']);

/** Whether a surface a step relies on has shipped. */
const SURFACE_STATES = Object.freeze(['shipped', 'proposed']);

/**
 * Deep-freeze a plain data tree.
 * @param {*} value
 * @returns {*}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** A walkthrough's verification record before anyone has run it on a build. */
const UNVERIFIED = { status: 'unverified', buildVersion: null, verifiedAt: null, verifiedSteps: [] };

/** The architecture glossary: one plain-language definition per term. */
const GLOSSARY = deepFreeze({
  'Logical Project': 'The unit of work TangleClaw coordinates: one product or repository, with its fleets, charters and settings.',
  Fleet: 'The set of lanes working on one logical project at once, created from a template or by hand.',
  Lane: 'One working session in a fleet, with one role, one engine, and its own workspace.',
  Seat: 'A role slot in a fleet template (PM, Builder, Reviewer…). A seat becomes a lane when it launches.',
  Car: 'One unit of scheduled work: a bounded set of issues with a declared file scope.',
  Wave: 'A group of cars with no dependency on each other, scheduled to run together; the next wave starts as its dependencies complete.',
  Charter: 'The written grant that authorizes a sprint: its cars, its deciders, and what each role may do without asking again.',
  'R-Gate': 'Review gate: an independent reviewer checks a car\'s exact commit before it can merge.',
  'A-Gate': 'Architecture gate: the Architect checks a change against the design and scope it was given.',
  'Open Hood': 'Opening a lane\'s live terminal to inspect what its engine is actually doing, alongside the native chat view.',
  'Native Conversation Layer': 'The chat view of a lane\'s own engine conversation, recorded as events TangleClaw can replay.',
  Medusa: 'The switchboard lanes use to message each other: each message is read, answered if needed, then acknowledged.',
  'Launch binding': 'The proof that a request comes from the live session it claims to be, carried as launch headers.',
  'Workload receipt': 'A lane\'s own report of what it is doing and whether it is safe to clear, read by coordinators.',
  'HOLD / STOP': 'A durable control a coordinator places on a lane; it wins over any earlier go-ahead until released.',
  'Model attestation': 'The record of which model a lane asked for and which one was actually observed running.',
  Failover: 'Moving a lane to an approved alternate engine when its own cannot continue — only under an explicit, expiring grant.',
  PortHub: 'TangleClaw\'s registry of which project owns which port on the machine.'
});

/** The five walkthroughs #3000 names, in learning order. */
const WALKTHROUGHS = deepFreeze([
  {
    id: 'install-to-first-chat',
    title: 'Install to First Chat',
    summary: 'Start TangleClaw on a disposable project and hold your first conversation with one lane.',
    prerequisites: ['TangleClaw v6 installed and running', 'An empty folder you can delete afterwards'],
    surfaces: { projects: 'shipped', nativeChat: 'shipped', conversationTimeline: 'proposed' },
    steps: [
      { id: 'fixture', instruction: 'Create a disposable project folder with a one-line README.', expect: 'A folder containing README.md.' },
      { id: 'add-project', instruction: 'In the dashboard, add the folder as a project and confirm the exact path shown.', expect: 'The project card shows your folder\'s absolute path.' },
      { id: 'launch', instruction: 'Launch a session on the project, then read its launch context from inside it.', command: 'tc start next', expect: 'The first launch step prints, naming this project.' },
      { id: 'whoami', instruction: 'Confirm which session you are.', command: 'tc whoami', expect: 'Launch binding: verified, with this project\'s name.' },
      { id: 'first-chat', instruction: 'In the native chat, ask: "Summarize README.md in one sentence."', expect: 'Your message appears as a user turn, then the engine\'s reply as its own turn.', surface: 'conversationTimeline' }
    ],
    successCriteria: ['The project, the session and the reply all name the same lane.', 'A reply that has not arrived shows as pending, never as complete.'],
    verification: UNVERIFIED
  },
  {
    id: 'fleet-setup',
    title: '4-Seat & 10-Role Fleet Setup',
    summary: 'Preview the small-4-seat and recommended-10-role templates, then launch a fleet and confirm every lane\'s identity.',
    prerequisites: ['Walkthrough "Install to First Chat" completed', 'At least one qualified engine installed'],
    surfaces: { templatePreview: 'proposed', fleetLaunch: 'proposed', workload: 'shipped' },
    steps: [
      { id: 'preview-small', instruction: 'Open the template list and preview small-4-seat.', expect: 'One seat (the PM) starts immediately; the other three are deferred until needed.', surface: 'templatePreview' },
      { id: 'preview-ten', instruction: 'Preview recommended-10-role and compare which seats start now.', expect: 'Ten roles listed, again with only the supervisory seat starting immediately.', surface: 'templatePreview' },
      { id: 'launch-fleet', instruction: 'Launch small-4-seat on your project.', expect: 'A PM lane launches; the deferred seats stay unlaunched.', surface: 'fleetLaunch' },
      { id: 'identities', instruction: 'List the fleet\'s sessions and check each has its own id.', command: 'tc sessions', expect: 'Distinct session ids, each with a workload state.' },
      { id: 'workload', instruction: 'From inside the PM lane, report what it is doing.', command: 'tc workload show', expect: 'The lane\'s current workload receipt.' }
    ],
    successCriteria: ['Only the seats the preview said would start have started.', 'Every lane reports a distinct identity and a workload state.'],
    verification: UNVERIFIED
  },
  {
    id: 'charter-to-wave-execution',
    title: 'Charter to Wave Execution',
    summary: 'Turn a charter into cars, watch the scheduler order them into waves, and see a review gate hold a dependent car.',
    prerequisites: ['Walkthrough "4-Seat & 10-Role Fleet Setup" completed'],
    surfaces: { charter: 'proposed', waveScheduler: 'proposed', medusa: 'shipped' },
    steps: [
      { id: 'charter', instruction: 'Write a two-car charter: car A edits roadmap.csv; car B depends on A and edits README.md.', expect: 'The charter lists both cars with their file scopes.', surface: 'charter' },
      { id: 'waves', instruction: 'Start the run and look at its waves.', expect: 'Wave 1 holds car A; wave 2 holds car B.', surface: 'waveScheduler' },
      { id: 'dispatch', instruction: 'Read the dispatch from the builder lane.', command: 'tc message read', expect: 'A message assigning car A.' },
      { id: 'reply', instruction: 'Reply in the same exchange before acknowledging it.', command: 'tc message send', expect: 'The reply is delivered to the sender.' },
      { id: 'ack', instruction: 'Then mark the dispatch handled.', command: 'tc message ack', expect: 'The message leaves the inbox.' },
      { id: 'gate', instruction: 'Complete car A and watch car B before the reviewer passes A\'s gate.', expect: 'Car B stays waiting until the gate passes, then dispatches.', surface: 'waveScheduler' }
    ],
    successCriteria: ['No car starts before every car it depends on is complete.', 'A reply always precedes its acknowledgement.'],
    verification: UNVERIFIED
  },
  {
    id: 'multi-engine-failover',
    title: 'Multi-Engine Failover',
    summary: 'Grant an expiring failover rule, trigger a test failure, and audit the switch; then revoke the rule and see the lane wait.',
    prerequisites: ['Two qualified engines installed', 'A disposable test fleet — never a production lane'],
    surfaces: { failoverGrant: 'proposed', failureFixture: 'proposed', attestation: 'shipped' },
    steps: [
      { id: 'grant', instruction: 'Create a project-scoped failover grant for one lane, naming one alternate engine and an expiry.', expect: 'The grant reads back with its engines, scope and expiry.', surface: 'failoverGrant' },
      { id: 'fail', instruction: 'Use the release build\'s test failure fixture to stop the lane\'s engine.', expect: 'The lane moves to the alternate engine.', surface: 'failureFixture' },
      { id: 'audit', instruction: 'Open the lane\'s model attestation history.', expect: 'A new generation names the alternate model, the grant and the reason.' },
      { id: 'revoke', instruction: 'Revoke the grant and trigger the failure again.', expect: 'The lane waits for a human instead of switching.', surface: 'failoverGrant' }
    ],
    successCriteria: ['Every switch cites a live grant and records the new session identity.', 'With no grant, a failure waits for a human.'],
    verification: UNVERIFIED
  },
  {
    id: 'open-hood-inspection',
    title: 'Open Hood Inspection',
    summary: 'Match a lane\'s native turn to its live terminal, and learn why delivery is not the same as submission.',
    prerequisites: ['Walkthrough "Install to First Chat" completed'],
    surfaces: { openHood: 'shipped', conversationTimeline: 'proposed' },
    steps: [
      { id: 'send', instruction: 'Send a short task to the lane in native chat.', expect: 'A user turn appears.', surface: 'conversationTimeline' },
      { id: 'hood', instruction: 'Choose Open Hood on the same lane.', expect: 'The live terminal opens beside the chat, showing the same turn.' },
      { id: 'compare', instruction: 'Compare the chat turn, the terminal and the event timestamp.', expect: 'All three identify the same lane and turn.', surface: 'conversationTimeline' },
      { id: 'pending', instruction: 'Find a message that was delivered but has no submission receipt.', expect: 'It shows as pending or unverified, never as complete.', surface: 'conversationTimeline' },
      { id: 'control', instruction: 'Check whether the lane is held before typing into it.', command: 'tc control status', expect: 'The lane\'s control state; no typing while it is held.' }
    ],
    successCriteria: ['Chat, terminal and timeline agree on the lane and turn.', 'Delivery, submission and completion are shown as different states.'],
    verification: UNVERIFIED
  }
]);

/**
 * A summary row per walkthrough, in learning order.
 * @returns {Array<{id: string, title: string, summary: string, stepCount: number, verification: string}>}
 */
function listWalkthroughs() {
  return WALKTHROUGHS.map((w) => ({ id: w.id, title: w.title, summary: w.summary, stepCount: w.steps.length, verification: w.verification.status }));
}

/**
 * One walkthrough by id.
 * @param {string} id
 * @returns {object|null} The frozen walkthrough, or null.
 */
function getWalkthrough(id) {
  return WALKTHROUGHS.find((w) => w.id === id) || null;
}

/**
 * Every `tc` command a walkthrough cites, as `tc <verb> [<subverb>]`.
 * @param {object} walkthrough
 * @returns {string[]}
 */
function tcCommandsIn(walkthrough) {
  const steps = walkthrough && Array.isArray(walkthrough.steps) ? walkthrough.steps : [];
  return steps.filter((s) => typeof s.command === 'string').map((s) => s.command.trim().split(/\s+/).slice(0, 3).join(' '));
}

/**
 * Look a term up in the glossary, ignoring case.
 * @param {string} term
 * @returns {{term: string, definition: string}|null}
 */
function glossaryTerm(term) {
  if (typeof term !== 'string') return null;
  const wanted = term.trim().toLowerCase();
  const match = Object.keys(GLOSSARY).find((k) => k.toLowerCase() === wanted);
  return match ? { term: match, definition: GLOSSARY[match] } : null;
}

/**
 * Whether a walkthrough may be published for a release build. It may only
 * when its verification record is `verified` on exactly that build, every
 * step was verified, and every surface it relies on has shipped (or the
 * caller confirms it did, with `confirmedSurfaces`).
 * @param {object} walkthrough
 * @param {{buildVersion: string, confirmedSurfaces?: string[]}} release
 * @returns {{publishable: boolean, reasons: string[]}} `reasons` names every blocker.
 */
function publicationGate(walkthrough, { buildVersion, confirmedSurfaces = [] } = {}) {
  const reasons = [];
  if (!walkthrough || !Array.isArray(walkthrough.steps)) return { publishable: false, reasons: ['UNKNOWN_WALKTHROUGH'] };
  if (typeof buildVersion !== 'string' || !buildVersion) reasons.push('BUILD_VERSION_REQUIRED');
  const v = walkthrough.verification || {};
  if (v.status !== 'verified') reasons.push('NOT_VERIFIED');
  else if (v.buildVersion !== buildVersion) reasons.push('VERIFIED_ON_OTHER_BUILD');
  const verifiedSteps = new Set(Array.isArray(v.verifiedSteps) ? v.verifiedSteps : []);
  const unverified = walkthrough.steps.filter((s) => !verifiedSteps.has(s.id)).map((s) => s.id);
  if (unverified.length) reasons.push(`STEPS_UNVERIFIED:${unverified.join(',')}`);
  const confirmed = new Set(confirmedSurfaces);
  const proposed = Object.entries(walkthrough.surfaces || {})
    .filter(([name, state]) => state !== 'shipped' && !confirmed.has(name)).map(([name]) => name);
  if (proposed.length) reasons.push(`SURFACES_UNSHIPPED:${proposed.join(',')}`);
  return { publishable: reasons.length === 0, reasons };
}

module.exports = {
  VERIFICATION_STATUSES,
  SURFACE_STATES,
  GLOSSARY,
  WALKTHROUGHS,
  listWalkthroughs,
  getWalkthrough,
  tcCommandsIn,
  glossaryTerm,
  publicationGate
};
