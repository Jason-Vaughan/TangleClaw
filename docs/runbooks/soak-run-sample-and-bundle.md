# Run, sample and bundle the soak

The Operator runs this runbook, inside a guest prepared by
[Install and start the pinned candidate](soak-install-the-candidate.md).

## When to use this

The guest printed `guest ready: …` and you are starting a dry run, a destructive-phase run, or the
72-hour certifying run.

- **A destructive run** (`--phase destructive`) restarts the owned ttyd, which fails a certification.
  Run it in its own guest, then throw that guest away.
- **The certifying run** also needs the release-certification judge running beside it, in host-attested
  mode. See "Certifying in a guest" in [`deploy/soak/README.md`](../../deploy/soak/README.md).
  Soak time counts only while that judge accepts the run.

## Before you start

- **Run every command as `soakrun`, in its GUI session**, from `/opt/tangleclaw-soak`. The faults act
  on that user's tmux, database and launchd jobs, and Safari needs that session.
- **Keep the run's files together**, for example in `/Users/soakrun/soak/`. The evidence goes to the
  shared directory, `/Volumes/My Shared Files/soak/`.
- **Unverified until the first dry run:** step 3 (safaridriver as `soakrun`) has not yet been run in a
  real guest.

## Steps

1. Build the schedule (`SOAK_SHA` is the pin, exported in this session too):
   `mkdir -p ~/soak && node scripts/soak.js plan --seed "rc-$SOAK_SHA" --phase certifying --duration-hours 72 --out ~/soak/schedule.json`
   → Expected: a JSON line with `"digest"`, `"phase":"certifying"` and an `events` count. Record the
   digest. For a dry run, use `--duration-hours 2`. For a destructive run, use `--phase destructive`.

2. Check it:
   `node scripts/soak.js validate --schedule ~/soak/schedule.json`
   → Expected: `"valid":true` and the same digest.

3. Start the WebDriver, and check it answers:
   `safaridriver -p 4444 &` then `curl -s http://127.0.0.1:4444/status`
   → Expected: `"ready":true`. If `safaridriver` refuses, the admin runs `sudo safaridriver --enable`
   once, and you try again.

4. Start the integrity sampler in its own terminal:
   `node scripts/soak.js sample --home ~/.tangleclaw --api http://127.0.0.1:3102 --out ~/soak/samples.ndjson --no-live-install`
   → Expected: no output while it runs. `~/soak/samples.ndjson` gains a line every 10 minutes.
   → If it prints `LOCAL_CONTROL_REFUSED`: it names each unmet condition. It only runs in the guest,
   with no `TANGLECLAW_API` set.

5. Run the schedule:
   `node scripts/soak.js run --schedule ~/soak/schedule.json --api http://127.0.0.1:3102 --log ~/soak/soak.ndjson --no-live-install --home ~/.tangleclaw --webdriver http://127.0.0.1:4444`
   → Expected: after the schedule's duration, exit 0 and a line with `"status":"completed"`.
   → Exit 4 (stopped): run the same command again. It resumes, and no logged event runs twice.
   → Exit 5 (`completed-ownership-unverified`): not an automatic pass. Continue to the bundle; the
   judge decides.
   → Exit 3: the JSON on stderr names the refusal. Nothing ran.

6. Stop the sampler with Ctrl-C in its terminal.
   → Expected: a line such as `{"taken":433,"lastSeq":432}`.

7. Bundle the evidence into a new directory:
   `node scripts/soak.js bundle --out "/Volumes/My Shared Files/soak/evidence-$SOAK_SHA" --candidate-sha "$SOAK_SHA" --schedule ~/soak/schedule.json --log ~/soak/soak.ndjson --samples ~/soak/samples.ndjson --attestations <the attestation files, comma-separated> --home ~/.tangleclaw --no-live-install`
   → Expected: one JSON line with `"manifestSha256"`. Record it with the run's evidence.
   → If it prints `BUNDLE_REFUSED`: it names the input. An existing `--out` is refused, so pick a new
   directory; never delete an earlier bundle. `--candidate-sha` must be the full 40-character SHA you
   pinned in the install runbook; the certification judge refuses a bundle that names any other.

8. Read the bundle's summary:
   `node -p "const s = require('/Volumes/My Shared Files/soak/evidence-$SOAK_SHA/manifest.json').summary; JSON.stringify({log: [s.log.readable, s.log.ended, s.log.scheduleMatches], samples: [s.samples.failed, s.samples.largestGapMs <= 2 * s.samples.intervalMs, Math.round((s.samples.lastAt - s.samples.firstAt) / 3600000)], corrupt: s.samples.db.corrupt, snapshot: s.dbSnapshot.state})"`
   → Expected: `"log":[true,true,true]`, then `"samples":[0,true,<hours>]` where `<hours>` is at least the
   schedule's duration (72 for a certifying run), then `"corrupt":0` and `"snapshot":"ok"`. The middle
   check proves the sampler ran the whole time, never more than two of its own intervals apart.
   → Anything else: the run does not pass as it stands. Keep the bundle, and report the summary on
   #2020. The acceptance gates' default is fail and reset.
   → This is a quick read of the summary, not the verdict. The verdict is the host's: the
   certification judge re-derives all of it from the bundle's files when the host finalizes the run
   (`rc-cert host-finalize --soak-bundle`, see "Judging the bundle" in
   [`deploy/soak/README.md`](../../deploy/soak/README.md)). Keep `rc-cert run` sampling until the
   host has finalized: the certification run must not be accepted before then, or the soak's end can
   fall outside its window.

9. Tear the guest down once the bundle is safe on the host. As the admin:
   `sudo defaults delete /Library/Preferences/com.apple.loginwindow autoLoginUser; sudo rm -f /etc/kcpassword`
   Then, on the host: `tart delete tc-soak-guest`.
   → Expected: `tart list` no longer shows `tc-soak-guest`. A certification never reuses a guest.

## If it fails

Stop, keep every file in `~/soak/`, and bundle what exists (step 7). A failed run's bundle is still
evidence. Report it on #2020 with the step number, then start again from a fresh guest.
