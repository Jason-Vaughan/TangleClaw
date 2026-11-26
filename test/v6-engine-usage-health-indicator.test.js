'use strict';

/*
 * v6.6.2 Wave 1 Zero-Clobber Look-Ahead (Car V662-W1-D, #3269 / V6-025).
 *
 * #3269 asks for a per-engine health indicator matching
 * public/v6-shell.js's sidebar engine badge (ENGINE_HEALTH:
 * 'operational'/'degraded'/'outage', falling back 'unknown';
 * public/style.css's .v6-member-ai-status.is-operational/-degraded/
 * -outage: green #56d364/amber #d4a72c/red #f85149) on the bottom-right
 * usage/status footer bar and per-engine usage cards. That sidebar signal
 * (engineHealth) is a public/v6-shell.js-private closure var this car's
 * envelope (public/api-helper.js alone, to stay zero-overlap with
 * concurrent Wave 1 cars on public/v6-shell.js and public/style.css) has
 * no access to — so tcV6RenderEngineHealthDotMarkup computes the SAME
 * 4-state vocabulary and color meaning from the quota-probe reading this
 * file already owns instead, inline-styled (no new CSS rule), and
 * exported so public/v6-shell.js's own footer pill() can call it
 * directly in a 2-line wire-up whenever a later car touches that file.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const loadApiHelperGlobals = require('./_api-helper-globals');

describe('tcV6RenderEngineHealthDotMarkup (#3269, V6-025)', () => {
  const G = loadApiHelperGlobals();

  it('a configured, error-free, non-exhausted probe reads operational (green)', () => {
    const html = G.tcV6RenderEngineHealthDotMarkup({ status: 'configured', fiveHourRemainingPct: 80, weeklyRemainingPct: 60 });
    assert.match(html, /class="v6-engine-health-dot"/);
    assert.match(html, /color: #56d364;/);
    assert.match(html, /title="Healthy"/);
    assert.match(html, />●</);
  });

  it('a configured probe with either window exhausted (<= 0%) reads outage (red), even with no error flag', () => {
    const fiveHourZero = G.tcV6RenderEngineHealthDotMarkup({ status: 'configured', fiveHourRemainingPct: 0, weeklyRemainingPct: 40 });
    assert.match(fiveHourZero, /color: #f85149;/);
    assert.match(fiveHourZero, /title="Unavailable"/);
    const weeklyNegative = G.tcV6RenderEngineHealthDotMarkup({ status: 'configured', fiveHourRemainingPct: 30, weeklyRemainingPct: -1 });
    assert.match(weeklyNegative, /color: #f85149;/);
  });

  it('a configured probe carrying a real error (error or lastRefreshError) reads outage (red), per #3269 AC2 grouping Error under Red', () => {
    assert.match(G.tcV6RenderEngineHealthDotMarkup({ status: 'configured', fiveHourRemainingPct: 50, lastRefreshError: 'timeout' }),
      /color: #f85149;/);
    assert.match(G.tcV6RenderEngineHealthDotMarkup({ status: 'configured', fiveHourRemainingPct: 50, error: 'boom' }),
      /color: #f85149;/);
  });

  it('a configured probe carrying ONLY refreshDegraded (no actual error) reads degraded (amber) — the softer "Needs attention" state', () => {
    assert.match(G.tcV6RenderEngineHealthDotMarkup({ status: 'configured', fiveHourRemainingPct: 50, refreshDegraded: true }),
      /color: #d4a72c;/);
  });

  it('exhausted quota wins over refreshDegraded/error — the outage-by-quota check runs first', () => {
    const viaQuota = G.tcV6RenderEngineHealthDotMarkup({ status: 'configured', fiveHourRemainingPct: 0, refreshDegraded: true });
    assert.match(viaQuota, /color: #f85149;/, 'outage (exhausted) must win, not degraded');
    const viaError = G.tcV6RenderEngineHealthDotMarkup({ status: 'configured', fiveHourRemainingPct: 0, error: 'boom' });
    assert.match(viaError, /color: #f85149;/, 'still outage, just via a different trigger');
  });

  it('anything not status "configured" — not-present, not-configured, missing, null — reads unknown (gray), never degraded', () => {
    for (const probe of [{ status: 'not-present' }, { status: 'not-configured' }, {}, null, undefined]) {
      const html = G.tcV6RenderEngineHealthDotMarkup(probe);
      assert.match(html, /color: #8b949e;/, `expected unknown for ${JSON.stringify(probe)}`);
      assert.match(html, /title="Unknown — not probed"/);
    }
  });

  it('escapes its own title (defense in depth — the label is a fixed literal today, never untrusted input)', () => {
    // The label set is a closed, hardcoded enum (never probe-supplied text), so this is
    // really pinning that the renderer always escapes rather than trusting it stays literal.
    const html = G.tcV6RenderEngineHealthDotMarkup({ status: 'configured', fiveHourRemainingPct: 50 });
    assert.doesNotMatch(html, /title="[^"]*[<>][^"]*"/, 'a title attribute must never carry an unescaped angle bracket');
  });
});

describe('tcV6RenderEngineUsageCardMarkup includes the health dot in its header (#3269 acceptance criterion 1)', () => {
  const G = loadApiHelperGlobals();

  it('an operational engine\'s card shows the green dot before its title', () => {
    const html = G.tcV6RenderEngineUsageCardMarkup('claude', { status: 'configured', fiveHourRemainingPct: 90, weeklyRemainingPct: 90 }, null, {});
    const headerMatch = html.match(/<header class="v6-usage-card-header">([\s\S]*?)<\/header>/);
    assert.ok(headerMatch, 'the card must still have its header');
    assert.match(headerMatch[1], /v6-engine-health-dot/);
    const dotIndex = headerMatch[1].indexOf('v6-engine-health-dot');
    const titleIndex = headerMatch[1].indexOf('v6-usage-card-title');
    assert.ok(dotIndex < titleIndex, 'the health dot must render before the card title, not after');
    assert.match(headerMatch[1], /color: #56d364;/);
  });

  it('an unconfigured engine\'s card shows the gray unknown dot, independent of the existing degraded-note text', () => {
    const html = G.tcV6RenderEngineUsageCardMarkup('codex', { status: 'not-configured' }, null, {});
    assert.match(html, /color: #8b949e;/);
    // The pre-existing degraded note (a DIFFERENT, textual signal — #3209) still renders too;
    // this car adds the dot alongside it, and does not touch that note's own logic.
    assert.match(html, /v6-usage-degraded-note/);
  });
});
