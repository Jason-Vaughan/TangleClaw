'use strict';
/**
 * Every registered route is reachable (#2248).
 *
 * The route table is matched first-match in registration order, so a route
 * whose pattern is also matched by an earlier route of the same method is
 * unreachable: requests for it are answered by the other handler and nothing
 * says so. Moving a route family into its own module changes where its routes
 * are registered from, and this is what makes such a move safe to review: for
 * every route, a request shaped like its own pattern must reach that route and
 * no other. Read from the runtime table, never from source text, so the
 * loop-registered families count too.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const server = require('../server');

const ROUTES = server._routePatterns();

/**
 * A concrete path an instance of the pattern would have: every `:param`
 * segment becomes one literal segment.
 * @param {string} pattern - A registered route pattern
 * @returns {string}
 */
function instanceOf(pattern) {
  return pattern.replace(/:[^/]+/g, 'x');
}

describe('route reachability (#2248)', () => {
  it('reads a populated table in which every method and pattern pair is registered once', () => {
    assert.ok(ROUTES.length > 100, `only ${ROUTES.length} routes registered`);
    const seen = new Map();
    for (const r of ROUTES) {
      const key = `${r.method} ${r.pattern}`;
      assert.ok(!seen.has(key), `${key} is registered twice; the second registration can never be reached`);
      seen.set(key, true);
    }
  });

  it('answers a request shaped like each route\'s own pattern with that route and no other', () => {
    const shadowed = [];
    for (const r of ROUTES) {
      const match = server.matchRoute(r.method, instanceOf(r.pattern));
      if (!match) {
        shadowed.push(`${r.method} ${r.pattern}: no match at all for ${instanceOf(r.pattern)}`);
      } else if (match.pattern !== r.pattern) {
        shadowed.push(`${r.method} ${r.pattern}: reached by ${match.pattern}, registered earlier`);
      } else {
        assert.equal(typeof match.handler, 'function', `${r.method} ${r.pattern} has no handler`);
      }
    }
    assert.deepEqual(shadowed, [], `shadowed routes:\n${shadowed.join('\n')}`);
  });
});
