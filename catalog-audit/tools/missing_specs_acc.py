#!/usr/bin/env python3
"""Missing-spec scan for cups/glassware and accessories. Writes raw/missing_specs_acc.json."""
import json, re, html, collections, sys
P = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'backup/before-models/products.json'))
def text(p): return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', p['short_description'] + ' ' + p['description']))).strip()
def group(p):
    n = html.unescape(p['name']); cs = ' | '.join(c['name'] for c in p['categories'])
    if re.search(r'ספלים וכוסות|Loveramics|notNeutral|Club House|Egg Mug|KRUVE|NOMAD|כוסות קפה', cs) or re.search(r'^(\d+\s*)?(ספל|כוס|כוסות|סט כוסות|סט ספלים|תחתית|צלוחית)', n): return 'cup'
    if re.search(r'כד(י)? הקצפה|milk (jug|pitcher)|קנקן הקצפה|כד חלב', n + cs, re.I): return 'milk_jug'
    if re.search(r'דוחסן|tamper|מפזר|distributor|leveler|WDT', n, re.I): return 'tamper'
    if re.search(r'נוק ?בוקס|knock|מגירת ריקון|פח ריקון|סיר ריקון', n + cs, re.I): return 'knockbox'
    if re.search(r'סלסל|basket|ידית (חליטה|חתוכה)|portafilter|מסננת ראש|shower', n, re.I): return 'basket_portafilter'
    if re.search(r'משקל', n) and re.search(r'משקלים', cs): return 'scale'
    if re.search(r'פילטר(ים)? מים|מסנן מים|מרכך|אוסמוזה|BRITA|Aquaphor|CLARIS|AquaClean|טיפול במים', n + cs, re.I): return 'water'
    if re.search(r'חומרי ניקוי|טבליות|אבקת ניקוי|נוזל ניקוי|מסיר אבנית|descal', n + cs, re.I): return 'cleaning'
    if re.search(r'קופסאות אחסון|Airscape|מיכל אחסון|canister', n + cs, re.I): return 'storage'
    if re.search(r'מקציף|nanofoamer|frother', n, re.I): return 'frother'
    return None
CHECK = {
 'volume': r'\d+\s?(מ["״”]?ל|מל|ml|oz|ליטר)', 'material': r'פורצלן|קרמיקה|זכוכית|נירוסטה|פלסטיק|אלומיניום|עץ|נחושת|סיליקון|porcelain|ceramic|glass|stainless|borosilicate|בורוסיליקט|טרקוטה|חרס',
 'dishwasher': r'מדיח|dishwasher', 'dimensions': r'מידות|קוטר|גובה|רוחב|עומק|\d+\s?[xX×]\s?\d+', 'diameter': r'(49|51|53|53\.3|54|57|58|58\.3|58\.4|58\.5)\s?(מ["״]?מ|mm)',
 'weight': r'משקל|ק["״]ג|גרם', 'capacity_g': r'\d+\s?(גרם|גר׳|גר\b|g\b)|\d+\s?(מ["״]?ל|ליטר)', 'quantity': r'\d+\s?(יח|יחידות|טבליות|שקיות|שקיקים|מנות|גרם|מ["״]?ל|ליטר)',
 'compatibility': r'מתאים|תואם|למכונות|למכונת|עבור|compatible', 'filter_life': r'ליטר|חודש|כוסות|liters|months',
 'power': r'וואט|W\b|הספק|סוללה|battery|USB',
}
NEED = {'cup': ['volume', 'material', 'dishwasher'], 'milk_jug': ['volume', 'material'], 'tamper': ['diameter', 'material'],
        'knockbox': ['dimensions', 'material'], 'basket_portafilter': ['diameter', 'compatibility'], 'scale': ['dimensions', 'weight'],
        'water': ['compatibility', 'filter_life'], 'cleaning': ['quantity', 'compatibility'], 'storage': ['capacity_g', 'material'],
        'frother': ['volume', 'power']}
out = []
for p in P:
    if p['status'] != 'publish' or p['catalog_visibility'] == 'hidden': continue
    g = group(p)
    if not g: continue
    t = text(p); miss = [k for k in NEED[g] if not re.search(CHECK[k], t, re.I)]
    out.append(dict(id=p['id'], name=p['name'], group=g, missing=miss, text_len=len(t), permalink=p['permalink']))
json.dump(out, open('raw/missing_specs_acc.json', 'w'), ensure_ascii=False, indent=1)
c = collections.Counter(o['group'] for o in out); m = collections.Counter(o['group'] for o in out if o['missing'])
print('products:', dict(c)); print('with gaps:', dict(m), 'total', sum(m.values()))
print('missing items:', collections.Counter(k for o in out for k in o['missing']).most_common())
