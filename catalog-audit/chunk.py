#!/usr/bin/env python3
"""Split visible non-coffee products into review chunks (raw/chunks/chunk_N.txt), families kept together."""
import json,re,html,collections,os
D=os.path.dirname(os.path.abspath(__file__))
P=json.load(open(f'{D}/raw/products.json')); V={int(k):v for k,v in json.load(open(f'{D}/raw/variations.json')).items()}
COFFEE={d['id'] for d in json.load(open(f'{D}/raw/coffee_products_clean.json'))}
def strip(h):
    h=re.sub(r'<(br|/p|/li|/h\d|/div|/tr)[^>]*>','\n',h or '',flags=re.I); h=re.sub(r'<[^>]+>',' ',h)
    return re.sub(r'[ \t]+',' ',re.sub(r'\n\s*\n+','\n',html.unescape(h))).strip()
CAT_ORDER=['מכונות קפה','מטחנות קפה','קפסולות קפה','ספלים וכוסות קפה','חומרי ניקוי ותחזוקה לקפה','קפה פילטר ואביזרים','מוצרים לטיפול במים','תה - חליטות','מוצרים נלווים']
def top(p):
    cs=[c['name'] for c in p['categories']]
    for c in CAT_ORDER:
        if c in cs: return c
    return cs[0] if cs else '-'
def fam(name):
    n=re.sub(r'(צבע|בצבע)\s+\S+|[-–|]\s*\S+\s*$','',name.lower())
    return re.sub(r'[^a-z0-9א-ת ]','',n).split()[:5]
vis=[p for p in P if p['catalog_visibility']!='hidden' and p['id'] not in COFFEE]
vis.sort(key=lambda p:(CAT_ORDER.index(top(p)) if top(p) in CAT_ORDER else 99, top(p), ' '.join(fam(p['name']))))
def rec(p):
    vs=V.get(p['id'],[])
    out=[f"### ID {p['id']} | {p['status']} | {p['type']} | {p['permalink']}",
         f"NAME: {strip(p['name'])}", f"PRICE: {p['price']} (regular {p['regular_price'] or '-'}, sale {p['sale_price'] or '-'}) | SKU: {p['sku'] or '-'} | stock: {p['stock_status']} | weight: {p['weight'] or '-'} | dims: {'x'.join(v for v in p['dimensions'].values() if v) or '-'} | images: {len(p['images'])}",
         f"CATEGORIES: {', '.join(c['name'] for c in p['categories'])}"]
    if p['attributes']: out.append('ATTRIBUTES: '+' ; '.join(f"{a['name']}: {', '.join(a['options'])}" for a in p['attributes']))
    for v in vs: out.append(f"  VARIATION {v['id']}: {', '.join(a['option'] for a in v['attributes'])} | price {v['price']} | SKU {v['sku'] or '-'} | {v['stock_status']}")
    out.append('SHORT: '+strip(p['short_description']))
    d=strip(p['description'])
    out.append('DESCRIPTION: '+(d[:7000]+' [...truncated]' if len(d)>7000 else d))
    return '\n'.join(out)+'\n'
os.makedirs(f'{D}/raw/chunks',exist_ok=True)
recs=[(top(p),rec(p)) for p in vis]
total=sum(len(r) for _,r in recs); n=8; target=total/n
chunks=[[]]; size=0; prevfam=None
for (t,r),p in zip(recs,vis):
    f=fam(p['name'])
    if size>=target and f!=prevfam and len(chunks)<n: chunks.append([]); size=0
    chunks[-1].append((t,r)); size+=len(r); prevfam=f
for i,c in enumerate(chunks,1):
    open(f'{D}/raw/chunks/chunk_{i}.txt','w').write(''.join(r for _,r in c))
    print(i,len(c),sum(len(r) for _,r in c),collections.Counter(t for t,_ in c).most_common(3))
