## Project Version Recording

TangleClaw displays each project's version on the landing page and session banner. The AI is the writer — it detects the version and records it to a cache file that TangleClaw reads.

### Cache File

Path: `<project-root>/.tangleclaw/project-version.txt`

Format (plain key-value lines, not YAML):
```
version: 3.12.7
recorded_at: 2026-04-10T20:34:12Z
source: CHANGELOG.md
```

- `version` — the project's current version string
- `recorded_at` — ISO-8601 UTC timestamp of when it was recorded
- `source` — free-form string indicating where the version came from (e.g., `CHANGELOG.md`, `package.json`, `version.json`, `git tag`, `pyproject.toml`)

### When to Write

- **Session start** — detect the version and write the file. The prime prompt includes instructions for this.
- **Session wrap** — re-check and rewrite the file, since the version may have changed during the session (e.g., CHANGELOG bump, git tag).

### Detection Order

When determining the version to write, check in this order:
1. Latest released entry in `CHANGELOG.md` (skip `[Unreleased]`)
2. `version.json` or `package.json` at the project root
3. Latest git tag (`git describe --tags --abbrev=0`)
4. `0.0.0-dev` as a placeholder if none of the above exist

### How TangleClaw Reads It

`enrichProject()` uses a layered fallback chain: cache file → CHANGELOG → version.json → package.json → null. The cache file has highest priority because the AI may have used a source (like git tags or pyproject.toml) that TangleClaw can't parse natively.
