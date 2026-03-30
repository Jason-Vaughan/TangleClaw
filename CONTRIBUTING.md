# Contributing to TangleClaw

Thanks for your interest in contributing to TangleClaw! This document covers how to set up a development environment, run tests, and submit changes.

## Prerequisites

- **macOS** (launchd required for service management)
- **Node.js 22+** (`node:sqlite` and `node:test` are required)
- **ttyd** (`brew install ttyd`)
- **tmux** (`brew install tmux`)

## Getting Started

```bash
git clone https://github.com/Jason-Vaughan/TangleClaw.git
cd TangleClaw
```

TangleClaw has zero npm dependencies — no `npm install` needed. You can run the server directly:

```bash
node server.js
```

Or install as a launchd service:

```bash
./deploy/install.sh
```

## Running Tests

```bash
node --test 'test/*.test.js'
```

The test suite uses `node:test` (built into Node.js 22+). Tests create temporary directories and in-memory SQLite databases — no external services needed.

## Project Structure

- `server.js` — HTTP server, API routes, reverse proxy, WebSocket upgrade
- `lib/` — Core modules (store, engines, sessions, methodologies, etc.)
- `public/` — Frontend (HTML, CSS, JS — no build step, no framework)
- `data/engines/` — Bundled engine profiles (JSON)
- `data/templates/` — Bundled methodology templates (JSON)
- `test/` — Test files matching `*.test.js`
- `docs/` — User documentation
- `deploy/` — launchd plists and install script

## Adding a New Engine

1. Create a JSON profile at `data/engines/<id>.json` (see [Engine Guide](docs/engine-guide.md) for the schema)
2. If the engine uses a config file that TangleClaw should generate, add a generator function in `lib/engines.js` and a `case` in `generateConfig()`
3. Run `engines.validateParity()` to verify all engines receive core rules, PortHub references, and methodology info
4. Add tests in `test/engines.test.js`

## Adding a New Methodology Template

1. Create `data/templates/<id>/template.json` (see [Methodology Guide](docs/methodology-guide.md) for the schema)
2. Define phases, rules, detection strategy, wrap behavior, and prime prompt sections
3. Add tests for detection and initialization

## Making Changes

1. Create a branch from `main`
2. Make your changes
3. Run the full test suite: `node --test 'test/*.test.js'`
4. Update `CHANGELOG.md` with a description of your changes
5. Submit a pull request

### Commit Messages

- First line: concise summary (72 chars max)
- Focus on *why*, not just *what*
- Reference issue numbers where applicable

### Code Style

- Follow the existing code style (no linter configured — match what's there)
- All functions should have JSDoc comments
- Write tests alongside implementation
- Zero external dependencies — use Node.js stdlib only

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- TangleClaw version (`curl localhost:3102/api/version`)
- Node.js version (`node --version`)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
