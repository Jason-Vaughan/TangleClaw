# Dashboard loads blank — no project list, session tabs still work

Tier 2, single browser. Reversible except where marked. Owner: whoever is looking at it.

## When to use this

The dashboard page (`/`) renders its chrome but no projects appear and nothing
recovers, while session tabs already open in the same browser keep working.
First seen 2026-07-31 (#817): the condition cleared on its own after about
twenty minutes with no server restart, no config change, no deploy.

The mechanism, as far as it is known: `landing.js` and `ui.js` are precached
by the service worker (`STATIC_ASSETS` in `public/sw.js`) and served
cache-first, so a stale or corrupt precache entry loads the document over the
network and never runs the shell. **Their absence from the access log is
expected on every load, healthy or not** — it is not evidence.

**Not this runbook:** the whole page fails to load, or a "Connection lost" /
unreachable-server overlay appears — that is the server, see
[Server Won't Start](../user-guide.md#server-wont-start).

## Steps

Do steps 1–3 **before** reloading, clearing anything, or waiting. The evidence
lives only in the affected browser and is gone once the condition clears.
iOS Safari exposes none of it without a Mac attached; from a phone, do step 4
now and steps 1–3 from a desktop browser if one reproduces.

1. Open DevTools → **Console** on the blank page. Copy every error verbatim.
   → Expected: an error naming `landing.js`, `ui.js`, or
   `FetchEvent.respondWith` — or a clean console. Record either; "no errors"
   is a finding too.

2. **Application → Cache Storage** → expand the origin. Record every cache
   name, and for the `tangleclaw-*` cache(s) whether `/landing.js` and
   `/ui.js` entries exist, their response status, and their size.
   → Expected on a healthy browser: exactly one `tangleclaw-v3-NN` cache, its
   `NN` equal to `CACHE_NAME` in `public/sw.js`, both entries present with
   status 200 and a non-zero size. Two generations, a missing entry, a
   0-byte or non-200 entry: that is the finding. Screenshot it.

3. **Application → Service Workers**. Record the worker's status line
   (`activated and is running` / `waiting to activate` / `redundant`), its
   source URL, and whether a second worker is listed as waiting.
   → Expected: one worker, activated, source `/sw.js`. A waiting worker beside
   a running one means an update was mid-cycle — record both.

4. Read the beacon from the server log — **on the server box, over SSH**
   (`ssh <server>`); the log and `localhost` are the server's, never the
   phone's. Every dashboard load that boots sends `POST /api/dashboard/boot`
   after its first projects fetch renders, and the server logs it as
   `Dashboard booted`. Page navigations (`GET /`, `GET /session/<name>`) are
   logged at info for exactly this pairing; other static assets are not.

   ```bash
   grep -E 'GET / |GET /session/|Dashboard booted|POST /api/dashboard/boot|Refused' ~/.tangleclaw/logs/tangleclaw.log | tail -30
   ```

   → Expected on a healthy load: `GET / status=200 … document=index.html`
   followed within seconds by
   `Dashboard booted cacheName=tangleclaw-v3-NN swControlled=true`.
   → The fault: `GET /` lines with **no** `Dashboard booted` after them. A
   `GET /` followed by `GET /session/<name>` and no beacon is an operator who
   went straight to a session page, not this fault.
   → A `[WARN] … Refused …` line (an unserved Host, a cross-site request, a
   write whose body is not JSON) right after the `GET /` is the **other**
   explanation for a missing beacon: the shell ran and the server turned the
   beacon away before its access-log line. The browser console then shows
   `boot beacon refused: HTTP <status>` (step 1) — that is a serving or
   ingress problem, not this runbook.
   → `cacheName=null` on a booted load means the browser had no TangleClaw
   cache at all — a first visit, or a browser that just cleared site data.
   The log rotates by size (`tangleclaw.log.1`, `.2`); grep those too if the
   window is more than a few hours old.

5. Recover **this browser only** — never every browser (see below).
   - Desktop: DevTools → Application → Service Workers → **Unregister**, then
     reload. If the list still does not render, Application → Storage →
     **Clear site data**, then reload.
   - iOS Safari: Settings → Safari → Advanced → **Website Data** → find the
     TangleClaw host → swipe left → **Delete**, then reopen the page. This
     removes the worker and its caches for that site only.
   Either path also drops this browser's saved dashboard preferences (the
   `tc_*` keys in local storage) — nothing server-side.
   → Expected: the reload produces a `Dashboard booted` line (step 4's grep)
   and the project list renders.

6. Attach steps 1–4 to #817 (or a new issue if #817 is closed). The
   hypothesis there has never been confirmed because nobody captured the
   browser side before it healed; that capture is the whole point.

## Done when

The reload's `GET /` is followed by `Dashboard booted` in the log and the
project list is on screen.

## Do not bump `CACHE_NAME`

The reflex fix — bumping `CACHE_NAME` in `public/sw.js` — is the wrong tool:

- It tears down **every** registered worker in **every** browser at once, when
  the fault is one browser's cache. Step 5 fixes exactly the browser that is
  broken.
- This clone is the running install and serves `public/` off the working
  tree, so the bump reaches every operator the moment it is saved, with no
  staging step. On 2026-07-28 a bump did exactly that and locked Chrome out
  behind the auth gate (#710).
- It destroys the evidence steps 1–3 exist to capture.

A new asset or a stale script is a network-first carve-out in
`NETWORK_FIRST_PATHS`, not a bump — see the comments beside `CACHE_NAME`.

## If this doesn't work

If step 5 does not produce a `Dashboard booted` line and a rendered list, the
fault is not the cached shell. On the server box (over SSH, as in step 4),
check the server answers the same request the shell makes:

```bash
curl -s http://localhost:3102/api/projects | head -c 300
```

No JSON → [Server Won't Start](../user-guide.md#server-wont-start). JSON but
still blank in the browser → file it with everything captured above; this
runbook's hypothesis was wrong for this instance, and that is worth knowing.
