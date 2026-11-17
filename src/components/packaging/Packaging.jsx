import React, { useState } from 'react';
import { PackageCheck, Pencil, Check } from 'lucide-react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';
import { reservedBagsByProduct, storeStock, webOwed } from '../../lib/reservedStock';
import PackingList from './PackingList';
import B2BAllocations from './B2BAllocations';
import { PageHeader } from '../shared/ui';
import './packaging.css';

// ── Helpers ───────────────────────────────────────────────────────────────────

const calcDeductions = (product, bags, origins, roastProfiles) => {
  const sizeKg = product.size / 1000;
  return (product.recipe || []).map(ing => {
    const kgPerBag = sizeKg * (ing.percentage / 100);
    const kgNeeded = bags * kgPerBag;
    if (ing.sourceType === 'profile' && ing.sourceId) {
      const profile = roastProfiles.find(p => p.id === ing.sourceId);
      return profile ? {
        type: 'profile', item: profile, kgNeeded, kgPerBag,
        minStock: profile.min_stock ?? null
      } : null;
    } else {
      const originId = ing.sourceId || ing.originId;
      const origin = origins.find(o => o.id === originId);
      return origin ? {
        type: 'origin', item: origin, kgNeeded, kgPerBag,
        minStock: origin.critical_stock ?? null
      } : null;
    }
  }).filter(Boolean);
};

// ── Packaging ─────────────────────────────────────────────────────────────────

export default function Packaging() {
  const {
    data, originsDb, roastProfilesDb, productsDb, packingLogsDb, showToast
  } = useApp();

  const reserved = reservedBagsByProduct(data.bagAllocations);

  const [packProductId, setPackProductId] = useState('');
  const [packBags,      setPackBags]      = useState('');
  const [submitting,    setSubmitting]    = useState(false);
  const [editingLogId,  setEditingLogId]  = useState(null);
  const [editBags,      setEditBags]      = useState('');
  const [correcting,    setCorrecting]    = useState(false);

  const selectedProduct = data.products.find(p => p.id === parseInt(packProductId));
  const bags            = parseInt(packBags) || 0;

  // ── Record new packing ────────────────────────────────────────────────────

  const recordPacking = async () => {
    if (!selectedProduct) { showToast('נא לבחור מוצר', 'warning'); return; }
    if (bags <= 0)         { showToast('נא להזין כמות שקיות', 'warning'); return; }

    const deductions = calcDeductions(selectedProduct, bags, data.origins, data.roastProfiles);

    // Block if not enough roasted stock
    const shortages = deductions.filter(d => (d.item.roasted_stock ?? 0) < d.kgNeeded);
    if (shortages.length > 0) {
      const msg = shortages.map(s =>
        `${s.item.name}: יש ${(s.item.roasted_stock ?? 0).toFixed(1)} ק"ג, צריך ${s.kgNeeded.toFixed(2)} ק"ג`
      ).join(' | ');
      // Stays until closed: it is the message that says what to roast next.
      showToast(`אין מספיק מלאי קלוי: ${msg}`, 'error', { duration: Infinity });
      return;
    }

    setSubmitting(true);
    try {
      // Deduct roasted stock from origins / roast profiles
      for (const d of deductions) {
        const newStock = parseFloat(((d.item.roasted_stock ?? 0) - d.kgNeeded).toFixed(3));
        if (d.type === 'origin') {
          await originsDb.update(d.item.id, { roasted_stock: newStock });
        } else {
          await roastProfilesDb.update(d.item.id, { roasted_stock: newStock });
        }
      }

      // Increment packed_stock
      await productsDb.update(selectedProduct.id, {
        packed_stock: (selectedProduct.packed_stock || 0) + bags
      });

      // Log with deduction details
      await packingLogsDb.insert({
        product_id:       selectedProduct.id,
        product_name:     `${selectedProduct.name} ${selectedProduct.size}g`,
        bags_count:       bags,
        roasted_deducted: deductions.map(d => ({
          name:       d.item.name,
          kg:         parseFloat(d.kgNeeded.toFixed(3)),
          kg_per_bag: parseFloat(d.kgPerBag.toFixed(6)),
          type:       d.type,
          source_id:  d.item.id,
        })),
        reported_by: 'מערכת',
      });

      showToast(`נרשמה אריזה: ${bags} שקיות ${selectedProduct.name} ${selectedProduct.size}g`);
      setPackProductId('');
      setPackBags('');
    } catch (err) {
      console.error(err);
      showToast('שגיאה ברישום האריזה', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Correct an existing packing log ──────────────────────────────────────

  const submitCorrection = (log) => {
    if (correcting) return;
    const n = parseInt(editBags);
    if (!n || n <= 0) { showToast('כמות לא תקינה', 'warning'); return; }
    correctPacking(log, n);
  };

  const correctPacking = async (log, newBags) => {
    const diff = newBags - log.bags_count;
    if (diff === 0) { setEditingLogId(null); return; }

    setCorrecting(true);
    try {
      // Adjust roasted_stock for each ingredient based on the bag diff
      for (const d of (log.roasted_deducted || [])) {
        const deltaKg = parseFloat((d.kg_per_bag * diff).toFixed(3));
        if (d.type === 'origin') {
          const origin = data.origins.find(o => o.id === d.source_id);
          if (origin) {
            const newStock = parseFloat(((origin.roasted_stock ?? 0) - deltaKg).toFixed(3));
            await originsDb.update(d.source_id, { roasted_stock: Math.max(0, newStock) });
          }
        } else {
          const profile = data.roastProfiles.find(p => p.id === d.source_id);
          if (profile) {
            const newStock = parseFloat(((profile.roasted_stock ?? 0) - deltaKg).toFixed(3));
            await roastProfilesDb.update(d.source_id, { roasted_stock: Math.max(0, newStock) });
          }
        }
      }

      // Adjust packed_stock
      const product = data.products.find(p => p.id === log.product_id);
      if (product) {
        const { error: prodErr } = await supabase
          .from('products')
          // A correction exactly reverses part of a logged packing, so no floor:
          // bags that were never packed cannot pay off a website back-order.
          // packed_stock is signed (negative = owed to website orders).
          .update({ packed_stock: (product.packed_stock || 0) + diff })
          .eq('id', log.product_id);
        if (prodErr) throw prodErr;
      }

      // Update the packing log
      const { error: logErr } = await supabase
        .from('packing_logs')
        .update({ bags_count: newBags })
        .eq('id', log.id);
      if (logErr) throw logErr;

      await Promise.all([
        originsDb.refresh(),
        roastProfilesDb.refresh(),
        productsDb.refresh(),
        packingLogsDb.refresh(),
      ]);

      setEditingLogId(null);
      showToast(`תוקן: ${log.product_name}, ${newBags} שקיות`);
    } catch (err) {
      console.error(err);
      showToast('שגיאה בתיקון הרישום', 'error');
    } finally {
      setCorrecting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="page pack-page">
      <PageHeader
        title="אריזה"
        subtitle="רישום אריזות, מלאי שקיות לחנות והקצאות ללקוחות B2B"
      />

      {/* Packing form */}
      <section className="card flush">
        <div className="card-head"><h2>רישום אריזה</h2></div>
        <div className="card-body pack-form">
          <div className="form-group">
            <label htmlFor="pack-product">מוצר</label>
            <select id="pack-product" value={packProductId} onChange={e => setPackProductId(e.target.value)}>
              <option value="">בחירת מוצר</option>
              {data.products.map(p => (
                <option key={p.id} value={p.id}>{p.name} {p.size}g</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="pack-bags">כמות שקיות</label>
            <input
              id="pack-bags"
              type="number" min="1" placeholder="0"
              value={packBags}
              onChange={e => setPackBags(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={recordPacking}
            className="btn primary pack-submit"
            disabled={submitting}
          >
            <PackageCheck aria-hidden="true" />
            {submitting ? 'שומר...' : 'שמירת אריזה'}
          </button>
        </div>
      </section>

      <PackingList />

      {/* Product stock overview */}
      <section className="card flush">
        <div className="card-head">
          <h2>מלאי שקיות ארוזות</h2>
          {data.products.length > 0 && <span className="meta num">{data.products.length} מוצרים</span>}
        </div>

        {data.products.length === 0 ? (
          <div className="empty-state">אין מוצרים מוגדרים עדיין.</div>
        ) : (
          <div className="pack-stock">
            {data.products.map(product => {
              // Bags allocated to a B2B customer are not store stock.
              const reservedBags = reserved[product.id] || 0;
              const stock    = storeStock(product, reserved);
              const minStock = product.min_packed_stock ?? 0;
              const isEmpty  = stock === 0;
              const isLow    = !isEmpty && minStock > 0 && stock <= minStock;
              const tone     = isEmpty ? 'danger' : isLow ? 'warn' : 'ok';

              return (
                <div className="pack-srow" key={product.id}>
                  <span className={`dot ${tone}`} aria-hidden="true" />
                  <div className="pack-sinfo">
                    <div className="pack-sname">
                      <span className="attn-what">{product.name}</span>{' '}
                      <span className="pack-size">{product.size}g</span>
                    </div>
                    <div className="pack-sdetail num">
                      {minStock > 0 && (
                        <span className={isEmpty ? 'pack-out' : isLow ? 'pack-low' : undefined}>
                          {isEmpty ? 'אזל מהמלאי' : `מינימום ${minStock}`}
                        </span>
                      )}
                      {reservedBags > 0 && <span>ועוד {reservedBags} מוקצות ל־B2B</span>}
                      {webOwed(product) > 0 && (
                        <span className="tag warn" title="הזמנות אתר שנמכרו לפני שנארזו. האריזה הבאה מכסה אותן קודם.">
                          {webOwed(product)} חסרות להזמנות אתר
                        </span>
                      )}
                    </div>
                  </div>
                  <div className={`pack-sn num ${tone}`}>
                    {stock}
                    <small>לחנות</small>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <B2BAllocations />

      {/* Packing logs */}
      <section className="card flush">
        <div className="card-head">
          <h2>היסטוריית אריזות</h2>
          {data.packingLogs && data.packingLogs.length > 0 && (
            <span className="meta num">{data.packingLogs.length} רישומים</span>
          )}
        </div>

        {data.packingLogs && data.packingLogs.length === 0 ? (
          <div className="empty-state">אין רישומי אריזה עדיין.</div>
        ) : (
          <div className="pack-logs">
            {(data.packingLogs || []).slice().reverse().map(log => {
              const isEditing = editingLogId === log.id;
              return (
                <div className="pack-log" key={log.id}>
                  {/* Log details */}
                  <div className="pack-log-main">
                    <div className="attn-what">{log.product_name}</div>

                    {isEditing ? (
                      /* ── Inline edit ── */
                      <div className="pack-log-edit">
                        <span className="text-muted">שקיות:</span>
                        <input
                          className="pack-edit-input"
                          type="number" min="1"
                          value={editBags}
                          onChange={e => setEditBags(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter')  { e.preventDefault(); submitCorrection(log); }
                            if (e.key === 'Escape') { e.preventDefault(); if (!correcting) setEditingLogId(null); }
                          }}
                          aria-label="מספר שקיות מתוקן"
                          autoFocus
                        />
                        <button
                          type="button"
                          className="btn primary sm"
                          onClick={() => submitCorrection(log)}
                          disabled={correcting}
                        >
                          <Check aria-hidden="true" />
                          {correcting ? 'שומר...' : 'שמירה'}
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => setEditingLogId(null)}
                          disabled={correcting}
                        >
                          ביטול
                        </button>
                      </div>
                    ) : (
                      /* ── Normal view ── */
                      <div className="pack-log-meta">
                        <span className="pack-log-bags num">{log.bags_count} שקיות</span>
                        {log.reported_by && <span>{log.reported_by}</span>}
                        <span className="num">{new Date(log.packed_at).toLocaleString('he-IL')}</span>
                      </div>
                    )}

                    {/* Deduction detail */}
                    {!isEditing && log.roasted_deducted && log.roasted_deducted.length > 0 && (
                      <div className="pack-log-deduct num">
                        {log.roasted_deducted.map((d, i) => (
                          <span key={i}>{d.name}: {d.kg?.toFixed(2)} ק״ג</span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Edit button */}
                  {!isEditing && (
                    <button
                      type="button"
                      className="btn-icon"
                      title="תיקון רישום"
                      aria-label="תיקון רישום"
                      onClick={() => { setEditingLogId(log.id); setEditBags(String(log.bags_count)); }}
                    >
                      <Pencil aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

