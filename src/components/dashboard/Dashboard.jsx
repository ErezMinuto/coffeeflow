import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Flame, PackagePlus, ChevronLeft, CircleCheck } from 'lucide-react';
import { useApp } from '../../lib/context';
import { reservedBagsByProduct, storeStock } from '../../lib/reservedStock';
import { PageHeader, Kpi } from '../shared/ui';

const ATTN_PREVIEW = 6;
const STOCK_ROWS   = 8;
const RECENT_ROWS  = 6;

const fmtKg   = n => n.toLocaleString('he-IL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtDate = d => `${d.getDate()}.${d.getMonth() + 1}`;

function SkelRows({ n }) {
  return Array.from({ length: n }, (_, i) => (
    <div className="dash-skel-row" key={i} aria-hidden="true">
      <span className="skel" style={{ width: `${55 - i * 8}%` }} />
    </div>
  ));
}

export default function Dashboard() {
  const { data, dataLoading } = useApp();
  const navigate = useNavigate();
  const [showAllAttn, setShowAllAttn] = useState(false);

  const lowStockOrigins   = data.origins.filter(o => (o.stock || 0) < (o.min_stock || 10) && (o.stock || 0) > 0);
  const outOfStockOrigins = data.origins.filter(o => (o.stock || 0) === 0);

  // Bags allocated to a B2B customer are not store stock (see reservedStock.js).
  const reserved          = reservedBagsByProduct(data.bagAllocations);
  const outOfPackedStock  = data.products.filter(p => storeStock(p, reserved) === 0 && (p.min_packed_stock ?? 0) > 0);
  const lowPackedStock    = data.products.filter(p => storeStock(p, reserved) > 0 && (p.min_packed_stock ?? 0) > 0 && storeStock(p, reserved) <= p.min_packed_stock);

  // ── KPIs ─────────────────────────────────────────────────────────────────
  const greenKg     = data.origins.reduce((sum, o) => sum + (o.stock || 0), 0);
  const stockValue  = data.origins.reduce((sum, o) => sum + ((o.stock || 0) * (o.cost_per_kg || 0)), 0);
  const originsInStock = data.origins.filter(o => (o.stock || 0) > 0).length;

  const roastStats = useMemo(() => {
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevStart  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    let thisMonth = 0, prevMonth = 0;
    const dated = [];
    for (const r of data.roasts) {
      if (!r.date) continue;
      const d = new Date(r.date);
      if (Number.isNaN(d.getTime())) continue;
      if (d >= monthStart) thisMonth++;
      else if (d >= prevStart) prevMonth++;
      dated.push({ r, d });
    }
    dated.sort((a, b) => b.d - a.d);

    // Weight loss from what was actually roasted, not from the per-origin setting.
    const weighed = dated
      .filter(({ r }) => (r.green_weight || 0) > 0 && (r.roasted_weight || 0) > 0)
      .slice(0, 30);
    const avgLoss = weighed.length
      ? weighed.reduce((s, { r }) => s + (r.green_weight - r.roasted_weight) / r.green_weight, 0) / weighed.length * 100
      : null;

    return {
      thisMonth,
      prevMonth,
      prevMonthName: prevStart.toLocaleDateString('he-IL', { month: 'long' }),
      avgLoss,
      lossSample: weighed.length,
      recent: dated.slice(0, RECENT_ROWS),
    };
  }, [data.roasts]);

  // ── Needs attention: one list, most urgent first ─────────────────────────
  const attention = [
    ...outOfPackedStock.map(p => ({
      key: `pk-out-${p.id}`, tone: 'danger', what: `${p.name} ${p.size}g`,
      why: 'אין שקיות ארוזות לחנות', to: '/packaging', go: 'לאריזה',
    })),
    ...outOfStockOrigins.map(o => ({
      key: `or-out-${o.id}`, tone: 'danger', what: o.name,
      why: 'אין מלאי ירוק', to: '/origins', go: 'לזנים',
    })),
    ...lowPackedStock.map(p => ({
      key: `pk-low-${p.id}`, tone: 'warn', what: `${p.name} ${p.size}g`,
      why: `${storeStock(p, reserved)} שקיות, מינימום ${p.min_packed_stock}`, to: '/packaging', go: 'לאריזה',
    })),
    ...lowStockOrigins.map(o => ({
      key: `or-low-${o.id}`, tone: 'warn', what: o.name,
      why: `${fmtKg(o.stock || 0)} ק״ג ירוק, מינימום ${o.min_stock || 10}`, to: '/origins', go: 'לזנים',
    })),
  ];
  const attnShown = showAllAttn ? attention : attention.slice(0, ATTN_PREVIEW);

  // ── Store bags: tracked products, emptiest first ─────────────────────────
  const storeRows = data.products
    .filter(p => (p.min_packed_stock ?? 0) > 0)
    .map(p => ({ p, n: storeStock(p, reserved) }))
    .sort((a, b) => (a.n / a.p.min_packed_stock) - (b.n / b.p.min_packed_stock))
    .slice(0, STOCK_ROWS);
  const storeMax = Math.max(1, ...storeRows.map(({ n, p }) => Math.max(n, p.min_packed_stock * 2)));

  const roastName = r => {
    if (r.roast_profile_id) return data.roastProfiles.find(p => p.id === r.roast_profile_id)?.name || 'פרופיל לא ידוע';
    return data.origins.find(o => o.id === r.origin_id)?.name || 'זן לא ידוע';
  };

  const today = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="page dash-page">
      <PageHeader
        title="סקירה"
        subtitle={today}
        actions={<>
          <button type="button" className="btn" onClick={() => navigate('/packaging')}>
            <PackagePlus aria-hidden="true" />רישום אריזה
          </button>
          <button type="button" className="btn primary" onClick={() => navigate('/roasting')}>
            <Flame aria-hidden="true" />רישום קלייה
          </button>
        </>}
      />

      {dataLoading ? (
        <section className="kpis dash-kpis" aria-label="מדדים" aria-busy="true">
          {['מלאי ירוק', 'ערך מלאי', 'קליות החודש', 'איבוד משקל ממוצע'].map(label => (
            <div className="kpi" key={label}>
              <div className="kpi-label">{label}</div>
              <span className="skel lg" />
            </div>
          ))}
        </section>
      ) : (
        <section className="kpis dash-kpis" aria-label="מדדים">
          <Kpi label="מלאי ירוק" value={fmtKg(greenKg)} unit="ק״ג" note={`${originsInStock} זנים במלאי`} />
          <Kpi label="ערך מלאי" value={`₪${Math.round(stockValue).toLocaleString('he-IL')}`} note="לפי עלות לק״ג" />
          <Kpi label="קליות החודש" value={roastStats.thisMonth} note={`${roastStats.prevMonth} קליות ב${roastStats.prevMonthName}`} />
          <Kpi
            label="איבוד משקל ממוצע"
            value={roastStats.avgLoss == null ? '—' : roastStats.avgLoss.toFixed(1)}
            unit={roastStats.avgLoss == null ? null : '%'}
            note={roastStats.lossSample ? `ב־${roastStats.lossSample} הקליות האחרונות` : 'אין עדיין קליות שקולות'}
          />
        </section>
      )}

      <div className="dash-grid">
        <section className="card flush">
          <div className="card-head">
            <h2>דורש טיפול</h2>
            {!dataLoading && attention.length > 0 && <span className="meta num">{attention.length} פריטים</span>}
          </div>
          {dataLoading ? <SkelRows n={4} /> : attention.length === 0 ? (
            <div className="dash-allgood">
              <CircleCheck size={18} aria-hidden="true" />
              <span>אין כרגע פריטים שדורשים טיפול</span>
            </div>
          ) : (
            <>
              {attnShown.map(item => (
                <div className="attn-item" key={item.key}>
                  <span className={`dot ${item.tone}`} aria-hidden="true" />
                  <div className="dash-attn-text">
                    <div className="attn-what">{item.what}</div>
                    <div className="attn-why num">{item.why}</div>
                  </div>
                  <Link className="attn-go" to={item.to}>{item.go}<ChevronLeft aria-hidden="true" /></Link>
                </div>
              ))}
              {attention.length > ATTN_PREVIEW && (
                <button type="button" className="dash-more" onClick={() => setShowAllAttn(v => !v)}>
                  {showAllAttn ? 'הצגת פחות' : `הצגת כל ${attention.length} הפריטים`}
                </button>
              )}
            </>
          )}
        </section>

        <section className="card flush">
          <div className="card-head">
            <h2>שקיות לחנות</h2>
            <Link to="/products">כל המוצרים</Link>
          </div>
          {dataLoading ? <SkelRows n={4} /> : storeRows.length === 0 ? (
            <div className="empty-state">לא הוגדר מינימום שקיות לאף מוצר</div>
          ) : (
            <div className="dash-stock">
              {storeRows.map(({ p, n }) => {
                const tone = n === 0 ? 'danger' : n <= p.min_packed_stock ? 'warn' : '';
                const pct  = n === 0 ? 2 : Math.max(4, Math.min(100, (n / storeMax) * 100));
                return (
                  <div className="dash-srow" key={p.id}>
                    <div className="dash-sname"><span className="attn-what">{p.name}</span> <span className="dash-size">{p.size}g</span></div>
                    <div className="meter" role="img" aria-label={`${n} שקיות, מינימום ${p.min_packed_stock}`}>
                      <i className={tone} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="dash-n num">{n}</div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <section className="card flush">
        <div className="card-head">
          <h2>קליות אחרונות</h2>
          <Link to="/roasting">כל הקליות</Link>
        </div>
        {dataLoading ? <SkelRows n={4} /> : roastStats.recent.length === 0 ? (
          <div className="empty-state">עדיין לא נרשמו קליות</div>
        ) : (
          <div className="dash-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>תאריך</th>
                  <th>זן</th>
                  <th className="hide-sm">מפעיל</th>
                  <th className="end">ירוק</th>
                  <th className="end">קלוי</th>
                  <th className="end hide-sm">איבוד</th>
                </tr>
              </thead>
              <tbody>
                {roastStats.recent.map(({ r, d }) => {
                  const loss = (r.green_weight || 0) > 0 && (r.roasted_weight || 0) > 0
                    ? `${((r.green_weight - r.roasted_weight) / r.green_weight * 100).toFixed(1)}%`
                    : '—';
                  return (
                    <tr key={r.id}>
                      <td>{fmtDate(d)}</td>
                      <td>{roastName(r)}</td>
                      <td className="hide-sm">{r.operator || '—'}</td>
                      <td className="end">{r.green_weight != null ? `${fmtKg(r.green_weight)} ק״ג` : '—'}</td>
                      <td className="end">{r.roasted_weight != null ? `${fmtKg(r.roasted_weight)} ק״ג` : '—'}</td>
                      <td className="end hide-sm">{loss}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!dataLoading && data.origins.length === 0 && (
        <div className="empty-state">
          עדיין אין זנים במערכת. <Link className="text-link" to="/origins">הוספת זן ראשון</Link>
        </div>
      )}
    </div>
  );
}
