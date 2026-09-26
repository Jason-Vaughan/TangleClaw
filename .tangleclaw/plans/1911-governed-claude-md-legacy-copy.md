# #1911 — Governed CLAUDE.md keeps TangleClaw's legacy whole-file guide beside the managed block

**Status: PR #1917. The Architect rejected it for merge under A22 (three repair-path safety blockers), and the correction is on the same branch. Ruled A7–A10 (Medusa 8869adf0). No live-fleet healing.**
Dispatched by the PM on 2026-09-26 (Medusa d5b2a91a). The dispatch rules out running contributor code
and stops here until the Architect rules. The issue came from an external user (#1911); its body is
analysis only, with no code attached. Archive this plan when #1911 closes.

## Reproduction (B1, current main `c600a7c6`, this checkout's own `lib/`)

A throwaway script ran against a temporary store (`store._setBasePath`) and a temporary project
dir. It touched no live data and no other project.

| Step | Lines | `## Port Management (PortHub)` | `## Shared Documents` | `## Session Memory` | BEGIN markers |
|---|---|---|---|---|---|
| 1. Ungoverned launch (`writeEngineConfig`, whole-file) | 212 | 1 | 1 | 1 | 0 |
| 2. Prawduct onboarded (anchor appended, `prawduct@prawduct` enabled) | 217 | 1 | 1 | 1 | 0 |
| 3. Governed relaunch | **419** | **2** | **2** | **2** | 1 |
| 4. Second governed relaunch | 419 | 2 | 2 | 2 | 1 |

Confirmed: the duplication happens on the first governed write and stays put afterwards, because
the markers make later writes idempotent.

## Root cause (line numbers on `c600a7c6`; the issue's line numbers were taken at `a3155b7c`)

- `lib/engines.js:3350`: `governed = isPluginGoverned(projectPath)`.
- `lib/engines.js:3369-3371`: a governed project gets `_generateOperationalBlock` (`:2459`) in place
  of `_generateClaudeMd` (`:2358`). Both emit the same operational sections: the tc bootstrap,
  plans, re-entry and control-state lines; the PortHub guide; the shared docs and their guide; and
  the session-memory guide.
- `lib/engines.js:3389`: governed projects are forced to `mergeStrategy = 'managed-block'`.
- `lib/engines.js:3416` → `_mergeManagedBlock` (`:231`) → `lib/managed-block.js:134`
  `spliceManagedBlock`. With no markers present, it **appends** the block and treats everything
  already in the file as operator content.
- Nothing on the whole-file → managed-block switch recognises TangleClaw's own earlier output. The
  retire path already does: `lib/engines.js:375` treats a file with `GENERATED_HEADER_MARK` in its
  first 3 lines as TangleClaw-written.

## Constraints the fix must respect

1. **Operators do edit the legacy region.** This repo's own `CLAUDE.md` shows it: the generated
   header was replaced with a project vision, a "This Repo's Exceptions" section was added between
   the rules tiers, and `## Core Rules` was kept. Anything that deletes the whole region above the
   anchor on the strength of the header alone would destroy content like that. The issue asks for
   a "regenerate-and-compare" guard, but it cannot be done byte-exact. The legacy copy is a
   snapshot from an older generator (the guides and global rules have changed since), and TC
   stores no hash of what it last wrote. Whole-file drift is detected by comparing against a fresh
   regeneration (`lib/engines.js:3478-3500`).
2. **The rules tiers are already declared hand-kept on governed projects.** `lib/sessions.js:1735`
   tells every governed launch: "TangleClaw global rules do NOT reach this project by file: …
   Any copy of them in that file is hand-kept and may be stale." Governed projects get their rules
   through the launch prime. So the issue's point 2 is largely answered by current design. What is
   left is only whether TC should *remove* a stale copy it once wrote.
3. **The healed files are committed.** On most affected projects `CLAUDE.md` is tracked. Any fix
   will dirty the working tree at the next launch or boot, and the operator has to commit it.

## Options

**A. Strip the whole legacy region (the issue's suggestion).** The condition: no markers, the
generated header in the first 3 lines, and a `PRAWDUCT:ANCHOR` after it. The action: delete
`[start, anchor)`. This has the smallest diff and gives the cleanest result. It is unsafe under
constraint 1: hand-added sections inside the region are lost, and no reliable test proves the
region is untouched.

**B. Section-scoped dedupe (recommended).** The condition is the same as A. Only the sections that
the managed block now carries are removed from the legacy region:
- the tc bootstrap, plans, re-entry and control-state bullet lines, matched by their exact leading
  text;
- `## Port Management (PortHub)`, `## Shared Documents` and `## Session Memory`, each from its
  heading up to the next heading of the same or higher level, or the anchor.

The pass **refuses and reports** a section it cannot bound cleanly, for example a heading that
appears twice or a section that runs into the anchor with unknown `##` headings inside. Everything
else stays: the rules tiers, any hand-added section, and the anchor. The removed byte count is
logged at warn, the same way as `repaired`. The trade-off: the stale rules snapshot and the
`# CLAUDE.md — Generated by TangleClaw` header stay, and that header then misdescribes a
co-owned file. The rules copy is already labelled hand-kept at launch (constraint 2).

**C. Detect and report only.** Add a warn log and a doctor or `tc` check that counts duplicate TC
headings in governed carriers, and leave the files as they are. This destroys nothing, but it
fixes nothing either: 8 of 12 projects on the reporter's install keep the duplicates until someone
cleans them by hand.

## Architect rulings (2026-09-26, Medusa 8869adf0)

- **A7, approved with a required modification.** Use Option B's section-scoped algorithm as the
  repair. Exact headings and the legacy generated header mark only *candidate* boundaries: they do
  not prove a section body was never edited by an operator. The normal launch and boot path may
  detect and report candidates, but must never delete them. Duplicate headings, ambiguous bounds or
  a malformed anchor are refused, with no partial mutation.
- **A8, approved.** Only during an explicitly approved repair, replace the legacy header with a
  neutral `# CLAUDE.md`, and only when the header is byte-identical to the generated form. An
  altered header stays untouched.
- **A9, approved.** Don't remove the Core, Extension or Global rules copies in #1911. Any cleanup of
  those needs a separate opt-in issue and contract.
- **A10, rejected as proposed.** No automatic fleet mutation on launch, boot or PATCH.
  Automatic read-only detection plus a visible warning is approved. Healing requires an explicit
  operator action with:
  - a preview of the exact removals;
  - a content digest bound to that preview;
  - a compare-and-swap refusal if the file changes;
  - an atomic write.

  A second repair must be a byte-identical no-op, and a refusal changes nothing. No live-fleet
  healing is authorized.

## A22: merge rejected, then corrected (2026-09-26, Medusa c6ab9ee3)

At a5993f55 the Architect rejected the merge on three narrow repair-path blockers. The A7–A10 architecture is otherwise accepted.
1. **Quoting.** `repairCommand` must shellWord-quote every argv word, tested against hostile but legal paths. It now maps `lib/shell-word.js#shellWord` over `node`, the script, the project path and `--apply <digest>`. The test runs the emitted command through `/bin/sh` with a stub `node` that echoes its argv, over paths holding a space, `$HOME`, `$(…)`, a backtick, `"`, `\`, `'`, `;`, a newline and glob characters. Each one reaches the script byte for byte, and nothing executes.
2. **Complete write.** `applyLegacyRepair` must complete all bytes or refuse without replacing the target. `_writeAll` continues through short writes. It throws on a write that makes no progress or fails, and the temp file's fstat size is checked before the rename. Any failure removes the temp file and leaves the target. The tests inject writes through `_setIoForTest`: short writes (7 bytes at a time) land the complete file; a zero-byte write and a mid-write ENOSPC both refuse with the target unchanged and no temp file left.
3. **Symlink carriers.** A symlinked `CLAUDE.md` must be refused, checked with `lstat`, without mutation. `_carrierRefusal` refuses a symlink or non-regular file before reading and again just before the rename, and the CLI preview refuses it too. No target-binding design is proposed.

Mutation checks: reverting each fix turns its tests red.

A cumulative-review follow-up fixed the preview so it no longer always flags PortHub as differing: the old layout's trailing API URL and token lines now count as matching when the block carries them verbatim.

## Design (as built)

**`lib/legacy-claude-md.js`** holds pure analysis plus one guarded writer.
- `analyzeLegacyCarrier(text)` returns `{eligible, reason, refused, header, candidates, digest}`.
  It performs no I/O.
- **Eligibility:**
  - the generated header mark is in the first 3 lines (the file was written by TC);
  - there is exactly one `PRAWDUCT:ANCHOR`;
  - there is exactly one well-formed managed block, and it comes after the anchor.

  A file that fails these checks is either not eligible (`reason`) or refused (`refused`: several
  anchors, an anchor inside or after the block, or malformed markers).
- **The legacy region** is everything from the start of the file up to the anchor. Headings are
  scanned outside fenced code blocks, because the guides' code samples contain lines that start
  with `# `. An unterminated fence counts as ambiguous and refuses.
- **Candidates** are *proven duplicates*. Each one also appears in the file's own managed block:
  - a top-level bullet line byte-identical to a line in the block;
  - a `##` section whose heading line also occurs in the block, bounded by the next `#`/`##`
    heading or the anchor.

  Each section candidate records whether its body is byte-identical to the block's copy, so the
  preview can show what may have been edited. A candidate heading that appears more than once in
  the legacy region refuses. The rules tiers are never candidates (A9), and neither is any heading
  the block lacks.
- **The digest** is `sha256(fileBytes)` combined with the serialized removal plan, so a preview
  binds both the file and the exact removals.
- `applyLegacyRepair(filePath, expectedDigest)`:
  - it reads the file and re-analyzes it, and refuses on a digest mismatch (the file changed after
    the preview, or the plan changed);
  - it builds the repaired text, replacing the header only when it is byte-identical (A8);
  - it writes a temp file in the same directory, fsyncs it, re-reads the target and refuses if the
    target's hash has moved (compare-and-swap), then renames and keeps the file mode;
  - with nothing to repair, it writes nothing. On any refusal, the file is unchanged.

**Detection surfaces, all read-only (A10).**
- `writeEngineConfig`'s governed path runs the analysis on the text it just merged. When there are
  candidates it logs at warn with the preview command, and it never removes anything.
- `_ruleSourcesSection` in `lib/sessions.js` adds a note to a governed launch's context. The note
  names the count and the preview command, so the agent relays it to the operator.

**Operator action: `scripts/repair-governed-claude-md.js <project-path> [--apply <digest>] [--json]`.**
- Without `--apply` it previews the exact removals: each section's line range and byte count,
  whether each body matches the managed copy, and the header change. It prints the digest.
- `--apply <digest>` performs the guarded write.
- It refuses a project that isn't plugin-governed.

## Tests (required by the ruling)
- Detection without mutation: a governed launch over an affected file warns and leaves the file
  byte-identical, apart from the managed block itself.
- The preview/apply digest binding holds, and a changed-after-preview file is refused with nothing
  written.
- An operator-edited section is preserved: a legacy section whose heading is absent from the block
  stays. A section whose body differs is flagged in the preview.
- Ambiguous boundaries refuse: a duplicate candidate heading, an unterminated fence, several
  anchors, or an anchor after the block.
- The neutral header replaces the generated one only when byte-identical, and an altered header is
  kept.
- Idempotence: a second apply is a byte-identical no-op. The rules tiers and everything from the
  anchor on stay byte-identical.

## Out of scope

- Removing the frozen rules tiers (ruling 3).
- Non-`claude-md` carriers: governed projects already skip those.
- Changing `spliceManagedBlock`'s general append behaviour. It is correct for operator files; the
  fix is a governed-only pre-pass.

## Size and risk

Small to medium: one helper, one call site, tests and docs. It crosses a persisted-file contract
(a committed carrier TC co-owns), so it gets a Critic review and a PR through a branch. The main
risk is removing operator text, and B reduces that with exact headings and refuse-on-ambiguity.
