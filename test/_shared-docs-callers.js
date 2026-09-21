'use strict';

/**
 * The callers the shared-docs and groups routes tell apart, as request
 * headers a test can send. Those routes refuse a caller with no binding, so a
 * test has to say which caller it is playing.
 *
 * Not a test file: the leading underscore keeps it out of the suite glob.
 * @module test/_shared-docs-callers
 */

const store = require('../lib/store');
const launchSequence = require('../lib/launch-sequence');

/**
 * Headers that make a request the operator's dashboard on a scratch store,
 * where no admin account exists and the gate stands down: a same-origin
 * browser request.
 * @param {import('node:http').Server} server - The listening test server
 * @returns {Record<string, string>}
 */
function operatorHeaders(server) {
  const { port } = server.address();
  return { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' };
}

/**
 * Start a session for a project with a launch binding, as a real launch does,
 * without starting a pane.
 * @param {{id: number}} project - Project record
 * @returns {{launchId: string, sessionId: number, headers: Record<string, string>}}
 *   `headers` are the two a project pane sends, per the shared-docs guide.
 */
function bindProject(project) {
  const launchId = launchSequence.mintLaunchId();
  const snapshot = launchSequence.buildSnapshot({
    launchId,
    project,
    engineProfile: store.engines.get('claude'),
    applicability: { applicable: false, reason: 'test binding' },
    rendered: null,
    rules: []
  });
  const session = store.sessions.start({ projectId: project.id, engineId: 'claude', launchSequence: snapshot });
  return {
    launchId,
    sessionId: session.id,
    headers: {
      'x-tangleclaw-project-id': String(project.id),
      'x-tangleclaw-launch-id': launchId
    }
  };
}

module.exports = { operatorHeaders, bindProject };
