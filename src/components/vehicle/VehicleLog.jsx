import React, { useEffect, useState } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';

// ── Vehicle log (admin) ──────────────────────────────────────────────────────
// Who had the shared work car and when, as recorded by the vehicle Telegram
// bot (tables drivers + vehicle_trips, admin-only RLS). Two jobs:
//   1. trips in a date range, with CSV export
//   2. "who had the car at <date time>" lookup for traffic fines
// All times shown in Israel time; the RPCs do the local→UTC conversion.

const TZ = 'Asia/Jerusalem';

const isoDayIL = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: TZ });
const daysAgoIL = (n) => isoDayIL(new Date(Date.now() - n * 86400000));

const fmt = (iso) =>
  iso
    ? new Date(iso).toLocaleString('he-IL', {
        timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : '';

function duration(fromIso, toIso) {
  const end = toIso ? Date.parse(toIso) : Date.now();
  const mins = Math.max(0, Math.round((end - Date.parse(fromIso)) / 60000));
  const h = Math.floor(mins / 60);
  return h ? `${h} ש׳ ${mins % 60} ד׳` : `${mins} ד׳`;
}

function StatusCell({ trip }) {
  if (!trip.ended_at) return <span style={pill('#DBEAFE', '#1E40AF')}>עדיין בנסיעה</span>;
  if (trip.end_reason === 'handover') return <span style={pill('#FEF3C7', '#92400E')}>⚠️ לא סימן החזרה</span>;
  if (trip.end_reason === 'admin') return <span style={pill('#F3F4F6', '#374151')}>נסגר ע״י מנהל</span>;
  return <span style={pill('#DCFCE7', '#166534')}>הוחזר</span>;
}

const pill = (bg, color) => ({
  background: bg, color, borderRadius: '999px', padding: '2px 10px', fontSize: '0.78rem', fontWeight: 600, whiteSpace: 'nowrap',
});

export default function VehicleLog() {
  const { showToast } = useApp();
  const [from, setFrom] = useState(daysAgoIL(30));
  const [to, setTo] = useState(isoDayIL());
  const [trips, setTrips] = useState(null);
  const [loading, setLoading] = useState(false);

  const [at, setAt] = useState('');
  const [atResult, setAtResult] = useState(null);
  const [atLoading, setAtLoading] = useState(false);

  async function load() {
    if (!from || !to) { showToast('⚠️ נא לבחור תאריך התחלה וסיום', 'warning'); return; }
    if (from > to) { showToast('⚠️ תאריך ההתחלה מאוחר מהסיום', 'warning'); return; }
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('vehicle_trips_between', { from_day: from, to_day: to });
      if (error) throw error;
      setTrips(data || []);
    } catch (e) {
      showToast(`❌ ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function lookup() {
    if (!at) { showToast('⚠️ נא לבחור תאריך ושעה', 'warning'); return; }
    setAtLoading(true); setAtResult(null);
    try {
      // datetime-local gives "YYYY-MM-DDTHH:MM" in Israel wall-clock time
      const { data, error } = await supabase.rpc('vehicle_driver_at', { local_ts: at.replace('T', ' ') });
      if (error) throw error;
      setAtResult(data || []);
    } catch (e) {
      showToast(`❌ ${e.message}`, 'error');
    } finally {
      setAtLoading(false);
    }
  }

  function exportCsv() {
    if (!trips?.length) return;
    const reason = (t) => (!t.ended_at ? 'בנסיעה' : t.end_reason === 'handover' ? 'לא סימן החזרה' : t.end_reason === 'admin' ? 'נסגר ע"י מנהל' : 'הוחזר');
    const rows = [['נהג', 'לקיחה', 'החזרה', 'משך', 'סטטוס']];
    for (const t of trips) rows.push([t.driver_name, fmt(t.started_at), fmt(t.ended_at), duration(t.started_at, t.ended_at), reason(t)]);
    const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `vehicle-log_${from}_${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const card = { background: 'white', borderRadius: '12px', padding: '1.5rem', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', maxWidth: '900px', margin: '1.25rem auto' };
  const btn = (bg, disabled) => ({ padding: '0.7rem 1.1rem', fontSize: '0.95rem', fontWeight: 700, color: 'white', background: disabled ? '#9CA3AF' : bg, border: 'none', borderRadius: '8px', cursor: disabled ? 'default' : 'pointer', marginInlineEnd: '0.6rem' });
  const input = { padding: '0.55rem 0.7rem', fontSize: '0.95rem', border: '1px solid #D5DBC8', borderRadius: '8px', marginInlineEnd: '0.6rem', marginInlineStart: '0.4rem' };
  const label = { fontSize: '0.85rem', color: '#374151', display: 'inline-block', marginBottom: '0.5rem' };
  const th = { textAlign: 'right', padding: '0.5rem 0.7rem', borderBottom: '2px solid #E5E7EB', fontSize: '0.85rem', color: '#374151' };
  const td = { padding: '0.45rem 0.7rem', borderBottom: '1px solid #F3F4F6', fontSize: '0.88rem' };

  const missedReturns = (trips || []).filter((t) => t.end_reason === 'handover').length;

  return (
    <div style={{ direction: 'rtl', paddingBottom: '3rem' }}>
      <h2 style={{ textAlign: 'center', marginTop: '1.25rem' }}>יומן רכב</h2>

      {/* Fine lookup */}
      <div style={card}>
        <h3 style={{ marginTop: 0, fontSize: '1.05rem' }}>🔎 מי היה עם הרכב? (לדוחות)</h3>
        <label style={label}>תאריך ושעה מהדוח
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} style={input} />
        </label>
        <button style={btn('#3D4A2E', atLoading)} disabled={atLoading} onClick={lookup}>{atLoading ? 'מחפש…' : 'חפש'}</button>

        {atResult && (
          atResult.length === 0 ? (
            <p style={{ background: '#FEF3C7', color: '#92400E', padding: '0.6rem 0.8rem', borderRadius: '8px', fontSize: '0.9rem', marginBottom: 0 }}>
              בזמן הזה הרכב לא היה רשום על אף אחד. כדאי לבדוק בטבלה למטה מי לקח לפני ואחרי.
            </p>
          ) : (
            <div style={{ marginTop: '0.75rem' }}>
              {atResult.map((t, i) => (
                <div key={i} style={{ background: '#F0FDF4', borderRadius: '8px', padding: '0.7rem 0.9rem', marginBottom: '0.4rem' }}>
                  <strong style={{ fontSize: '1.05rem' }}>{t.driver_name}</strong>
                  <span style={{ color: '#4B5563', fontSize: '0.88rem', marginInlineStart: '0.6rem' }}>
                    {fmt(t.started_at)} → {t.ended_at ? fmt(t.ended_at) : 'עדיין בנסיעה'}
                  </span>
                  {t.end_reason === 'handover' && <span style={{ ...pill('#FEF3C7', '#92400E'), marginInlineStart: '0.6rem' }}>⚠️ לא סימן החזרה — שעת הסיום משוערת</span>}
                </div>
              ))}
            </div>
          )
        )}
      </div>

      {/* Trips table */}
      <div style={card}>
        <label style={label}>מתאריך
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={input} />
        </label>
        <label style={label}>עד תאריך
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} style={input} />
        </label>
        <button style={btn('#16A34A', loading)} disabled={loading} onClick={load}>{loading ? 'טוען…' : 'הצג'}</button>
        {trips?.length > 0 && <button style={btn('#6B7280', loading)} disabled={loading} onClick={exportCsv}>ייצוא CSV</button>}

        {trips && (
          <div style={{ marginTop: '1rem', overflowX: 'auto' }}>
            <p style={{ color: '#6B7280', fontSize: '0.85rem', marginTop: 0 }}>
              {trips.length} נסיעות{missedReturns > 0 ? ` · ${missedReturns} בלי סימון החזרה` : ''}
            </p>
            {trips.length === 0 ? (
              <p style={{ color: '#6B7280' }}>אין נסיעות בטווח שנבחר.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '560px' }}>
                <thead>
                  <tr>
                    <th style={th}>נהג</th>
                    <th style={th}>לקיחה</th>
                    <th style={th}>החזרה</th>
                    <th style={{ ...th, textAlign: 'center' }}>משך</th>
                    <th style={th}>סטטוס</th>
                  </tr>
                </thead>
                <tbody>
                  {trips.map((t) => (
                    <tr key={t.id}>
                      <td style={{ ...td, fontWeight: 600 }}>{t.driver_name}</td>
                      <td style={td}>{fmt(t.started_at)}</td>
                      <td style={td}>{t.ended_at ? fmt(t.ended_at) : '—'}</td>
                      <td style={{ ...td, textAlign: 'center' }}>{duration(t.started_at, t.ended_at)}</td>
                      <td style={td}><StatusCell trip={t} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
