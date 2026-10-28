'use strict';

/**
 * The `/api/audit/*` and `/api/sidecar/*` route family (eval audit mode and
 * OpenClaw process visibility), moved out of `server.js` unchanged (#2248).
 *
 * `register()` registers the routes through the shared kernel, in the order
 * they held in `server.js`; the entry point calls it at the position the routes
 * held, so the route table reads as before. This family closes over no
 * server-local helper, so `register` takes nothing; a later area that does
 * receives those helpers as its `register` argument.
 *
 * @module lib/routes/audit
 */

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../logger');
const store = require('../store');
const evalAudit = require('../eval-audit');
const serviceToken = require('../service-token');
const sidecar = require('../sidecar');
const wrapDefaultPipeline = require('../wrap-default-pipeline');
const sharedDocsAccess = require('../shared-docs-access');
const launchBindingGuard = require('../launch-binding-guard');
const { route, jsonResponse, errorResponse, reqUrl, parseQuery } = require('./_kernel');

// The logger keeps the entry point's name so every log line this family writes
// reads exactly as it did before the move.
const log = createLogger('server');

// ── Eval Audit Mode ──

// Debounced incident generation — max once per 60s per project
const _incidentGenerationTimestamps = {};

/**
 * Run incident generation for a project if not run in the last 60 seconds.
 * @param {string} project - Project name
 */
function _maybeGenerateIncidents(project) {
  const now = Date.now();
  const lastRun = _incidentGenerationTimestamps[project] || 0;
  if (now - lastRun < 60000) return;
  _incidentGenerationTimestamps[project] = now;
  try {
    evalAudit.generateIncidents(project, store);
  } catch (err) {
    log.error('Incident generation failed', { project, error: err.message });
  }
}

/**
 * The Bearer token on a request, or null when there is none.
 * @param {object} req - The request
 * @returns {string|null}
 */
function _bearerToken(req) {
  const authHeader = (req.headers && req.headers['authorization']) || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

/**
 * The OpenClaw connection a Bearer token's `audit_secret` matches, or null.
 * Shared by `/api/audit/ingest` and `/api/audit/heartbeat` (#2239): both are
 * a remote engine's webhook with no TangleClaw launch binding, so this is the
 * whole of their caller proof. Every connection is compared, in constant
 * time, so neither how much of a secret matched nor which connection matched
 * shows in the response time.
 * @param {string} token - The Bearer token presented
 * @returns {object|null} The matching connection, or null
 */
function _connectionByAuditToken(token) {
  let conn = null;
  for (const candidate of store.openclawConnections.list()) {
    if (typeof candidate.auditSecret !== 'string' || candidate.auditSecret === '') continue;
    if (serviceToken.safeEqual(token, candidate.auditSecret) && !conn) conn = candidate;
  }
  return conn;
}

/**
 * The project bound to an OpenClaw connection, or null. Archived projects are
 * included: archiving does not unbind a connection, and a refusal telling the
 * operator to bind an already-bound project would mislead.
 * @param {object} conn - An OpenClaw connection, from {@link _connectionByAuditToken}
 * @returns {object|null}
 */
function _projectForConnection(conn) {
  return store.projects.list({ archived: true }).find(p => p.engineId === `openclaw:${conn.id}`) || null;
}

/**
 * Register the audit and sidecar routes on the shared route table.
 * @returns {void}
 */
function register() {
  // POST /api/audit/ingest — Receive exchange data from OpenClaw webhook
  route('POST', '/api/audit/ingest', (_req, res, _params, body) => {
    // Authenticate via Bearer token
    const token = _bearerToken(_req);

    if (!token) {
      return errorResponse(res, 401, 'Missing Authorization header', 'UNAUTHORIZED');
    }

    // This route is not held to the launch binding (a remote engine's webhook
    // has none), so the audit secret is the whole of its caller proof and it
    // runs before anything is read or written.
    const conn = _connectionByAuditToken(token);
    if (!conn) {
      return errorResponse(res, 401, 'Invalid audit token', 'UNAUTHORIZED');
    }

    // Validate payload
    const validation = evalAudit.validateIngestPayload(body);
    if (!validation.valid) {
      return errorResponse(res, 400, validation.error, 'BAD_REQUEST');
    }

    // The exchange is attributed to the project bound to the authenticated
    // connection, never to a name the payload asserts: a connection with no
    // project could otherwise write audit rows under any project it chose (#1261).
    const project = _projectForConnection(conn);
    if (!project) {
      log.warn('Audit ingest refused: connection has no bound project', { connectionId: conn.id });
      return errorResponse(res, 409,
        `OpenClaw connection "${conn.name}" has no project bound to it, so its exchanges cannot be `
          + 'attributed. Bind a project to this connection (set its engine to this connection) and retry.',
        'CONNECTION_UNBOUND');
    }
    const projectName = project.name;

    // Transform and store the exchange
    const exchangeData = evalAudit.transformIngestPayload(body, projectName);
    const exchange = store.evalExchanges.insert(exchangeData);

    // Record heartbeat for watchdog. Scoped by (project, session_id), never
    // session_id alone (#2239 R4): another project's exchange or heartbeat
    // sharing this same session_id string touches a DIFFERENT watch entry,
    // so there is nothing here to collide with or refuse.
    evalAudit.watchSession(body.session_id, projectName);

    const evalDims = evalAudit.getEvalDimensions();

    // Determine if this exchange should be scored (sampling)
    const projectConfig = store.projectConfig.load(project.path);
    const auditConfig = projectConfig.evalAuditMode || {};
    const samplingConfig = auditConfig.sampling || {};

    // Run Tier 1 (always — it's free)
    const tier1Result = evalAudit.runTier1(
      { userMessage: exchange.userMessage, agentResponse: exchange.agentResponse, agentThinking: exchange.agentThinking },
      evalDims.tier1 || []
    );

    // Decide if we should score beyond Tier 1
    const samplingDecision = evalAudit.shouldScore(
      exchange,
      samplingConfig,
      { tier1Flags: tier1Result.flags }
    );

    // Cost cap enforcement — skip paid tiers if session cost exceeds cap
    const costCap = auditConfig.costCapPerSession || 1.00;
    const sessionCost = store.evalScores.getSessionCost(body.session_id);
    const costCapResult = evalAudit.checkCostCap(sessionCost, costCap);

    if (costCapResult.exceeded && samplingDecision.shouldScore) {
      // Store Tier 1 only (free), mark as cost-cap-skipped
      store.evalExchanges.updateScored(exchange.id, 3);

      if (tier1Result.flags.length > 0) {
        store.evalScores.insert({
          exchangeId: exchange.id,
          schemaVersion: evalDims.schemaVersion || 'default-v1',
          judgeModel: 'structural',
          scoredAt: new Date().toISOString(),
          tier1StructuralScore: tier1Result.score,
          tier1Flags: tier1Result.flags,
          tier2Skipped: true,
          tier2_5Skipped: true,
          tier3Skipped: true,
          anomalyFlag: true,
          anomalyReason: `Structural: ${tier1Result.flags.join(', ')}`,
          costUsd: 0
        });
      }

      return jsonResponse(res, 201, {
        exchangeId: exchange.id,
        scored: false,
        reason: 'cost_cap_exceeded',
        tier1: tier1Result,
        costCap: { currentCost: costCapResult.currentCost, cap: costCapResult.cap }
      });
    }

    if (!samplingDecision.shouldScore) {
      // Mark as skipped (sampling) but still store Tier 1 result
      store.evalExchanges.updateScored(exchange.id, 2);

      // Store Tier 1-only score if there were flags
      if (tier1Result.flags.length > 0) {
        store.evalScores.insert({
          exchangeId: exchange.id,
          schemaVersion: evalDims.schemaVersion || 'default-v1',
          judgeModel: 'structural',
          scoredAt: new Date().toISOString(),
          tier1StructuralScore: tier1Result.score,
          tier1Flags: tier1Result.flags,
          tier2Skipped: true,
          tier2_5Skipped: true,
          tier3Skipped: true,
          anomalyFlag: tier1Result.flags.length > 0,
          anomalyReason: tier1Result.flags.length > 0 ? `Structural: ${tier1Result.flags.join(', ')}` : null,
          costUsd: 0
        });
        store.evalExchanges.updateScored(exchange.id, 1);
      }

      return jsonResponse(res, 201, {
        exchangeId: exchange.id,
        scored: false,
        reason: samplingDecision.reason,
        tier1: tier1Result
      });
    }

    // Insert initial Tier 1 score record
    const scoreRecord = store.evalScores.insert({
      exchangeId: exchange.id,
      schemaVersion: evalDims.schemaVersion || 'default-v1',
      judgeModel: auditConfig.judgeModel || 'claude-haiku-4-5-20251001',
      scoredAt: new Date().toISOString(),
      tier1StructuralScore: tier1Result.score,
      tier1Flags: tier1Result.flags,
      tier2Skipped: true,
      tier2_5Skipped: true,
      tier3Skipped: true,
      anomalyFlag: tier1Result.flags.length > 0,
      anomalyReason: tier1Result.flags.length > 0 ? `Structural: ${tier1Result.flags.join(', ')}` : null,
      costUsd: 0
    });

    store.evalExchanges.updateScored(exchange.id, 1);

    // Send immediate response with Tier 1 results (non-blocking)
    jsonResponse(res, 201, {
      exchangeId: exchange.id,
      scoreId: scoreRecord.id,
      scored: true,
      reason: samplingDecision.reason,
      tier1: tier1Result,
      anomaly: tier1Result.flags.length > 0
    });

    // Run Tier 2/2.5/3 pipeline asynchronously (does not block the response)
    evalAudit.runScoringPipeline({
      exchange: { userMessage: exchange.userMessage, agentResponse: exchange.agentResponse, agentThinking: exchange.agentThinking, turnNumber: exchange.turnNumber },
      tier1Result,
      evalDims,
      samplingReason: samplingDecision.reason,
      options: {
        callJudge: auditConfig._callJudge || undefined,
        model: auditConfig.judgeModel,
        apiKey: auditConfig.apiKey,
        gateCascade: auditConfig.gateCascade !== false
      }
    }).then(pipelineResult => {
      // Update the score record with Tier 2/2.5/3 results
      const updateData = { costUsd: pipelineResult.totalCost };

      if (pipelineResult.tier2) {
        updateData.tier2SemanticScore = pipelineResult.tier2.score;
        updateData.tier2Reasoning = pipelineResult.tier2.reasoning;
        updateData.tier2Skipped = false;
        updateData.judgeModel = auditConfig.judgeModel || 'claude-haiku-4-5-20251001';
      }

      if (pipelineResult.tier2_5) {
        updateData.tier2_5AlignmentScore = pipelineResult.tier2_5.alignmentScore;
        updateData.tier2_5Reasoning = pipelineResult.tier2_5.reasoning;
        updateData.tier2_5Skipped = false;
      } else {
        updateData.tier2_5Skipped = true;
      }

      if (pipelineResult.tier3) {
        updateData.tier3BehavioralScore = pipelineResult.tier3.score;
        updateData.tier3DimensionScores = pipelineResult.tier3.dimensionScores;
        updateData.tier3Skipped = false;
      } else {
        updateData.tier3Skipped = true;
      }

      // Re-check anomaly with full scoring data
      const fullAnomaly = evalAudit.checkPerExchangeAnomaly({
        tier1Flags: tier1Result.flags,
        tier3DimensionScores: pipelineResult.tier3 ? pipelineResult.tier3.dimensionScores : null,
        tier2_5AlignmentScore: pipelineResult.tier2_5 ? pipelineResult.tier2_5.alignmentScore : null
      });
      updateData.anomalyFlag = fullAnomaly.anomaly;
      updateData.anomalyReason = fullAnomaly.anomaly ? fullAnomaly.reasons.join('; ') : null;

      store.evalScores.update(scoreRecord.id, updateData);

      // Debounced incident generation (max once per minute per project)
      _maybeGenerateIncidents(projectName);
    }).catch(err => {
      log.error('Async scoring pipeline failed', { exchangeId: exchange.id, error: err.message });
    });
  }, { maxBodySize: 512 * 1024 });

  // ── Sidecar: OpenClaw Process Visibility ──

  // GET /api/sidecar/:project/processes — Get cached process state for an OpenClaw project
  route('GET', '/api/sidecar/:project/processes', (_req, res, params) => {
    const projectName = params.project;
    const state = sidecar.getProcessesForProject(projectName);

    if (!state.connectionId) {
      return errorResponse(res, 404, `Project "${projectName}" is not an OpenClaw project`, 'NOT_FOUND');
    }

    // Ensure polling is running for this connection
    if (!sidecar._pollers.has(state.connectionId)) {
      sidecar.startPolling(state.connectionId);
    }

    jsonResponse(res, 200, {
      active: state.processes ? (state.processes.active || []) : [],
      recent: state.processes ? (state.processes.recent || []) : [],
      lastPollAt: state.lastPollAt,
      stale: state.stale,
      error: state.error
    });
  });

  // GET /api/sidecar/connection/:connId/processes — Get cached process state by connection ID (direct connect)
  route('GET', '/api/sidecar/connection/:connId/processes', (_req, res, params) => {
    const connId = params.connId;
    const state = sidecar.getProcessesByConnection(connId);

    if (state.error === 'Connection not found') {
      return errorResponse(res, 404, `Connection "${connId}" not found`, 'NOT_FOUND');
    }

    // Ensure polling is running for this connection
    if (!sidecar._pollers.has(connId)) {
      sidecar.startPolling(connId);
    }

    jsonResponse(res, 200, {
      active: state.active,
      recent: state.recent,
      lastPollAt: state.lastPollAt,
      stale: state.stale,
      error: state.error
    });
  });

  // POST /api/audit/heartbeat — Lightweight heartbeat from OpenClaw, or from a
  // TangleClaw-launched project session or the operator (#2239). Listed in
  // `lib/launch-binding-guard.js`'s `EXCEPTIONS` as OWN_PRINCIPAL, the same
  // reason and the same way `/api/audit/ingest` is, so the launch-binding
  // floor steps aside for the webhook case; unlike ingest, that leaves no
  // floor-level check at all for the OTHER caller, so this handler proves
  // one of two callers itself before trusting the body's `session_id`:
  //   1) An OpenClaw webhook's own `audit_secret` Bearer token, exactly as
  //      ingest proves it. The connection's bound project is the attribution,
  //      same as ingest. The watch itself is scoped by `(project, session_id)`
  //      (R-Gate R4, #2239), never `session_id` alone: another project's
  //      session can legitimately share the same caller-supplied string with
  //      no TangleClaw record to tell them apart, and a flat key cannot be
  //      policed by a claim check — whoever presented a given string FIRST
  //      would always win it, letting one project pre-empt or silence
  //      another's telemetry before it ever started. Scoping removes the
  //      collision outright: this connection's project never touches, resets
  //      or is refused over another project's entry for the identical string.
  //   2) A verified TangleClaw project launch binding, or the operator/Master,
  //      resolved the same way every other mutating route is — never from
  //      what the body claims. The caller's OWN binding is checked by the
  //      launch-binding guard's own classifier, so a stale, unbound or
  //      invalid caller is refused exactly as it would be at the floor. A
  //      project caller may then heartbeat only its OWN session — matched to
  //      `access.sessionId`, not merely to its project, so one bound session
  //      cannot heartbeat a DIFFERENT, superseded-but-still-active session of
  //      that same project (R-Gate R1, #2239). `session_id` here is
  //      TangleClaw's numeric session id (never an OpenClaw string id),
  //      looked up server-side — never trusted from the body alone. The
  //      operator and the Master may name any project's session. Passing
  //      either check grants nothing beyond this one heartbeat: no Operator,
  //      Master, Medusa or PortHub authority follows from it.
  route('POST', '/api/audit/heartbeat', (req, res, _params, body) => {
    if (!body || !body.session_id) {
      return errorResponse(res, 400, 'Missing session_id', 'BAD_REQUEST');
    }

    const token = _bearerToken(req);
    if (token) {
      const conn = _connectionByAuditToken(token);
      if (!conn) {
        return errorResponse(res, 401, 'Invalid audit token', 'UNAUTHORIZED');
      }
      const project = _projectForConnection(conn);
      if (!project) {
        log.warn('Audit heartbeat refused: connection has no bound project', { connectionId: conn.id });
        return errorResponse(res, 409,
          `OpenClaw connection "${conn.name}" has no project bound to it, so its heartbeat cannot be `
            + 'attributed. Bind a project to this connection (set its engine to this connection) and retry.',
          'CONNECTION_UNBOUND');
      }
      // Scoped to (this project, session_id): creates the watch on first
      // contact, resets it on every later one, and never collides with
      // another project's entry for the identical session_id string.
      evalAudit.watchSession(body.session_id, project.name);
      return jsonResponse(res, 200, { ok: true });
    }

    // No audit secret presented: the caller must be a verified TangleClaw
    // launch binding or the operator/Master, resolved exactly as the floor
    // would — reused here rather than re-derived, so a caller refused at the
    // floor on every OTHER route is refused with the same code and message here.
    const access = sharedDocsAccess.resolveAccess(req);
    if (access.kind !== sharedDocsAccess.KINDS.OPERATOR && access.kind !== sharedDocsAccess.KINDS.MASTER) {
      const described = launchBindingGuard.describeBinding(req);
      if (described.state !== launchBindingGuard.BINDING_STATES.VERIFIED) {
        const refusal = launchBindingGuard.refusalFor(described);
        return errorResponse(res, refusal.status, refusal.message, refusal.code);
      }
    }

    const sessionId = Number(body.session_id);
    if (!Number.isInteger(sessionId)) {
      return errorResponse(res, 400,
        'session_id must be a TangleClaw session id (an integer) for a caller with no audit credential.',
        'BAD_REQUEST');
    }
    const session = store.sessions.get(sessionId);
    if (!session) {
      return errorResponse(res, 404, `Session ${sessionId} not found`, 'NOT_FOUND');
    }
    // Matched to the caller's OWN session, not merely its project: a second,
    // superseded-but-still-active session of the SAME project is still not
    // this caller's to heartbeat (R-Gate R1, #2239). `access.sessionId` is
    // undefined for the operator/Master, so this never applies to either.
    if (access.kind === sharedDocsAccess.KINDS.PROJECT && session.id !== access.sessionId) {
      log.warn('Audit heartbeat refused: session is not the caller\'s own', {
        callerProjectId: access.projectId, callerSessionId: access.sessionId, namedSessionId: session.id
      });
      return errorResponse(res, 403,
        'A project session may only heartbeat its own session.',
        'OTHER_SESSION');
    }
    if (session.status !== store.SESSION_STATUS.ACTIVE) {
      return errorResponse(res, 409, `Session ${sessionId} has ended; nothing to heartbeat.`, 'SESSION_ENDED');
    }

    // The session's own project (ground truth, not the caller's claim) scopes
    // the watch — same (project, session_id) scoping as the Bearer path above.
    const sessionProject = store.projects.get(session.projectId);
    evalAudit.watchSession(sessionId, sessionProject ? sessionProject.name : null);
    return jsonResponse(res, 200, { ok: true });
  });

  // GET /api/audit/telemetry — Heartbeat status for all active sessions
  route('GET', '/api/audit/telemetry', (_req, res) => {
    const statuses = evalAudit.getTelemetryStatus();
    return jsonResponse(res, 200, { sessions: statuses });
  });

  // GET /api/audit/:project/scores — Query scores for a project
  route('GET', '/api/audit/:project/scores', (req, res, params) => {
    const urlObj = reqUrl(req);
    const query = parseQuery(urlObj.search);
    try {
      const scores = store.evalScores.listByProject(params.project, {
        from: query.from || null,
        to: query.to || null,
        anomaliesOnly: query.anomalies === 'true',
        limit: query.limit ? parseInt(query.limit, 10) : 100
      });
      return jsonResponse(res, 200, { scores, count: scores.length });
    } catch (err) {
      return errorResponse(res, 500, err.message, 'INTERNAL');
    }
  });

  // GET /api/audit/:project/anomalies — Anomaly log for a project
  route('GET', '/api/audit/:project/anomalies', (req, res, params) => {
    const urlObj = reqUrl(req);
    const query = parseQuery(urlObj.search);
    try {
      const anomalies = store.evalScores.listByProject(params.project, {
        from: query.from || null,
        to: query.to || null,
        anomaliesOnly: true,
        limit: query.limit ? parseInt(query.limit, 10) : 100
      });
      return jsonResponse(res, 200, { anomalies, count: anomalies.length });
    } catch (err) {
      return errorResponse(res, 500, err.message, 'INTERNAL');
    }
  });

  // GET /api/audit/:project/summary — Current period summary
  route('GET', '/api/audit/:project/summary', (_req, res, params) => {
    try {
      const project = params.project;
      const exchanges = store.evalExchanges.list({ project });
      const scored = exchanges.filter(e => e.scored === 1).length;
      const pending = exchanges.filter(e => e.scored === 0).length;
      const skippedSampling = exchanges.filter(e => e.scored === 2).length;
      const skippedCostCap = exchanges.filter(e => e.scored === 3).length;

      const scores = store.evalScores.listByProject(project);
      const anomalyCount = scores.filter(s => s.anomalyFlag).length;

      // Compute average Tier 1 score
      const tier1Scores = scores
        .filter(s => s.tier1StructuralScore !== null && s.tier1StructuralScore !== undefined)
        .map(s => s.tier1StructuralScore);
      const avgTier1 = tier1Scores.length > 0
        ? tier1Scores.reduce((a, b) => a + b, 0) / tier1Scores.length
        : null;

      const baseline = store.evalBaselines.getLatest(project);

      return jsonResponse(res, 200, {
        project,
        exchanges: {
          total: exchanges.length,
          scored,
          pending,
          skippedSampling,
          skippedCostCap
        },
        scores: {
          total: scores.length,
          anomalies: anomalyCount,
          avgTier1Structural: avgTier1 !== null ? Math.round(avgTier1 * 1000) / 1000 : null
        },
        baseline: baseline ? {
          computedAt: baseline.computedAt,
          exchangeCount: baseline.exchangeCount,
          schemaVersion: baseline.schemaVersion
        } : null
      });
    } catch (err) {
      return errorResponse(res, 500, err.message, 'INTERNAL');
    }
  });

  // GET /api/audit/:project/baseline — Current baseline
  route('GET', '/api/audit/:project/baseline', (_req, res, params) => {
    try {
      const baseline = store.evalBaselines.getLatest(params.project);
      if (!baseline) {
        return jsonResponse(res, 200, { baseline: null, message: 'No baseline computed yet' });
      }
      return jsonResponse(res, 200, { baseline });
    } catch (err) {
      return errorResponse(res, 500, err.message, 'INTERNAL');
    }
  });

  // GET /api/audit/:project/trends — Aggregated score trends over time
  route('GET', '/api/audit/:project/trends', (req, res, params) => {
    const urlObj = reqUrl(req);
    const query = parseQuery(urlObj.search);
    try {
      const window = query.window || '14d';
      const scores = store.evalScores.listByProject(params.project, { limit: 10000 });
      const trends = evalAudit.aggregateTrends(scores, window);
      return jsonResponse(res, 200, { project: params.project, ...trends });
    } catch (err) {
      return errorResponse(res, 500, err.message, 'INTERNAL');
    }
  });

  // GET /api/audit/:project/wrap-quality — Wrap quality scores for recent sessions
  route('GET', '/api/audit/:project/wrap-quality', (req, res, params) => {
    const urlObj = reqUrl(req);
    const query = parseQuery(urlObj.search);
    try {
      const limit = query.limit ? parseInt(query.limit, 10) : 10;
      const sessions = store.evalExchanges.listSessions(params.project, { limit });

      // Score against the steps this project's wrap actually runs — the
      // code-owned pipeline minus override-disabled steps — so a commit-only
      // project isn't marked down for steps it deliberately turned off.
      const projects = store.projects.list();
      const project = projects.find(p => p.name === params.project);
      let wrapStepIds = [];
      let expectedStepsUnavailable = false;
      if (project && project.path) {
        // Raw read rather than store.projectConfig.load: load() masks a corrupt
        // file by returning defaults, which would silently score the project
        // against the full pipeline as if its overrides never existed. An audit
        // surface must report the degraded state, not paper over it.
        const cfgPath = path.join(project.path, '.tangleclaw', 'project.json');
        try {
          const overrides = fs.existsSync(cfgPath)
            ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')).wrapStepOverrides
            : null;
          wrapStepIds = wrapDefaultPipeline.effectiveStepIds(overrides);
        } catch (err) { // prawduct:allow prawduct/broad-except -- an unreadable project config must not 500 the audit surface; the degraded state is logged and flagged in the response
          // Empty expected steps scores every session 1.0 — indistinguishable
          // from a deliberately commit-only project unless flagged.
          log.warn('project config unreadable — wrap-quality scored with no expected steps', {
            project: params.project,
            error: err.message
          });
          expectedStepsUnavailable = true;
        }
      }

      const results = sessions.map(sess => {
        // Get last 5 exchanges for this session
        const exchanges = store.evalExchanges.list({
          project: params.project,
          sessionId: sess.sessionId
        }).slice(-5);

        const quality = evalAudit.scoreWrapQuality(exchanges, wrapStepIds);
        return {
          sessionId: sess.sessionId,
          exchangeCount: sess.exchangeCount,
          lastTimestamp: sess.lastTimestamp,
          ...quality
        };
      });

      return jsonResponse(res, 200, { project: params.project, sessions: results, expectedStepsUnavailable });
    } catch (err) {
      return errorResponse(res, 500, err.message, 'INTERNAL');
    }
  });

  // POST /api/audit/:project/baseline/recompute — Recompute baseline from recent scores
  route('POST', '/api/audit/:project/baseline/recompute', (req, res, params, body) => {
    try {
      const window = (body && body.window) || '14d';
      const baseline = evalAudit.computeBaseline(params.project, store, { window });
      if (!baseline) {
        return jsonResponse(res, 200, { baseline: null, message: 'No scores found in window to compute baseline' });
      }
      return jsonResponse(res, 200, { baseline });
    } catch (err) {
      return errorResponse(res, 500, err.message, 'INTERNAL');
    }
  });

  // GET /api/audit/:project/incidents — List incidents
  route('GET', '/api/audit/:project/incidents', (req, res, params) => {
    const urlObj = reqUrl(req);
    const query = parseQuery(urlObj.search);
    try {
      const options = {};
      if (query.status) options.status = query.status;
      if (query.type) options.type = query.type;
      if (query.limit) options.limit = parseInt(query.limit, 10);
      const incidents = store.evalIncidents.list(params.project, options);
      return jsonResponse(res, 200, { project: params.project, incidents });
    } catch (err) {
      return errorResponse(res, 500, err.message, 'INTERNAL');
    }
  });

  // GET /api/audit/:project/incidents/:id — Get single incident
  route('GET', '/api/audit/:project/incidents/:id', (_req, res, params) => {
    try {
      const incident = store.evalIncidents.get(params.id);
      if (!incident || incident.project !== params.project) {
        return errorResponse(res, 404, 'Incident not found', 'NOT_FOUND');
      }
      return jsonResponse(res, 200, { incident });
    } catch (err) {
      return errorResponse(res, 500, err.message, 'INTERNAL');
    }
  });

  // PUT /api/audit/:project/incidents/:id — Update incident (accept/dismiss)
  route('PUT', '/api/audit/:project/incidents/:id', (_req, res, params, body) => {
    try {
      const existing = store.evalIncidents.get(params.id);
      if (!existing || existing.project !== params.project) {
        return errorResponse(res, 404, 'Incident not found', 'NOT_FOUND');
      }
      if (!body || !body.status) {
        return errorResponse(res, 400, 'Missing status field', 'VALIDATION');
      }
      const validStatuses = ['open', 'accepted', 'dismissed'];
      if (!validStatuses.includes(body.status)) {
        return errorResponse(res, 400, `Invalid status: ${body.status}. Must be one of: ${validStatuses.join(', ')}`, 'VALIDATION');
      }
      const updateData = { status: body.status };
      if (body.status !== 'open') {
        updateData.resolvedAt = new Date().toISOString();
        updateData.resolvedBy = body.resolvedBy || 'user';
      }
      const updated = store.evalIncidents.update(params.id, updateData);
      return jsonResponse(res, 200, { incident: updated });
    } catch (err) {
      return errorResponse(res, 500, err.message, 'INTERNAL');
    }
  });

  // POST /api/audit/:project/scores/:id/human — Submit human score for an exchange
  route('POST', '/api/audit/:project/scores/:id/human', (_req, res, params, body) => {
    try {
      const score = store.evalScores.get(params.id);
      if (!score) {
        return errorResponse(res, 404, 'Score record not found', 'NOT_FOUND');
      }
      // Verify score belongs to the project
      const exchange = store.evalExchanges.get(score.exchangeId);
      if (!exchange || exchange.project !== params.project) {
        return errorResponse(res, 404, 'Score record not found for this project', 'NOT_FOUND');
      }
      const validation = evalAudit.validateHumanScore(body);
      if (!validation.valid) {
        return errorResponse(res, 400, validation.error, 'VALIDATION');
      }
      const updated = store.evalScores.updateHumanScore(params.id, body);
      return jsonResponse(res, 200, { score: updated });
    } catch (err) {
      return errorResponse(res, 500, err.message, 'INTERNAL');
    }
  });

  // POST /api/audit/retention/run — Manually trigger retention policy
  route('POST', '/api/audit/retention/run', (_req, res, _params, body) => {
    try {
      const retentionDays = (body && body.retentionDays) || 90;
      const result = evalAudit.runRetentionPolicy(store, retentionDays);
      return jsonResponse(res, 200, result);
    } catch (err) {
      return errorResponse(res, 500, err.message, 'INTERNAL');
    }
  });
}

module.exports = { register };
