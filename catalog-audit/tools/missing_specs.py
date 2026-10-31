#!/usr/bin/env python3
"""Find visible coffee-equipment products whose page lacks key spec items. Writes raw/missing_specs.json."""
import json, re, html, collections, sys
P = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'backup/before-specs/products.json'))
def text(p): return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', p['short_description'] + ' ' + p['description']))).strip()
ACCESSORY = r'^\s*(\d+\s*)?(סלסל|ידית|מברשת|פילטר(?! קפה)|אטם|מקרר|מתאם|צנצנת|סט |ניירות|מסננת|חלק|מגש|כיסוי|מכסה|צינור|דוחסן|נרתיק|תרמוס|קרטון|טבליות|ערכת ניקוי|נוזל|אבקת|שני פילטר|כד|כוס|ספל)'
def group(p):
    cs = ' | '.join(c['name'] for c in p['categories']); n = html.unescape(p['name'])
    if re.search(ACCESSORY, n) or re.search(r'אטם ראש|סלסלת|למכונות קפה|למכונת קפה|למטחנ|צנצנת', n): return None
    if re.search(r'מכונת קפה פילטר|filter coffee', n, re.I): return 'filter_machine'
    if re.search(r'מטחנ', n) or (re.search(r'מטחנות קפה', cs) and not re.search(r'צנצנת|ידית|מברשת|סכינ|חלק|כיסוי|מכסה|קערית|jar', n, re.I)): return 'grinder'
    if re.search(r'מכונ(ת|ות) (קפה|אספרסו)|espresso machine', n, re.I) or (re.search(r'מכונות קפה', cs) and re.search(r'מכונ', n)):
        if re.search(r'טוחנות|אוטומטי', cs + n): return 'superauto'
        if re.search(r'קפסול|נספרסו|דולצ|nespresso', cs + n, re.I): return 'capsule_machine'
        return 'espresso'
    if re.search(r'קומקום|kettle', n, re.I): return 'kettle'
    if re.search(r'משקל', n) and re.search(r'משקלים', cs): return 'scale'
    if re.search(r'מכשירי חליטה|קפה פילטר ואביזרים|השרייה קרה|מקינטה', cs) and re.search(r'דריפר|dripper|קנקן|פרנץ|פלנג|מקינטה|כימקס|chemex|v60|aeropress|אירופרס|clever|קולד ברו|cold brew|סיפון|מוקה|moka', n, re.I) and not re.search(r'פילטר(ים)? נייר|פילטרים|filters|שקיות|גומי|אטם|חלק', n, re.I): return 'brewer'
    return None
CHECK = {
 'power': r'וואט|ואט|\d\s?W\b|הספק',
 'dimensions': r'מידות|רוחב|גובה|עומק|dimensions|\d+\s?[xX×]\s?\d+',
 'weight': r'משקל|ק["״]ג|ק״ג|\bkg\b',
 'water_tank': r'מיכל (ה)?מים|water tank',
 'boiler': r'דוד|boiler|מחליף חום|תרמובלוק|thermoblock|thermo ?coil|תרמוקויל',
 'pressure': r'\d+\s?(בר|bar)\b',
 'portafilter': r'(51|53|54|57|58)\s?(מ["״]?מ|mm)|פורטפילטר|ידית (החליטה|ה?פילטר)',
 'burrs': r'סכינ|להב|burr',
 'burr_size': r'(סכינ|להב|burr)[^.]{0,40}\d{2}\s?(מ["״]?מ|mm)|\d{2}\s?(מ["״]?מ|mm)[^.]{0,30}(סכינ|להב|burr)',
 'speed': r'סל["״]ד|rpm',
 'hopper': r'מיכל (ה)?פולים|hopper|קיבולת[^.]{0,20}גרם',
 'bean_hopper': r'מיכל (ה)?פולים|bean',
 'capacity': r'\d+\s?(מ["״]ל|מל|ml|ליטר|כוסות|cups)',
 'material': r'נירוסטה|זכוכית|קרמיקה|פלסטיק|אלומיניום|נחושת|stainless|glass|ceramic|borosilicate|בורוסיליקט|פורצלן',
}
NEED = {
 'espresso': ['power', 'dimensions', 'weight', 'water_tank', 'boiler', 'pressure', 'portafilter'],
 'superauto': ['power', 'dimensions', 'weight', 'water_tank', 'pressure', 'bean_hopper'],
 'capsule_machine': ['power', 'dimensions', 'weight', 'water_tank', 'pressure'],
 'grinder': ['power', 'dimensions', 'weight', 'burrs', 'burr_size', 'speed', 'hopper'],
 'kettle': ['power', 'capacity', 'material'],
 'scale': ['dimensions', 'weight'],
 'brewer': ['capacity', 'material'],
 'filter_machine': ['power', 'capacity', 'dimensions', 'weight'],
}
out = []
for p in P:
    if p['status'] != 'publish' or p['catalog_visibility'] == 'hidden': continue
    g = group(p)
    if not g: continue
    t = text(p)
    miss = [k for k in NEED[g] if not re.search(CHECK[k], t, re.I)]
    out.append(dict(id=p['id'], name=p['name'], group=g, missing=miss, text_len=len(t), permalink=p['permalink']))
json.dump(out, open('raw/missing_specs.json', 'w'), ensure_ascii=False, indent=1)
c = collections.Counter(o['group'] for o in out); m = collections.Counter(o['group'] for o in out if o['missing'])
print('equipment products:', dict(c)); print('with something missing:', dict(m), 'total', sum(m.values()))
print('missing items:', collections.Counter(k for o in out for k in o['missing']).most_common())
print('empty/near-empty pages (<150 chars):', [(o['id'], o['name'][:40]) for o in out if o['text_len'] < 150])
