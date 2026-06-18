import React, { useEffect, useState } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';

// ── iCount Admin ────────────────────────────────────────────────────────────
// Two server-driven jobs (credentials live in the icount-admin edge function):
//   1. Set item_type_id=8 ("פולי קפה מינוטו") on specialty-coffee items
//      (matched by SKU to the Woo specialty-coffee category).
//   2. Upload each item's matching WooCommerce product image (matched by SKU),
//      processed in batches so it never hits the edge-function timeout.
// Every job previews first (dry-run); nothing is written until you confirm.

const call = (body) => supabase.functions.invoke('icount-admin', { body });

export default function IcountAdmin() {
  const { showToast } = useApp();

  const [status, setStatus]   = useState(null);
  const [loading, setLoading] = useState(false);

  // types job
  const [typePreview, setTypePreview] = useState(null);
  const [typeBusy, setTypeBusy]       = useState(false);

  // images job
  const [imgBusy, setImgBusy]       = useState(false);
  const [imgProgress, setImgProgress] = useState(null); // {processed,total,uploaded,skippedHasImage,skippedNoWoo,failed,done}

  useEffect(() => { loadStatus(); }, []); // eslint-disable-line

  async function loadStatus() {
    setLoading(true);
    try {
      const { data, error } = await call({ action: 'status' });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      setStatus(data);
    } catch (e) {
      showToast(`❌ ${e.message}`, 'error');
    } finally { setLoading(false); }
  }

  // ── Types ─────────────────────────────────────────────────────────────────
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
      setTypePreview(null);
      loadStatus();
    } catch (e) { showToast(`❌ ${e.message}`, 'error'); }
    finally { setTypeBusy(false); }
  }

  // ── Images ──────────────────────────────────────────────────────────────────
  // Loops batches of set_images until done, accumulating totals.
  async function runImages(dryRun) {
    setImgBusy(true);
    const totals = { processed: 0, uploaded: 0, skippedHasImage: 0, skippedNoWoo: 0, failed: 0, total: 0, done: false };
    setImgProgress({ ...totals });
    try {
      let offset = 0;
      for (;;) {
        const { data, error } = await call({ action: 'set_images', dry_run: dryRun, offset, limit: 15 });
        if (error || data?.error) throw new Error(data?.error || error?.message);
        totals.total          = data.total_with_sku;
        totals.processed     += data.processed;
        totals.uploaded      += data.uploaded;
        totals.skippedHasImage += data.skipped_has_image;
        totals.skippedNoWoo  += data.skipped_no_woo;
        totals.failed        += data.failed;
        totals.done           = data.done;
        setImgProgress({ ...totals });
        if (data.done) break;
        offset = data.next_offset;
      }
      const verb = dryRun ? 'יועלו' : 'הועלו';
      showToast(`✅ סיום: ${verb} ${totals.uploaded} תמונות, ${totals.skippedHasImage} כבר עם תמונה, ${totals.skippedNoWoo} ללא תמונה ב-Woo`, 'success');
    } catch (e) { showToast(`❌ ${e.message}`, 'error'); }
    finally { setImgBusy(false); }
  }

  // ── styles ──────────────────────────────────────────────────────────────────
  const card = { background: 'white', borderRadius: '12px', padding: '1.5rem', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', maxWidth: '720px', margin: '1.25rem auto' };
  const btn = (bg, disabled) => ({ padding: '0.7rem 1.1rem', fontSize: '0.95rem', fontWeight: 700, color: 'white', background: disabled ? '#9CA3AF' : bg, border: 'none', borderRadius: '8px', cursor: disabled ? 'default' : 'pointer', marginInlineEnd: '0.6rem' });
  const stat = { display: 'inline-block', minWidth: '120px', margin: '0.3rem 0.6rem 0.3rem 0', fontSize: '0.95rem' };

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
            {typePreview.preview?.length > 0 && (
              <div style={{ maxHeight: '180px', overflow: 'auto', marginTop: '0.5rem', border: '1px solid #eee', borderRadius: '8px', padding: '0.4rem 0.7rem' }}>
                {typePreview.preview.map((p) => (
                  <div key={p.id} style={{ fontSize: '0.82rem', padding: '0.15rem 0' }}>
                    <span style={{ color: '#888' }}>[{p.from || '?'}→8]</span> {p.sku} — {p.name}
                  </div>
                ))}
              </div>
            )}
            {typePreview.missing_in_icount?.length > 0 && (
              <p style={{ color: '#B45309', marginTop: '0.5rem', fontSize: '0.82rem' }}>
                מק"טים בקטגוריה שלא נמצאו ב-iCount ({typePreview.missing_in_icount.length}): {typePreview.missing_in_icount.join(', ')}
              </p>
            )}
          </div>
        )}
      </div>

      {/* images */}
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>תמונות מוצרים</h3>
        <p style={{ color: '#555', fontSize: '0.9rem' }}>מעלה לכל פריט ב-iCount את תמונת המוצר התואמת מ-WooCommerce (לפי מק"ט). מדלג על פריטים שכבר יש להם תמונה או שאין להם התאמה ב-Woo.</p>
        <button style={btn('#2563EB', imgBusy)} disabled={imgBusy} onClick={() => runImages(true)}>תצוגה מקדימה (ללא העלאה)</button>
        <button style={btn('#16A34A', imgBusy)} disabled={imgBusy} onClick={() => { if (window.confirm('להעלות תמונות לכל הפריטים החסרים?')) runImages(false); }}>העלאת תמונות</button>
        {imgProgress && (
          <div style={{ marginTop: '0.9rem', fontSize: '0.9rem' }}>
            <div style={{ background: '#eee', borderRadius: '6px', height: '10px', overflow: 'hidden', marginBottom: '0.6rem' }}>
              <div style={{ width: `${imgProgress.total ? Math.round((imgProgress.processed / imgProgress.total) * 100) : 0}%`, height: '100%', background: imgProgress.done ? '#16A34A' : '#2563EB', transition: 'width 0.3s' }} />
            </div>
            <span style={stat}>עובדו: <b>{imgProgress.processed}/{imgProgress.total}</b></span>
            <span style={stat}>הועלו: <b>{imgProgress.uploaded}</b></span>
            <span style={stat}>כבר עם תמונה: <b>{imgProgress.skippedHasImage}</b></span>
            <span style={stat}>ללא תמונה ב-Woo: <b>{imgProgress.skippedNoWoo}</b></span>
            {imgProgress.failed > 0 && <span style={{ ...stat, color: '#B91C1C' }}>נכשלו: <b>{imgProgress.failed}</b></span>}
            {imgBusy && <span style={{ color: '#2563EB' }}> מעבד…</span>}
          </div>
        )}
      </div>
    </div>
  );
}
