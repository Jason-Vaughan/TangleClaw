'use strict';

/**
 * v6 (#3261, V6-006, Car V662-W1-B): the Peek Under the Hood traffic
 * filter's canonical, standalone implementation — a documented reference
 * and regression target for `public/v6-shell.js`'s own in-place
 * `filterPeekTrafficLines`.
 *
 * NOT YET WIRED INTO THE LIVE PAGE: `public/v6-shell.js` keeps its own
 * copy of this logic (fixed identically, in the same PR) rather than
 * calling into this file at runtime, because doing that safely needs two
 * things outside this car's file envelope: (1) a `<script>` tag for this
 * file in `public/index.html`, loaded before `v6-shell.js`, and (2)
 * `test/v6-b1-ui-shell.test.js`'s sandbox loader (`loadV6Shell()`) would
 * need to load this file into the same `vm` context first, or every
 * existing test that exercises the traffic filter through `v6-shell.js`
 * (directly or via `render()`) starts failing with "not a function" —
 * that test file is a sibling car's, out of this car's scope to edit.
 * A future car that owns both of those files can wire this module in and
 * delete `v6-shell.js`'s copy; until then, keep both in sync by hand (this
 * file's own test suite pins the exact behavior both must share).
 *
 * This module exists now, pre-wired, because the dispatch's file list
 * named it and its own content IS where the audited, fixed logic belongs
 * going forward — not because it does anything live yet.
 *
 * @module public/v6-uth-filter
 */

(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    factory(global);
  }
})(typeof window !== 'undefined' ? window : globalThis, function (attachTo) {
  /**
   * A switchboard wake or TangleClaw notice (#3076). It reaches the pane as
   * a typed prompt, so without this it reads as the operator speaking; it
   * belongs Under the Hood, never in the conversation.
   */
  const SWITCHBOARD_TEXT = /^\[TangleClaw( Switchboard)?\]/;

  /**
   * The notices TangleClaw types into a pane (#3076), each slot it fills in
   * marked by the kind of text it takes: `#` a count, `@` an address (an
   * origin, a switchboard path), `%` a wake-ref id, `~` a project's own
   * reply guidance, which replaces the default reply step. Kept in exact
   * sync with `public/v6-shell.js`'s own `NOTICE_TEMPLATES` — a change to
   * one without the other reintroduces the drift this module exists to
   * eventually close.
   */
  const NOTICE_TEMPLATES = Object.freeze([
    '[TangleClaw Switchboard] You have # unread Medusa message(s): tc message read. Reply where an answer is needed, BEFORE marking it handled: ~. The initiator closes the exchange, so no answer leaves them blocked; tc message owed lists what you owe. Never use /clear as an acknowledgement. Without tc: API at @ GET /messages; POST /send (inReplyTo) and /read need launch headers.',
    '[TangleClaw Switchboard] You have # unread Medusa message(s). Fetch them from the TangleClaw API at @ GET @ — act on them as appropriate. Reply to each one that needs an answer BEFORE marking it handled: POST @ {"to":"<sender-workspace-id>","message":"<reply>","inReplyTo":"<message-id>"}; then mark it handled: POST @ {"ids":[...]}. Both POSTs need the headers x-tangleclaw-role: master and x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID. The initiator closes the exchange, so a message you do not answer leaves them blocked. Never use /clear as an acknowledgement.',
    '[TangleClaw Switchboard] You have # unread Medusa message(s). Fetch them from the TangleClaw API at @ GET @ — act on them as appropriate. Sending is disabled at your current access level: for one that needs an answer, describe the exact reply for the operator to send, rather than attempting to send it yourself. Mark it handled once dealt with: POST @ {"ids":[...]}, which needs the headers x-tangleclaw-role: master and x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID. Never use /clear as an acknowledgement.',
    '[TangleClaw] Your workload report has expired, so coordinators now read this lane as UNKNOWN. Report what you are doing with `tc workload set <working|waiting-external|blocked|complete> --clearance <safe-to-clear|do-not-clear|unknown> --summary "<one line>"`. This is a reminder, sent once for this report; it changes nothing about your task.'
  ].flatMap((t) => [`${t} (wake ref %)`, t]).map(compileNotice));

  /**
   * What each slot kind in {@link NOTICE_TEMPLATES} takes, and how much of
   * it at most, whitespace removed.
   */
  const NOTICE_SLOTS = Object.freeze({
    '#': { re: /[0-9]/, max: 12 },
    '@': { re: /./, max: 1000 },
    '%': { re: /[0-9a-f]/, max: 32 },
    '~': { re: /./, max: 2000 }
  });

  /**
   * A notice template as alternating literal parts and slot kinds, whitespace removed.
   * @param {string} template
   * @returns {{parts: string[], slots: string[]}}
   */
  function compileNotice(template) {
    const flat = template.replace(/\s+/g, '');
    const parts = flat.split(/[#@%~]/);
    const slots = (flat.match(/[#@%~]/g) || []);
    return { parts, slots };
  }

  /**
   * Whether some text is the start of one of {@link NOTICE_TEMPLATES}, all
   * whitespace removed, each slot taking only its own kind of text. A small
   * automaton walks the text: a state is a position in a literal part, or a
   * count of characters taken by the slot after it. Kept byte-for-byte
   * identical to `public/v6-shell.js`'s own `fitsNotice` — including the
   * pruning step below, without which an open-ended `@`/`~` slot (`re:
   * /./`, matching ANY character) would keep "fitting" for up to that
   * slot's own `max` characters past where the template's literal text
   * actually ends, letting {@link filterPeekTrafficLines} clip whatever
   * legitimate line comes right after a real notice.
   * @param {string} text
   * @returns {boolean}
   */
  function fitsNotice(text) {
    const flat = String(text).replace(/\s+/g, '');
    return NOTICE_TEMPLATES.some(({ parts, slots }) => {
      // [part, offset in it, characters taken by the slot after it]
      let states = [[0, 0, 0]];
      for (const ch of flat) {
        const next = new Map();
        const add = (st) => next.set(st.join(','), st);
        for (const [part, off, taken] of states) {
          const lit = parts[part];
          if (off < lit.length) {
            if (lit[off] === ch) add([part, off + 1, 0]);
            continue;
          }
          if (part === parts.length - 1) continue; // the notice is over
          const slot = NOTICE_SLOTS[slots[part]];
          if (taken < slot.max && slot.re.test(ch)) add([part, off, taken + 1]);
          if (parts[part + 1][0] === ch) add([part + 1, 1, 0]);
        }
        states = [...next.values()];
        if (!states.length) return false;
        // Once the text is well into what follows a slot, the slot is over:
        // a free slot must not swallow the rest of the notice, and what
        // comes after it, by also matching it as slot text.
        const settled = states.reduce((most, [part, off]) => Math.max(most, off >= 10 || off === parts[part].length ? part : part - 1), -1);
        states = states.filter(([part, off]) => !(off === parts[part].length && part < settled));
      }
      return true;
    });
  }

  /**
   * A `tc message` command the operator typed or the pane echoed: read,
   * send, ack or owed — the ones the switchboard protocol asks a session to
   * run on every wake, which read as noise once "Hide Medusa & fleet
   * chatter" is on.
   */
  const TC_MESSAGE_COMMAND_RE = /^\$?\s*tc message (read|send|ack|owed)\b/i;

  /**
   * A Medusa switchboard receipt line: what `tc message send`/`read`/`ack`
   * themselves print back, as opposed to the wake notice a project
   * receives (that is {@link SWITCHBOARD_TEXT}, filtered separately).
   */
  const MEDUSA_RECEIPT_RE = /^Message to .+: received\. Exchange mx_|^Reported \d+ message id\(s\) handled|^Your switchboard inbox is empty|^\d+ message\(s\) in your inbox:|^Reading does NOT mark these handled\b/i;

  /**
   * Drop Medusa/fleet traffic from Under the Hood's raw output, for "Hide
   * Medusa & fleet chatter": a switchboard wake notice and every wrapped
   * continuation line of it, a `tc message` command, and a Medusa receipt
   * line. Pure.
   *
   * #3261 audit fix: a real terminal hard-wraps wherever the pane's width
   * falls, words included, with NO guaranteed leading whitespace on the
   * continuation row — {@link fitsNotice} itself compares with all
   * whitespace stripped for exactly this reason. An earlier version of
   * this function (and of `v6-shell.js`'s own in-place copy, fixed
   * identically in the same PR) only offered a line to `fitsNotice` when
   * it was indented, so a plain unindented continuation — the common case
   * — was never recognized: only a wake notice's first line was ever
   * filtered, and every wrapped continuation leaked straight through, or
   * clipped whatever legitimate line came right after it once the running
   * match broke. Fixed by always attempting to extend the match; the
   * pruning step inside {@link fitsNotice} is what keeps an open-ended
   * slot from also swallowing the genuinely unrelated line right after a
   * notice ends.
   * @param {string[]|null} lines
   * @param {boolean} hideTraffic
   * @returns {string[]}
   */
  function filterPeekTrafficLines(lines, hideTraffic) {
    const list = Array.isArray(lines) ? lines : [];
    if (!hideTraffic) return list;
    const out = [];
    let wakeSoFar = null;
    list.forEach((raw) => {
      const text = String(raw);
      const trimmed = text.trim();
      if (wakeSoFar !== null) {
        const joined = `${wakeSoFar} ${trimmed}`;
        if (fitsNotice(joined)) { wakeSoFar = joined; return; }
        wakeSoFar = null;
      }
      if (SWITCHBOARD_TEXT.test(trimmed)) { wakeSoFar = trimmed; return; }
      if (TC_MESSAGE_COMMAND_RE.test(trimmed) || MEDUSA_RECEIPT_RE.test(trimmed)) return;
      out.push(raw);
    });
    return out;
  }

  const exported = {
    SWITCHBOARD_TEXT, NOTICE_TEMPLATES, NOTICE_SLOTS, TC_MESSAGE_COMMAND_RE, MEDUSA_RECEIPT_RE,
    compileNotice, fitsNotice, filterPeekTrafficLines
  };
  if (attachTo) attachTo.tcV6UthFilter = exported;
  return exported;
});
