# Plan — #768: the Master drawer header becomes a real control bar

**Status:** chunks 1 and 2 SHIPPED. Chunk 3 (Master Kill) optional and unstarted. **Milestone:** Master Control (#829).
**Predecessor:** #756 shipped in v5.5.0 (the Master's launch mode) — its picker is one of the two
mode controls this bar surfaces.
**Shared artifact:** published alongside this file; keep both updated together.

## Where this sits

#829 is the tracking issue for "the first train car after v5". It slipped v5.1–v5.4 because train
rosters were assembled from a severity ranking of open issues instead of from the milestone. #756
closed the launch-mode half. This is the surface half.

## The headline, in one sentence

**From inside a session there is no route to the Master's settings at all.** `masterSettingsModal`
lives only in `public/index.html`; `grep -c masterSettingsModal public/session.html` is `0`. To see
or change the single most consequential fact about the Master — what it is allowed to do — the
operator must leave the session, go to the dashboard, open the Master panel, and click the gear.

## The constraint that shapes everything

**Reuse, don't fork.** Operator requirement on #768: the bar must be built from the *same* code as
the session controls, so the project does not end up maintaining two Upload buttons and two Medusa
controls.

The obstacle is structural, not cosmetic. The session controls are **singleton-ID DOM driven by
module-global scope**, not components:

- `public/session.js:7` — `const projectName` is derived from the page URL and is module-global.
  Every control reads it implicitly.
- Upload addresses `#uploadFile`, `#uploadPreview`, `#uploadModal`, `#uploadHistory`,
  `#uploadSubmitBtn` — fixed ids — and `openUploadModal()` fetches `/api/uploads?project=${projectName}`.
- Medusa renders into `#medusaControl`, `#medusaHeads`, `#medusaBadge`, `#medusaPanel`,
  `#medusaLoopsPanel`, driven by the single `sessionState.medusa` object.

**The drawer lives on the same page as the host session's banner.** A second copy of either control
collides on every one of those ids and on the global project name.

So reuse means **parameterising by target**: each control takes a descriptor —
`{kind: 'session' | 'master', project, sessionId}` — plus a root element to render into, and the
existing call sites pass the host session's descriptor unchanged. `public/api-helper.js` is the
established home (it already holds `tcWireTerminalDragCopy`, `tcCopyToClipboard`,
`tcCreateUpdateBeacon`'s siblings, and is loaded by both pages).

**The same bar must serve the landing Master panel** (`#masterPanel`, `public/index.html:87`), not
the drawer alone — otherwise the second copy this constraint exists to prevent grows anyway.

## Control inventory — verified against the tree at v5.5.0

| Control | Frontend | Backend | Verdict |
|---|---|---|---|
| Gear → settings | modal exists, `public/ui.js:3477-3790` | none needed | **Build.** Needs the modal extracted to a shared component. |
| Launch mode | picker shipped in #756 | `PATCH /api/config { master.launchMode }` | **Build.** |
| Access level | radios exist, `public/ui.js:3504` | `suggest`/`write` rejected server-side | **Blocked on #755.** |
| Upload | modal reusable | ❌ no route — `/api/upload*` resolves via `projects.getProject`, and the Master is not a registered project | Absent, honest reason. |
| Medusa | control reusable | ❌ no route — every endpoint is `/api/sessions/:project/medusa/*` | Absent, honest reason. Gated on Q3. |
| Kill | button reusable | ❌ no endpoint — Master API is `status`, `ensure`, `rules/restore-defaults`; `lib/master.js:581` says "no kill/adopt semantics in v1" | Absent, honest reason. |
| Wrap | button reusable | ❌ and undefined — see Q1 | Do not build. |

**Rule for this bar (from #755 and #741):** a control with no backend is **visibly absent with an
honest reason**, never present-and-inert.

## Chunks

### 1. Extract the Master settings modal into a shared component — ✅ DONE 2026-08-16
Built on `feat/768-master-settings-component` (worktree `.claude/worktrees/768-chunk01`).
Landed as `tcCreateMasterSettings(deps)` + `tcMasterSettingsMarkup()` in `public/api-helper.js`;
`ui.js` and `session.js` both construct and `mount()` it, and `index.html` no longer declares the
modal. Suite green (the count lives in CHANGELOG.md and the evidence store; copying it here only
creates a second number to drift). One deviation worth recording: the plan said "the existing
suites pass untouched", and three source-pinned suites could not — they pin the FILE a function
lives in, so a move breaks them by construction. They were re-pointed with every assertion
unchanged, which is the honest version of that criterion; new guards cover what the move itself
could break, each mutation-checked red first.

The load-bearing chunk. `openMasterSettings` → `saveMasterSettings` spans ~300 lines of
`public/ui.js`, including the whole Hard-rules editor (add / toggle / delete / restore, with its
confirm flows), plus modal markup in `index.html` only.

Move it to `public/api-helper.js` as a mountable component both pages can open. Keep
`renderMasterSettingsBody` behaviourally identical — `test/master-launch-mode.test.js` already
lifts and runs it, so that suite is the regression net for the move.

**Done when:** the dashboard behaves exactly as before, and the same component mounts on the
session page; no markup is duplicated; the existing suites pass untouched.

### 2. The control bar itself — ✅ DONE 2026-08-17 (branch `feat/768-control-bar`)

**Carried in from chunk 1's Critic review — do this IN chunk 2, it is not optional there.**
`public/style.css` and `public/session.css` are independent files (no `@import`), and chunk 1 moved
the modal's MARKUP into the shared component without its STYLES. `session.css` has none of
`master-access-grid`, `master-access-option`, `master-rules-section`, `session-rule-item`,
`master-rule-version` or `rules-status`. The modal therefore renders unstyled on the session page —
invisible today only because nothing opens it. Chunk 2's Done-when is "the settings open from
inside a session", so chunk 2 is exactly where that becomes a visible defect, at the mobile widths
`project-preferences.md` makes load-bearing. Either move the shared classes into a file both pages
load, or duplicate them into `session.css` with a test pinning parity. `boundary-patterns.md`'s
Shared Frontend Module Contract now carries the general rule (point 4).

A target-parameterised bar rendered into **both** the drawer header
(`public/session.html:172-180`) and the landing Master panel. Carries: status dot + text (existing),
gear, launch-mode control. Absent controls rendered with their reason.

**Done when:** the Master's settings open from inside a session; both surfaces render from one
implementation, proven by a test that changing the component changes both; no id collides with the
host session's controls; and **a failed open is visible on the session page** — chunk 1 mounts the
component with an `onOpenError` that only reaches the console, which is honest but invisible, so
the bar must own a status line and pass a handler that paints it. Without that, a Master whose
status fetch fails looks to the operator exactly like a gear that does nothing.

### 2b. RATIFIED 2026-08-17 — the confirmed chunk-2 design

Operator reviewed a rendered mockup and confirmed. Supersedes the sketch above where they differ.

**The bar is the session banner's control set, reused.** Not a status row. Order:
`status dot · title · model pill · Medusa │ spacer │ READ/WRITE · Upload · gear · Wrap · Kill`.

**Dropped from the session set:** Select, Cmd, Peek (terminal-local); Run Critic; Shared docs (the
Master reads every shared doc by default).

**Run Critic is never in the Master, and the reason is structural, not taste.** `invoke-critic`
dispatches `/critic` into a project's tmux session and reads that project's `.critic-findings.json`.
The Master has no checkout, so there is nothing to review — the same root reason Wrap is *undecided*
rather than merely unbuilt. A "run the Critic in project X" capability is a different feature
(fleet command, Medusa-shaped addressing), not this bar. Tracked: #961.

**Only the gear and the model pill have backends.** Everything else ships **dim, disabled, and
carrying its own reason** — the operator chose placeholders over growing the bar, so the layout is
decided once and each control lights up as its route lands. Reasons live in ONE table in the
component so the two surfaces cannot drift.

**Model pill mirrors the session's `#bannerEngine`** — status dot AND whole-pill tint for
non-operational states, so it survives a glance rather than resting on one small dot.

**READ/WRITE is GLOBAL — there is exactly one Master.** `MASTER_TMUX_SESSION` is a single reserved
tmux session and every session drawer attaches the same iframe to it, so flipping from any bar
changes the Master for everyone. The warning must say so (§2b's blast-radius wording is right and
scope-silent), other open bars must repaint from the polled Master state rather than from a local
click, and the toggle therefore reflects server state, never optimistic intent. Ratified 2026-08-17;
full spec on #755.

**On non-Claude engines the toggle still works, and the bar shows the enforcement tier.** Read-only
is already unenforced there (no PreToolUse hook — instructional only), so disabling the toggle would
prevent nothing while implying a binding boundary. The bar inherits the modal's existing
`master-enforcement-badge` vocabulary; today it shows nothing, so a Gemini Master and a Claude Master
look identical, which is a gap that predates this work.

**Defaults READ, persists, warns on the way IN only —
returning to read-only is always the safe direction, and warning there trains the operator to click
through. Blocked on #755 until then.

**SHIPPED 2026-08-17 in #755 chunk 3, and the wording is settled.** The warning names the GLOBAL
scope, which the blast-radius sentence above did not: it was right about reach ("modify files across
every project it can reach") and silent about there being exactly one Master — the half an operator
flipping from inside a session drawer would guess wrong. It also reads WHEN the change binds from the
server's `levelAppliesAt` rather than promising immediacy an instructional master cannot deliver, and
it fires on `suggest` → `write` too, because what makes a move dangerous is the destination. The
toggle paints only from server state, re-fetches before every flip, and the bar carries the
enforcement badge. `suggest` renders as a readout rather than a third segment — the two-segment
design here is what that decision preserves.

**Continuity is a two-layer contract, and the split is the load-bearing decision.**
- *Look — shared NOW.* The Master's controls reuse the SESSION'S OWN CSS classes (`.banner-btn`,
  `.medusa-control`, the engine pill), never new ones. Restyle once, both surfaces move, dim
  placeholders included. This is what the operator asked for and it is free.
- *Behaviour — shared WHEN each backend lands.* One implementation serving both means
  parameterising by target (`{kind, project, sessionId}` + a root) and having the session banner
  adopt the shared version too. Wasted effort while the Master has no route.

**The trap this encodes.** The dim placeholder is exactly where a fork sneaks in, because a
placeholder feels too small to be an architecture decision. A hand-rolled Medusa that merely *looks*
like the session's is identical on day one and drifted by the third restyle. The split above is safe
ONLY because the placeholder is inert: the moment a control goes live on the Master it must be the
extracted component, not a copy sharing a stylesheet.

**Also required here (carried from chunk 1's review):** the CSS parity port — DONE, commit
`a654af0`, with `test/master-settings-css-parity.test.js` deriving the class list from the
component's own markup. The plan named six classes; the component emitted 23 that `session.css`
lacked.

### Carried into chunk 3 — deferred deliberately, not dropped

Both came out of chunk 2's cumulative review (`rev-20260817T015148Z-d42d6848`) and were accepted
there rather than fixed, because each would have enlarged an already-large diff mid-review.

- **Mobile density, touch targets, and the collapse rule — decide them TOGETHER (R-20, Q4).** Q4
  deferred the collapse rule on the premise "the bar ships with two controls". It ships with nine
  laid-out children, so that premise is gone. The bar's controls are ~30px against the 44px minimum,
  which `project-preferences.md` treats as load-bearing and which the banner-scoped exception does
  not cover — the bar renders in a drawer and a panel, not a banner. `flex-wrap: wrap` is in place as
  a floor, not an answer. Do not fix touch targets alone: raising heights without the collapse rule
  makes a nine-control bar taller on the smallest screen, which is the wrong direction.

- **Consolidate the settings-modal CSS into `shared-controls.css` (R-7).** Chunk 2 ported those
  classes into `session.css` one commit BEFORE creating a sheet both pages load — correct at the
  time, superseded an hour later. The coherent end state is one definition in the shared sheet, which
  is what the amended boundary contract (point 5) now asks for. `test/master-settings-css-parity.test.js`
  guards symmetry today; when the classes move, that guard should follow them to ownership.

### 3. (Optional, only if 1–2 land clean) Master Kill
The smallest of the three missing backends and the one #768 recommends first: `POST /api/master/kill`
plus the button. **Wrap stays unbuilt** until Q1 is answered.

## Open questions — the operator's, and they gate the rest

1. **What does "Wrap" mean for the Master?** Wrap is a git pipeline — changelog promotion, version
   bump, wrap commit, auto-branch. The Master has no checkout; `~/.tangleclaw/master/` is a data
   directory. Plausibly it is a memory consolidation (`MEMORY.md` / `NOTES.md`) and nothing else.
   Shipping a button that looks like session Wrap and does something materially different is the
   failure mode. **#768's own recommendation: ship Kill first, defer Wrap.**
2. **Where do Master uploads land?** `~/.tangleclaw/master/.uploads/` is the obvious answer, but it
   means `lib/uploads.js` takes a path rather than a project record, and the upload secret scanner
   (#343) has to follow it there.
3. **Should the Master be a Medusa participant at all?** It is a fleet-wide observer; giving it a
   workspace id makes it addressable by every project session. Whether that is the best feature in
   this list or a governance hole depends on how #755 lands — a `write`-level Master that any
   session can send instructions to is a different risk profile from a read-only one. **If Medusa
   ships before #755, it must be read-side only.**
4. **Mobile density** (deferred with a reason, not guessed): six controls plus a status dot is
   comfortable at desktop width and is not at phone width. The bar ships with two controls, so the
   collapse rule is owed when Upload/Medusa/Kill land, not now.

## Standing constraints for whoever picks this up

- **`public/` is served live off the primary checkout.** Do this in a git worktree
  (`git worktree add .claude/worktrees/<name> <branch>`), symlink every `.prawduct/*` entry except
  the tracked `change-log.md`, plus `.tangleclaw/plans`. Keep the primary on `main`.
- **Never bump `CACHE_NAME` in `public/sw.js`.** A new shared module goes in
  `NETWORK_FIRST_PATHS` *and* `STATIC_ASSETS` (see the #941 precedent); a bump tears down every
  browser's worker and, behind the basic_auth gate, produced the repeating credential prompt in
  #710.
- **Engine-agnostic bar.** Nothing in it may depend on a capability only one engine has;
  per-engine differences (launch modes) degrade visibly.
- **Mutate every guard, and check the fixture reaches the subject first.** Three vacuous guards
  slipped through in one train on 2026-08-15.

## Related

#829 (tracking) · #755 (access level) · #756 (shipped) · #596 (launch-mode picker) ·
#331 (shipped the drawer and panel) · #343 (upload secret scanner) · #333 (Medusa transport) ·
`docs/adr/0008-project-master-session-model.md`
