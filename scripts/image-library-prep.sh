#!/usr/bin/env bash
# CoffeeFlow — prepare the real-photo library for the shot library.
#
#   ./scripts/image-library-prep.sh                    # all folders, new photos only
#   ./scripts/image-library-prep.sh hands              # one folder
#   ./scripts/image-library-prep.sh --force bag_scenes # redo already-prepared photos
#
# Real-photo shots (docs/image-pipeline/plan.md) publish Minuto's own photos
# without redrawing them: letting an image model "reframe" a photo to 9:16
# rotated it, re-staged it or added hands. So the crop happens here, once,
# deterministically:
#
#   marketing/upload_images/<folder>/<photo>
#     → marketing/upload_images_ready/9x16/<folder>/<photo>.jpg  (1080×1920, stories)
#     → marketing/upload_images_ready/4x5/<folder>/<photo>.jpg   (1080×1350, feed)
#     → marketing/upload_images_ready/1x1/<folder>/<photo>.jpg   (1080×1080, square feed)
#
# A vision model (Gemini) only answers WHERE the main subject is; ffmpeg crops
# around it. Every photo also gets the house look (owner-approved 2026-10-28):
# a warm grade, a little more contrast, light sharpening, nothing blurred,
# EXCEPT car licence plates, each covered by its own small blur patch. The
# coffee_bags/ studio packshots get no grade. Photos listed in docs/image-pipeline/library_exclude.txt (order
# tickets with customer names, green coffee, bad crops) are never prepared,
# and an existing prepared copy is deleted. coffee_bags/ packshots are padded onto white instead of cropped,
# so the label is never touched. Already-prepared photos are skipped.
#
# After a photo shoot: upload to upload_images/<folder>/ (bag photos go in
# upload_images/bag_scenes/), run this, and check the contact sheets it prints.
#
# Runs on the Mac (needs ffmpeg + sips). Needs SUPABASE_URL,
# SUPABASE_SERVICE_ROLE_KEY and GEMINI_API_KEY (scripts/secrets-doctor.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SUPABASE_URL:?}"; : "${SUPABASE_SERVICE_ROLE_KEY:?}"; : "${GEMINI_API_KEY:?}"
command -v ffmpeg >/dev/null || { echo "ffmpeg is required (brew install ffmpeg)" >&2; exit 1; }

FORCE=0
if [ "${1:-}" = "--force" ]; then FORCE=1; shift; fi
FOLDERS="${*:-hands machine pitchers roaster brewing beans cups coffee_bags bag_scenes}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

FORCE=$FORCE python3 - "$WORK" $FOLDERS <<'PY'
import json, math, os, subprocess, sys, time, urllib.request, urllib.parse, base64

work, folders = sys.argv[1], sys.argv[2:]
BASE, KEY, GKEY = os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"], os.environ["GEMINI_API_KEY"]
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
TARGETS = {"9x16": (1080, 1920), "4x5": (1080, 1350), "1x1": (1080, 1080)}
FORCE = os.environ.get("FORCE") == "1"
# The house look. Owner-approved 2026-10-28: warm, a touch more contrast,
# light sharpening — and no blur anywhere except licence plates.
GRADE = "colortemperature=temperature=5700:mix=0.3,eq=contrast=1.07:saturation=1.06:gamma=0.98,unsharp=5:5:0.4"

def gemini_json(jpg, text):
    b64 = base64.b64encode(open(jpg, "rb").read()).decode()
    body = {"contents": [{"parts": [{"inlineData": {"mimeType": "image/jpeg", "data": b64}}, {"text": text}]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0}}
    r = urllib.request.Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
                               data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": GKEY})
    out = json.load(urlopen_retry(r))
    return json.loads("".join(p.get("text", "") for p in out["candidates"][0]["content"]["parts"]))

def plate_boxes(jpg):
    """Licence-plate boxes (0-1000). Israeli plates are yellow; the generic
    'list plates' prompt missed a clearly visible one in testing."""
    raw = gemini_json(jpg, "Detect every car licence plate in the image (Israeli plates are yellow rectangles with black digits, "
        "on the front or back of cars, including cars seen through a window). Return a JSON list of objects "
        "{\"box_2d\": [ymin, xmin, ymax, xmax], \"label\": \"licence plate\"}, coordinates normalised to 0-1000. "
        "Return [] only if no car plate is visible.")
    items = raw.get("plates", []) if isinstance(raw, dict) else raw
    if len(items) == 4 and all(isinstance(v, (int, float)) for v in items):
        items = [items]
    boxes = []
    for it in items or []:
        if isinstance(it, dict):
            it = it.get("box_2d") or it.get("box")
        if isinstance(it, list) and len(it) == 4:
            boxes.append([float(v) for v in it])
    return boxes

def house_look(src, dst, w, h):
    """Blur each licence plate (box padded 40%), then apply the grade."""
    boxes = plate_boxes(src)
    chain, last = ["[0]null[v0]"], "v0"
    for i, (y0, x0, y1, x1) in enumerate(boxes):
        bw, bh = (x1 - x0) / 1000 * w, (y1 - y0) / 1000 * h
        X, Y = max(0, int(x0 / 1000 * w - bw * .4)), max(0, int(y0 / 1000 * h - bh * .4))
        W, Hh = min(w - X, int(bw * 1.8)), min(h - Y, int(bh * 1.8))
        if W < 4 or Hh < 4:
            continue
        chain.append(f"[{last}]split[s{i}][t{i}];[t{i}]crop={W}:{Hh}:{X}:{Y},gblur=sigma=14[p{i}];[s{i}][p{i}]overlay={X}:{Y}[v{i+1}]")
        last = f"v{i+1}"
    chain.append(f"[{last}]{GRADE},format=yuvj420p")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src, "-filter_complex", ";".join(chain),
                    "-frames:v", "1", "-q:v", "2", "-strict", "unofficial", dst], check=True)
    return len(boxes)

def urlopen_retry(r, timeout=120, tries=4):
    # Storage and Gemini both throw the odd 5xx (a 520 stopped a full run);
    # retry those with backoff, fail fast on anything else.
    for i in range(tries):
        try:
            return urllib.request.urlopen(r, timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code < 500 or i == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if i == tries - 1:
                raise
        time.sleep(2 ** i * 3)

def req(url, data=None, headers=None, method=None):
    r = urllib.request.Request(url, data=data, headers={**H, **(headers or {})}, method=method)
    return urlopen_retry(r)

def listing(prefix):
    body = json.dumps({"prefix": prefix, "limit": 1000}).encode()
    rows = json.load(req(f"{BASE}/storage/v1/object/list/marketing", body, {"Content-Type": "application/json"}))
    return [r["name"] for r in rows if r.get("id")]

def subject_box(jpg):
    """Box (0..1: x0, y0, x1, y1) around ALL main subjects together — the bag
    AND the glass beside it, hands AND what they hold. Centring on one object
    cut the espresso glass off the edge of several 9:16 bag crops."""
    b64 = base64.b64encode(open(jpg, "rb").read()).decode()
    body = {"contents": [{"parts": [
        {"inlineData": {"mimeType": "image/jpeg", "data": b64}},
        {"text": "This photo will be cropped to a narrow vertical frame. Give ONE box that contains ALL of its main "
                 "subjects together: every coffee bag, cup or glass, the hands and what they hold, the machine part in "
                 "focus, the roaster, the brewing equipment, the beans. Also give the box of the single HERO object "
                 "(the coffee bag if there is one, otherwise the most important subject). "
                 "JSON {\"box_2d\": [ymin, xmin, ymax, xmax], \"hero\": [ymin, xmin, ymax, xmax]}, values 0-1000."}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0}}
    r = urllib.request.Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
                               data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": GKEY})
    out = json.load(urlopen_retry(r))
    j = json.loads("".join(p.get("text", "") for p in out["candidates"][0]["content"]["parts"]))
    if isinstance(j, list) and j and isinstance(j[0], dict):
        j = j[0]
    def norm(b):
        y0, x0, y1, x1 = [min(max(float(v) / 1000, 0), 1) for v in b]
        return x0, y0, x1, y1
    try:
        group = norm(j["box_2d"])
    except Exception:
        group = (0.25, 0.25, 0.75, 0.75)
    try:
        hero = norm(j["hero"])
    except Exception:
        hero = group
    return group, hero

def dims(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                          "-of", "json", path], capture_output=True, text=True).stdout
    s = json.loads(out)["streams"][0]; return s["width"], s["height"]

def crop_filter(w, h, tw, th, boxes):
    # Largest box of the target ratio inside the photo. The whole subject
    # group stays inside when it fits; when it doesn't (bag and glass far
    # apart at the counter), the HERO (the bag) stays whole and the crop
    # leans toward the rest of the group.
    (gx0, gy0, gx1, gy1), (hx0, hy0, hx1, hy1) = boxes
    ratio = tw / th
    cw, ch = (w, round(w / ratio)) if w / h < ratio else (round(h * ratio), h)
    def place(glo, ghi, hlo, hhi, size, total):
        glo, ghi, hlo, hhi = glo * total, ghi * total, hlo * total, hhi * total
        lo, hi = (glo, ghi) if ghi - glo <= size else (hlo, hhi)
        start = (glo + ghi) / 2 - size / 2
        if hi - lo <= size:
            start = min(max(start, math.ceil(hi) - size), math.floor(lo))
        return int(min(max(start, 0), total - size))
    return f"crop={cw}:{ch}:{place(gx0, gx1, hx0, hx1, cw, w)}:{place(gy0, gy1, hy0, hy1, ch, h)},scale={tw}:{th}"

EXCLUDE = set()
for line in open("docs/image-pipeline/library_exclude.txt", encoding="utf-8"):
    line = line.split("#", 1)[0].strip()
    if line:
        ratio, path = line.split()
        for t in (TARGETS if ratio == "*" else [ratio]):
            EXCLUDE.add((t, path))

def delete(path):
    body = json.dumps({"prefixes": [path]}).encode()
    req(f"{BASE}/storage/v1/object/marketing", body, {"Content-Type": "application/json"}, "DELETE")

done = skipped = removed = 0
for folder in folders:
    names = [n for n in listing(f"upload_images/{folder}/") if n.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".heic"))]
    if not names:
        print(f"{folder}: no photos"); continue
    ready = {t: set(listing(f"upload_images_ready/{t}/{folder}/")) for t in TARGETS}
    for name in names:
        out_name = os.path.splitext(name)[0] + ".jpg"
        for t in TARGETS:
            if (t, f"{folder}/{name}") in EXCLUDE and out_name in ready[t]:
                delete(f"upload_images_ready/{t}/{folder}/{out_name}"); ready[t].discard(out_name); removed += 1
                print(f"  {folder}/{name} → excluded from {t}, prepared copy removed")
        wanted = [t for t in TARGETS if (t, f"{folder}/{name}") not in EXCLUDE]
        if not FORCE and all(out_name in ready[t] for t in wanted):
            skipped += 1; continue
        src = os.path.join(work, "src_" + name)
        with open(src, "wb") as f:
            f.write(req(f"{BASE}/storage/v1/object/public/marketing/upload_images/{folder}/{urllib.parse.quote(name)}").read())
        # Normalise first (HEIC/PNG/rotation flag → plain upright JPEG).
        flat = os.path.join(work, "flat.jpg")
        subprocess.run(["sips", "-s", "format", "jpeg", src, "--out", flat], capture_output=True, check=True)
        w, h = dims(flat)
        box = ((0.25, 0.25, 0.75, 0.75),) * 2 if folder == "coffee_bags" else subject_box(flat)
        n_plates = 0
        if folder != "coffee_bags":
            looked = os.path.join(work, "look.jpg")
            n_plates = house_look(flat, looked, w, h)
            flat = looked
        for t, (tw, th) in TARGETS.items():
            if (out_name in ready[t] and not FORCE) or t not in wanted:
                continue
            if folder == "coffee_bags":
                # Packshot: fit inside the frame on white, never cropped.
                vf = f"scale={tw}:{th}:force_original_aspect_ratio=decrease,pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:color=white"
            else:
                vf = crop_filter(w, h, tw, th, box)
            dst = os.path.join(work, f"{t}.jpg")
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", flat, "-vf", vf + ",format=yuvj420p",
                            "-q:v", "3", "-strict", "unofficial", dst], check=True)
            req(f"{BASE}/storage/v1/object/marketing/upload_images_ready/{t}/{folder}/{urllib.parse.quote(out_name)}",
                open(dst, "rb").read(), {"Content-Type": "image/jpeg", "x-upsert": "true"}, "POST")
        done += 1
        print(f"  {folder}/{name} → ready (group x {box[0][0]:.2f}-{box[0][2]:.2f}, hero x {box[1][0]:.2f}-{box[1][2]:.2f}{f', {n_plates} plate(s) blurred' if n_plates else ''})")
print(f"prepared {done}, already ready {skipped}, excluded copies removed {removed}")
print(f"review: {BASE}/storage/v1/object/public/marketing/upload_images_ready/9x16/<folder>/<photo>.jpg")
PY
