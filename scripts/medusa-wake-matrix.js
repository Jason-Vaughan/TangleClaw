#!/usr/bin/env node
'use strict';

/**
 * Print the Medusa wake monitor's scale matrix (#2086).
 *
 *   node scripts/medusa-wake-matrix.js [--real]
 *
 * Drives the real `lib/medusa-wake.js` tick over a synthetic fleet
 * (`test/helpers/medusa-wake-matrix.js`) at 1, 2, 5, 10, 20 and 30 sessions,
 * and prints what each run cost as Markdown tables. It touches no tmux
 * session, no Hub and no TangleClaw database but a throwaway one.
 *
 * Times are virtual and come from the harness's cost model, so the output is
 * the same on every machine. `--real` adds a run in which each cost really
 * blocks the thread, scaled down tenfold, under a real timer, to show that the
 * virtual numbers describe what the event loop does.
 *
 * Exit: 0 printed · 1 a run broke one of the monitor's invariants.
 */

const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'lib', 'logger')).setLevel('error');
const { useThrowawayStore } = require(path.join(ROOT, 'test', '_engine-store'));

const store = useThrowawayStore('medusa-wake-matrix-script');
const wake = require(path.join(ROOT, 'lib', 'medusa-wake'));
const matrix = require(path.join(ROOT, 'test', 'helpers', 'medusa-wake-matrix'));

/**
 * Seconds, to one decimal place.
 * @param {number|null} ms - Milliseconds
 * @returns {string}
 */
const sec = (ms) => (ms === null ? 'never' : `${(ms / 1000).toFixed(1)} s`);

/**
 * Whole milliseconds.
 * @param {number} ms - Milliseconds
 * @returns {string}
 */
const whole = (ms) => `${Math.round(ms)} ms`;

/**
 * One Markdown table.
 * @param {string[]} head - Column headings
 * @param {string[][]} rows - Rows
 * @returns {string}
 */
function table(head, rows) {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

let broken = 0;

/**
 * Run a cell and count it as broken if the wrong pane was typed into or the
 * eligible recipient was nudged other than once.
 * @param {object} opts - `runCell` options
 * @returns {object} The cell
 */
function cell(opts) {
  const c = matrix.runCell(opts);
  if (c.nudgesToEligible !== 1 || c.nudgesToOthers !== 0) broken += 1;
  return c;
}

/**
 * A row of the standard columns.
 * @param {string} label - First column
 * @param {object} c - A cell
 * @returns {string[]}
 */
const row = (label, c) => [label, String(c.size), whole(c.tickMsMax), whole(c.lagMsMax), String(c.overruns), sec(c.firstAssessmentMs), sec(c.wakeMs), String(c.nudgesToEligible - 1)];

const HEAD = ['Run', 'Sessions', 'Longest tick', 'Latest start', 'Overruns', 'First assessed', 'Woken', 'Duplicates'];
const out = [];

out.push('### Mixed fleet, eligible recipient scanned last\n');
out.push(table(HEAD, matrix.SIZES.map((size) => row('mixed', cell({ size })))));

out.push('\n### Mixed fleet, eligible recipient scanned first\n');
out.push(table(HEAD, matrix.SIZES.map((size) => row('mixed', cell({ size, eligibleAt: 'first' })))));

out.push('\n### Every other session holds mail in a busy or drafting pane\n');
out.push(table(HEAD, matrix.SIZES.flatMap((size) => [
  row('median tmux cost', cell({ size, fillers: ['busy', 'draft'] })),
  row('95th-percentile tmux cost', cell({ size, fillers: ['busy', 'draft'], costs: matrix.P95_COSTS }))
])));

out.push('\n### A pane read that times out (5 s) is scanned first\n');
out.push(table(HEAD, [
  ...[2, 5, 10, 20, 30].map((size) => row('one hung pane', cell({ size, lead: ['slow'] }))),
  row('two hung panes', cell({ size: 30, lead: ['slow', 'slow'], maxTicks: 20 })),
  row('three hung panes', cell({ size: 30, lead: ['slow', 'slow', 'slow'], maxTicks: 20 })),
  row('ten hung panes', cell({ size: 30, lead: new Array(10).fill('slow'), maxTicks: 40 }))
]));

out.push('\n### A scan that throws is scanned first\n');
out.push(table(HEAD, [2, 5, 10, 20, 30].map((size) => row('one throwing scan', cell({ size, lead: ['throwing'] })))));

const restart = matrix.runRestart();
const restartBlind = matrix.runRestart({ durableUnreadable: true });
const left = matrix.runDeparture({ state: 'busy' });
const replaced = matrix.runDeparture({ state: 'busy', replaced: true });
if (restart.duplicates !== 0 || left.nudgedDeparted !== 0 || replaced.nudgedDeparted !== 0 || replaced.nudgedReplacement !== 1) broken += 1;

out.push('\n### Restart and departure\n');
out.push(table(['Run', 'Result'], [
  ['Restart after the nudge, durable attempt record readable', `${restart.duplicates} duplicate nudges`],
  ['Restart after the nudge, durable attempt record unreadable', `${restartBlind.duplicates} duplicate nudge(s)`],
  ['Busy recipient leaves the roster with mail deferred', `nudged ${left.nudgedDeparted} times; its last ledger row stays \`${left.ledgerAfter[left.ledgerAfter.length - 1].split('|').slice(1).join(' ')}\` and nothing supersedes it`],
  ['Same, and a replacement session of the project joins', `replacement nudged ${replaced.nudgedReplacement} time; the departed session's \`skipped\` row remains`]
]));

/**
 * One run under a real timer with costs that really block the thread, at a
 * tenth of their size.
 * @param {string} label - Row label
 * @param {object} fleetOpts - `buildFleet` options
 * @returns {Promise<string[]>} A table row
 */
function realRun(label, fleetOpts) {
  const SCALE = 10;
  const intervalMs = matrix.INTERVAL_MS / SCALE;
  const fleet = matrix.buildFleet(fleetOpts);
  const world = matrix.install(fleet, { realScale: SCALE, clock: wake._internal.clock });
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  wake.start({ intervalMs });
  return new Promise((resolve) => {
    setTimeout(() => {
      loop.disable();
      const snap = wake.tickMetrics();
      world.restore();
      resolve([
        label, String(fleet.length), String(snap.passes),
        whole(snap.window.durationMs.max * SCALE), whole(snap.window.lagMs.max * SCALE), String(snap.overruns),
        whole((loop.max / 1e6) * SCALE)
      ]);
    }, intervalMs * 6.5);
  });
}

/**
 * Print everything, with the real-timer runs when asked for.
 * @returns {Promise<void>}
 */
async function main() {
  if (process.argv.includes('--real')) {
    const rows = [];
    rows.push(await realRun('mixed', { size: 30 }));
    rows.push(await realRun('every other session holds mail', { size: 30, fillers: ['busy', 'draft'] }));
    rows.push(await realRun('one hung pane first', { size: 30, lead: ['slow'] }));
    out.push('\n### Real timer, real blocking, scaled back up tenfold\n');
    out.push(table(['Run', 'Sessions', 'Ticks', 'Longest tick', 'Latest start', 'Overruns', 'Longest event-loop stall'], rows));
  }
  process.stdout.write(`${out.join('\n')}\n`);
  store.cleanup();
  process.exitCode = broken === 0 ? 0 : 1;
}

main();
