# Artisan → CoffeeFlow roasting log

Artisan already records everything about a roast. This puts the two readings that
matter onto the CoffeeFlow roast row, without anyone retyping them:

| CoffeeFlow | Artisan | Meaning |
|---|---|---|
| `טמפ' הטענה` → `roasts.charge_et` | `computed.CHARGE_ET` | environmental/drum probe when the beans go in |
| `טמפ' סיום` → `roasts.drop_bt` | `computed.DROP_BT` | bean probe at drop |

All four charge/drop readings are stored (`charge_et`, `charge_bt`, `drop_et`,
`drop_bt`) — the two above are the ones shown in the log table, the other two
appear in the roast's edit drawer. Everything is normalised to **°C** and **kg**
on the way in, whatever Artisan is set to.

---

## How it flows

```
Artisan, OFF pressed
  └─ Autosave writes  <name>.alog   → the archive folder
     and            → <name>.json   → the WATCHED folder
          │
          └─ scripts/artisan-watch.mjs  ──POST──▶  edge fn `artisan-import`
                                                      │
                            ┌─────────────────────────┴──────────────────────┐
                            │                                                │
                   a roast row matches                          nothing matches yet
                            │                                                │
              readings written onto it                     parked in `artisan_profiles`
                                                                             │
                                                    the roaster logs the roast in CoffeeFlow
                                                    → it attaches itself, and the toast shows
                                                      "Artisan: הטענה 195° · סיום 208.3°"
```

The second path is the normal one. The roaster logs a roast **after** roasting,
so Artisan's file almost always arrives first and waits.

**An import never creates a roast row.** Creating one moves green and roasted
stock — real inventory — so that stays a human action.

---

## The naming protocol

Artisan builds the filename from a `~` template, so the roaster types nothing
except the bean name.

```
CF_2026-09-27_1432_Yirgacheffe.json
└┬┘ └────┬────┘ └┬┘ └────┬────┘
 │       │       │       └─ Artisan's Beans field, first line
 │       │       └───────── hhmm, local, at CHARGE
 │       └───────────────── yyyy-MM-dd, at CHARGE
 └───────────────────────── sentinel — the watcher ignores everything else
```

The filename is a **cross-check, not the source of truth.** The body already
carries `roastUUID`, `roastepoch`, `roastisodate` and `beans`. If the filename
disagrees with the body the import is **refused with an explanation**, rather
than storing a row that quietly describes the wrong roast.

---

## Setting up Artisan (once, on the roastery computer)

`Config ▸ Autosave`:

| Setting | Value |
|---|---|
| **Autosave** | ticked |
| **Path** | where the `.alog` archive goes, e.g. `~/Artisan/profiles` |
| **Autosave prefix** | `CF_~date_long_~time_~beans_line` |
| **Save also** | ticked, format **JSON** |
| **Save also** path | a folder of its own, e.g. `~/Artisan/coffeeflow` — this is the watched folder |

Give the JSON its own folder. The watcher then sees only files it cares about.

**Per roast:** type the bean name into `Roast Properties ▸ Beans` **before
pressing OFF**. Artisan keeps the last value, so roasting the same bean again
needs no retyping. Forget it and the roast still imports — it just lands in the
staging list as "ללא שם זן" for a manual attach.

### Matching the name to a CoffeeFlow origin

The bean name is typed by hand, so it will not always equal the CoffeeFlow name.
The first time a spelling comes in unrecognised, attach it from the staging list
with **"זכור את השם הזה"** ticked. That writes `origins.artisan_name` (or
`roast_profiles.artisan_name`) and every later roast of that bean matches by
itself. No admin screen, no mapping table to maintain.

---

## Running the watcher

Node 18 or newer, no dependencies.

```bash
export ARTISAN_WATCH_DIR="$HOME/Artisan/coffeeflow"
export ARTISAN_INGEST_KEY="<the ARTISAN_INGEST_KEY secret>"
export SUPABASE_URL="https://ytydgldyeygpzmlxvpvb.supabase.co"

node scripts/artisan-watch.mjs
```

Check the wiring before leaving it running:

```bash
node scripts/artisan-watch.mjs --once --dry-run
```

| Variable | Default | |
|---|---|---|
| `ARTISAN_WATCH_DIR` | — | required |
| `ARTISAN_INGEST_KEY` | — | required |
| `SUPABASE_URL` | — | required (or `ARTISAN_IMPORT_URL` for the full endpoint) |
| `ARTISAN_POLL_SECONDS` | `15` | |
| `ARTISAN_STATE_FILE` | `~/.coffeeflow/artisan-watch-state.json` | which files were already sent |

Flags: `--once` (one sweep then exit), `--dry-run` (report, send nothing).

It polls rather than using filesystem events — those are unreliable on Windows
and on network shares, and missing a roast is worse than a 15-second delay. A
file modified in the last 5 seconds is left alone, so a half-written profile is
never read. Uploads are idempotent: re-sending a file updates the same row.

### Keeping it running

macOS — `~/Library/LaunchAgents/com.minuto.artisan-watch.plist`, then
`launchctl load` it. Linux — a `systemd --user` unit. Windows — Task Scheduler,
"at log on". The script is a plain long-running process; anything that restarts
it on boot will do.

---

## Manual import

For a roast the watcher missed, or a file exported by hand:
**רישום קלייה → ייבוא מ-Artisan**, and pick the `.json`.

`.alog` is **not** accepted. Despite looking similar it is a Python literal, not
JSON (`True`, `None`, single quotes). The JSON autosave is the contract. To get
one from an existing `.alog`: open it in Artisan, then `File ▸ Export ▸ JSON`.

---

## Verifying / troubleshooting

```bash
./scripts/logs.sh errors          # what failed in the last 24h
./scripts/logs.sh runs            # every import and its outcome
./scripts/logs.sh run <run-id>    # the full trace of one import
```

Every response carries a `run_id`. Import outcomes are logged under the events
`profile.parsed`, `profile.reject`, `match.none`, `match.staged`, `match.raced`
and `run.done`.

| Symptom | Cause |
|---|---|
| `filename_mismatch` | The Autosave prefix is wrong. It must be exactly `CF_~date_long_~time_~beans_line`. |
| `missing_uuid` | An `.alog` was sent, or a file that is not an Artisan export. |
| `staged / unknown_bean` | No origin or roast profile carries that name. Attach once with "זכור את השם הזה". |
| `staged / ambiguous` | The same bean was roasted more than once that day. Attach from the list — the import will not guess. |
| `staged / no_roast_logged_yet` | Normal. It attaches when the roaster records the roast. |
| Watcher says nothing at all | Filenames lack the `CF_` prefix, or **Save also** is not set to JSON. |

### Tests

```bash
deno run supabase/functions/_shared/artisan_test.ts                                # the parser
deno run --allow-net --allow-env supabase/functions/artisan-import/index_test.ts    # attach / stage / refuse
deno run supabase/functions/health-watchdog/artisan_coverage_test.ts               # the alert thresholds
```

---

## Monitoring

The watcher is pushed, not scheduled — there is no cron to watch, so if the
roastery computer reboots or Autosave gets unticked, roasts would quietly stop
carrying temperatures and nobody would notice. `health-watchdog` therefore runs
a **conditional** check (`supabase/functions/health-watchdog/artisan_coverage.ts`),
not the usual `EXPECTED_FRESH_DATA` max-age — a flat age budget would fire every
time Minuto simply doesn't roast for a few days.

| Condition | Alert |
|---|---|
| ≥3 roasts in the last 96h and **none** carries readings | **ERROR** — the watcher is probably down |
| ≥5 roasts in 96h and under half covered | **WARN** — profiles arrive but don't match; a bean name needs teaching |
| Profiles unattached for over 7 days | **WARN** — readings recorded but on no roast |

Under 3 roasts it stays silent: too thin to tell a dead watcher from a quiet
week, and a watchdog that cries wolf gets muted.

---

## Deploying

```bash
supabase functions deploy artisan-import --project-ref ytydgldyeygpzmlxvpvb --no-verify-jwt
```

`--no-verify-jwt` is required — the watcher authenticates with
`x-artisan-key`, not a Supabase JWT. Then set the secret:

```bash
supabase secrets set ARTISAN_INGEST_KEY=<a long random string> --project-ref ytydgldyeygpzmlxvpvb
```

Schema: `supabase/migrations/20260927_artisan_integration.sql` — additive only
(new columns on `roasts`, `origins`, `roast_profiles`; the new
`artisan_profiles` table) and safe to re-run.

## What is not stored

The curve arrays (`timex`, `temp1`, `temp2`) are stripped before storage. A
17-minute roast at 1 Hz is ~50 KB of them per roast, and prod runs on an
instance with little headroom. `artisan_profiles.computed` keeps Artisan's whole
computed block — phases, ROR, AUC, development time — so charting a roast later
needs no schema change, only the curve arrays turned back on.
