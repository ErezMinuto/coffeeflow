#!/usr/bin/env python3
"""Builds report.html (filterable findings browser) from findings.csv + summary.md."""
import csv, json, os, re, html
D = os.path.dirname(os.path.abspath(__file__))
P = {p['id']: p for p in json.load(open(f'{D}/raw/products.json'))}
ORDER = ['פולי קפה','מכונות קפה','מטחנות קפה','קפסולות קפה','ספלים וכוסות קפה','חומרי ניקוי ותחזוקה לקפה','קפה פילטר ואביזרים','מוצרים לטיפול במים','תה - חליטות','מוצרים נלווים']
def cat(pid):
    cs = [c['name'] for c in P[pid]['categories']] if pid in P else []
    if any(c.startswith('פולי קפה') or c == 'תערובות קפה מינוטו' for c in cs): return 'פולי קפה'
    for c in ORDER:
        if c in cs: return c
    return 'אחר'
rows = list(csv.DictReader(open(f'{D}/findings.csv', encoding='utf-8-sig')))
data = [[int(r['product_id']), r['product_name'], r['permalink'], r['field'], r['issue_type'], r['severity'][0],
         r['current_text'], r['problem'], r['suggested_fix'], r['confidence'][0], cat(int(r['product_id']))] for r in rows]
md = open(f'{D}/summary.md').read()
top = md.split('## Top 10 fixes', 1)[1].split('## Came out clean', 1)[0].strip()
def inline(t):
    t = html.escape(t)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    return re.sub(r'`(.+?)`', r'<code>\1</code>', t)
out, depth = [], 0
for line in top.splitlines():
    m = re.match(r'^(\s*)(\d+\.|\*)\s+(.*)', line)
    if not m: continue
    lvl = 0 if not m.group(1) else 1
    if lvl == 0:
        if depth == 1: out.append('</ul>'); depth = 0
        if out: out.append('</li>')
        out.append(f'<li>{inline(m.group(3))}')
    else:
        if depth == 0: out.append('<ul>'); depth = 1
        out.append(f'<li>{inline(m.group(3))}</li>')
if depth: out.append('</ul>')
out.append('</li>')
top_html = '<ol class="top">' + ''.join(out) + '</ol>'
clean = sum(1 for _ in open(f'{D}/clean_products.txt'))
tpl = open(f'{D}/report_template.html').read()
page = (tpl.replace('/*DATA*/[]', json.dumps(data, ensure_ascii=False, separators=(',', ':')))
           .replace('<!--TOP-->', top_html).replace('{{CLEAN}}', str(clean))
           .replace('{{PRODUCTS}}', str(len({d[0] for d in data}))).replace('{{TOTAL}}', str(len(data))))
open(f'{D}/report.html', 'w').write(page)
print('report.html', len(page) // 1024, 'KB')
