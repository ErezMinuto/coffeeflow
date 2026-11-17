import React, { useEffect, useState } from 'react';
import { Search, Plus, Download, Trash2 } from 'lucide-react';
import { useApp } from '../../lib/context';
import { PageHeader } from '../shared/ui';
import './vehicle.css';
import { supabase } from '../../lib/supabase';

// ── Vehicle log (admin) ──────────────────────────────────────────────────────
// Who had the shared work car and when, as recorded through employee-bot's
// "🚙 יומן רכב" menu (table vehicle_trips, admin-only RLS). Three jobs:
//   1. trips in a date range, with CSV export
//   2. "who had the car at <date time>" lookup for traffic fines
//   3. adding a trip someone didn't record (end_reason 'manual', admin RPC)
// All times shown in Israel time; the RPCs do the local→UTC conversion.

const TZ = 'Asia/Jerusalem';

const isoDayIL = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: TZ });
const daysAgoIL = (n) => isoDayIL(new Date(Date.now() - n * 86400000));
// ISO instant → Israel wall-clock "YYYY-MM-DDTHH:MM", the datetime-local format
const localIL = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16).replace(' ', 'T');

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
  if (!trip.ended_at) return <span className="tag"><span className="dot ok" aria-hidden="true" />עדיין בנסיעה</span>;
  if (trip.end_reason === 'handover') return <span className="tag warn">לא סומנה החזרה</span>;
  if (trip.end_reason === 'admin') return <span className="tag">נסגר ע״י הנהלה</span>;
  if (trip.end_reason === 'manual') return <span className="tag">נרשם ידנית</span>;
  return <span className="vehicle-returned">הוחזר</span>;
}

export default function VehicleLog() {
  const { showToast, employees } = useApp();
  const [from, setFrom] = useState(daysAgoIL(30));
  const [to, setTo] = useState(isoDayIL());
  const [trips, setTrips] = useState(null);
  const [loading, setLoading] = useState(false);

  const [at, setAt] = useState('');
  const [atResult, setAtResult] = useState(null);
  const [atLoading, setAtLoading] = useState(false);

  const [man, setMan] = useState({ employeeId: '', start: '', end: '', note: '' });
  const [saving, setSaving] = useState(false);
  const drivers = [...(employees || [])].sort((a, b) =>
    (b.active === true) - (a.active === true) || String(a.name).localeCompare(String(b.name), 'he'));

  async function load() {
    if (!from || !to) { showToast('נא לבחור תאריך התחלה וסיום', 'warning'); return; }
    if (from > to) { showToast('⚠️ תאריך ההתחלה מאוחר מהסיום', 'warning'); return; }
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('vehicle_trips_between', { from_day: from, to_day: to });
      if (error) throw error;
      setTrips(data || []);
    } catch (e) {
      showToast(`${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function lookup() {
    if (!at) { showToast('נא לבחור תאריך ושעה', 'warning'); return; }
    setAtLoading(true); setAtResult(null);
    try {
      // datetime-local gives "YYYY-MM-DDTHH:MM" in Israel wall-clock time
      const { data, error } = await supabase.rpc('vehicle_driver_at', { local_ts: at.replace('T', ' ') });
      if (error) throw error;
      setAtResult(data || []);
    } catch (e) {
      showToast(`${e.message}`, 'error');
    } finally {
      setAtLoading(false);
    }
  }

  async function addManual() {
    const { employeeId, start, end, note } = man;
    if (!employeeId || !start || !end) { showToast('נא לבחור נהג/ת, שעת לקיחה ושעת החזרה', 'warning'); return; }
    if (end <= start) { showToast('⚠️ שעת ההחזרה חייבת להיות אחרי שעת הלקיחה', 'warning'); return; }
    setSaving(true);
    try {
      // Overlaps are allowed (a "handover" trip's end time is only an estimate),
      // but the admin should see them before saving.
      const { data: near, error: nearErr } = await supabase.rpc('vehicle_trips_between', {
        from_day: start.slice(0, 10), to_day: end.slice(0, 10),
      });
      if (nearErr) throw nearErr;
      const overlaps = (near || []).filter((t) =>
        localIL(t.started_at) < end && (t.ended_at ? localIL(t.ended_at) : localIL(new Date().toISOString())) > start);
      if (overlaps.length) {
        const list = overlaps.map((t) => `• ${t.driver_name}: ${fmt(t.started_at)} → ${t.ended_at ? fmt(t.ended_at) : 'עדיין בנסיעה'}`).join('\n');
        if (!window.confirm(`הנסיעה חופפת לנסיעות שכבר רשומות:\n${list}\n\nלשמור בכל זאת?`)) return;
      }
      const { error } = await supabase.rpc('vehicle_trip_add_manual', {
        p_employee_id: Number(employeeId),
        p_started_local: start.replace('T', ' '),
        p_ended_local: end.replace('T', ' '),
        p_note: note || null,
      });
      if (error) throw error;
      showToast('הנסיעה נוספה ליומן', 'success');
      setMan({ employeeId: '', start: '', end: '', note: '' });
      load();
    } catch (e) {
      showToast(`${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function removeManual(t) {
    if (!window.confirm(`למחוק את הנסיעה הידנית של ${t.driver_name} (${fmt(t.started_at)})?`)) return;
    const { error } = await supabase.rpc('vehicle_trip_delete_manual', { p_id: t.id });
    if (error) { showToast(`${error.message}`, 'error'); return; }
    showToast('הנסיעה נמחקה', 'success');
    load();
  }

  function exportCsv() {
    if (!trips?.length) return;
    const reason = (t) => (!t.ended_at ? 'בנסיעה' : t.end_reason === 'handover' ? 'לא סימן החזרה' : t.end_reason === 'admin' ? 'נסגר ע"י מנהל' : t.end_reason === 'manual' ? 'נרשם ידנית' : 'הוחזר');
    const rows = [['נהג', 'לקיחה', 'החזרה', 'משך', 'סטטוס', 'הערה']];
    for (const t of trips) rows.push([t.driver_name, fmt(t.started_at), fmt(t.ended_at), duration(t.started_at, t.ended_at), reason(t), t.note || '']);
    const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `vehicle-log_${from}_${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const missedReturns = (trips || []).filter((t) => t.end_reason === 'handover').length;

  return (
    <div className="page vehicle-page">
      <PageHeader title="יומן רכב" subtitle="מי לקח את רכב העבודה ומתי, לפי הרישום בבוט הצוות" />

      <div className="vehicle-grid">
        {/* Fine lookup */}
        <section className="card flush">
          <div className="card-head"><h2>מי היה עם הרכב? (לדוחות)</h2></div>
          <div className="card-body">
            <div className="vehicle-fields">
              <div className="form-group grow">
                <label htmlFor="veh-at">תאריך ושעה מהדוח</label>
                <input id="veh-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
              </div>
              <button type="button" className="btn primary" disabled={atLoading} onClick={lookup}>
                <Search aria-hidden="true" />{atLoading ? 'בחיפוש…' : 'חיפוש'}
              </button>
            </div>

            {atResult && (
              atResult.length === 0 ? (
                <p className="notice warn vehicle-result">
                  בזמן הזה הרכב לא היה רשום על אף אחד. כדאי לבדוק בטבלה למטה מי לקח לפני ואחרי.
                </p>
              ) : (
                <ul className="vehicle-hits vehicle-result">
                  {atResult.map((t, i) => (
                    <li key={i} className="vehicle-hit">
                      <strong className="vehicle-hit-name">{t.driver_name}</strong>
                      <span className="vehicle-hit-time num">
                        {fmt(t.started_at)} ← {t.ended_at ? fmt(t.ended_at) : 'עדיין בנסיעה'}
                      </span>
                      {t.end_reason === 'handover' && <span className="tag warn">לא סומנה החזרה, שעת הסיום משוערת</span>}
                      {t.end_reason === 'manual' && <span className="tag">נרשם ידנית</span>}
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>
        </section>

        {/* Manual trip: someone took the car without recording it */}
        <section className="card flush">
          <div className="card-head"><h2>הוספת נסיעה שלא נרשמה</h2></div>
          <div className="card-body">
            <p className="field-help vehicle-intro">
              למקרה שהרכב נלקח בלי סימון בבוט. הנסיעה תסומן ביומן כ״נרשם ידנית״.
            </p>
            <div className="vehicle-form">
              <div className="form-group span-2">
                <label htmlFor="veh-driver">נהג/ת</label>
                <select id="veh-driver" value={man.employeeId} onChange={(e) => setMan({ ...man, employeeId: e.target.value })}>
                  <option value="">בחירה…</option>
                  {drivers.map((e) => (
                    <option key={e.id} value={e.id}>{e.name}{e.active === false ? ' (לא פעיל/ה)' : ''}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="veh-start">לקיחה</label>
                <input id="veh-start" type="datetime-local" value={man.start} max={man.end || undefined} onChange={(e) => setMan({ ...man, start: e.target.value })} />
              </div>
              <div className="form-group">
                <label htmlFor="veh-end">החזרה</label>
                <input id="veh-end" type="datetime-local" value={man.end} min={man.start || undefined} onChange={(e) => setMan({ ...man, end: e.target.value })} />
              </div>
              <div className="form-group span-2">
                <label htmlFor="veh-note">הערה (לא חובה)</label>
                <input id="veh-note" type="text" value={man.note} maxLength={200} placeholder="למשל: לפי מה שסיפר/ה" onChange={(e) => setMan({ ...man, note: e.target.value })} />
              </div>
            </div>
            <button type="button" className="btn" disabled={saving} onClick={addManual}>
              <Plus aria-hidden="true" />{saving ? 'בשמירה…' : 'הוספה ליומן'}
            </button>
          </div>
        </section>
      </div>

      {/* Trips table */}
      <section className="card flush">
        <div className="card-head">
          <h2>נסיעות</h2>
          {trips && (
            <span className="meta num">
              {trips.length} נסיעות{missedReturns > 0 ? ` · ${missedReturns} בלי סימון החזרה` : ''}
            </span>
          )}
        </div>
        <div className="vehicle-filters">
          <div className="form-group">
            <label htmlFor="veh-from">מתאריך</label>
            <input id="veh-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="veh-to">עד תאריך</label>
            <input id="veh-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="vehicle-filter-actions">
            <button type="button" className="btn" disabled={loading} onClick={load}>{loading ? 'בטעינה…' : 'הצגה'}</button>
            {trips?.length > 0 && (
              <button type="button" className="btn ghost" disabled={loading} onClick={exportCsv}>
                <Download aria-hidden="true" />ייצוא CSV
              </button>
            )}
          </div>
        </div>

        {trips && (
          trips.length === 0 ? (
            <p className="empty-state">אין נסיעות בטווח שנבחר.</p>
          ) : (
            <div className="vehicle-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>נהג/ת</th>
                    <th>לקיחה</th>
                    <th>החזרה</th>
                    <th>משך</th>
                    <th>סטטוס</th>
                    <th aria-label="פעולות" />
                  </tr>
                </thead>
                <tbody>
                  {trips.map((t) => (
                    <tr key={t.id}>
                      <td className="vehicle-driver">{t.driver_name}</td>
                      <td className="num">{fmt(t.started_at)}</td>
                      <td className="num">{t.ended_at ? fmt(t.ended_at) : <span className="text-muted">בנסיעה</span>}</td>
                      <td className="num">{duration(t.started_at, t.ended_at)}</td>
                      <td>
                        <StatusCell trip={t} />
                        {t.note && <div className="vehicle-note">{t.note}</div>}
                      </td>
                      <td className="vehicle-act">
                        {t.end_reason === 'manual' && (
                          <button type="button" className="btn-icon danger" title="מחיקת נסיעה ידנית" aria-label="מחיקת נסיעה ידנית" onClick={() => removeManual(t)}>
                            <Trash2 aria-hidden="true" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </section>
    </div>
  );
}
