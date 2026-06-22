import React, { useEffect, useState } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';

// ── iCount Admin ────────────────────────────────────────────────────────────
// Server-driven iCount maintenance (credentials live in the icount-admin edge
// function, never in the browser). Every job previews first (dry-run); nothing
// is written until you confirm. Long jobs run in batches with a progress bar so
// they never hit the edge-function timeout.
//   • Item type   — tag specialty coffee as "פולי קפה מינוטו" (type 8)
//   • Images      — upload each item's Woo photo as a 150×150 POS-friendly square
//   • Stock sync  — set non-coffee stock = WooCommerce stock_quantity
//   • Delete hidden — remove iCount items whose Woo product is draft/unpublished

const call = (body) => supabase.functions.invoke('icount-admin', { body });

export default function IcountAdmin() {
  const { showToast } = useApp();
  const [status, setStatus]   = useState(null);
  const [loading, setLoading] = useState(false);

  const [typePreview, setTypePreview] = useState(null);
  const [typeBusy, setTypeBusy]       = useState(false);

  // one progress object per batched op: { processed, total, done, ...sums }
  const [prog, setProg] = useState({});   // keyed by op name
  const [busy, setBusy] = useState({});   // keyed by op name
  const [delHits, setDelHits] = useState(null);

  useEffect(() => { loadStatus(); }, []); // eslint-disable-line

  async function loadStatus() {
    setLoading(true);
    try {
      const { data, error } = await call({ action: 'status' });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      setStatus(data);
    } catch (e) { showToast(`❌ ${e.message}`, 'error'); }
    finally { setLoading(false); }
  }

  // Generic batched runner. Loops offset→next_offset until done, summing the
  // given fields (looked up at top level OR inside data.tally), and optionally
  // collecting an array field (e.g. delete hits).
  async function runBatched(op, { action, limit, dryRun, sum, collect }) {
    setBusy((b) => ({ ...b, [op]: true }));
    const totals = { processed: 0, total: 0, done: false };
    sum.forEach((f) => (totals[f] = 0));
    setProg((p) => ({ ...p, [op]: { ...totals } }));
    const gathered = [];
    try {
      let offset = 0;
      for (;;) {
        const { data, error } = await call({ action, dry_run: dryRun, offset, limit });
        if (error || data?.error) throw new Error(data?.error || error?.message);
        totals.total = data.total_with_sku;
        totals.processed += data.processed;
        totals.done = data.done;
        sum.forEach((f) => { totals[f] += (data[f] ?? data.tally?.[f] ?? 0); });
        if (collect) gathered.push(...(data[collect] || []));
        setProg((p) => ({ ...p, [op]: { ...totals } }));
        if (data.done) break;
        offset = data.next_offset;
      }
      return { totals, gathered };
    } finally { setBusy((b) => ({ ...b, [op]: false })); }
  }

  // ── Item type ───────────────────────────────────────────────────────────────
  async function previewTypes() {
    setTypeBusy(true); setTypePreview(null);
    try {
      const { data, error } = await call({ action: 'set_types', dry_run: true });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      setTypePreview(data);
      showToast(`✅ ${data.to_change} פריטים לעדכון (מתוך ${data.matched} תואמים)`, 'success');
    } catch (e) { showToast(`❌ ${e.message}`, 'error'); }
    finally { setTypeBusy(false); }
  }
  async function applyTypes() {
    if (!typePreview?.to_change) return;
    if (!window.confirm(`לעדכן ${typePreview.to_change} פריטים ל"פולי קפה מינוטו" (סוג 8)?`)) return;
    setTypeBusy(true);
    try {
      const { data, error } = await call({ action: 'set_types', dry_run: false });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      showToast(`✅ עודכנו ${data.updated} פריטים${data.failed ? `, ${data.failed} נכשלו` : ''}`, data.failed ? 'warning' : 'success');
      setTypePreview(null); loadStatus();
    } catch (e) { showToast(`❌ ${e.message}`, 'error'); }
    finally { setTypeBusy(false); }
  }

  // ── Images (150×150 square) ───────────────────────────────────────────────────
  async function runSquare(dryRun) {
    try {
      const { totals } = await runBatched('square', { action: 'square_images', limit: 20, dryRun,
        sum: ['squared', 'already_square', 'skipped_no_woo', 'failed'] });
      const verb = dryRun ? 'יעודכנו' : 'עודכנו';
      showToast(`✅ ${verb} ${totals.squared} תמונות, ${totals.already_square} כבר מרובעות, ${totals.skipped_no_woo} ללא תמונה`, totals.failed ? 'warning' : 'success');
    } catch (e) { showToast(`❌ ${e.message}`, 'error'); }
  }

  // ── Stock sync ────────────────────────────────────────────────────────────────
  async function runStock(dryRun) {
    try {
      const { totals } = await runBatched('stock', { action: 'stock_sync', limit: 40, dryRun,
        sum: ['would_set', 'set', 'in_sync', 'woo_untracked', 'no_woo_match', 'skip_coffee', 'set_failed'] });
      const n = dryRun ? totals.would_set : totals.set;
      showToast(`✅ ${dryRun ? 'יעודכנו' : 'עודכנו'} ${n} פריטים, ${totals.in_sync} כבר תואמים`, totals.set_failed ? 'warning' : 'success');
    } catch (e) { showToast(`❌ ${e.message}`, 'error'); }
  }

  // ── Delete hidden ─────────────────────────────────────────────────────────────
  async function previewDelete() {
    setDelHits(null);
    try {
      const { totals, gathered } = await runBatched('del', { action: 'delete_hidden', limit: 40, dryRun: true,
        sum: ['would_delete', 'published', 'no_woo_match'], collect: 'hits' });
      setDelHits(gathered);
      showToast(`✅ ${totals.would_delete} מוצרים מוסתרים למחיקה`, 'success');
    } catch (e) { showToast(`❌ ${e.message}`, 'error'); }
  }
  async function applyDelete() {
    const n = delHits?.length ?? 0;
    if (!n) return;
    if (!window.confirm(`למחוק ${n} מוצרים מ-iCount? פעולה זו אינה הפיכה.`)) return;
    try {
      const { totals } = await runBatched('del', { action: 'delete_hidden', limit: 40, dryRun: false,
        sum: ['deleted', 'delete_blocked'], collect: 'hits' });
      showToast(`✅ נמחקו ${totals.deleted} מוצרים${totals.delete_blocked ? `, ${totals.delete_blocked} נחסמו` : ''}`, totals.delete_blocked ? 'warning' : 'success');
      setDelHits(null); loadStatus();
    } catch (e) { showToast(`❌ ${e.message}`, 'error'); }
  }

  // ── styles ──────────────────────────────────────────────────────────────────
  const card = { background: 'white', borderRadius: '12px', padding: '1.5rem', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', maxWidth: '720px', margin: '1.25rem auto' };
  const btn = (bg, disabled) => ({ padding: '0.7rem 1.1rem', fontSize: '0.95rem', fontWeight: 700, color: 'white', background: disabled ? '#9CA3AF' : bg, border: 'none', borderRadius: '8px', cursor: disabled ? 'default' : 'pointer', marginInlineEnd: '0.6rem' });
  const stat = { display: 'inline-block', minWidth: '120px', margin: '0.3rem 0.6rem 0.3rem 0', fontSize: '0.9rem' };

  // progress bar + stat readout for a batched op
  const Progress = ({ op, fields }) => {
    const p = prog[op];
    if (!p) return null;
    const pct = p.total ? Math.round((p.processed / p.total) * 100) : 0;
    return (
      <div style={{ marginTop: '0.9rem', fontSize: '0.9rem' }}>
        <div style={{ background: '#eee', borderRadius: '6px', height: '10px', overflow: 'hidden', marginBottom: '0.6rem' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: p.done ? '#16A34A' : '#2563EB', transition: 'width 0.3s' }} />
        </div>
        <span style={stat}>עובדו: <b>{p.processed}/{p.total}</b></span>
        {fields.map(([key, label, danger]) => (
          <span key={key} style={danger && p[key] ? { ...stat, color: '#B91C1C' } : stat}>{label}: <b>{p[key] ?? 0}</b></span>
        ))}
        {busy[op] && <span style={{ color: '#2563EB' }}> מעבד…</span>}
      </div>
    );
  };

  return (
    <div style={{ direction: 'rtl', paddingBottom: '3rem' }}>
      <h2 style={{ textAlign: 'center', marginTop: '1.25rem' }}>ניהול iCount</h2>

      {/* status */}
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>מצב נוכחי</h3>
        {loading && !status ? <p>טוען…</p> : status ? (
          <div>
            <span style={stat}>סה"כ פריטים: <b>{status.icount_total_items}</b></span>
            <span style={stat}>עם מק"ט: <b>{status.items_with_sku}</b></span>
            <span style={stat}>סוג {status.target_type_id}: <b>{status.target_type_label || '—'}</b></span>
            <span style={stat}>כבר בסוג זה: <b>{status.already_target_type}</b></span>
          </div>
        ) : <p style={{ color: '#B91C1C' }}>לא ניתן לטעון מצב — בדוק הגדרות.</p>}
        <button style={btn('#6B7280', loading)} disabled={loading} onClick={loadStatus}>רענון</button>
      </div>

      {/* types */}
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>סוג פריט — פולי קפה מינוטו (סוג 8)</h3>
        <p style={{ color: '#555', fontSize: '0.9rem' }}>מסמן כל פריט ב-iCount שהמק"ט שלו נמצא בקטגוריית הקפה הספיישלטי באתר, ומעדכן את סוג הפריט ל"פולי קפה מינוטו".</p>
        <button style={btn('#2563EB', typeBusy)} disabled={typeBusy} onClick={previewTypes}>תצוגה מקדימה</button>
        {typePreview && (
          <button style={btn('#16A34A', typeBusy || !typePreview.to_change)} disabled={typeBusy || !typePreview.to_change} onClick={applyTypes}>
            עדכן {typePreview.to_change} פריטים
          </button>
        )}
        {typePreview && (
          <div style={{ marginTop: '0.9rem', fontSize: '0.9rem' }}>
            <span style={stat}>מק"טים בקטגוריה: <b>{typePreview.coffee_skus}</b></span>
            <span style={stat}>תואמים ב-iCount: <b>{typePreview.matched}</b></span>
            <span style={stat}>לעדכון: <b>{typePreview.to_change}</b></span>
            <span style={stat}>כבר מעודכנים: <b>{typePreview.already_set}</b></span>
          </div>
        )}
      </div>

      {/* images — 150×150 square */}
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>תמונות מוצרים (150×150 ל-POS)</h3>
        <p style={{ color: '#555', fontSize: '0.9rem' }}>מעדכן לכל פריט את תמונת המוצר מ-WooCommerce כריבוע 150×150 (הגודל המומלץ לאפליקציית ה-POS). מדלג על פריטים שכבר מרובעים או ללא התאמה ב-Woo.</p>
        <button style={btn('#2563EB', busy.square)} disabled={busy.square} onClick={() => runSquare(true)}>תצוגה מקדימה</button>
        <button style={btn('#16A34A', busy.square)} disabled={busy.square} onClick={() => { if (window.confirm('לעדכן תמונות מרובעות לכל הפריטים?')) runSquare(false); }}>עדכון תמונות</button>
        <Progress op="square" fields={[['squared', 'עודכנו'], ['already_square', 'כבר מרובע'], ['skipped_no_woo', 'ללא תמונה'], ['failed', 'נכשלו', true]]} />
      </div>

      {/* stock sync */}
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>סנכרון מלאי מ-WooCommerce</h3>
        <p style={{ color: '#555', fontSize: '0.9rem' }}>מעדכן את המלאי ב-iCount כך שיתאים לכמות במלאי ב-WooCommerce (פריטים שאינם קפה). פריטי קפה, ופריטים ללא מלאי מנוהל ב-Woo, נשארים ללא שינוי.</p>
        <button style={btn('#2563EB', busy.stock)} disabled={busy.stock} onClick={() => runStock(true)}>תצוגה מקדימה</button>
        <button style={btn('#16A34A', busy.stock)} disabled={busy.stock} onClick={() => { if (window.confirm('לסנכרן מלאי מ-WooCommerce ל-iCount?')) runStock(false); }}>סנכרון מלאי</button>
        <Progress op="stock" fields={[['would_set', 'לעדכון'], ['set', 'עודכנו'], ['in_sync', 'תואמים'], ['woo_untracked', 'ללא מעקב'], ['skip_coffee', 'קפה (דילוג)'], ['set_failed', 'נכשלו', true]]} />
      </div>

      {/* delete hidden */}
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>מחיקת מוצרים מוסתרים</h3>
        <p style={{ color: '#555', fontSize: '0.9rem' }}>מוחק מ-iCount פריטים שהמוצר התואם שלהם ב-WordPress במצב טיוטה/מוסתר (לא פורסם). פריטים שפורסמו, או ללא התאמה ב-Woo, נשארים. מאפס מלאי לפני מחיקה במידת הצורך.</p>
        <button style={btn('#2563EB', busy.del)} disabled={busy.del} onClick={previewDelete}>תצוגה מקדימה</button>
        {delHits && (
          <button style={btn('#DC2626', busy.del || !delHits.length)} disabled={busy.del || !delHits.length} onClick={applyDelete}>
            מחק {delHits.length} מוצרים
          </button>
        )}
        <Progress op="del" fields={[['would_delete', 'למחיקה'], ['deleted', 'נמחקו'], ['delete_blocked', 'נחסמו', true], ['published', 'פורסמו (נשמרים)']]} />
        {delHits && delHits.length > 0 && (
          <div style={{ maxHeight: '200px', overflow: 'auto', marginTop: '0.6rem', border: '1px solid #eee', borderRadius: '8px', padding: '0.4rem 0.7rem' }}>
            {delHits.map((h) => (
              <div key={h.id} style={{ fontSize: '0.82rem', padding: '0.15rem 0' }}>
                <span style={{ color: '#B45309' }}>[{h.woo_status}]</span> {h.sku} — {h.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
