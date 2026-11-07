#!/usr/bin/env bash
# CoffeeFlow — build the photo index the Instagram art director reads.
#
#   ./scripts/image-library-index.sh
#
# The art director (supabase/functions/_shared/art_director.ts) picks 1-2 of
# Minuto's own photos as references for each image. It picks by key from this
# index: one factual sentence per photo, what it shows, and quality flags
# (order ticket, sharp face, clutter...), written by a vision model (Gemini).
#
#   marketing/upload_images/<folder>/<photo>  →  supabase/functions/_shared/photo_index.ts
#
# The index is a source file, not a storage object (the marketing bucket only
# accepts images and video), so a new shoot ships through a reviewed PR:
# re-run this, check the diff, merge.
#
# Photos in docs/image-pipeline/library_exclude.txt are left out. Facts the
# model gets wrong are corrected in docs/image-pipeline/photo_index_overrides.json
# (owner, 2026-10-29: roaster-49 and fix-8 show ROASTED beans). Re-run after
# every photo shoot, after uploading to upload_images/<folder>/.
#
# Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and GEMINI_API_KEY
# (scripts/secrets-doctor.sh). Credentials go in headers only.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SUPABASE_URL:?}"; : "${SUPABASE_SERVICE_ROLE_KEY:?}"; : "${GEMINI_API_KEY:?}"

python3 -I - "$PWD" <<'PY'
import base64, json, os, sys, time, urllib.parse, urllib.request, concurrent.futures as cf
ROOT = sys.argv[1]
BASE = os.environ["SUPABASE_URL"].rstrip("/"); KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
FOLDERS = ["machine", "hands", "pitchers", "roaster", "brewing", "cups", "beans", "bag_scenes", "coffee_bags"]
# Rows are "<ratio or *>  <folder>/<file>"; only "*" rows exclude a photo for every use.
exclude = set()
for line in open(f"{ROOT}/docs/image-pipeline/library_exclude.txt"):
    f = line.split("#")[0].split()
    if len(f) == 2 and f[0] == "*": exclude.add(f[1])
overrides = json.load(open(f"{ROOT}/docs/image-pipeline/photo_index_overrides.json"))

def req(url, body=None, headers=None, method=None):
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}", **(headers or {})}
    return urllib.request.Request(url, data=body, headers=h, method=method)
def urlopen_retry(r, timeout=120, tries=4):
    for i in range(tries):
        try: return urllib.request.urlopen(r, timeout=timeout)
        except Exception:
            if i == tries - 1: raise
            time.sleep(2 * (i + 1))

keys = []
for folder in FOLDERS:
    body = json.dumps({"prefix": f"upload_images/{folder}", "limit": 1000}).encode()
    for o in json.load(urlopen_retry(req(f"{BASE}/storage/v1/object/list/marketing", body, {"Content-Type": "application/json"}))):
        name = o.get("name", "")
        if o.get("id") and name.lower().endswith((".jpg", ".jpeg", ".png", ".webp")) and f"{folder}/{name}" not in exclude:
            keys.append(f"{folder}/{name}")

PROMPT = ('This photo is from the library of Minuto, a specialty coffee roastery and espresso bar. Reply with JSON only: '
  '{"desc": "one factual sentence: the main subject, the exact equipment, the setting", '
  '"shows": ["short tags such as strada_x_front, strada_x_side, steam_wand, milk_pitcher, drum_roaster, cooling_bin, roasted_beans, green_beans, chemex, v60, moka_pot, aeropress, cup, latte_art, coffee_bag, bar_interior, window, barista_hands"], '
  '"flags": ["any of: order_ticket, readable_customer_text, sharp_face, clutter, dirty_equipment, blurry, cropped_subject, people_background"]}')

def caption(key):
    data = urlopen_retry(urllib.request.Request(f"{BASE}/storage/v1/object/public/marketing/upload_images/{urllib.parse.quote(key)}")).read()
    mime = "image/png" if key.lower().endswith(".png") else "image/webp" if key.lower().endswith(".webp") else "image/jpeg"
    r = urllib.request.Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
        data=json.dumps({"contents": [{"parts": [{"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}}, {"text": PROMPT}]}],
                         "generationConfig": {"responseMimeType": "application/json", "temperature": 0}}).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    text = "".join(p.get("text", "") for p in json.load(urlopen_retry(r))["candidates"][0]["content"]["parts"])
    d = json.loads(text[text.find("{"): text.rfind("}") + 1])
    out = {"key": key, "desc": str(d.get("desc", ""))[:300],
           "shows": [str(s)[:40] for s in d.get("shows", [])][:12], "flags": [str(s)[:40] for s in d.get("flags", [])][:8]}
    out.update(overrides.get(key, {}))
    return out

with cf.ThreadPoolExecutor(6) as ex:
    index = []
    for key, fut in [(k, ex.submit(caption, k)) for k in keys]:
        try: index.append(fut.result())
        except Exception as e: print(f"  skipped {key}: {e}", file=sys.stderr)
index.sort(key=lambda d: d["key"])
with open(f"{ROOT}/supabase/functions/_shared/photo_index.ts", "w") as f:
    f.write("// GENERATED by scripts/image-library-index.sh: do not edit by hand.\n")
    f.write("// Minuto's photo library as the art director sees it (_shared/art_director.ts).\n")
    f.write("// Corrections go in docs/image-pipeline/photo_index_overrides.json.\n\n")
    f.write("export interface IndexedPhoto { key: string; desc: string; shows: string[]; flags: string[] }\n\n")
    f.write(f"export const PHOTO_INDEX_BUILT_AT = {json.dumps(time.strftime('%Y-%m-%d', time.gmtime()))}\n\n")
    f.write("export const PHOTO_INDEX: IndexedPhoto[] = [\n")
    for d in index: f.write("  " + json.dumps(d, ensure_ascii=False) + ",\n")
    f.write("]\n")
print(f"indexed {len(index)} of {len(keys)} photos → supabase/functions/_shared/photo_index.ts")
for d in index:
    if d["flags"]: print(f"  {d['key']}: {', '.join(d['flags'])}")
PY
