# Changelog fragments

How a change records its changelog entry without touching `CHANGELOG.md`.

> The wrap asks for a fragment and accepts one ("How a wrap produces one"
> below), and a wrap that cuts a release compiles every fragment into
> `[Unreleased]` and deletes it in the same commit ("When compilation happens"
> below). This page documents the contract the module `lib/changelog-fragments.js`
> enforces and what the wrap does with it.

## Why

Every pull request that adds a line under `## [Unreleased]` edits the same few
lines of one file, so two branches that each add an entry conflict there and
have to be landed one at a time. A **fragment** is one entry in its own file,
named for the issue it records and the Keep a Changelog subsection it belongs
under. Parallel branches never touch the same file. At release preparation the
fragments are compiled into `[Unreleased]` and deleted, and `CHANGELOG.md`
reads exactly as if the entries had been written there by hand.

## The file

```
changelog.d/<issue>.<slug>.<type>.md
```

| Part | Rule |
|---|---|
| `<issue>` | The GitHub issue number: a positive integer, no leading zero. One name per issue. |
| `<slug>` | 1 to 48 of `a-z`, `0-9`, `-`. Distinguishes several fragments for one issue; it is not published. |
| `<type>` | One of the seven below. It names the subsection the entry lands under. |
| `.md` | Always. |

The directory is `changelog.d/` at the project root, and nothing else is read
from it or written to it. Git does not track an empty directory, so when the
last fragment is consumed the directory disappears, and that is the normal
"nothing pending" state: no `README`, no `.gitkeep`. Any file in the
directory that is not a fragment is a refusal (below), and the release
preparation fails closed on it rather than guessing.

## The seven types and the bump they imply

Types are listed in the order their subsections appear, which is also the
order the compiler writes them.

| Type | Subsection | Release bump |
|---|---|---|
| `added` | `### Added` | minor |
| `changed` | `### Changed` | minor |
| `removed` | `### Removed` | minor |
| `deprecated` | `### Deprecated` | minor |
| `fixed` | `### Fixed` | patch |
| `security` | `### Security` | patch |
| `internal` | `### Internal` | patch |

The bump is not decided by this module. `lib/wrap-steps/version-bump.js`
decides it on the compiled `[Unreleased]` text with the same rule it applies
to hand-written entries: a `BREAKING:` or `BREAKING(` marker anywhere in the
block is major, any minor-tier subsection present is minor, otherwise patch.
A fragment whose body carries `BREAKING:` therefore forces a major release
whatever its type. `docs/release-process.md` has the rule in full.

## The body

The file holds **one Markdown list entry**: the first non-blank line starts
with `- ` or `* ` followed by text, and continuation lines or sub-bullets may
follow. Only that first line is checked to be a list item; what follows is
published as written, so a second column-0 bullet lands as a second entry
under the same heading, and unindented prose lands as prose. Write one entry.

```markdown
- Per-car changelog fragments: an entry lives in `changelog.d/` until the
  release compiles it, so parallel branches stop conflicting on `CHANGELOG.md`
  (#1220).
```

The body is published as written, with CRLF line endings normalized, leading
blank lines and trailing whitespace dropped, and one trailing newline. Write
the entry as it should read under its heading, issue reference included.

Not allowed in a body: a heading line (`# ` to `###### `) or a fenced code
block opener (```` ``` ```` or `~~~`). Both would break the subsection
structure that `CHANGELOG.md`'s own tests enforce.

## Ordering

Compiled entries are sorted by issue number, then by slug, then by type, and
the order of the filesystem never reaches the output: two checkouts with the same
fragments compile the same bytes. Inside `[Unreleased]`, entries are appended
after the existing entries of their subsection when that subsection already
exists, and a missing subsection is added at its place in the order above.
Entries written directly into `[Unreleased]` stay exactly where they are.
Nothing is deduplicated: a fragment and a direct entry that say the same
thing are two entries, and the reviewer's job.

## Refusals

A read of `changelog.d/` either accepts every file or refuses, naming each
offender with a code. One refused file fails the whole read; the release
preparation stops and reports the list, and nothing is compiled or deleted.

| Code | What it means to the contributor |
|---|---|
| `MALFORMED_NAME` | The name is not `<issue>.<slug>.<type>.md`, or carries a path separator. Stray files (`README.md`, `.DS_Store`) land here. |
| `BAD_ISSUE` | The issue part is not a positive integer without a leading zero. |
| `BAD_SLUG` | The slug is outside `[a-z0-9-]{1,48}`. |
| `UNKNOWN_TYPE` | The type is not one of the seven, exactly as spelled (lowercase). |
| `NOT_A_FILE` | The entry is a directory or another non-regular file. |
| `SYMLINK` | The entry, or `changelog.d/` itself, is a symbolic link. Fragments are real files. |
| `PATH_ESCAPE` | The entry's real path resolves outside `changelog.d/`. |
| `NOT_A_DIRECTORY` | `changelog.d/` exists but is not a directory, or the root handed in is not one. A missing `changelog.d/` is not a refusal. |
| `EMPTY_BODY` | The file is empty or whitespace only. |
| `BAD_BODY` | A heading line, a fence opener, or a first line that is not a list item. The reason names the line. |

## How a wrap produces one

The wrap's `changelog-update` step (`lib/wrap-default-pipeline.js`) asks the
session's AI to write one fragment per issue worked, named by the grammar
above, and to leave `CHANGELOG.md` alone. Its verification then passes by any
of these, judged by `lib/wrap-steps/changelog-coverage.js`:

- a correctly named fragment was created, rewritten or removed directly under
  `changelog.d/` during the step (the step declares the directory as a produced
  path, and the wrap reads it as a digest of the entries the contract names, so
  a new fragment is a change the same way an edit to `CHANGELOG.md` is, while a
  misnamed file written there is not the step's output and reads as no change);
- a correctly named fragment is uncommitted in the working tree, or a commit
  in the session's range added one: the changelog was maintained as the
  session worked, and the step has nothing to add;
- `CHANGELOG.md` was edited by the same routes, for the transition
  (`docs/release-process.md` names the boundary).

Only the **name** is judged here, by `parseFragmentName`. A file under
`changelog.d/` that is not a fragment (`README.md`, `0.x.added.md`,
`1220.x.docs.md`, anything nested) satisfies nothing, and a dirty one is
reported as *unlogged work* with its path whatever its basename, so the name
gets fixed before it is committed. The body is read at release preparation,
which refuses a bad one as the table above says. The gate deliberately declares
no coverage glob for the directory: a glob would accept any `.md` there,
misnamed ones included.

## What the module never touches

`lib/changelog-fragments.js` has no write path. Compilation returns new text
for the caller to stage; splicing is a pure function. Its one read path is
`<root>/changelog.d`, so `.prawduct/change-log.md`, the project's own change
log under ADR 0011, is never read and never written by it. Everything outside
the `[Unreleased]` block, released sections included, is returned byte for
byte.

## When compilation happens

At release preparation, inside the wrap's version bump
(`lib/wrap-steps/version-bump.js`), as one transaction with the bump: the
fragments are read, spliced into `[Unreleased]` in memory, the bump level is
decided on the result, the file is promoted, and each consumed fragment is
staged for deletion beside the promoted `CHANGELOG.md`. The `commit` step
writes and unlinks them in one flush and commits them in one commit, whose
body says `Compiled N changelog fragment(s)`. A pull request does not run the
compiler; it adds a fragment and leaves `CHANGELOG.md` alone.

A pending fragment counts as an entry everywhere the wrap asks whether there
is anything to release: the readiness gate's `unreleased-entries` signal
passes on fragments alone, and the `release-recommendation` prompt is sent
when fragments wait under an empty `[Unreleased]`. A hold stages nothing and
deletes nothing, so the fragments wait for the next wrap.

Any refused file stops the cut. `version-bump` halts with `needs-operator`,
naming every file and its code, and nothing is promoted or deleted; a skip
would promote the block without the refused fragment and publish it under the
wrong release later. Fix or remove the file, then Retry. The same halt
covers a stray file: the directory holds fragments and nothing else.

**If the wrap stops after the fragments were consumed**, nothing is
committed and the cut is put back. Before it flushes a release cut, the
`commit` step records every release file's prior bytes (the promoted
`CHANGELOG.md`, the version file and each fragment, an untracked one included)
and their index entries, in memory and under
`.tangleclaw/release-recovery/<run id>/` in the project's TangleClaw config
root. Any halt between the flush and a landed commit restores the work tree
from that record, and the index entries of those files once `git add` ran;
the record is then removed. A `git commit` stopped by its timeout is the one
halt that restores nothing, because the commit may still land: check
`git log -1` first. While a record exists, which it does only when something
could not be put back, `version-bump` refuses every cut, naming it, so a
retry can neither compile a fragment twice nor skip one; its `manifest.json`
names each file's path and index entry, and copying them back and deleting the
directory is the recovery. `docs/release-process.md` "If a release did not go
out" has the steps. The directory ignores itself (a `.gitignore` holding `*`),
so a wrap never commits it.

This repo's `releasePrepareCommand`, `scripts/release-prepare.js`, refuses to
run while `changelog.d/` still holds a valid fragment: it runs after the flush,
so on a correct cut the directory is already empty, and a fragment still there
is one the cut did not compile.

## The module's exports

| Export | What it does |
|---|---|
| `FRAGMENT_DIR`, `TYPES`, `NAME_RE` | The directory name, the seven types in subsection order, the closed name grammar. |
| `parseFragmentName(basename)` | `{ok, issue, slug, type}` or `{ok: false, code, reason}`. |
| `readFragments(root, {fs})` | Enumerates and validates `<root>/changelog.d`; `{ok, fragments, refused, dirMissing}`. `fs` overrides are for tests. |
| `compileFragments(fragments)` | Groups accepted fragments into `{sections: [{heading, entries}], bytes}`. |
| `spliceIntoUnreleased(text, compiled)` | Pure: `{ok, text, added}`, the text with the sections written into `[Unreleased]`. |

`test/changelog-fragments.test.js` holds the contract as executable cases,
including the pin that keeps this module's block-finding regexes equal to
`version-bump`'s and the bump-level fixtures judged by `version-bump` itself.
`test/version-bump-fragments.test.js` holds the compilation and the refusals,
and `test/wrap-changelog-transaction.test.js` the cut as one transaction and
its recovery, against real repositories.
