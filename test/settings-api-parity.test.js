'use strict';

// #3278 (V6-049) — settings API parity audit primitive, and the project
// domain's own read route built on it. The route handler is tested as a
// pure function via its dependency-injection factory (no real HTTP server,
// no real store) — the same testability bar lib/roadmap-admission.js and
// lib/fleet-sdlc-policy.js already hold themselves to, and the only option
// available anyway: register() is not wired into server.js by this car (see
// lib/routes/projects.js's own module doc for why).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PROJECT_CONFIG_KEYS, auditProjectSettings } = require('../lib/routes/settings-parity');
const projectsRoutes = require('../lib/routes/projects');
const { _buildGetProjectSettingsParity } = projectsRoutes;
const { DEFAULT_PROJECT_CONFIG } = require('../lib/project-config');
const { matchRoute } = require('../lib/routes/_kernel');

describe('auditProjectSettings', () => {
  it('the live schema keys are read from DEFAULT_PROJECT_CONFIG itself, not a hand-kept copy', () => {
    assert.deepEqual(new Set(PROJECT_CONFIG_KEYS), new Set(Object.keys(DEFAULT_PROJECT_CONFIG)));
  });

  it('a config that is exactly the defaults reports no drift and no gaps', () => {
    const audit = auditProjectSettings({ ...DEFAULT_PROJECT_CONFIG });
    assert.deepEqual(audit.unknownKeys, []);
    assert.deepEqual(audit.missingKeys, []);
    assert.deepEqual(audit.gaps, []);
    assert.deepEqual(new Set(audit.knownKeys), new Set(PROJECT_CONFIG_KEYS));
  });

  it('flags a field present in config but not in the known schema (drift)', () => {
    const audit = auditProjectSettings({ ...DEFAULT_PROJECT_CONFIG, aStaleUndocumentedField: true });
    assert.deepEqual(audit.unknownKeys, ['aStaleUndocumentedField']);
  });

  it('flags a schema field missing from a raw, un-merged config', () => {
    const partial = { ...DEFAULT_PROJECT_CONFIG };
    delete partial.engine;
    const audit = auditProjectSettings(partial);
    assert.deepEqual(audit.missingKeys, ['engine']);
  });

  it('with no exposedKeys option, reports zero gaps -- the config itself is the exposure', () => {
    const audit = auditProjectSettings({ ...DEFAULT_PROJECT_CONFIG });
    assert.deepEqual(audit.gaps, []);
  });

  it('with exposedKeys given, reports every schema key that surface does not cover', () => {
    const audit = auditProjectSettings({ ...DEFAULT_PROJECT_CONFIG }, { exposedKeys: ['engine', 'silentPrime'] });
    assert.ok(audit.gaps.includes('fleetCoordinator'));
    assert.ok(!audit.gaps.includes('engine'));
    assert.ok(!audit.gaps.includes('silentPrime'));
  });

  it('refuses a non-object config rather than silently producing a meaningless report', () => {
    assert.throws(() => auditProjectSettings(null), TypeError);
    assert.throws(() => auditProjectSettings([]), TypeError);
    assert.throws(() => auditProjectSettings('nope'), TypeError);
  });
});

describe('GET /api/projects/:name/settings-parity handler', () => {
  function fakeRes() {
    return { statusCode: null, body: null, writeHead(code) { this.statusCode = code; }, end(chunk) { this.body = JSON.parse(chunk); } };
  }
  const OWN_ACCESS = { kind: 'project' };
  const OTHER_ACCESS = { kind: 'project' };
  const PROJECT_ROW = { id: 7, name: 'demo', path: '/fake/demo' };

  function handlerWith(overrides = {}) {
    return _buildGetProjectSettingsParity({
      resolveAccess: () => OWN_ACCESS,
      projectRefusalFor: () => null,
      canChangeProject: (access) => access === OWN_ACCESS,
      getProjectRow: () => PROJECT_ROW,
      loadProjectConfig: () => ({ ...DEFAULT_PROJECT_CONFIG }),
      auditProjectSettings: (config) => auditProjectSettings(config),
      ...overrides
    });
  }

  it('returns the project name, its full resolved config, and an audit report', () => {
    const res = fakeRes();
    handlerWith()({}, res, { name: 'demo' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.project, 'demo');
    assert.deepEqual(res.body.config, DEFAULT_PROJECT_CONFIG);
    assert.deepEqual(res.body.audit.unknownKeys, []);
  });

  it('refuses a caller with no project/operator binding before any lookup', () => {
    const res = fakeRes();
    let lookedUp = false;
    handlerWith({
      projectRefusalFor: () => ({ status: 403, code: 'PROJECT_BINDING_REQUIRED', message: 'no binding' }),
      getProjectRow: () => { lookedUp = true; return PROJECT_ROW; }
    })({}, res, { name: 'demo' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'PROJECT_BINDING_REQUIRED');
    assert.equal(lookedUp, false, 'must refuse on the binding check before ever looking the project up');
  });

  it('answers 404 for a project that does not exist, after the binding check passes', () => {
    const res = fakeRes();
    handlerWith({ getProjectRow: () => null })({}, res, { name: 'ghost' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'NOT_FOUND');
  });

  it('refuses a session bound to a different project with OTHER_PROJECT, never leaking the config', () => {
    const res = fakeRes();
    handlerWith({ resolveAccess: () => OTHER_ACCESS, canChangeProject: () => false })({}, res, { name: 'demo' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'OTHER_PROJECT');
    assert.equal(res.body.config, undefined);
  });
});

describe('register', () => {
  it('adds GET /api/projects/:name/settings-parity to the shared kernel route table, reachable and working end to end', () => {
    projectsRoutes.register({
      resolveAccess: () => ({ kind: 'project' }),
      projectRefusalFor: () => null,
      canChangeProject: () => true,
      getProjectRow: () => ({ id: 1, name: 'demo', path: '/fake/demo' }),
      loadProjectConfig: () => ({ ...DEFAULT_PROJECT_CONFIG }),
      auditProjectSettings: (config) => auditProjectSettings(config)
    });
    const matched = matchRoute('GET', '/api/projects/demo/settings-parity');
    assert.ok(matched, 'the route must be registered and match its own pattern');
    assert.equal(matched.params.name, 'demo');
    const res = { statusCode: null, body: null, writeHead(code) { this.statusCode = code; }, end(chunk) { this.body = JSON.parse(chunk); } };
    matched.handler({}, res, matched.params);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.project, 'demo');
  });
});
