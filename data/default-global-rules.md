# Global Rules

These rules apply to all projects managed by TangleClaw, across all engines.
Edit them from the TangleClaw landing page or via the API.

## General

- Follow the project's existing code style and conventions
- Prefer small, focused commits over large monolithic ones
- Keep functions short and single-purpose
- Write clear commit messages that explain why, not just what

## Project Stats Workflow

Every project managed by TangleClaw must include a GitHub Actions workflow (`.github/workflows/stats.yml`) that auto-generates project metrics on every push to `main`. This enables the portfolio site to display live stats.

### What the workflow does
- Counts lines of code (JS/TS/JSX/TSX/MJS, excluding node_modules, .next, dist, .min files)
- Counts test cases (`it()` and `test()` calls in test/spec files)
- Counts test files
- Writes results to `stats.json` with an `updatedAt` timestamp

### Public vs private repos
- **Public repos**: Commit `stats.json` directly to the repo root. The portfolio fetches from the raw GitHub URL.
- **Private repos**: Push `<project>-stats.json` to the `project-assets` repo using the `PROJECT_ASSETS_TOKEN` secret. This secret must be added to each private repo (Settings → Secrets → Actions).

### When setting up a new project
1. Add `.github/workflows/stats.yml` (use the public or private template as appropriate)
2. For private repos: add the `PROJECT_ASSETS_TOKEN` secret
3. Push to main to trigger the first stats generation
4. If the project has a portfolio card, update the card to fetch from the stats URL
