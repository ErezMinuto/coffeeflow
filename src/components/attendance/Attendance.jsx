import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';

// ── Helpers ──────────────────────────────────────────────────────────────────

const HEBREW_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

const DAY_LABELS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

function israelDateOf(utcIso) {
  const d = new Date(utcIso);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function israelTimeOf(utcIso) {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(utcIso));
}

function ymKey(year, month1) {
  return `${year}-${String(month1).padStart(2, '0')}`;
}

function daysInMonth(year, month1) {
  return new Date(year, month1, 0).getDate();
}

function dayOfWeekFor(year, month1, day) {
  // Use UTC noon to dodge TZ drift; then read Asia/Jerusalem weekday.
  const d = new Date(Date.UTC(year, month1 - 1, day, 12, 0, 0));
  const wd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', weekday: 'short',
  }).format(d).toLowerCase();
  const codes = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return codes.findIndex(c => wd.startsWith(c));
}

// Pair sorted in/out events into shifts. Returns { firstIn, lastOut, hours, warnings[] }.
function summarizeDay(events) {
  const sorted = [...events].sort((a, b) => a.event_at.localeCompare(b.event_at));
  let pendingIn = null;
  let totalMs = 0;
  let firstIn = null, lastOut = null;
  const warnings = [];
  for (const e of sorted) {
    if (e.event_type === 'in') {
      if (pendingIn) warnings.push('שתי כניסות רצופות');
      pendingIn = new Date(e.event_at);
      if (!firstIn) firstIn = pendingIn;
    } else {
      if (!pendingIn) { warnings.push('יציאה ללא כניסה'); continue; }
      const out = new Date(e.event_at);
      totalMs += out.getTime() - pendingIn.getTime();
      lastOut = out;
      pendingIn = null;
    }
  }
  if (pendingIn) warnings.push('חסרה החתמת יציאה');
  return {
    firstIn,
    lastOut,
    hours: totalMs / 3_600_000,
    warnings,
    isOpen: !!pendingIn,
  };
}

// Israel-local YYYY-MM string for current "last month".
function defaultExportMonth() {
  const now = new Date();
  const israelDate = israelDateOf(now.toISOString());
  const [y, m] = israelDate.split('-').map(Number);
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  return ymKey(prevY, prevM);
}

// Build the UTC instant for Israel-local midnight of the given Y-M-D.
function utcForIsraelMidnight(year, month1, day) {
  const ymd = `${year}-${String(month1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Compute Israel offset at noon-UTC of that date.
  const probe = new Date(`${ymd}T12:00:00Z`);
  const tz = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    timeZoneName: 'shortOffset',
  }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value ?? 'GMT+3';
  const offset = parseInt(tz.replace('GMT', '').replace('+', '')) || 3;
  const utc = new Date(`${ymd}T00:00:00Z`);
  utc.setUTCHours(utc.getUTCHours() - offset);
  return utc;
}

// ── Edit modal ───────────────────────────────────────────────────────────────

function EditDayModal({ employee, dateStr, events, userId, onClose, onSaved }) {
  const [list, setList] = useState(events);
  const [busy, setBusy] = useState(false);
  const [newTime, setNewTime] = useState('09:30');
  const [newType, setNewType] = useState('in');

  const refresh = async () => {
    const start = utcForIsraelMidnight(...dateStr.split('-').map(Number));
    const next = new Date(start); next.setUTCDate(next.getUTCDate() + 1);
    const { data } = await supabase
      .from('attendance_events')
      .select('*')
      .eq('employee_id', employee.id)
      .gte('event_at', start.toISOString())
      .lt('event_at', next.toISOString())
      .order('event_at', { ascending: true });
    setList(data || []);
    onSaved();
  };

  const addEvent = async () => {
    setBusy(true);
    const [y, m, d] = dateStr.split('-').map(Number);
    const [hh, mm] = newTime.split(':').map(Number);
    // Build the UTC instant for Israel-local Y-M-D HH:MM.
    const midnight = utcForIsraelMidnight(y, m, d);
    const evAt = new Date(midnight);
    evAt.setUTCMinutes(evAt.getUTCMinutes() + hh * 60 + mm);
    const { error } = await supabase.from('attendance_events').insert({
      employee_id: employee.id,
      event_type: newType,
      event_at: evAt.toISOString(),
      source: 'manual',
      edited_by_user_id: userId,
      edited_at: new Date().toISOString(),
    });
    setBusy(false);
    if (error) { alert(`שגיאה: ${error.message}`); return; }
    await refresh();
  };

  const deleteEvent = async (id) => {
    if (!window.confirm('למחוק את הרישום?')) return;
    const { error } = await supabase.from('attendance_events').delete().eq('id', id);
    if (error) { alert(`שגיאה: ${error.message}`); return; }
    await refresh();
  };

  const updateTime = async (ev, newHHMM) => {
    const [hh, mm] = newHHMM.split(':').map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return;
    const [y, m, d] = dateStr.split('-').map(Number);
    const midnight = utcForIsraelMidnight(y, m, d);
    const evAt = new Date(midnight);
    evAt.setUTCMinutes(evAt.getUTCMinutes() + hh * 60 + mm);
    const { error } = await supabase
      .from('attendance_events')
      .update({
        event_at: evAt.toISOString(),
        source: 'manual',
        edited_by_user_id: userId,
        edited_at: new Date().toISOString(),
      })
      .eq('id', ev.id);
    if (error) { alert(`שגיאה: ${error.message}`); return; }
    await refresh();
  };

  const sorted = [...list].sort((a, b) => a.event_at.localeCompare(b.event_at));
  const summary = summarizeDay(sorted);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <div style={{
        background: 'white', borderRadius: 12, padding: '1.5rem',
        minWidth: 360, maxWidth: 480, direction: 'rtl',
      }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: 0, marginBottom: 4 }}>{employee.name}</h3>
        <div style={{ color: '#666', fontSize: '0.9rem', marginBottom: '1rem' }}>{dateStr}</div>

        {sorted.length === 0 && (
          <div style={{ color: '#999', padding: '1rem 0' }}>אין רישומים ליום זה</div>
        )}

        {sorted.map(ev => (
          <div key={ev.id} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '0.5rem 0', borderBottom: '1px solid #eee',
          }}>
            <span style={{
              fontWeight: 600, color: ev.event_type === 'in' ? '#16a34a' : '#dc2626',
              minWidth: 60,
            }}>
              {ev.event_type === 'in' ? 'כניסה' : 'יציאה'}
            </span>
            <input
              type="time"
              defaultValue={israelTimeOf(ev.event_at)}
              onBlur={e => {
                if (e.target.value !== israelTimeOf(ev.event_at)) {
                  updateTime(ev, e.target.value);
                }
              }}
              style={{ padding: '0.3rem 0.5rem', border: '1px solid #ddd', borderRadius: 4 }}
            />
            <span style={{ fontSize: '0.75rem', color: '#888' }}>
              {ev.source === 'manual' ? '✏️' : '🤖'}
            </span>
            <button
              onClick={() => deleteEvent(ev.id)}
              style={{ marginRight: 'auto', background: 'none', border: 'none',
                       cursor: 'pointer', color: '#dc2626' }}
            >
              מחק
            </button>
          </div>
        ))}

        <div style={{ marginTop: '1rem', padding: '0.75rem',
                      background: '#f9fafb', borderRadius: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>הוסף רישום</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={newType} onChange={e => setNewType(e.target.value)}
                    style={{ padding: '0.3rem' }}>
              <option value="in">כניסה</option>
              <option value="out">יציאה</option>
            </select>
            <input type="time" value={newTime} onChange={e => setNewTime(e.target.value)}
                   style={{ padding: '0.3rem 0.5rem', border: '1px solid #ddd', borderRadius: 4 }} />
            <button onClick={addEvent} disabled={busy}
                    style={{ padding: '0.4rem 0.9rem', background: '#16a34a',
                             color: 'white', border: 'none', borderRadius: 6,
                             cursor: 'pointer', fontWeight: 600 }}>
              הוסף
            </button>
          </div>
        </div>

        <div style={{ marginTop: '1rem', fontSize: '0.9rem', color: '#444' }}>
          סה״כ שעות: <b>{summary.hours.toFixed(2)}</b>
          {summary.warnings.length > 0 && (
            <span style={{ color: '#dc2626', marginRight: 12 }}>
              ⚠️ {summary.warnings.join(', ')}
            </span>
          )}
        </div>

        <div style={{ marginTop: '1rem', textAlign: 'left' }}>
          <button onClick={onClose}
                  style={{ padding: '0.5rem 1rem', background: '#6b7280',
                           color: 'white', border: 'none', borderRadius: 6,
                           cursor: 'pointer' }}>
            סגור
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Settings section ─────────────────────────────────────────────────────────

function SettingsCard({ settings, onSave }) {
  const [email, setEmail]               = useState(settings?.accountant_email ?? '');
  const [checkinGrace, setCheckinGrace]   = useState(settings?.checkin_grace_minutes ?? 10);
  const [checkoutGrace, setCheckoutGrace] = useState(settings?.checkout_grace_minutes ?? 30);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEmail(settings?.accountant_email ?? '');
    setCheckinGrace(settings?.checkin_grace_minutes ?? 10);
    setCheckoutGrace(settings?.checkout_grace_minutes ?? 30);
  }, [settings]);

  const save = async () => {
    setBusy(true);
    const { error } = await supabase
      .from('attendance_settings')
      .update({
        accountant_email:         email.trim() || null,
        checkin_grace_minutes:    Math.max(0, parseInt(checkinGrace)  || 0),
        checkout_grace_minutes:   Math.max(0, parseInt(checkoutGrace) || 0),
        updated_at:               new Date().toISOString(),
      })
      .eq('id', 1);
    setBusy(false);
    if (error) { alert(`שגיאה: ${error.message}`); return; }
    onSave();
  };

  return (
    <div style={{
      background: 'white', padding: '1rem', borderRadius: 10,
      boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: '1rem',
    }}>
      <h3 style={{ margin: 0, marginBottom: 12 }}>הגדרות</h3>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 240px' }}>
          <span style={{ fontSize: '0.85rem', color: '#666' }}>אימייל רו״ח</span>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                 placeholder="accountant@example.com"
                 style={{ padding: '0.5rem', border: '1px solid #ddd', borderRadius: 6 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.85rem', color: '#666' }}>תזכורת כניסה (דקות אחרי תחילת משמרת)</span>
          <input type="number" min="0" value={checkinGrace}
                 onChange={e => setCheckinGrace(e.target.value)}
                 style={{ padding: '0.5rem', border: '1px solid #ddd',
                          borderRadius: 6, width: 80 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.85rem', color: '#666' }}>תזכורת יציאה (דקות אחרי סיום משמרת)</span>
          <input type="number" min="0" value={checkoutGrace}
                 onChange={e => setCheckoutGrace(e.target.value)}
                 style={{ padding: '0.5rem', border: '1px solid #ddd',
                          borderRadius: 6, width: 80 }} />
        </label>
        <button onClick={save} disabled={busy}
                style={{ padding: '0.55rem 1.25rem', background: '#3D4A2E',
                         color: 'white', border: 'none', borderRadius: 6,
                         cursor: 'pointer', fontWeight: 600 }}>
          {busy ? 'שומר…' : 'שמור'}
        </button>
      </div>
    </div>
  );
}

function HolidaysCard({ onChange }) {
  const [list, setList] = useState([]);
  const [newDate, setNewDate] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const { data } = await supabase
      .from('attendance_holidays')
      .select('*')
      .order('holiday_date', { ascending: true });
    setList(data || []);
    onChange?.();
  };

  useEffect(() => { reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    if (!newDate) return;
    setBusy(true);
    const { error } = await supabase
      .from('attendance_holidays')
      .insert({ holiday_date: newDate, label: newLabel.trim() || null });
    setBusy(false);
    if (error) { alert(`שגיאה: ${error.message}`); return; }
    setNewDate(''); setNewLabel('');
    await reload();
  };

  const remove = async (date) => {
    if (!window.confirm(`למחוק את ${date}?`)) return;
    const { error } = await supabase
      .from('attendance_holidays')
      .delete()
      .eq('holiday_date', date);
    if (error) { alert(`שגיאה: ${error.message}`); return; }
    await reload();
  };

  return (
    <div style={{
      background: 'white', padding: '1rem', borderRadius: 10,
      boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: '1rem',
    }}>
      <h3 style={{ margin: 0, marginBottom: 4 }}>חגים</h3>
      <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: 12 }}>
        בתאריכים אלו תחול חוקת יום שישי (סיום ב-15:00).
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)}
               style={{ padding: '0.4rem', border: '1px solid #ddd', borderRadius: 6 }} />
        <input type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)}
               placeholder="שם החג (אופציונלי)"
               style={{ padding: '0.4rem', border: '1px solid #ddd',
                        borderRadius: 6, flex: '1 1 200px' }} />
        <button onClick={add} disabled={busy || !newDate}
                style={{ padding: '0.45rem 1rem', background: '#3D4A2E',
                         color: 'white', border: 'none', borderRadius: 6,
                         cursor: busy ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
          הוסף
        </button>
      </div>

      {list.length === 0 ? (
        <div style={{ color: '#999', fontSize: '0.9rem' }}>אין חגים מוגדרים.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {list.map(h => (
            <div key={h.holiday_date}
                 style={{ display: 'flex', alignItems: 'center', gap: 12,
                          padding: '0.4rem 0.6rem',
                          background: '#f9fafb', borderRadius: 6 }}>
              <span style={{ fontWeight: 600, minWidth: 100 }}>{h.holiday_date}</span>
              <span style={{ color: '#444', flex: 1 }}>{h.label || ''}</span>
              <button onClick={() => remove(h.holiday_date)}
                      style={{ background: 'none', border: 'none',
                               color: '#dc2626', cursor: 'pointer' }}>
                מחק
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function Attendance() {
  const { data, user, showToast } = useApp();
  const employees = useMemo(
    () => (data.employees || []).filter(e => e.active && e.user_id !== 'pending'),
    [data.employees],
  );

  const today = new Date();
  const israelToday = israelDateOf(today.toISOString());
  const [iy, im] = israelToday.split('-').map(Number);

  const [year, setYear]   = useState(iy);
  const [month, setMonth] = useState(im);
  const [events, setEvents] = useState([]);
  const [settings, setSettings] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const numDays = daysInMonth(year, month);
  const days = useMemo(
    () => Array.from({ length: numDays }, (_, i) => i + 1),
    [numDays],
  );

  // Load events for selected month.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const startUTC = utcForIsraelMidnight(year, month, 1);
      const endUTC   = utcForIsraelMidnight(
        month === 12 ? year + 1 : year,
        month === 12 ? 1 : month + 1,
        1,
      );
      const { data: rows, error } = await supabase
        .from('attendance_events')
        .select('*')
        .gte('event_at', startUTC.toISOString())
        .lt('event_at', endUTC.toISOString());
      if (cancelled) return;
      if (error) { console.error('load attendance:', error); setEvents([]); return; }
      setEvents(rows || []);
    })();
    return () => { cancelled = true; };
  }, [year, month, refreshKey]);

  // Load settings.
  useEffect(() => {
    (async () => {
      const { data: row } = await supabase
        .from('attendance_settings')
        .select('*')
        .eq('id', 1)
        .single();
      setSettings(row);
    })();
  }, [refreshKey]);

  const reload = useCallback(() => setRefreshKey(k => k + 1), []);

  // Group events by (employee_id, israel-date).
  const eventsByEmpDay = useMemo(() => {
    const map = new Map();
    for (const ev of events) {
      const date = israelDateOf(ev.event_at);
      const key = `${ev.employee_id}|${date}`;
      const list = map.get(key) ?? [];
      list.push(ev);
      map.set(key, list);
    }
    return map;
  }, [events]);

  const monthlyTotal = useCallback((empId) => {
    let h = 0, d = 0;
    for (const day of days) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const ev = eventsByEmpDay.get(`${empId}|${dateStr}`);
      if (!ev) continue;
      const s = summarizeDay(ev);
      if (s.hours > 0) { h += s.hours; d += 1; }
    }
    return { hours: h, days: d };
  }, [days, eventsByEmpDay, year, month]);

  const goPrev = () => {
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
  };
  const goNext = () => {
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
  };

  const exportToAccountant = async () => {
    if (!settings?.accountant_email) {
      alert('הגדר קודם אימייל רו״ח בהגדרות');
      return;
    }
    const ym = ymKey(year, month);
    const ok = window.confirm(
      `לשלוח דו״ח נוכחות לחודש ${ym} ל-${settings.accountant_email}?`,
    );
    if (!ok) return;
    setExportBusy(true);
    try {
      const { data: result, error } = await supabase.functions.invoke('attendance-export', {
        body: { year_month: ym },
      });
      if (error) throw error;
      if (!result?.ok) throw new Error(result?.error || 'unknown');
      showToast(`נשלח לרו״ח (${result.employee_count} עובדים)`, 'success');
    } catch (e) {
      showToast(`שגיאה: ${e.message}`, 'error');
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <div style={{ padding: '1rem 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    marginBottom: '1rem', flexWrap: 'wrap', gap: 12 }}>
        <h2 style={{ margin: 0 }}>נוכחות</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={goPrev} style={navBtn}>‹</button>
          <span style={{ fontSize: '1.05rem', fontWeight: 600, minWidth: 140, textAlign: 'center' }}>
            {HEBREW_MONTHS[month - 1]} {year}
          </span>
          <button onClick={goNext} style={navBtn}>›</button>
        </div>
        <button onClick={exportToAccountant} disabled={exportBusy}
                style={{ padding: '0.55rem 1.25rem', background: '#16a34a',
                         color: 'white', border: 'none', borderRadius: 6,
                         cursor: exportBusy ? 'not-allowed' : 'pointer',
                         fontWeight: 600, opacity: exportBusy ? 0.6 : 1 }}>
          {exportBusy ? 'שולח…' : '📧 שלח לרו״ח'}
        </button>
      </div>

      <SettingsCard settings={settings} onSave={reload} />
      <HolidaysCard />

      <div style={{ overflowX: 'auto', background: 'white', borderRadius: 10,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
        <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...cellTh, position: 'sticky', right: 0, background: '#f3f4f6',
                            minWidth: 120, zIndex: 2 }}>
                עובד
              </th>
              {days.map(d => {
                const dow = dayOfWeekFor(year, month, d);
                const isWeekend = dow === 5 || dow === 6;
                return (
                  <th key={d} style={{
                    ...cellTh,
                    background: isWeekend ? '#fef3c7' : '#f3f4f6',
                    minWidth: 64,
                  }}>
                    <div>{d}</div>
                    <div style={{ fontWeight: 400, fontSize: '0.75rem', color: '#666' }}>
                      {DAY_LABELS[dow]}
                    </div>
                  </th>
                );
              })}
              <th style={{ ...cellTh, background: '#e5e7eb', minWidth: 90 }}>סה״כ</th>
            </tr>
          </thead>
          <tbody>
            {employees.map(emp => {
              const total = monthlyTotal(emp.id);
              return (
                <tr key={emp.id}>
                  <td style={{ ...cellTd, position: 'sticky', right: 0, background: 'white',
                                fontWeight: 600 }}>
                    {emp.name}
                  </td>
                  {days.map(d => {
                    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                    const dayEvents = eventsByEmpDay.get(`${emp.id}|${dateStr}`) ?? [];
                    const s = dayEvents.length ? summarizeDay(dayEvents) : null;
                    const hasWarn = s && s.warnings.length > 0;
                    return (
                      <td key={d}
                          onClick={() => setEditTarget({ employee: emp, dateStr, events: dayEvents })}
                          style={{
                            ...cellTd, cursor: 'pointer',
                            background: hasWarn ? '#fef2f2' : (s ? '#f0fdf4' : 'white'),
                            fontSize: '0.78rem', textAlign: 'center',
                          }}>
                        {s ? (
                          <>
                            <div>{s.firstIn ? israelTimeOf(s.firstIn.toISOString()) : '—'}</div>
                            <div>{s.lastOut ? israelTimeOf(s.lastOut.toISOString()) : '—'}</div>
                            <div style={{ fontWeight: 700 }}>{s.hours.toFixed(1)}</div>
                          </>
                        ) : ''}
                      </td>
                    );
                  })}
                  <td style={{ ...cellTd, background: '#f9fafb', fontWeight: 700, textAlign: 'center' }}>
                    <div>{total.hours.toFixed(1)}</div>
                    <div style={{ fontSize: '0.7rem', fontWeight: 400, color: '#666' }}>
                      {total.days} ימים
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editTarget && (
        <EditDayModal
          employee={editTarget.employee}
          dateStr={editTarget.dateStr}
          events={editTarget.events}
          userId={user?.id ?? ''}
          onClose={() => setEditTarget(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

const cellTh = {
  padding: '0.5rem 0.4rem',
  borderBottom: '1px solid #e5e7eb',
  borderInline: '1px solid #f3f4f6',
  fontSize: '0.85rem',
  fontWeight: 600,
};

const cellTd = {
  padding: '0.4rem',
  borderBottom: '1px solid #f3f4f6',
  borderInline: '1px solid #f9fafb',
  verticalAlign: 'middle',
};

const navBtn = {
  padding: '0.3rem 0.7rem',
  background: '#f3f4f6',
  border: '1px solid #e5e7eb',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: '1.1rem',
};
