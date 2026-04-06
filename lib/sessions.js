'use strict';

const store = require('./store');
const tmux = require('./tmux');
const tunnel = require('./tunnel');
const git = require('./git');
const engines = require('./engines');
const methodologies = require('./methodologies');
const skills = require('./skills');
const { createLogger } = require('./logger');

const log = createLogger('sessions');

// ── Session Launch ──

/**
 * Launch a new session for a project.
 * Generates prime prompt, starts tmux session, injects prime, records in SQLite.
 * @param {string} projectName - Project directory name
 * @param {object} [options]
 * @param {boolean} [options.primePrompt] - Generate and inject prime prompt (default true)
 * @param {string} [options.engineOverride] - Use different engine for this session only
 * @returns {{ session: object|null, primePrompt: string|null, ttydUrl: string, error: string|null }}
 */
function launchSession(projectName, options = {}) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `Project "${projectName}" not found` };
  }

  if (project.archived) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `Project "${projectName}" is archived — unarchive it first` };
  }

  // Check for existing active session
  const existing = store.sessions.getActive(project.id);
  if (existing) {
    // If tmux is dead, clean up the stale session instead of blocking
    if (existing.tmuxSession && !tmux.hasSession(existing.tmuxSession)) {
      store.sessions.markCrashed(existing.id, 'tmux session died');
      clearIdleCache(existing.tmuxSession);
      log.warn('Cleaned up stale active session before launch', { project: projectName, session: existing.id });
    } else {
      return { session: null, primePrompt: null, ttydUrl: null, error: `Session already active for "${projectName}"` };
    }
  }

  // Check for stale wrapping session
  const wrapping = store.sessions.getWrapping(project.id);
  if (wrapping) {
    if (wrapping.tmuxSession && tmux.hasSession(wrapping.tmuxSession)) {
      return { session: null, primePrompt: null, ttydUrl: null, error: `Session is currently wrapping for "${projectName}"` };
    }
    // Dead wrapping session — auto-complete it
    autoCompleteWrap(project, wrapping);
    log.info('Cleaned up stale wrapping session before launch', { project: projectName, session: wrapping.id });
  }

  // Resolve engine — openclaw:<connId> IDs resolve to the base "openclaw" profile
  const engineId = options.engineOverride || project.engineId;
  const baseEngineId = engineId.startsWith('openclaw:') ? 'openclaw' : engineId;
  const engineProfile = store.engines.get(baseEngineId);
  if (!engineProfile) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `Engine "${engineId}" not found` };
  }

  // Check engine availability (for openclaw, SSH must be available)
  const det = engines.detectEngine(engineProfile);
  if (!det.available) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `Engine "${engineId}" not available (binary not found)` };
  }

  // Verify OpenClaw connection exists and check for webui mode
  if (engineId.startsWith('openclaw:')) {
    const connId = engineId.slice('openclaw:'.length);
    const conn = store.openclawConnections.get(connId);
    if (!conn) {
      return { session: null, primePrompt: null, ttydUrl: null, error: `OpenClaw connection "${connId}" not found` };
    }

    // Web UI mode — delegate to async launch path
    const mode = (options.mode === 'webui' || options.mode === 'ssh') ? options.mode : conn.defaultMode;
    if (mode === 'webui') {
      return { session: null, primePrompt: null, ttydUrl: null, error: null, webui: true, _conn: conn, _engineId: engineId, _engineProfile: engineProfile, _project: project };
    }
  }

  // Generate prime prompt
  let primeText = null;
  if (options.primePrompt !== false) {
    primeText = generatePrimePrompt(project, engineProfile);
  }

  // Get methodology phase
  const projConfig = store.projectConfig.load(project.path);
  const methodologyPhase = projConfig.methodologyPhase || null;

  // Sync shared docs from group shared directories before config generation
  try {
    const groups = store.projectGroups.getByProject(project.id);
    for (const group of groups) {
      if (group.sharedDir) {
        store.sharedDocs.syncFromDirectory(group.id, group.sharedDir);
      }
    }
  } catch (err) {
    log.warn('Failed to sync shared docs from group directories', { error: err.message });
  }

  // Regenerate engine config BEFORE launching (ensures engine reads current methodology)
  const methodologyTemplate = store.templates.get(project.methodology);
  const configContent = engines.generateConfig(engineId, projConfig, methodologyTemplate);
  if (configContent && engineProfile.configFormat) {
    try {
      const configFilePath = require('node:path').join(project.path, engineProfile.configFormat.filename);
      require('node:fs').mkdirSync(require('node:path').dirname(configFilePath), { recursive: true });
      require('node:fs').writeFileSync(configFilePath, configContent);
    } catch (err) {
      log.warn('Failed to write engine config', { error: err.message });
    }
  }

  // Sync engine hooks to match methodology (before launch so hooks are current)
  try {
    engines.syncEngineHooks(project.path, methodologyTemplate);
  } catch (err) {
    log.warn('Failed to sync engine hooks during session launch', { error: err.message });
  }

  // Start tmux session (sanitize name for tmux — spaces not allowed)
  const tmuxName = tmux.toSessionName(projectName);
  const launchCmd = _buildLaunchCommand(engineProfile, project);

  // If an orphaned tmux session exists (no DB record but tmux session present),
  // kill it and create a fresh one with the correct cwd and launch command.
  // Adopting in-place would skip cwd, prime prompt, config generation, and hooks.
  if (tmux.hasSession(tmuxName)) {
    log.info('Killing orphaned tmux session before fresh launch', { name: tmuxName });
    tmux.killSession(tmuxName);
  }

  try {
    const created = tmux.createSession(tmuxName, {
      cwd: project.path,
      command: launchCmd,
      env: engineProfile.launch ? engineProfile.launch.env : {}
    });

    if (!created) {
      return { session: null, primePrompt: null, ttydUrl: null, error: `Failed to create tmux session "${tmuxName}"` };
    }
  } catch (err) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `tmux error: ${err.message}` };
  }

  // Dismiss startup prompts (e.g. update dialogs, trust confirmations)
  if (engineProfile.launch && engineProfile.launch.preKeys && engineProfile.launch.preKeys.length > 0) {
    const preDelay = engineProfile.launch.preKeyDelay || 2000;
    _sleep(preDelay);
    for (const key of engineProfile.launch.preKeys) {
      try {
        tmux.sendRawKey(tmuxName, key);
        _sleep(500);
      } catch (err) {
        log.warn('Failed to send pre-key', { project: projectName, key, error: err.message });
      }
    }
  }

  // Inject prime prompt if engine supports it
  if (primeText && engineProfile.capabilities && engineProfile.capabilities.supportsPrimePrompt) {
    try {
      const startupDelay = (engineProfile.launch && engineProfile.launch.startupDelay) || 1500;
      log.debug('Injecting prime prompt', { project: projectName, engine: engineId, startupDelay, length: primeText.length });
      _sleep(startupDelay);
      tmux.sendKeys(tmuxName, primeText, { enter: true });
      log.debug('Prime prompt injected', { project: projectName });
    } catch (err) {
      log.warn('Failed to inject prime prompt', { project: projectName, error: err.message });
    }
  }

  // Record session in store
  const session = store.sessions.start({
    projectId: project.id,
    engineId,
    tmuxSession: tmuxName,
    primePrompt: primeText,
    methodologyPhase
  });

  log.info('Session launched', { project: projectName, engine: engineId, session: session.id });

  return {
    session,
    primePrompt: primeText,
    ttydUrl: '/terminal/',
    error: null
  };
}

/**
 * Launch a Web UI session for an OpenClaw connection.
 * Skips tmux — ensures SSH tunnel, health checks, and returns an iframe URL.
 * @param {string} projectName - Project directory name
 * @param {object} conn - OpenClaw connection record
 * @param {string} engineId - Full engine ID (openclaw:<connId>)
 * @param {object} engineProfile - Base openclaw engine profile
 * @param {object} project - Project record from store
 * @returns {Promise<{ session: object|null, primePrompt: string|null, iframeUrl: string|null, ttydUrl: string|null, error: string|null }>}
 */
async function launchWebuiSession(projectName, conn, engineId, engineProfile, project, options = {}) {
  // Detect stale tunnel on the port and auto-kill if force is set
  const existing = await tunnel.detectTunnel(conn.localPort, conn.host);
  const forceCleanup = options.force || false;

  // Ensure SSH tunnel is up (force kills stale tunnel first if needed)
  const extraForwards = conn.bridgePort ? [{ localPort: conn.bridgePort, remotePort: conn.bridgePort }] : [];
  const tunnelResult = await tunnel.ensureTunnel(projectName, {
    host: conn.host,
    port: conn.port,
    localPort: conn.localPort,
    sshUser: conn.sshUser,
    sshKeyPath: conn.sshKeyPath,
    force: forceCleanup && existing.active,
    extraForwards
  });

  if (!tunnelResult.ok) {
    // If tunnel failed and there's a stale process, provide actionable error
    if (existing.active && !forceCleanup) {
      const pidInfo = existing.pid ? ` (PID ${existing.pid})` : '';
      return { session: null, primePrompt: null, iframeUrl: null, ttydUrl: null,
        error: `Port ${conn.localPort} blocked by existing SSH tunnel${pidInfo}. Kill it from the OpenClaw connection panel or retry with force.`,
        staleTunnel: { pid: existing.pid, port: conn.localPort }
      };
    }
    return { session: null, primePrompt: null, iframeUrl: null, ttydUrl: null, error: `Tunnel failed: ${tunnelResult.error}` };
  }

  // Health check
  const health = await tunnel.checkHealth({ localPort: conn.localPort });
  if (!health.healthy) {
    log.warn('OpenClaw health check failed after tunnel', { project: projectName, error: health.error });
    // Non-fatal — instance may still be starting up. Session is created regardless.
  }

  // Build iframe URL: /openclaw/<project>/chat?session=main
  const tokenParam = conn.gatewayToken ? `#token=${encodeURIComponent(conn.gatewayToken)}` : '';
  const iframeUrl = `/openclaw/${encodeURIComponent(projectName)}/chat?session=main${tokenParam}`;

  // Record session in store (no tmux session, mode = webui)
  const session = store.sessions.start({
    projectId: project.id,
    engineId,
    tmuxSession: null,
    primePrompt: null,
    methodologyPhase: null,
    sessionMode: 'webui'
  });

  log.info('Web UI session launched', { project: projectName, engine: engineId, session: session.id, localPort: conn.localPort });

  return {
    session,
    primePrompt: null,
    iframeUrl,
    ttydUrl: null,
    error: null
  };
}

// ── Prime Prompt Generation ──

/**
 * Generate a prime prompt from methodology + project state + learnings + last session.
 * @param {object} project - Project record from store
 * @param {object} engineProfile - Engine profile
 * @returns {string}
 */
function generatePrimePrompt(project, engineProfile) {
  const template = store.templates.get(project.methodology);
  const projConfig = store.projectConfig.load(project.path);
  const sections = [];

  // Header
  sections.push(`# Session Start — ${project.name}`);
  sections.push("*TangleClaw'd into existence.*");
  sections.push('');

  // Methodology info
  if (template) {
    sections.push(`## Methodology: ${template.name}`);
    if (template.description) {
      sections.push(template.description);
    }
    sections.push('');

    // Current phase
    if (projConfig.methodologyPhase && template.phases) {
      const phase = template.phases.find((p) => p.id === projConfig.methodologyPhase);
      if (phase) {
        sections.push(`## Current Phase: ${phase.name}`);
        if (phase.description) sections.push(phase.description);
        sections.push('');
      }
    }
  }

  // Previous methodology archives
  if (projConfig.methodologyArchives && projConfig.methodologyArchives.length > 0) {
    sections.push('## Previous Methodology Archives');
    sections.push('Archived methodology state is preserved at:');
    for (const archive of projConfig.methodologyArchives) {
      sections.push(`- \`${archive.archivePath}/\` (${archive.methodology})`);
    }
    sections.push('Review learnings and reflections there for context on prior work.');
    sections.push('');
  }

  // Active learnings
  try {
    const learnings = store.learnings.getActive(project.id);
    if (learnings.length > 0) {
      sections.push('## Active Learnings');
      for (const learning of learnings) {
        sections.push(`- ${learning.content}`);
      }
      sections.push('');
    }
  } catch {
    // Learnings might not be available — skip
  }

  // Last session summary
  const lastSession = store.sessions.getLatest(project.id);
  if (lastSession && lastSession.wrapSummary) {
    sections.push('## Last Session Summary');
    sections.push(lastSession.wrapSummary);
    sections.push('');
  }

  // Rules summary — include definitions from template defaultRules when available
  if (projConfig.rules) {
    const activeExtensions = Object.entries(projConfig.rules.extensions || {})
      .filter(([, v]) => v === true);
    if (activeExtensions.length > 0) {
      const ruleDefs = (template && template.defaultRules) || {};
      sections.push('## Active Extension Rules');
      for (const [rule] of activeExtensions) {
        const def = ruleDefs[rule];
        if (def && typeof def === 'object' && def.definition) {
          sections.push(`- **${rule}**: ${def.definition}`);
        } else {
          sections.push(`- ${rule}`);
        }
      }
      sections.push('');
    }
  }

  // Eval Audit Mode
  try {
    if (projConfig.evalAuditMode && projConfig.evalAuditMode.enabled) {
      const ac = projConfig.evalAuditMode;
      const openIncidents = store.evalIncidents.countByStatus(project.name, 'open');
      sections.push('## Eval Audit Mode: Active');
      sections.push('Exchanges are being scored for governance compliance.');
      const lines = [
        `- Judge model: ${ac.judgeModel || 'claude-haiku-4-5'}`,
        '- Tiers: Structural (Tier 1), Semantic (Tier 2), Thinking Analysis (Tier 2.5), Behavioral (Tier 3)',
        `- Sampling: ${ac.sampling && ac.sampling.enabled !== false ? `enabled (routine interval: ${ac.sampling.routineInterval || 3})` : 'disabled'}`,
        `- Cost cap: $${(ac.costCapPerSession || 1.00).toFixed(2)}/session`
      ];
      if (openIncidents > 0) {
        lines.push(`- Open incidents: ${openIncidents}`);
      }
      sections.push(lines.join('\n'));
      sections.push('');
    }
  } catch {
    // Eval audit info might not be available — skip
  }

  // Shared infrastructure (groups with shared docs)
  try {
    const groups = store.projectGroups.getByProject(project.id);
    const groupsWithDocs = groups.map(g => {
      const docs = store.sharedDocs.getByGroup(g.id);
      return { ...g, docCount: docs.length };
    }).filter(g => g.docCount > 0);

    if (groupsWithDocs.length === 1) {
      const g = groupsWithDocs[0];
      sections.push(`## Shared Infrastructure: ${g.name}`);
      const dirNote = g.sharedDir ? ` — read from \`${g.sharedDir}\` as needed.` : '';
      sections.push(`${g.docCount} shared doc${g.docCount !== 1 ? 's' : ''} linked${dirNote}`);
      sections.push('');
    } else if (groupsWithDocs.length > 1) {
      sections.push('## Shared Infrastructure');
      for (const g of groupsWithDocs) {
        const dirNote = g.sharedDir ? ` — \`${g.sharedDir}\`` : '';
        sections.push(`- **${g.name}**: ${g.docCount} doc${g.docCount !== 1 ? 's' : ''}${dirNote}`);
      }
      sections.push('');
    }
  } catch {
    // Groups/shared docs might not be available — skip
  }

  let prompt = sections.join('\n');

  // Respect maxTokens from template prime config (rough character estimate)
  if (template && template.prime && template.prime.maxTokens) {
    const maxChars = template.prime.maxTokens * 4; // rough token-to-char ratio
    if (prompt.length > maxChars) {
      prompt = prompt.slice(0, maxChars) + '\n\n[Prime prompt truncated]';
    }
  }

  return prompt;
}

// ── Session Status ──

/**
 * Get session status for a project, including idle detection.
 * @param {string} projectName - Project directory name
 * @returns {{ active: boolean, sessionId?: number, project: string, engine?: string,
 *             tmuxSession?: string, startedAt?: string, durationSeconds?: number,
 *             idle?: boolean, lastOutputAge?: number, lastSession?: object }|null}
 */
function getSessionStatus(projectName) {
  const project = store.projects.getByName(projectName);
  if (!project) return null;

  const active = store.sessions.getActive(project.id);
  if (active) {
    // Web UI sessions — health-based status, no tmux
    if (active.sessionMode === 'webui') {
      const now = new Date();
      const started = new Date(active.startedAt);
      const durationSeconds = Math.floor((now - started) / 1000);

      // Reconstruct iframeUrl from connection config for reconnects
      let iframeUrl = null;
      if (active.engineId && active.engineId.startsWith('openclaw:')) {
        const connId = active.engineId.split(':')[1];
        const conn = store.openclawConnections.get(connId);
        if (conn) {
          const tokenParam = conn.gatewayToken ? `#token=${encodeURIComponent(conn.gatewayToken)}` : '';
          iframeUrl = `/openclaw/${encodeURIComponent(projectName)}/chat?session=main${tokenParam}`;
        }
      }

      return {
        active: true,
        sessionId: active.id,
        project: projectName,
        engine: active.engineId,
        sessionMode: 'webui',
        tmuxSession: null,
        startedAt: active.startedAt,
        durationSeconds,
        idle: false,
        lastOutputAge: 0,
        iframeUrl
      };
    }

    // Check if tmux session is actually alive
    if (active.tmuxSession && !tmux.hasSession(active.tmuxSession)) {
      // tmux died unexpectedly — mark as crashed so frontend detects session end
      store.sessions.markCrashed(active.id, 'tmux session died');
      clearIdleCache(active.tmuxSession);
      log.warn('Active session tmux died', { project: projectName, session: active.id });
      // Fall through to wrapping/lastSession checks below
    } else {
      // Check idle status via tmux
      let idle = false;
      let lastOutputAge = 0;

      if (active.tmuxSession && tmux.hasSession(active.tmuxSession)) {
        const idleInfo = detectIdle(active.tmuxSession);
        idle = idleInfo.idle;
        lastOutputAge = idleInfo.lastOutputAge;
      }

      const now = new Date();
      const started = new Date(active.startedAt);
      const durationSeconds = Math.floor((now - started) / 1000);

      return {
        active: true,
        sessionId: active.id,
        project: projectName,
        engine: active.engineId,
        tmuxSession: active.tmuxSession,
        startedAt: active.startedAt,
        durationSeconds,
        idle,
        lastOutputAge
      };
    }
  }

  // Check for wrapping session
  const wrapping = store.sessions.getWrapping(project.id);
  if (wrapping) {
    const tmuxAlive = wrapping.tmuxSession && tmux.hasSession(wrapping.tmuxSession);

    if (tmuxAlive) {
      // Check for wrap timeout — force-complete if wrapping too long
      const wrapStart = _wrapStartTimes.get(wrapping.id);
      if (wrapStart && (Date.now() - wrapStart) > WRAP_TIMEOUT_MS) {
        log.warn('Wrap timeout exceeded, force-completing', { project: projectName, session: wrapping.id, elapsed: Date.now() - wrapStart });
        const result = completeWrap(projectName);
        return {
          active: false,
          wrapping: false,
          wrapCompleted: true,
          project: projectName,
          lastSession: result.session ? {
            sessionId: result.session.id,
            status: result.session.status,
            endedAt: result.session.endedAt,
            durationSeconds: result.session.durationSeconds,
            wrapSummary: result.session.wrapSummary
          } : null
        };
      }

      // Cache pane output while wrapping (for capture when tmux dies)
      try {
        const lines = tmux.capturePane(wrapping.tmuxSession, { lines: 100 });
        _wrapPaneCache.set(wrapping.id, lines.join('\n'));
      } catch {
        // tmux may have just died — ignore
      }

      // Include idle detection so frontend can detect wrap completion
      const idleInfo = detectIdle(wrapping.tmuxSession);

      return {
        active: false,
        wrapping: true,
        sessionId: wrapping.id,
        project: projectName,
        engine: wrapping.engineId,
        tmuxSession: wrapping.tmuxSession,
        startedAt: wrapping.startedAt,
        idle: idleInfo.idle,
        lastOutputAge: idleInfo.lastOutputAge
      };
    }

    // tmux is dead — auto-complete the wrap
    const completed = autoCompleteWrap(project, wrapping);
    return {
      active: false,
      wrapping: false,
      wrapCompleted: true,
      project: projectName,
      lastSession: completed ? {
        sessionId: completed.id,
        status: completed.status,
        endedAt: completed.endedAt,
        durationSeconds: completed.durationSeconds,
        wrapSummary: completed.wrapSummary
      } : null
    };
  }

  // No DB session but tmux session exists (launched outside v3 or DB out of sync)
  const tmuxName = tmux.toSessionName(projectName);
  if (tmux.hasSession(tmuxName)) {
    return {
      active: true,
      project: projectName,
      engine: null,
      tmuxSession: tmuxName,
      startedAt: null,
      durationSeconds: null,
      idle: false,
      lastOutputAge: 0,
      untracked: true
    };
  }

  // No active session — return last session info
  const lastSession = store.sessions.getLatest(project.id);
  const result = {
    active: false,
    project: projectName,
    lastSession: null
  };

  if (lastSession) {
    result.lastSession = {
      sessionId: lastSession.id,
      status: lastSession.status,
      endedAt: lastSession.endedAt,
      durationSeconds: lastSession.durationSeconds,
      wrapSummary: lastSession.wrapSummary
    };
  }

  return result;
}

// ── Idle Detection ──

// Cache of last captured output per session, for change detection
const _lastOutput = new Map();

// Cache of pane output during wrapping, keyed by session id
const _wrapPaneCache = new Map();

// Track when each session entered wrapping state (session id → timestamp)
const _wrapStartTimes = new Map();

// Maximum time (ms) a session can stay in wrapping state before force-completing
const WRAP_TIMEOUT_MS = 120_000;

/**
 * Detect if a tmux session is idle (no output changes).
 * @param {string} tmuxSession - tmux session name
 * @returns {{ idle: boolean, lastOutputAge: number }}
 */
function detectIdle(tmuxSession) {
  try {
    const lines = tmux.capturePane(tmuxSession, { lines: 3 });
    const currentOutput = lines.join('\n');

    const cached = _lastOutput.get(tmuxSession);
    const now = Date.now();

    if (!cached || cached.output !== currentOutput) {
      _lastOutput.set(tmuxSession, { output: currentOutput, timestamp: now });
      return { idle: false, lastOutputAge: 0 };
    }

    const age = Math.floor((now - cached.timestamp) / 1000);
    return { idle: age > 10, lastOutputAge: age };
  } catch {
    return { idle: false, lastOutputAge: 0 };
  }
}

/**
 * Clear idle detection cache for a session.
 * @param {string} tmuxSession - tmux session name
 */
function clearIdleCache(tmuxSession) {
  _lastOutput.delete(tmuxSession);
}

// ── Command Injection ──

/**
 * Inject a command into an active session.
 * @param {string} projectName - Project name
 * @param {string} command - Text to inject
 * @param {object} [options]
 * @param {boolean} [options.enter] - Send Enter after text (default true)
 * @returns {{ ok: boolean, error: string|null }}
 */
function injectCommand(projectName, command, options = {}) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { ok: false, error: `Project "${projectName}" not found` };
  }

  // Enforce command length limit (security-model.md: 4096 chars max)
  if (command.length > 4096) {
    return { ok: false, error: 'Command exceeds maximum length of 4096 characters' };
  }

  const active = store.sessions.getActive(project.id);
  if (!active) {
    return { ok: false, error: `No active session for "${projectName}"` };
  }

  // Web UI sessions don't support command injection
  if (active.sessionMode === 'webui') {
    return { ok: false, error: 'Command injection not supported for Web UI sessions' };
  }

  if (!active.tmuxSession || !tmux.hasSession(active.tmuxSession)) {
    return { ok: false, error: `tmux session "${active.tmuxSession}" not found` };
  }

  try {
    tmux.sendKeys(active.tmuxSession, command, { enter: options.enter !== false });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Peek ──

/**
 * Peek at recent terminal output for a project's active session.
 * @param {string} projectName - Project name
 * @param {object} [options] - Options
 * @param {number} [options.lines] - Number of lines (default 5)
 * @param {boolean} [options.full] - Capture full scrollback buffer
 * @returns {{ lines: string[]|null, tmuxSession: string|null, error: string|null }}
 */
function peek(projectName, options = {}) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { lines: null, tmuxSession: null, error: `Project "${projectName}" not found` };
  }

  const active = store.sessions.getActive(project.id);
  if (!active || !active.tmuxSession) {
    // Check if it's a webui session (no tmux)
    if (active && active.sessionMode === 'webui') {
      return { lines: null, tmuxSession: null, error: 'Peek not supported for Web UI sessions' };
    }
    return { lines: null, tmuxSession: null, error: `No active session for "${projectName}"` };
  }

  if (!tmux.hasSession(active.tmuxSession)) {
    return { lines: null, tmuxSession: null, error: `tmux session not found` };
  }

  if (options.full) {
    const output = tmux.capturePane(active.tmuxSession, { full: true });
    return { lines: output, tmuxSession: active.tmuxSession, error: null };
  }

  const lineCount = Math.max(options.lines || 5, 1);
  const output = tmux.capturePane(active.tmuxSession, { lines: lineCount });

  return { lines: output, tmuxSession: active.tmuxSession, error: null };
}

// ── Wrap ──

/**
 * Trigger the session wrap skill. Sends the wrap command and returns immediately.
 * The frontend polls status to detect completion.
 * @param {string} projectName - Project name
 * @returns {{ ok: boolean, sessionId: number|null, wrapCommand: string|null, error: string|null }}
 */
function triggerWrap(projectName) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { ok: false, sessionId: null, wrapCommand: null, wrapSteps: [], captureFields: [], error: `Project "${projectName}" not found` };
  }

  const active = store.sessions.getActive(project.id);
  if (!active || !active.tmuxSession) {
    return { ok: false, sessionId: null, wrapCommand: null, wrapSteps: [], captureFields: [], error: `No active session for "${projectName}"` };
  }

  // Get methodology wrap config
  const wrapSkill = skills.getWrapSkill(project.methodology);
  let wrapSteps = [];
  let captureFields = [];
  let customCommand = null;

  if (wrapSkill) {
    customCommand = wrapSkill.command || null;
    wrapSteps = wrapSkill.steps;
    captureFields = wrapSkill.captureFields;
  }

  // Build wrap instruction — use custom command if set, otherwise natural language prompt
  let fullCommand;
  if (customCommand) {
    fullCommand = customCommand;
    if (wrapSteps.length > 0) {
      fullCommand += `\nWrap steps: ${wrapSteps.join(', ')}`;
    }
    if (captureFields.length > 0) {
      fullCommand += `\nOutput these fields as ## headings: ${captureFields.join(', ')}`;
    }
  } else {
    fullCommand = 'Perform a session wrap. Commit all uncommitted work, then output a wrap summary.';
    if (wrapSteps.length > 0) {
      fullCommand += `\nWrap steps: ${wrapSteps.join(', ')}`;
    }
    if (captureFields.length > 0) {
      fullCommand += `\nOutput these fields as ## markdown headings: ${captureFields.join(', ')}`;
    }
  }

  const wrapCommand = customCommand || 'session-wrap';

  // Send wrap command to the session
  try {
    tmux.sendKeys(active.tmuxSession, fullCommand, { enter: true });
  } catch (err) {
    return { ok: false, sessionId: active.id, wrapCommand, wrapSteps, captureFields, error: `Failed to send wrap command: ${err.message}` };
  }

  // Transition to wrapping status
  store.sessions.setWrapping(active.id);
  _wrapStartTimes.set(active.id, Date.now());

  log.info('Wrap triggered', { project: projectName, session: active.id, command: wrapCommand });

  return {
    ok: true,
    sessionId: active.id,
    wrapCommand,
    wrapSteps,
    captureFields,
    error: null
  };
}

/**
 * Complete a wrap — capture summary, update session record, kill tmux.
 * Called after wrap skill has finished (detected by polling or manually).
 * @param {string} projectName - Project name
 * @param {string} [summary] - Wrap summary text
 * @returns {{ session: object|null, error: string|null }}
 */
function completeWrap(projectName, summary) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { session: null, error: `Project "${projectName}" not found` };
  }

  // Check for wrapping session first, then active
  const target = store.sessions.getWrapping(project.id) || store.sessions.getActive(project.id);
  if (!target) {
    return { session: null, error: `No active or wrapping session for "${projectName}"` };
  }

  // Update session record
  const session = store.sessions.wrap(target.id, summary);

  // Kill tmux session
  if (target.tmuxSession && tmux.hasSession(target.tmuxSession)) {
    try {
      tmux.killSession(target.tmuxSession);
    } catch (err) {
      log.warn('Failed to kill tmux session during wrap', { error: err.message });
    }
  }

  // Auto-commit any uncommitted changes the wrap step may have missed
  _autoCommitIfDirty(project);

  // Release any document locks held by this session
  try {
    const released = store.documentLocks.releaseBySession(target.id);
    if (released > 0) {
      log.info('Released document locks on wrap', { session: target.id, count: released });
    }
  } catch (err) {
    log.warn('Failed to release document locks on wrap', { error: err.message });
  }

  clearIdleCache(target.tmuxSession);
  _wrapPaneCache.delete(target.id);
  _wrapStartTimes.delete(target.id);
  log.info('Session wrapped', { project: projectName, session: session.id });

  return { session, error: null };
}

/**
 * Auto-complete a wrap when tmux dies during wrapping state.
 * Pulls cached pane output, parses it, updates the session record.
 * @param {object} project - Project record
 * @param {object} session - Session record (status='wrapping')
 * @returns {object|null} - Updated session
 */
function autoCompleteWrap(project, session) {
  const rawOutput = _wrapPaneCache.get(session.id) || '';
  _wrapPaneCache.delete(session.id);

  // Get capture fields from methodology
  const wrapSkill = skills.getWrapSkill(project.methodology);
  const captureFields = wrapSkill ? wrapSkill.captureFields : [];

  const summary = parseWrapSummary(rawOutput, captureFields);
  const wrapped = store.sessions.wrap(session.id, summary);

  // Auto-commit any uncommitted changes the wrap step may have missed
  _autoCommitIfDirty(project);

  clearIdleCache(session.tmuxSession);
  _wrapStartTimes.delete(session.id);
  log.info('Wrap auto-completed', { project: project.name, session: session.id, summaryLength: summary.length });

  return wrapped;
}

/**
 * Auto-commit uncommitted changes after a wrap completes.
 * This catches cases where the AI engine exited before completing the commit step.
 * @param {object} project - Project record from store
 */
function _autoCommitIfDirty(project) {
  if (!project.path) return;
  try {
    if (!git.isGitRepo(project.path)) return;
    const result = git.commit(project.path, 'Session wrap: auto-commit uncommitted changes');
    if (result.committed) {
      log.info('Auto-committed uncommitted changes after wrap', { project: project.name });
    }
  } catch (err) {
    log.warn('Auto-commit check failed', { project: project.name, error: err.message });
  }
}

/**
 * Parse wrap summary from raw terminal output.
 * Looks for ## fieldName markdown headers and extracts content below each.
 * Falls back to last 50 lines if no structured fields found.
 * @param {string} rawOutput - Raw terminal output
 * @param {string[]} captureFields - Field names to look for as ## headings
 * @returns {string} - Parsed summary
 */
function parseWrapSummary(rawOutput, captureFields) {
  if (!rawOutput) return '';

  const lines = rawOutput.split('\n');

  if (captureFields && captureFields.length > 0) {
    const sections = {};
    let currentField = null;
    let currentContent = [];

    for (const line of lines) {
      // Check if this line is a ## heading matching a capture field
      const headingMatch = line.match(/^##\s+(.+)$/);
      if (headingMatch) {
        const heading = headingMatch[1].trim().toLowerCase();
        const matchedField = captureFields.find(
          (f) => f.toLowerCase() === heading
        );

        if (matchedField) {
          // Save previous field
          if (currentField) {
            sections[currentField] = currentContent.join('\n').trim();
          }
          currentField = matchedField;
          currentContent = [];
          continue;
        }
      }

      if (currentField) {
        currentContent.push(line);
      }
    }

    // Save last field
    if (currentField) {
      sections[currentField] = currentContent.join('\n').trim();
    }

    // If we captured any fields, format them
    if (Object.keys(sections).length > 0) {
      return Object.entries(sections)
        .map(([field, content]) => `## ${field}\n${content}`)
        .join('\n\n');
    }
  }

  // Fallback: last 50 lines raw
  return lines.slice(-50).join('\n').trim();
}

// ── Kill Session ──

/**
 * Kill an active session.
 * @param {string} projectName - Project name
 * @param {string} [reason] - Kill reason
 * @returns {{ session: object|null, error: string|null }}
 */
function killSession(projectName, reason) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { session: null, error: `Project "${projectName}" not found` };
  }

  const active = store.sessions.getActive(project.id);
  if (!active) {
    return { session: null, error: `No active session for "${projectName}"` };
  }

  // Update session record
  const session = store.sessions.kill(active.id, reason);

  // Tear down session resources based on mode
  if (active.sessionMode === 'webui') {
    // Web UI mode — tear down SSH tunnel
    tunnel.killTunnel(projectName);
  } else {
    // tmux mode — kill tmux session
    if (active.tmuxSession && tmux.hasSession(active.tmuxSession)) {
      try {
        tmux.killSession(active.tmuxSession);
      } catch (err) {
        log.warn('Failed to kill tmux session', { error: err.message });
      }
    }
  }

  // Release any document locks held by this session
  try {
    const released = store.documentLocks.releaseBySession(active.id);
    if (released > 0) {
      log.info('Released document locks on kill', { session: active.id, count: released });
    }
  } catch (err) {
    log.warn('Failed to release document locks on kill', { error: err.message });
  }

  clearIdleCache(active.tmuxSession);
  log.info('Session killed', { project: projectName, session: session.id, reason });

  return { session, error: null };
}

// ── Session History ──

/**
 * Get session history for a project.
 * @param {string} projectName - Project name
 * @param {object} [options]
 * @param {number} [options.limit] - Max sessions (default 20)
 * @param {string} [options.status] - Filter by status
 * @returns {{ sessions: object[], total: number, error: string|null }}
 */
function getSessionHistory(projectName, options = {}) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { sessions: [], total: 0, error: `Project "${projectName}" not found` };
  }

  const sessionList = store.sessions.list(project.id, {
    limit: options.limit || 20,
    status: options.status
  });

  const total = store.sessions.count(project.id, {
    status: options.status
  });

  return {
    sessions: sessionList.map((s) => ({
      id: s.id,
      engine: s.engineId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      status: s.status,
      durationSeconds: s.durationSeconds,
      wrapSummary: s.wrapSummary,
      methodologyPhase: s.methodologyPhase
    })),
    total,
    error: null
  };
}

// ── Helpers ──

/**
 * Build the tmux launch command from an engine profile.
 * For OpenClaw engines, builds an SSH command from the connection config.
 * @param {object} engineProfile - Engine profile
 * @param {object} [project] - Project record (needed for OpenClaw resolution)
 * @returns {string|undefined}
 */
function _buildLaunchCommand(engineProfile, project) {
  // OpenClaw engine: build SSH command from connection config
  const engineId = project ? (project.engineId || '') : '';
  if (engineId.startsWith('openclaw:')) {
    const connId = engineId.slice('openclaw:'.length);
    const conn = store.openclawConnections.get(connId);
    if (!conn) {
      log.warn('OpenClaw connection not found for launch', { connId });
      return undefined;
    }
    const keyPath = conn.sshKeyPath.replace(/^~/, process.env.HOME);
    const cliCmd = conn.cliCommand || 'openclaw-cli';
    return `ssh -t -i ${keyPath} ${conn.sshUser}@${conn.host} "${cliCmd}"`;
  }

  if (!engineProfile.launch) return undefined;
  let cmd = engineProfile.launch.shellCommand;
  if (engineProfile.launch.args && engineProfile.launch.args.length > 0) {
    cmd += ' ' + engineProfile.launch.args.join(' ');
  }
  return cmd;
}

/**
 * Synchronous sleep using spawnSync to avoid busy-waiting.
 * @param {number} ms - Milliseconds
 */
function _sleep(ms) {
  const { spawnSync } = require('node:child_process');
  spawnSync('sleep', [String(ms / 1000)], { timeout: ms + 1000 });
}

module.exports = {
  launchSession,
  launchWebuiSession,
  generatePrimePrompt,
  getSessionStatus,
  detectIdle,
  clearIdleCache,
  injectCommand,
  peek,
  triggerWrap,
  completeWrap,
  autoCompleteWrap,
  parseWrapSummary,
  killSession,
  getSessionHistory,
  _buildLaunchCommand,
  _wrapPaneCache,
  _wrapStartTimes,
  WRAP_TIMEOUT_MS
};
