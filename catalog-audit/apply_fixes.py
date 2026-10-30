#!/usr/bin/env python3
"""Validate and apply fix plans to the live WooCommerce store.
   python3 apply_fixes.py            # dry run: validate every edit against the live data, write fix_report.csv
   python3 apply_fixes.py --apply    # write changes (one PUT per product), backing up each product first"""
import base64, csv, glob, json, os, re, sys, time, urllib.request, urllib.parse
D = os.path.dirname(os.path.abspath(__file__))
APPLY = '--apply' in sys.argv
ONLY = {int(a.split('=')[1]) for a in sys.argv if a.startswith('--only=')}
BASE = os.environ['WOO_URL'].rstrip('/') + '/wp-json/wc/v3'
AUTH = 'Basic ' + base64.b64encode(f"{os.environ['WOO_KEY']}:{os.environ['WOO_SECRET']}".encode()).decode()

def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': AUTH, 'Content-Type': 'application/json', 'User-Agent': 'coffeeflow-audit'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r: return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code < 500: raise RuntimeError(f'{e.code} {e.read()[:300]!r}')
        except Exception: pass
        time.sleep(2 ** (attempt + 1))
    raise RuntimeError('request failed after retries')

tags = lambda s: re.findall(r'<[^>]+>', s)
edits = []
for f in sorted(g for g in glob.glob(f'{D}/raw/fix_plans/*.json') if not g.endswith('hold.json')):
    for e in json.load(open(f))['edits']: e['_plan'] = os.path.basename(f); edits.append(e)

live = {}   # (product_id, variation_id) -> current object
def get(pid, vid):
    k = (pid, vid)
    if k not in live: live[k] = call('GET', f'/products/{pid}' + (f'/variations/{vid}' if vid else ''))
    return live[k]

def field_value(obj, target):
    if target.startswith('meta:'):
        for m in obj['meta_data']:
            if m['key'] == target[5:]: return m['value']
        return None
    if target.startswith(('attribute:', 'set:')): return None
    return obj.get(target)

work, report = {}, []   # work: key -> {target: new value}
HOLD = json.load(open(f'{D}/raw/fix_plans/hold.json')) if os.path.exists(f'{D}/raw/fix_plans/hold.json') else {}
for e in edits:
    if str(e['product_id']) in HOLD:
        report.append(dict(product_id=e['product_id'], variation_id='', target=e['target'], status='held', reason=HOLD[str(e['product_id'])], old=e['old'][:200], new=e['new'][:200], finding=e.get('finding','')[:150], plan=e['_plan'])); continue
    pid, vid, t = int(e['product_id']), e.get('variation_id') or None, e['target']
    status, why = 'ok', ''
    try:
        obj = get(pid, vid)
        w = work.setdefault((pid, vid), {})
        if t.startswith('set:'):
            k = t[4:]
            if k not in ('catalog_visibility',): status, why = 'rejected', 'field not allowed'
            elif str(w.get(k, obj.get(k))) != e['old']: status, why = 'rejected', f"current value is {obj.get(k)!r}"
            else: w[k] = e['new']
        elif t.startswith('attribute:'):
            name = t[len('attribute:'):]
            attrs = w.get('attributes') or json.loads(json.dumps(obj['attributes']))
            a = next((a for a in attrs if a['name'] == name), None)
            if vid: status, why = 'rejected', 'variation attributes not supported'
            elif a and (a.get('id') or a.get('variation')): status, why = 'skipped', 'global or variation attribute: change by hand'
            elif not a or e['old'] not in a['options']: status, why = 'rejected', 'old option not found'
            elif e['new'] in a['options']: status, why = 'rejected', 'new option already present'
            else:
                a['options'] = [e['new'] if o == e['old'] else o for o in a['options']]; w['attributes'] = attrs
        else:
            cur = w.get(t, field_value(obj, t))
            if cur is None: status, why = 'rejected', 'field not present'
            elif cur.count(e['old']) != 1: status, why = 'rejected', f"old text found {cur.count(e['old'])}× (must be 1)"
            elif not e['old']: status, why = 'rejected', 'empty old'
            elif tags(e['old']) != tags(e['new']): status, why = 'rejected', 'HTML tags changed'
            elif e['old'] == e['new']: status, why = 'rejected', 'no change'
            else: w[t] = cur.replace(e['old'], e['new'], 1)
    except Exception as ex: status, why = 'error', str(ex)[:200]
    report.append(dict(product_id=pid, variation_id=vid or '', target=t, status=status, reason=why, old=e['old'][:200], new=e['new'][:200], finding=e.get('finding', '')[:150], plan=e['_plan']))

os.makedirs(f'{D}/backup/per-product', exist_ok=True)
applied = 0
for (pid, vid), w in work.items():
    if not w or (ONLY and pid not in ONLY): continue
    body = {}
    for t, v in w.items():
        if t.startswith('meta:'): body.setdefault('meta_data', []).append({'key': t[5:], 'value': v})
        else: body[t] = v
    if not APPLY: continue
    obj = live[(pid, vid)]
    json.dump(obj, open(f"{D}/backup/per-product/{pid}{'-' + str(vid) if vid else ''}.json", 'w'), ensure_ascii=False)
    try:
        res = call('PUT', f'/products/{pid}' + (f'/variations/{vid}' if vid else ''), body)
        ok = all((res.get(t) == v) if not t.startswith(('meta:', 'attributes')) else True for t, v in w.items())
        for r in report:
            if r['product_id'] == pid and (r['variation_id'] or None) == vid and r['status'] == 'ok': r['status'] = 'applied' if ok else 'applied-unverified'
        applied += 1
    except Exception as ex:
        for r in report:
            if r['product_id'] == pid and (r['variation_id'] or None) == vid and r['status'] == 'ok': r['status'], r['reason'] = 'error', str(ex)[:200]
    time.sleep(0.3)

with open(f'{D}/fix_report.csv', 'w', newline='', encoding='utf-8-sig') as f:
    wr = csv.DictWriter(f, fieldnames=list(report[0].keys()) if report else ['status']); wr.writeheader(); wr.writerows(report)
from collections import Counter
print('APPLY' if APPLY else 'DRY RUN', Counter(r['status'] for r in report), 'products written:', applied)
