# Artisan → CoffeeFlow roasting log

Artisan already records everything about a roast. This puts the two readings
that matter onto the CoffeeFlow roast record, without retyping them:

| CoffeeFlow | Artisan | Meaning |
|---|---|---|
| `טמפ' הטענה` → `roasts.charge_et` | `computed.CHARGE_ET` | environmental/drum probe when the beans go in |
| `טמפ' סיום` → `roasts.drop_bt` | `computed.DROP_BT` | bean probe at drop |

All four charge/drop readings are stored (`charge_et`, `charge_bt`, `drop_et`,
`drop_bt`). The two above show in the log table; the other two are in the
roast's edit drawer. Everything is normalised to **°C** and **kg** on the way
in, whatever Artisan is set to.

---

## How it works

Nothing to install, and nothing to configure in Artisan.

1. Roast.
2. Record the roast in CoffeeFlow exactly as before.
3. In the roast log, click the **chart icon** on that row and pick the file
   Artisan saved. The readings appear on the record.

The icon is filled on rows that already have a file. Clicking it again replaces
the file — useful if the wrong one was picked, or the roast was re-saved.

The same **טען קובץ** button is in the roast's edit drawer, alongside all four
readings.

### Which file

**`.alog`** — the file Artisan saves by default. This is the one to pick.

`.json` also works (`File ▸ Export ▸ JSON`, or the Autosave "Save also"
option), but there is no reason to bother: both formats are the same profile
serialised, and both carry the readings.

There is no filename convention. You are telling CoffeeFlow which record the
file belongs to, so nothing has to be inferred from the name.

---

## What it will not do

- **It never creates a roast.** Recording a roast moves green and roasted
  stock — real inventory — so that stays yours.
- **It never rewrites your numbers.** Green weight, roasted weight, operator,
  origin, date and batch number are untouched. Only the readings are added.
- **It will not put one file on two roasts.** Uploading a file that is already
  attached elsewhere is refused, naming the roast that has it — that mis-click
  would otherwise copy one roast's readings onto another record.

---

## Troubleshooting

```bash
./scripts/logs.sh errors          # what failed in the last 24h
./scripts/logs.sh runs            # every upload and its outcome
./scripts/logs.sh run <run-id>    # the full trace of one upload
```

Every response carries a `run_id`. Uploads log under `file.parsed`,
`file.reject`, `file.duplicate`, `roast.missing` and `run.done`.

| Message | Cause |
|---|---|
| *This Artisan file is already attached to another roast* | The wrong file was picked, or the right file onto the wrong row. |
| `missing_uuid` | The file is not an Artisan roast profile — a settings backup, or some other `.alog`-shaped file. |
| `bad_alog` / `bad_json` | The file is truncated or corrupt. Re-save it from Artisan. |
| `roast_not_found` | The roast was deleted in another tab while the file was being picked. |
| Readings show `—` after a successful upload | Artisan never registered CHARGE or DROP for that roast, so it has no reading to give. |

### Monitoring

Because uploading is a habit rather than a process, `health-watchdog` sends a
**reminder** (never an error — nothing is broken) when roasts are piling up
without files:

| Condition | |
|---|---|
| ≥3 roasts in the last 96h and **none** has a file | reminder |
| ≥5 roasts in 96h and under half have one | reminder |

Under 3 roasts it stays silent — too thin to tell a skipped upload from a quiet
week, and a watchdog that nags gets muted.

### Tests

```bash
deno run --allow-read supabase/functions/_shared/python_literal_test.ts          # the .alog reader
deno run supabase/functions/_shared/artisan_test.ts                              # both formats, units, refusals
deno run --allow-net --allow-env supabase/functions/artisan-import/index_test.ts  # attach / replace / refuse
deno run supabase/functions/health-watchdog/artisan_coverage_test.ts             # the reminder thresholds
```

---

## Deploying

```bash
supabase functions deploy artisan-import --project-ref ytydgldyeygpzmlxvpvb --no-verify-jwt
```

`health-watchdog` needs redeploying too, since the reminder lives in it. No
secrets to set.

Schema: `supabase/migrations/20260927_artisan_integration.sql` — additive only
(new columns on `roasts`, the new `artisan_profiles` table) and safe to re-run.

---

## Notes for whoever maintains this

**`.alog` is not JSON.** Artisan writes it with `repr(dict)` and reads it back
with `ast.literal_eval` (`artisanlib/util.py`). It is a Python literal: single
quotes, `True`/`False`/`None`, tuples. `supabase/functions/_shared/python_literal.ts`
is a real tokenizer for that subset, because a regex substitution mangles any
string containing an apostrophe — which is most Hebrew bean names
(`אתיופיה יירגצ'ף`). Its test corpus is generated from python3's own `repr()`
output, so the parser is checked against Python rather than against fixtures.

**The readings live in `computed`.** Both save paths serialise `getProfile()`
(`artisanlib/main.py` L13120, L17192), and `profile['computed']` is set
unconditionally, so `.alog` and `.json` carry identical data.

**Curve arrays are stripped** before storage — `timex`, `temp1`, `temp2` and
friends are ~50 KB per roast and prod has little headroom.
`artisan_profiles.computed` keeps Artisan's whole computed block, so surfacing
development time, DTR, first crack or measured weight loss later needs no
migration — only UI.
