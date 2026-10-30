#!/usr/bin/env python3
"""Cross-variant checks: products that differ only by colour should share price and numeric specs."""
import json,re,html,collections,os
D=os.path.dirname(os.path.abspath(__file__))
P=json.load(open(f'{D}/raw/products.json'))
COLORS=r"(בצבע|צבע)?\s*(שחור(ה)?|לבנ?ה?|לבן|אדום|אדומה|כחול(ה)?|ירוק(ה)?|צהוב(ה)?|כתום|ורוד(ה)?|סגול(ה)?|אפור(ה)?|כסף|כסוף|כסופה|זהב|קרם|תכלת|טורקיז|חום|בז'?|מוקה|נחושת|ברונזה|כרום|מט|מבריק|לבנדר|מנטה|חול|שמנת|בורדו|קרמל|אבן|פחם|ניקל|רוז|אינדיגו|זית|black|white|red|blue|green|yellow|orange|pink|purple|grey|gray|silver|gold|cream|copper|brass|chrome|matte?|mint|beige|brown|navy|sand|stone|ivory|charcoal|rose|olive|teal|sky|lavender|burgundy)\b"
def strip(h): return re.sub(r'\s+',' ',html.unescape(re.sub(r'<[^>]+>',' ',h or ''))).strip()
def key(n):
    n=strip(n).lower(); n=re.sub(COLORS,' ',n,flags=re.I)
    n=re.sub(r'[\-–|,()"״׳\'/]',' ',n); return ' '.join(n.split())
UNITS={'W':r'(\d{3,4})\s*(?:w\b|וואט|ואט)','bar':r'(\d{1,2})\s*(?:bar|בר)\b','L':r'(\d(?:[.,]\d+)?)\s*(?:ליטר|liter|l)\b','ml':r'(\d{2,4})\s*(?:מ״ל|מ"ל|מל|ml)\b','mm':r'(\d{2,3})\s*(?:מ״מ|מ"מ|מ\'מ|mm)\b'}
vis=[p for p in P if p['catalog_visibility']!='hidden' and p['status']=='publish']
groups=collections.defaultdict(list)
for p in vis: groups[key(p['name'])].append(p)
out=[]
for k,ps in groups.items():
    if len(ps)<2: continue
    prices={p['id']:float(p['price'] or 0) for p in ps}
    if len(set(prices.values()))>1: out.append(('price',k,ps,prices))
    for u,rx in UNITS.items():
        vals={p['id']:tuple(sorted(set(re.findall(rx,strip(p['description']+' '+p['short_description']).lower())))) for p in ps}
        nonempty={i:v for i,v in vals.items() if v}
        if len(nonempty)>=2 and len(set(nonempty.values()))>1: out.append((u,k,ps,nonempty))
json.dump([dict(kind=a,key=k,ids=[p['id'] for p in ps],names={p['id']:strip(p['name']) for p in ps},values={str(i):v for i,v in d.items()}) for a,k,ps,d in out],open(f'{D}/raw/family_diffs.json','w'),ensure_ascii=False,indent=1)
print(len([g for g in groups.values() if len(g)>1]),'families;',collections.Counter(a for a,*_ in out))
