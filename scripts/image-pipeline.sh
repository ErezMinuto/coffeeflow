#!/usr/bin/env bash
# CoffeeFlow — image pipeline measurement (Phase 0 of docs/image-pipeline/plan.md).
#
#   ./scripts/image-pipeline.sh report [--since 2026-08-01]
#       Owner verdicts on Instagram posts (published / rejected / never
#       reviewed) by prompt_version and scene type. The number every pipeline
#       change is judged by.
#
#   ./scripts/image-pipeline.sh golden
#       Rebuild docs/image-pipeline/golden_set.json: every post the owner
#       rejected, every image the owner reported as bad, and a spread of
#       published posts, each with the brief that produced it. Re-render this
#       set old-vs-new before shipping any prompt, model or judge change.
#       Each image still in storage is COPIED to marketing/golden/ (a prefix
#       purge-old-media never touches) and the manifest points at the copy;
#       ig-test/ is purged after 4 days.
#
# Read-only against the database; `golden` writes only new copies under
# marketing/golden/ (never overwrites, never deletes). Needs SUPABASE_URL and
# SUPABASE_SERVICE_ROLE_KEY (scripts/secrets-doctor.sh shows what is set).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${SUPABASE_URL:?SUPABASE_URL is not set}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is not set}"

cmd="${1:-report}"; shift || true
since="2026-08-01"
while [ $# -gt 0 ]; do
  case "$1" in
    --since) since="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

python3 - "$cmd" "$since" <<'PY'
import json, os, re, sys, collections, urllib.request, urllib.parse

cmd, since = sys.argv[1], sys.argv[2]
BASE, KEY = os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]
HDRS = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

def get(path):
    req = urllib.request.Request(f"{BASE}/rest/v1/{path}", headers=HDRS)
    return json.load(urllib.request.urlopen(req, timeout=90))

def preserve(url):
    """Copy a marketing-bucket image to golden/ once; return the golden URL."""
    marker = "/object/public/marketing/"
    if not url or marker not in url:
        return None
    src = urllib.parse.unquote(url.split(marker, 1)[1].split("?")[0])
    if src.startswith("golden/"):
        return url
    dst = "golden/" + src.replace("/", "__")
    public = f"{BASE}/storage/v1/object/public/marketing/{dst}"
    if alive(public):
        return public
    if not alive(url):
        return None
    body = json.dumps({"bucketId": "marketing", "sourceKey": src, "destinationKey": dst}).encode()
    req = urllib.request.Request(f"{BASE}/storage/v1/object/copy", data=body, method="POST",
                                 headers={**HDRS, "Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=60)
        return public
    except Exception as e:
        print(f"  could not preserve {src}: {e}", file=sys.stderr)
        return None

def alive(url):
    try:
        return urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=15).status == 200
    except Exception:
        return False

def verdict(rd):
    if rd.get("ig_media_id") or rd.get("ig_permalink") or rd.get("published_via_ui_at"):
        return "published"
    if rd.get("rejected_via_ui_at"):
        return "rejected"
    return "not_reviewed"

# Scene buckets for the layered-v1 era (free-form briefs). Once the shot
# library ships, brief_data.shot_type replaces this guess.
def scene_type(bd, rr):
    if bd.get("shot_type"):
        return bd["shot_type"]
    if bd.get("render_mode") == "bag_hero":
        return "bag"
    if (rr or {}).get("real_photo"):
        return "real photo edit"
    b = (bd.get("scene_brief") or " ".join(s.get("scene_brief", "") for s in bd.get("slides") or [])).lower()
    for name, rx in [
        ("action / hands / pouring", r"\b(hands?|barista|pour|pouring|tamp\w*|grind\w*|crank\w*|stirr\w*|kettle)\b"),
        ("roaster", r"\b(roaster|roasting machine|drum)\b"),
        ("bag", r"\bbag\b"),
        ("espresso machine", r"\b(espresso machine|portafilter)\b"),
        ("plant / origin", r"\b(leaf|plant|cherr\w*|farm|field)\b"),
        ("macro / single bean", r"\b(single (?:roasted )?(?:coffee )?bean|macro)\b"),
        ("finished drink", r"\b(cup|mug|latte|cappuccino|espresso|crema|glass)\b"),
    ]:
        if re.search(rx, b):
            return name
    return "other"

def load(since):
    posts = get(f"seo_tasks?task_type=eq.instagram_post&status=eq.completed&created_at=gte.{since}"
                "&select=id,created_at,parent_task_id,result_data&order=created_at.asc&limit=2000")
    ids = sorted({p["parent_task_id"] for p in posts if p["parent_task_id"]})
    parents = {}
    for i in range(0, len(ids), 40):
        q = ",".join(ids[i:i + 40])
        for row in get(f"seo_tasks?id=in.({q})&select=id,brief_data,result_data->render_response"):
            parents[row["id"]] = row
    return posts, parents

if cmd == "report":
    posts, parents = load(since)
    tab = collections.defaultdict(collections.Counter)
    for p in posts:
        par = parents.get(p["parent_task_id"]) or {}
        rr = par.get("render_response") or {}
        key = (rr.get("prompt_version") or "layered-v1", scene_type(par.get("brief_data") or {}, rr))
        tab[key][verdict(p["result_data"] or {})] += 1
    print(f"Instagram posts since {since}: {len(posts)}\n")
    print(f"{'prompt_version':16} {'scene type':28} {'published':>9} {'rejected':>8} {'not reviewed':>12}  approval (of decided)")
    for (ver, scene), c in sorted(tab.items(), key=lambda kv: (kv[0][0], -sum(kv[1].values()))):
        decided = c["published"] + c["rejected"]
        rate = f"{c['published'] / decided:.0%} of {decided}" if decided else "-"
        print(f"{ver:16} {scene:28} {c['published']:9} {c['rejected']:8} {c['not_reviewed']:12}  {rate}")
    sys.exit(0)

if cmd != "golden":
    sys.exit(f"unknown command: {cmd} (use report or golden)")

# Images the owner reported as bad in chat (no UI verdict recorded for them).
REPORTED = {
    "675121de": "owner: two left hands on the hand grinder (2026-10-22)",
    "0a6e5d89": "owner: 'This is bad!!!' — V60 dripper floats above the mug, milk pitcher instead of gooseneck kettle (2026-10-27)",
    "d7e95f21": "owner: bad story — a cut coffee leaf on a table, generic / off brand (2026-10-28)",
    "1b4585d6": "owner: bad story — lone bean on an empty oak table; brief asked for white (2026-10-28)",
    "8dcf5237": "QA review: garbled Hebrew on the Dark Chocolate bag label (2026-10-18)",
    "684db5d3": "QA review: espresso poured onto a wood table with no machine (2026-10-18)",
    "d33901ca": "QA review: grinder cranked one-handed, body unsupported (2026-10-18)",
}

posts, parents = load("2026-01-01")
entries, seen = [], set()

def entry(task_id, brief, rr, verdict_, reason, image_url, source):
    return {
        "visual_task_id": task_id,
        "source": source,
        "verdict": verdict_,
        "reason": reason,
        "scene_type": scene_type(brief, rr),
        "render_mode": brief.get("render_mode"),
        "aspect": brief.get("aspect"),
        "product_name": brief.get("product_name"),
        "scene_brief": brief.get("scene_brief"),
        "slides": brief.get("slides"),
        "original_image_url": image_url,
        "image_url": preserve(image_url),
    }

# 1. Everything the owner rejected in the review UI.
for p in posts:
    rd = p["result_data"] or {}
    if verdict(rd) != "rejected":
        continue
    par = parents.get(p["parent_task_id"]) or {}
    img = rd.get("image_url") or ((rd.get("carousel_children") or [None])[0])
    entries.append(entry(par.get("id"), par.get("brief_data") or {}, par.get("render_response"), "rejected",
                         rd.get("reject_reason"), img, "review_ui"))
    seen.add(par.get("id"))

# 2. Images reported in chat.
for prefix, reason in REPORTED.items():
    nxt = format(int(prefix, 16) + 1, "08x")
    rows = get(f"seo_tasks?id=gte.{prefix}-0000-0000-0000-000000000000&id=lt.{nxt}-0000-0000-0000-000000000000"
               "&select=id,brief_data,result_data")
    for row in rows:
        if row["id"] in seen:
            continue
        rd = row["result_data"] or {}
        entries.append(entry(row["id"], row["brief_data"] or {}, rd.get("render_response"), "reported_bad",
                             reason, rd.get("image_url"), "owner_chat"))
        seen.add(row["id"])

# 3. Published posts: the most recent per scene type, up to 3 each, so the set
#    also guards against making good scenes worse.
by_scene = collections.defaultdict(list)
for p in reversed(posts):
    rd = p["result_data"] or {}
    par = parents.get(p["parent_task_id"]) or {}
    if verdict(rd) != "published" or not par or par.get("id") in seen:
        continue
    by_scene[scene_type(par.get("brief_data") or {}, par.get("render_response"))].append((p, par))
for scene, rows in by_scene.items():
    for p, par in rows[:3]:
        rd = p["result_data"] or {}
        img = rd.get("image_url") or ((rd.get("carousel_children") or [None])[0])
        entries.append(entry(par["id"], par.get("brief_data") or {}, par.get("render_response"), "published",
                             None, img, "review_ui"))
        seen.add(par["id"])

os.makedirs("docs/image-pipeline", exist_ok=True)
out = "docs/image-pipeline/golden_set.json"
with open(out, "w") as f:
    json.dump({"note": "Built by scripts/image-pipeline.sh golden. Re-render these briefs old-vs-new before shipping a prompt, model or judge change.",
               "entries": entries}, f, ensure_ascii=False, indent=1)
c = collections.Counter(e["verdict"] for e in entries)
print(f"wrote {out}: {len(entries)} entries {dict(c)}; images preserved in golden/: {sum(1 for e in entries if e['image_url'])}")
PY
