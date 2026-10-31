#!/usr/bin/env python3
"""Download every product (+ variations) from the WooCommerce REST API into <outdir>/products.json, variations.json."""
import os, json, base64, urllib.request, urllib.parse, sys
base = os.environ['WOO_URL'].rstrip('/') + '/wp-json/wc/v3'
auth = 'Basic ' + base64.b64encode(f"{os.environ['WOO_KEY']}:{os.environ['WOO_SECRET']}".encode()).decode()
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
def get(path, params):
    req = urllib.request.Request(base + path + '?' + urllib.parse.urlencode(params), headers={'Authorization': auth, 'User-Agent': 'coffeeflow-audit'})
    with urllib.request.urlopen(req, timeout=60) as r: return json.load(r), r.headers.get('X-WP-TotalPages')
def pages(path, **kw):
    res, page = [], 1
    while True:
        data, tp = get(path, dict(per_page=100, page=page, status='any', **kw)); res += data
        if not data or page >= int(tp or 1): return res
        page += 1
prods = pages('/products')
json.dump(prods, open(f'{out}/products.json', 'w'), ensure_ascii=False, indent=1)
var = {p['id']: pages(f"/products/{p['id']}/variations") for p in prods if p['type'] == 'variable'}
json.dump(var, open(f'{out}/variations.json', 'w'), ensure_ascii=False, indent=1)
print(len(prods), 'products', sum(len(v) for v in var.values()), 'variations')
