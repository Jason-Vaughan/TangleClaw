'use strict';
/* ── TangleClaw — the Operator Bridge panel (#2031, ADR 0023) ── */
/* The signed-in operator's controls for the Discord bridge, drawn in global   */
/* settings. Loaded as a plain script before ui.js, exposing a controller and  */
/* a mount function on `window`.                                               */
/*                                                                            */
/* It calls only the operator routes under /api/bridge/operator/. Every one    */
/* of them is refused unless the caller is the operator signed in with an      */
/* account session, and the panel adds nothing to that: it shows what the      */
/* server answers and sends what the operator pressed.                         */
/*                                                                            */
/* The helper token. Creating one returns its value once. The panel holds it   */
/* in a variable for as long as it is on screen and nowhere else: not in the   */
/* page's storage, not in a URL, not in a log line, and it is copied only when */
/* the operator presses Copy. Dismissing it, or closing settings, loses it for */
/* good, which is the point.                                                   */

(function (global) {
  /**
   * HTML-escape a value for interpolation into markup. Self-contained so the
   * panel renders the same on any page that loads it.
   * @param {*} value - Anything; coerced to a string.
   * @returns {string}
   */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** The operator routes this panel calls, and no others. */
  const ROUTES = Object.freeze({
    status: '/api/bridge/operator/status',
    enable: '/api/bridge/operator/enable',
    disable: '/api/bridge/operator/disable',
    allowlist: '/api/bridge/operator/allowlist',
    helperToken: '/api/bridge/operator/helper-token',
    primer: '/api/bridge/operator/candidate-primer',
    circuitReset: '/api/bridge/operator/circuit/reset',
    requeue: (id) => `/api/bridge/operator/outbound/${Number(id)}/requeue`,
    withdraw: (id) => `/api/bridge/operator/outbound/${Number(id)}/withdraw`,
    withdrawCandidate: (id) => `/api/bridge/operator/candidates/${encodeURIComponent(String(id))}/withdraw`,
    alias: (name) => `/api/bridge/operator/aliases/${encodeURIComponent(String(name))}`,
    optouts: '/api/bridge/operator/optouts',
    optout: (id) => `/api/bridge/operator/optouts/${Number(id)}`
  });

  /** What Discord's ids look like: digits only. The server checks again. */
  const CHAT_ID = /^[0-9]{5,25}$/;

  /**
   * What each action asks before it is sent. An action that makes things
   * safer (disabling, switching the primer off) asks nothing: a kill switch
   * that needs a second click is slower than it should be.
   * @type {Readonly<Record<string, function(object): string>>}
   */
  const CONFIRMATIONS = Object.freeze({
    enable: () => 'Enable the operator bridge? Messages from the allowlisted Discord author will reach TangleClaw and may start the Project Master.',
    allowlist: (f) => `Set the allowlist to exactly this author (${f.authorId}), server (${f.spaceId}) and channel (${f.channelId})? `
      + 'Messages from anyone else, or anywhere else, are refused.',
    'mint-token': (f, status) => (status && status.helperToken
      ? 'Create a new helper token? The current one stops working at once, and the helper posts nothing until it is given the new one.'
      : 'Create the helper token? Its value is shown once.'),
    'revoke-token': () => 'Revoke the helper token? The helper can then neither deliver messages nor collect what to post.',
    'primer-on': () => 'Tell every session of `tc candidate` at its next launch?',
    'circuit-reset': (f) => (f.decision === 'withdraw'
      ? 'Reset the circuit and WITHDRAW what it set aside? Those items will never be posted, and a route whose answer is among them is closed.'
      : 'Reset the circuit and put what it set aside back in the queue to be posted?'),
    requeue: (f) => `Put item ${f.outboundId} back in the queue to be posted?`,
    withdraw: (f) => `Withdraw item ${f.outboundId}? It will never be posted. If it is a route's answer, that route is closed.`,
    'withdraw-candidate': (f) => `Withdraw candidate ${f.candidateId}? Nobody has decided it, and it will then never be approved or posted.`,
    'forget-nickname': (f) => `Forget the nickname @${f.nickname}? A message addressed by it will then be suggested for nobody. Nicknames are set by asking the Project Master in the chat.`,
    // Taking a project out of reach narrows what the bridge can do, and asks nothing. Putting one back widens it.
    'opt-in': (f) => `Put project ${f.projectId} back within reach of the bridge? Messages may then be routed to it, and a session launched for it when you say yes in the chat.`
  });

  /**
   * What Discord's close code means, for the two refusals an operator can put
   * right themselves. Any other code is shown as its number alone.
   */
  const REFUSALS = Object.freeze({ 4004: 'bad bot token', 4014: 'Message Content Intent is off' });

  /**
   * The words for how the helper's connection to Discord reads, from the
   * `discordGateway` of the status. They say what `tc bridge status` says.
   *
   * A status without the field, or with a reading this page does not know,
   * gets no words: a server that predates the report says nothing of the
   * connection, and the panel must not invent a reading for it.
   * @param {*} gateway - The status's `discordGateway`: `{reading, state, since, fatalCloseCode, reportedAt}`.
   * @param {boolean} enabled - Whether the bridge is enabled.
   * @returns {string} Safe markup, or '' for no line.
   */
  function discordWords(gateway, enabled) {
    const g = gateway && typeof gateway === 'object' ? gateway : {};
    const said = {
      connected: () => `connected since ${escapeHtml(g.since)} (the helper's report of ${escapeHtml(g.reportedAt)})`,
      down: () => (g.state === 'fatal'
        ? `<strong>REFUSED by Discord</strong> since ${escapeHtml(g.since)} (close code ${escapeHtml(g.fatalCloseCode)}`
          + `${Object.prototype.hasOwnProperty.call(REFUSALS, g.fatalCloseCode) ? `: ${REFUSALS[g.fatalCloseCode]}` : ''}). `
          + 'The helper will not retry until it is put right and restarted'
        : `<strong>NOT CONNECTED</strong> since ${escapeHtml(g.since)}: the helper reports ${escapeHtml(g.state)}`)
        + ` (its report of ${escapeHtml(g.reportedAt)}). Nothing you write in the chat arrives meanwhile.`,
      'not-reported': () => `<strong>not reported</strong> since ${escapeHtml(g.reportedAt)}: the helper last said ${escapeHtml(g.state)} and has not reported since. `
        + 'It may not be running; whether Discord is connected is not known.',
      'never-reported': () => 'never reported since this server started: the helper is not running, has not yet asked for work, '
        + 'or predates the report. Restart the helper after an update.'
    };
    if (!Object.prototype.hasOwnProperty.call(said, g.reading)) return '';
    // A disabled bridge refuses the helper's claim before it reads the report, so silence then says nothing about the helper.
    const unread = !enabled && (g.reading === 'not-reported' || g.reading === 'never-reported')
      ? ' The bridge is disabled, and a disabled bridge does not read the helper\'s reports: this says nothing about the helper.' : '';
    return said[g.reading]() + unread;
  }

  /**
   * Make the panel's controller: its state, what it draws, and what each
   * control does. It touches no DOM, so a test can drive it directly.
   * @param {object} deps
   * @param {Function} deps.api - The page's `api()`; its `lastError` and `lastErrorCode` say why a call returned null.
   * @param {Function} deps.apiMutate - The page's `apiMutate(url, method, body)`.
   * @param {function(string): boolean} deps.confirm - Ask the operator; true to go ahead.
   * @param {function(): string} deps.randomId - A fresh random token for a request id.
   * @param {{writeText: function(string): Promise<void>}|null} [deps.clipboard] - The clipboard, when there is one.
   * @returns {{load: function(): Promise<void>, act: function(string, object=): Promise<string>, html: function(): string, forget: function(): void, state: object}}
   */
  function tcCreateOperatorBridgePanel(deps) {
    const state = {
      status: null,
      /** Why the status could not be read: `{code, message}`. */
      refused: null,
      /** The helper token just created. Held here and nowhere else, until dismissed. */
      token: null,
      /** The last thing an action reported: `{ok, text}`. Never contains the token. */
      notice: null,
      /** Request ids of writes whose answer never arrived, by what they were for. */
      pending: Object.create(null),
      /** Whether the panel has left the screen. Nothing is drawn or kept after that. */
      gone: false
    };

    /**
     * Why the last call returned nothing.
     * @returns {{code: (string|null), message: string}}
     */
    function lastError() {
      return { code: deps.api.lastErrorCode || null, message: deps.api.lastError || 'The server did not answer.' };
    }

    /**
     * Read the bridge's status. A caller who is not the signed-in operator is
     * refused, and then nothing of the bridge's policy is held or drawn.
     * @returns {Promise<void>}
     */
    async function load() {
      const status = await deps.api(ROUTES.status);
      if (status) {
        state.status = status;
        state.refused = null;
      } else {
        state.status = null;
        state.refused = lastError();
      }
    }

    /**
     * The request id for a write that must not happen twice. A write whose
     * answer never arrived is sent again under the id it had, so the server
     * recognises the repeat; once the server answers, yes or no, the id is done.
     * @param {string} key - What the write is for.
     * @returns {string}
     */
    function requestIdFor(key) {
      if (!state.pending[key]) state.pending[key] = `op-${deps.randomId()}`;
      return state.pending[key];
    }

    /**
     * Send one write and report it.
     * @param {string} url - An operator route.
     * @param {string} method - HTTP method.
     * @param {object|undefined} body - JSON body.
     * @param {string} done - What to say when it worked.
     * @param {string} [key] - The idempotency key this write was sent under, if any.
     * @returns {Promise<object|null>} The server's answer, or null.
     */
    async function send(url, method, body, done, key) {
      const answer = await deps.apiMutate(url, method, body);
      if (answer) {
        if (key) delete state.pending[key];
        state.notice = { ok: true, text: done };
        return answer;
      }
      const why = lastError();
      // A refusal is an answer: the write is settled. No answer at all is not.
      if (key && why.code) delete state.pending[key];
      state.notice = { ok: false, text: `Not done: ${why.message}${key && !why.code ? ' Press it again to retry the same request.' : ''}` };
      return null;
    }

    /** What each control does. Each returns the server's answer or null. */
    const ACTIONS = {
      refresh: async () => { state.notice = null; return {}; },
      enable: () => send(ROUTES.enable, 'POST', {}, 'The bridge is enabled.'),
      disable: () => send(ROUTES.disable, 'POST', {}, 'The bridge is disabled. Nothing more is accepted or handed over.'),
      allowlist: (f) => send(ROUTES.allowlist, 'POST', { authorId: f.authorId, spaceId: f.spaceId, channelId: f.channelId }, 'The allowlist is set.'),
      'mint-token': async () => {
        const answer = await send(ROUTES.helperToken, 'POST', {}, 'A helper token was created. Its value is shown below, once.');
        // An answer that arrives after the panel left the screen is not kept:
        // there is nobody to show it to, and it would sit in a hidden page.
        if (answer && typeof answer.token === 'string' && !state.gone) state.token = answer.token;
        return answer;
      },
      'revoke-token': () => send(ROUTES.helperToken, 'DELETE', undefined, 'The helper token is revoked.'),
      'primer-on': () => send(ROUTES.primer, 'POST', { primed: true }, 'Sessions are told of tc candidate at their next launch.'),
      'primer-off': () => send(ROUTES.primer, 'POST', { primed: false }, 'Sessions are no longer told of tc candidate.'),
      'circuit-reset': (f) => {
        const key = `circuit-reset:${f.episodeId}:${f.decision}`;
        return send(ROUTES.circuitReset, 'POST', { requestId: requestIdFor(key), decision: f.decision },
          f.decision === 'withdraw' ? 'The circuit is reset; what it set aside is withdrawn.' : 'The circuit is reset; what it set aside is back in the queue.', key);
      },
      requeue: (f) => {
        const key = `requeue:${f.outboundId}`;
        return send(ROUTES.requeue(f.outboundId), 'POST', { requestId: requestIdFor(key) }, `Item ${Number(f.outboundId)} is back in the queue.`, key);
      },
      withdraw: (f) => {
        const key = `withdraw:${f.outboundId}`;
        return send(ROUTES.withdraw(f.outboundId), 'POST', { requestId: requestIdFor(key) }, `Item ${Number(f.outboundId)} is withdrawn.`, key);
      },
      'withdraw-candidate': (f) => {
        const key = `withdraw-candidate:${f.candidateId}`;
        return send(ROUTES.withdrawCandidate(f.candidateId), 'POST', { requestId: requestIdFor(key) }, `Candidate ${f.candidateId} is withdrawn.`, key);
      },
      'forget-nickname': (f) => send(ROUTES.alias(f.nickname), 'DELETE', undefined, `The nickname @${f.nickname} is forgotten.`),
      'opt-out': (f) => send(ROUTES.optouts, 'POST', { project: Number(f.projectId) },
        `Project ${Number(f.projectId)} is out of reach of the bridge. Nothing is routed to it and no session is launched for it.`),
      'opt-in': (f) => send(ROUTES.optout(f.projectId), 'DELETE', undefined, `Project ${Number(f.projectId)} is back within reach of the bridge.`)
    };

    /**
     * What stops an action before anything is asked or sent.
     * @param {string} action - The control.
     * @param {object} f - Its fields.
     * @returns {string|null} Why not, or null.
     */
    function blockedBy(action, f) {
      if (action === 'allowlist') {
        for (const [field, label] of [['authorId', 'author id'], ['spaceId', 'server id'], ['channelId', 'channel id']]) {
          if (typeof f[field] !== 'string' || !CHAT_ID.test(f[field])) return `The ${label} must be the number Discord shows for it.`;
        }
      }
      // Rolling back is disable first, then everything else. Revoking the token
      // of a bridge that is still enabled leaves it accepting and unable to post.
      if (action === 'revoke-token' && state.status && state.status.enabled) return 'Disable the bridge first, then revoke the token.';
      if (action === 'circuit-reset' && f.decision !== 'requeue' && f.decision !== 'withdraw') return 'Say what becomes of the items set aside: put back, or withdrawn.';
      if ((action === 'requeue' || action === 'withdraw') && !Number.isInteger(Number(f.outboundId))) return 'No such item.';
      if (action === 'withdraw-candidate' && !/^[A-Za-z0-9_-]{1,64}$/.test(String(f.candidateId || ''))) return 'No such candidate.';
      if ((action === 'opt-out' || action === 'opt-in') && !/^[1-9][0-9]{0,15}$/.test(String(f.projectId || ''))) return 'No such project.';
      if (action === 'forget-nickname' && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(f.nickname || ''))) return 'No such nickname.';
      return null;
    }

    /**
     * Run one control: check it, ask if it needs asking, send it, and read
     * the status again.
     * @param {string} action - The control pressed.
     * @param {object} [fields] - What it was pressed with.
     * @returns {Promise<('done'|'failed'|'blocked'|'declined'|'unknown')>}
     */
    async function act(action, fields = {}) {
      if (action === 'copy-token') {
        if (!state.token || !deps.clipboard || typeof deps.clipboard.writeText !== 'function') {
          state.notice = { ok: false, text: 'This browser cannot copy for you. Select the token and copy it by hand.' };
          return 'failed';
        }
        try {
          await deps.clipboard.writeText(state.token);
        } catch (err) { // eslint-disable-line no-unused-vars
          state.notice = { ok: false, text: 'The copy did not work. Select the token and copy it by hand.' };
          return 'failed';
        }
        state.notice = { ok: true, text: 'Copied. Paste it at the prompt of `bin/tc-bridge-helper set-secret helper`, then press "I have stored it".' };
        return 'done';
      }
      if (action === 'dismiss-token') {
        state.token = null;
        state.notice = { ok: true, text: 'The token is no longer shown. If it was not stored, create a new one.' };
        return 'done';
      }
      if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) return 'unknown';
      const why = blockedBy(action, fields);
      if (why) {
        state.notice = { ok: false, text: why };
        return 'blocked';
      }
      const ask = CONFIRMATIONS[action];
      if (ask && !deps.confirm(ask(fields, state.status))) return 'declined';
      const answer = await ACTIONS[action](fields);
      await load();
      return answer ? 'done' : 'failed';
    }

    /**
     * A button.
     * @param {string} action - The control it presses.
     * @param {string} label - Its words.
     * @param {object} [data] - Extra `data-bridge-*` values.
     * @param {boolean} [disabled] - Whether it is off.
     * @returns {string} Markup.
     */
    function button(action, label, data = {}, disabled = false) {
      const extra = Object.entries(data).map(([k, v]) => ` data-bridge-${escapeHtml(k)}="${escapeHtml(v)}"`).join('');
      return `<button type="button" class="btn btn-small" data-bridge-action="${escapeHtml(action)}"${extra}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
    }

    /**
     * One line of status.
     * @param {string} label - What it is.
     * @param {string} value - What it says; already safe markup.
     * @returns {string} Markup.
     */
    const line = (label, value) => `<div class="ob-line"><span class="ob-label">${escapeHtml(label)}</span> <span class="ob-value">${value}</span></div>`;

    /**
     * The panel's markup for the state it is in.
     * @returns {string}
     */
    function html() {
      const notice = state.notice
        ? `<div class="form-hint ob-notice ${state.notice.ok ? 'ob-ok' : 'ob-failed'}" aria-live="polite">${escapeHtml(state.notice.text)}</div>` : '';
      if (!state.status) {
        const signIn = state.refused && state.refused.code === 'OPERATOR_SESSION_REQUIRED';
        // Nothing of the bridge is shown to a caller the server did not accept.
        return `<div class="form-hint">${signIn
          ? 'The operator bridge is managed by the operator, signed in with an account. Sign in to see and change it.'
          : `Could not read the operator bridge: ${escapeHtml(state.refused ? state.refused.message : 'not loaded yet')}`}</div>`
          + button('refresh', 'Try again');
      }
      const s = state.status;
      const allow = s.allowlist;
      const circuit = s.configurationCircuit;
      const routes = Object.entries(s.openRoutesByState || {}).map(([k, v]) => `${escapeHtml(k)} ${escapeHtml(v)}`).join(', ');
      const items = Array.isArray(s.setAsideItems) ? s.setAsideItems : [];
      const routeless = Array.isArray(s.routelessItems) ? s.routelessItems : [];
      const reach = s.reach || {};
      const reachable = Array.isArray(reach.reachable) ? reach.reachable : [];
      const optouts = Array.isArray(reach.optouts) ? reach.optouts : [];
      const scope = reach.scope || {};
      const nicknames = Array.isArray(s.nicknames) ? s.nicknames : [];
      const discord = discordWords(s.discordGateway, Boolean(s.enabled));
      const token = state.token === null ? '' : `
        <div class="ob-token" data-bridge-token-shown="1">
          <div class="form-hint"><strong>The helper token, shown once.</strong> It is not saved anywhere by this page.
            On the machine that runs the helper, run <code>bin/tc-bridge-helper set-secret helper</code> and paste it at the prompt.
            Do not put it in a file, a message or a command line.</div>
          <code class="ob-token-value" id="obTokenValue">${escapeHtml(state.token)}</code>
          ${button('copy-token', 'Copy')} ${button('dismiss-token', 'I have stored it')}
        </div>`;
      return `
        ${notice}
        ${line('Bridge', s.enabled ? '<strong>enabled</strong>' : '<strong>disabled</strong>')}
        <div class="ob-controls">${s.enabled ? button('disable', 'Disable the bridge') : button('enable', 'Enable the bridge')} ${button('refresh', 'Refresh')}</div>
        ${line('Project Master', `${s.masterCredential ? `generation ${escapeHtml(s.masterCredential.generation)} (${escapeHtml(s.masterCredential.status)})` : 'no live credential'}; `
          + `listener ${s.masterListener && s.masterListener.enabled ? escapeHtml(s.masterListener.state || 'on') : '<strong>off</strong>'}`
          + (s.routesMasterNotTold ? `; <strong>${escapeHtml(s.routesMasterNotTold)} route(s) it has not been told of</strong>` : ''))}
        ${line('Routes', `${escapeHtml(s.openRoutes)} open${routes ? ` (${routes})` : ''}${s.oldestOpenRouteAt ? `, oldest since ${escapeHtml(s.oldestOpenRouteAt)}` : ''}`)}
        ${line('To post', `${escapeHtml(s.waitingForHelper)} waiting for the helper, ${escapeHtml(s.setAside)} set aside, ${escapeHtml(routeless.length)} queued with no open route`)}
        ${discord ? line('Discord connection', discord) : ''}

        <div class="gs-section-sublabel">Allowlist</div>
        ${line('Now', allow ? `author ${escapeHtml(allow.authorId)}, server ${escapeHtml(allow.spaceId)}, channel ${escapeHtml(allow.channelId)}` : '<strong>not set</strong>')}
        <div class="ob-form">
          <input type="text" class="form-input" id="obAuthorId" inputmode="numeric" autocomplete="off" aria-label="Discord author id" placeholder="Discord author id">
          <input type="text" class="form-input" id="obSpaceId" inputmode="numeric" autocomplete="off" aria-label="Discord server id" placeholder="Discord server id">
          <input type="text" class="form-input" id="obChannelId" inputmode="numeric" autocomplete="off" aria-label="Discord channel id" placeholder="Discord channel id">
          ${button('allowlist', 'Set the allowlist')}
        </div>

        <div class="gs-section-sublabel">What the bridge may reach</div>
        ${line('Scope', scope.kind === 'unresolved'
          ? `<strong>UNRESOLVED</strong>: the Project Master\'s scope cannot be resolved (${escapeHtml(scope.why || 'no reason given')}), so the bridge reaches <strong>no project</strong>. Put the scope right in the Master settings.`
          : (scope.kind === 'group' ? `the Project Master\'s scope, the ${escapeHtml(scope.groupName)} group` : 'every project on this install'))}
        <div class="form-hint">Every project in scope is reachable without being set up, and a new one is reachable at once. Taking one out of reach is done here and nowhere else:
          the Project Master cannot do it, and nothing said in the chat can. Nothing is then routed to it and no session is launched for it.</div>
        ${reachable.length ? reachable.map((p) => `<div class="ob-item" data-bridge-reachable="${escapeHtml(p.projectId)}">project ${escapeHtml(p.projectId)}: ${escapeHtml(p.name)} `
          + `${button('opt-out', 'Take out of reach', { project: p.projectId })}</div>`).join('')
          : '<div class="form-hint">No project is within reach.</div>'}
        ${optouts.length ? `<div class="form-hint">Out of reach by your choice:</div>${optouts.map((o) => `<div class="ob-item" data-bridge-optout="${escapeHtml(o.projectId)}">project ${escapeHtml(o.projectId)}`
          + `${o.name ? `: ${escapeHtml(o.name)}` : ' (no longer in the registry)'}, since ${escapeHtml(o.setAt)} ${button('opt-in', 'Put back within reach', { project: o.projectId })}</div>`).join('')}`
          : ''}

        <div class="gs-section-sublabel">Nicknames</div>
        <div class="form-hint">Set, renamed and forgotten by asking the Project Master in the chat ("@master remember @name means a project"). Shown here to look at, and to remove one that is wrong.
          A nickname is only a suggestion to the Master: it routes nothing and grants nothing.</div>
        ${nicknames.length ? nicknames.map((n) => `<div class="ob-item" data-bridge-nickname="${escapeHtml(n.nickname)}">@${escapeHtml(n.display)} means `
          + `${n.destination && n.destination.kind === 'master' ? 'the Project Master' : `project ${escapeHtml(n.destination ? n.destination.projectId : '')}${n.destination && n.destination.name ? `: ${escapeHtml(n.destination.name)}` : ''}`}`
          + `${n.reachable ? '' : ` <strong>(out of reach: ${escapeHtml(n.outOfReach)}; it names nothing now)</strong>`}; `
          + `${n.changedBy ? `set by ${n.changedBy === 'master' ? `the Project Master on your message ${escapeHtml(n.confirmedRouteId)}` : 'you'}, ${escapeHtml(n.changedAt)}` : `set ${escapeHtml(n.createdAt)}`} `
          + `${button('forget-nickname', 'Forget', { nickname: n.nickname })}</div>`).join('')
          : '<div class="form-hint">No nicknames are stored.</div>'}

        <div class="gs-section-sublabel">Helper token</div>
        ${line('Now', s.helperToken ? `one active, created ${escapeHtml(s.helperToken.createdAt)}` : '<strong>none</strong>')}
        <div class="ob-controls">${button('mint-token', s.helperToken ? 'Replace the helper token' : 'Create the helper token')}
          ${s.helperToken ? button('revoke-token', 'Revoke it', {}, Boolean(s.enabled)) : ''}</div>
        ${s.helperToken && s.enabled ? '<div class="form-hint">To revoke the token, disable the bridge first.</div>' : ''}
        ${token}

        <div class="gs-section-sublabel">Telling sessions of <code>tc candidate</code></div>
        ${line('Now', (s.candidatesPrimed ? 'on' : (s.candidatePrimerSetting ? 'set on, and <strong>not in effect while the bridge is disabled</strong>; it comes back when the bridge is enabled' : 'off'))
          + (s.candidatePrimerOmitted ? `; <strong>a session of project ${escapeHtml(s.candidatePrimerOmitted.projectId)} was not told</strong> `
            + `(${escapeHtml(s.candidatePrimerOmitted.length)} characters against a cap of ${escapeHtml(s.candidatePrimerOmitted.cap)}, at ${escapeHtml(s.candidatePrimerOmitted.at)})` : ''))}
        <div class="ob-controls">${s.candidatesPrimed || s.candidatePrimerSetting ? button('primer-off', 'Switch it off') : button('primer-on', 'Switch it on', {}, !s.enabled)}</div>

        <div class="gs-section-sublabel">Configuration circuit</div>
        ${circuit
          ? line('Now', `<strong>OPEN</strong>, episode ${escapeHtml(circuit.episodeId)} since ${escapeHtml(circuit.openedAt)} (${escapeHtml(circuit.reason)}). The chat is not taking posts.`)
            + `<div class="form-hint">Put the bot's access to the channel right first. Then say what becomes of what was set aside.</div>
               <div class="ob-controls">${button('circuit-reset', 'Reset and put back', { episode: circuit.episodeId, decision: 'requeue' })}
               ${button('circuit-reset', 'Reset and withdraw', { episode: circuit.episodeId, decision: 'withdraw' })}</div>`
          : line('Now', 'closed')}

        <div class="gs-section-sublabel">Set aside</div>
        ${items.length ? items.map((item) => `<div class="ob-item" data-bridge-item="${escapeHtml(item.outboundId)}">`
          + `item ${escapeHtml(item.outboundId)}: ${escapeHtml(item.notifyType || item.kind)}, ${escapeHtml(item.blockCode)}, `
          + `handed over ${escapeHtml(item.attempts)} time(s), ${escapeHtml(item.partsPosted)} part(s) posted `
          + `${button('requeue', 'Put back', { item: item.outboundId })} ${button('withdraw', 'Withdraw', { item: item.outboundId })}</div>`).join('')
          : '<div class="form-hint">Nothing is set aside.</div>'}

        <div class="gs-section-sublabel">Queued with no open route</div>
        <div class="form-hint">Closing a route withdraws what was released for it. These belong to no open route, so they wait,
          through a disabled bridge too, and are posted when it is next enabled unless withdrawn here.</div>
        ${routeless.length ? routeless.map((entry) => (entry.ref === 'candidate'
          ? `<div class="ob-item" data-bridge-queued="candidate:${escapeHtml(entry.id)}">candidate ${escapeHtml(entry.id)}: ${escapeHtml(entry.kind)}, ${escapeHtml(entry.state)}, `
            + `since ${escapeHtml(entry.createdAt)} ${button('withdraw-candidate', 'Withdraw', { candidate: entry.id })}</div>`
          : `<div class="ob-item" data-bridge-queued="item:${escapeHtml(entry.id)}">item ${escapeHtml(entry.id)}: ${escapeHtml(entry.kind)}, ${escapeHtml(entry.state)}, `
            + `since ${escapeHtml(entry.createdAt)} ${button('withdraw', 'Withdraw', { item: entry.id })}</div>`)).join('')
          : '<div class="form-hint">Nothing is queued without a route.</div>'}
      `;
    }

    /**
     * Let go of everything that was only for the operator's eyes: the token,
     * and what the last action said. Called when the panel leaves the screen.
     * @returns {void}
     */
    function forget() {
      state.token = null;
      state.notice = null;
      state.gone = true;
    }

    return { load, act, html, forget, state };
  }

  /** The panel drawn in each container, so that closing settings can clear it. */
  const mounted = new WeakMap();

  /**
   * Draw the panel in a container and wire its controls.
   * @param {HTMLElement|null} container - Where it goes.
   * @param {object} deps - As {@link tcCreateOperatorBridgePanel}; `confirm`, `randomId` and `clipboard` default to the browser's.
   * @returns {Promise<object|null>} The controller, or null with no container.
   */
  async function tcMountOperatorBridge(container, deps) {
    if (!container) return null;
    const doc = container.ownerDocument || global.document;
    const panel = tcCreateOperatorBridgePanel({
      confirm: (text) => global.confirm(text),
      randomId: () => {
        const bytes = new Uint8Array(12);
        global.crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      },
      // The page's own copy helper works on plain http too, where the browser has no clipboard API.
      clipboard: typeof global.tcCopyToClipboard === 'function'
        ? { writeText: async (text) => { if (!(await global.tcCopyToClipboard(text))) throw new Error('copy failed'); } }
        : null,
      ...deps
    });
    const draw = () => { if (!panel.state.gone) container.innerHTML = panel.html(); };
    /**
     * What a pressed control carries: its own data, and the allowlist's three inputs.
     * @param {object} target - The pressed element.
     * @returns {object}
     */
    const fieldsOf = (target) => {
      const value = (id) => { const input = doc.getElementById(id); return input ? String(input.value || '').trim() : ''; };
      return {
        authorId: value('obAuthorId'), spaceId: value('obSpaceId'), channelId: value('obChannelId'),
        outboundId: target.dataset.bridgeItem, candidateId: target.dataset.bridgeCandidate, projectId: target.dataset.bridgeProject, nickname: target.dataset.bridgeNickname,
        episodeId: target.dataset.bridgeEpisode, decision: target.dataset.bridgeDecision
      };
    };
    if (!container.dataset.bridgeBound) {
      container.dataset.bridgeBound = '1';
      container.addEventListener('click', async (evt) => {
        const target = evt && evt.target;
        const action = target && target.dataset && target.dataset.bridgeAction;
        if (!action || target.disabled) return;
        await panel.act(action, fieldsOf(target));
        draw();
      });
    }
    mounted.set(container, panel);
    await panel.load();
    draw();
    return panel;
  }

  /**
   * Take the panel off the screen: forget the token if one is showing, and
   * empty the container. Settings is hidden when it closes, not removed, so
   * without this a token would sit in the page behind a closed dialog.
   * @param {HTMLElement|null} container - Where the panel was drawn.
   * @returns {void}
   */
  function tcForgetOperatorBridge(container) {
    if (!container) return;
    const panel = mounted.get(container);
    if (panel) panel.forget();
    container.innerHTML = '';
  }

  global.tcCreateOperatorBridgePanel = tcCreateOperatorBridgePanel;
  global.tcMountOperatorBridge = tcMountOperatorBridge;
  global.tcForgetOperatorBridge = tcForgetOperatorBridge;
  global.tcOperatorBridgeRoutes = ROUTES;
})(typeof window !== 'undefined' ? window : globalThis);
