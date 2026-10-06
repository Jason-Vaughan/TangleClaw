# Archive manifest: quarantined #2005 work-in-progress (TangleClaw-Pilot-B1, session 1334)

QUARANTINED INCIDENT EVIDENCE. This is uncommitted work from a PM dispatch that was withdrawn
(2026-10-05). It is NOT implementation input and must not be merged, cherry-picked or replayed:
the same change shipped on main independently as bd3d972506a0 (#2005) and 266e351532e6 (#2112).
Archived by direct PM dispatch (Medusa c969ea41, operator-authorized) under Architect disposition A60/A63.

- Source worktree: /Users/jasonvaughan/Documents/Projects/TangleClaw-Pilot-B1-2005-delivery-failure
- Source branch: fix/2005-delivery-failure-event (local only, no commits of its own)
- Base commit (worktree HEAD): 7ee848675513d99dd8a3a513dc5760e27c1af5c4
- Patch: 2005-withdrawn-wip.patch, made with `git diff --binary HEAD`
- Patch sha256: 71a505edc7b63dd8ea25ad075ca40133590c9cf6461d80223a3d69b44bb30415
- Patch bytes: 19737
- Untracked files in the worktree: none. Staged changes: none. Stashes: none.
- capsule.md: the state capsule written 2026-10-06, sha256 9fb34b450c106f426fe20246c27d4947fb13bcf55cfd85628cd6260d835801d3

## Files (as they stood in the worktree; copies under files/)

| path | git blob at base | git blob in worktree | sha256 in worktree |
|---|---|---|---|
| .prawduct/change-log.md | 5d798081e5d30f6ce42cab859bce3c7da3199818 | f0838d17695ac55af05ad707ee0818dfad119573 | 845672a6ac06fc55a0c60b4f796b93807a9c23f611a24f5bb01308a215a2a0b5 |
| CHANGELOG.md | f63567ac459a1569d5421a8d7c1bfc9a8f3fa20b | 6e9d45ad9523fd15413efe0ac4cb408d4636b2f9 | ff38d5349cf842993d8f7f31d1b092bd586d5b01e03a19c941b784a119b0fbc5 |
| docs/operator-bridge.md | bb14e0bc2d59a2af649423dc6693c18fe613a5f7 | a89d5e8e261a54ce9f401142e699dbdda41d98b6 | c20eda4039d363a8bd8facb9138a9bb93453e3ef2e729f990d07205de72559f4 |
| lib/bridge-gateway.js | 021cbba8c8f8442b8386a0ec4f2da97b5e233b73 | cba95a8a088656f4118fdc3b0e8cc62b704521ae | a8ccd3c14e4a504e4895d567912f95d6c3bd5fe89d0c1b62d62b05b055924d27 |
| test/bridge-gateway.test.js | 137823c2d2b1ba84f67aecbcfc7800320a1d3b40 | 747dde06363b62c43ec53bd0435b27564abec0cc | 61b816a94494cb33d71ac3bc0b1f1c77161c1d0f071aac73d9af089b883073cc |

## To reproduce the worktree state

`git checkout 7ee848675513d99dd8a3a513dc5760e27c1af5c4 && git apply --binary 2005-withdrawn-wip.patch` gives the five files above, byte for byte.
