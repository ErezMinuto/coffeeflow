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

// ── Inline SVG icons (Lucide-style) ───────────────────────────────────────────
const Icon = ({ d, size = 16, sw = 2 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const A = {
  clock:   <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  chevR:   <path d="m9 18 6-6-6-6" />,
  chevL:   <path d="m15 18-6-6 6-6" />,
  download:<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></>,
  mail:    <><rect width="20" height="16" x="2" y="4" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /></>,
  gear:    <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></>,
  x:       <><path d="M18 6 6 18M6 6l12 12" /></>,
  plus:    <><path d="M5 12h14M12 5v14" /></>,
  logout:  <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
};
const initials = (n) => (n || '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('');
const AVATAR_COLORS = ['#7C5CD6', '#556B3A', '#C77914', '#3D8B8B', '#B5546E', '#4A72B5'];
const avatarColor = (id) => AVATAR_COLORS[Math.abs(Number(id) || 0) % AVATAR_COLORS.length];

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
    <div className="att-modal open" onClick={onClose}>
      <div className="att-modal-card" onClick={e => e.stopPropagation()}>
        <div className="am-h">
          <div className="att-av" style={{ background: avatarColor(employee.id) }}>{initials(employee.name)}</div>
          <div><h3>{employee.name}</h3><div className="am-date">{dateStr}</div></div>
          <button className="att-ico" style={{ marginInlineStart: 'auto' }} onClick={onClose} aria-label="סגור"><Icon d={A.x} /></button>
        </div>
        <div className="am-b">
          {sorted.length === 0 && <div className="am-empty">אין רישומים ליום זה</div>}
          {sorted.map(ev => (
            <div key={ev.id} className="am-ev">
              <span className={`am-type ${ev.event_type}`}>{ev.event_type === 'in' ? 'כניסה' : 'יציאה'}</span>
              <input
                type="time"
                defaultValue={israelTimeOf(ev.event_at)}
                onBlur={e => { if (e.target.value !== israelTimeOf(ev.event_at)) updateTime(ev, e.target.value); }}
              />
              <span className="am-src" title={ev.source === 'manual' ? 'עריכה ידנית' : 'אוטומטי'}>{ev.source === 'manual' ? '✏️' : '🤖'}</span>
              <button className="am-del" onClick={() => deleteEvent(ev.id)}>מחק</button>
            </div>
          ))}

          <div className="am-add">
            <div className="t">הוסף רישום</div>
            <div className="am-addrow">
              <select value={newType} onChange={e => setNewType(e.target.value)}>
                <option value="in">כניסה</option>
                <option value="out">יציאה</option>
              </select>
              <input type="time" value={newTime} onChange={e => setNewTime(e.target.value)} />
              <button className="att-btn primary" onClick={addEvent} disabled={busy}>{busy ? '…' : 'הוסף'}</button>
            </div>
          </div>

          <div className="am-sum">סה״כ שעות: <b>{summary.hours.toFixed(2)}</b>
            {summary.warnings.length > 0 && <span className="w">⚠ {summary.warnings.join(', ')}</span>}
          </div>
        </div>
        <div className="am-f"><button className="att-btn ghost" onClick={onClose}>סגור</button></div>
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
    <div className="att-setblock">
      <div className="att-field"><label>אימייל רו״ח</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="accountant@example.com" /></div>
      <div className="att-row2">
        <div className="att-field"><label>תזכורת כניסה (דק')</label>
          <input type="number" min="0" value={checkinGrace} onChange={e => setCheckinGrace(e.target.value)} /></div>
        <div className="att-field"><label>תזכורת יציאה (דק')</label>
          <input type="number" min="0" value={checkoutGrace} onChange={e => setCheckoutGrace(e.target.value)} /></div>
      </div>
      <button className="att-btn primary block" onClick={save} disabled={busy}>{busy ? 'שומר…' : 'שמור הגדרות'}</button>
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
    <div className="att-setblock">
      <div className="att-subhead">🗓 חגים <span>— חוקת שישי (סיום 15:00)</span></div>
      <div className="att-holiadd">
        <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} />
        <input type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="שם החג (אופציונלי)" />
        <button className="att-btn forest" onClick={add} disabled={busy || !newDate}>הוסף</button>
      </div>
      {list.length === 0 ? (
        <div className="att-holi-empty">אין חגים מוגדרים.</div>
      ) : (
        <div className="att-holilist">
          {list.map(h => (
            <div key={h.holiday_date} className="att-holi">
              <b>{h.holiday_date}</b>
              <span>{h.label || ''}</span>
              <button className="hx" onClick={() => remove(h.holiday_date)}>מחק</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function Attendance() {
  const { data, user, showToast, employeesDb } = useApp();

  const offBoard = useCallback(async (emp) => {
    const ok = window.confirm(
      `לסמן את ${emp.name} כעוזב/ת?\n\n` +
      `העובד/ת יוסר/תוסר מרשימת הפעילים והקישור לבוט יתבטל. ניתן להחזיר ידנית בעמוד Schedule.`,
    );
    if (!ok) return;
    const { error } = await supabase
      .from('employees')
      .update({ active: false, telegram_id: null })
      .eq('id', emp.id);
    if (error) {
      showToast(`שגיאה: ${error.message}`, 'error');
      return;
    }
    showToast(`${emp.name} סומן/ה כעוזב/ת`, 'success');
    employeesDb.refresh();
  }, [showToast, employeesDb]);
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
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showSettings, setShowSettings] = useState(false);

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

  // Month-wide KPI summary across all employees.
  const monthStats = useMemo(() => {
    let hours = 0, wdays = 0, warnDays = 0;
    for (const emp of employees) {
      for (const day of days) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const ev = eventsByEmpDay.get(`${emp.id}|${dateStr}`);
        if (!ev) continue;
        const s = summarizeDay(ev);
        if (s.hours > 0) { hours += s.hours; wdays += 1; }
        if (s.warnings.length > 0) warnDays += 1;
      }
    }
    return { hours, wdays, warnDays, emps: employees.length };
  }, [employees, days, eventsByEmpDay, year, month]);

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

  const downloadReport = async () => {
    const ym = ymKey(year, month);
    setDownloadBusy(true);
    try {
      const { data: result, error } = await supabase.functions.invoke('attendance-export', {
        body: { year_month: ym, mode: 'download' },
      });
      if (error) throw error;
      if (!result?.ok) throw new Error(result?.error || 'unknown');
      // Decode base64 → Blob and trigger a browser download.
      const bin = atob(result.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename || `attendance_${ym}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast(`הורד דו״ח (${result.employee_count} עובדים)`, 'success');
    } catch (e) {
      showToast(`שגיאה: ${e.message}`, 'error');
    } finally {
      setDownloadBusy(false);
    }
  };

  return (
    <div className="page att-page">
      <div className="att-head">
        <h1><span className="att-cl"><Icon d={A.clock} size={26} /></span>נוכחות</h1>
        <div className="att-monthnav">
          <button onClick={goPrev} aria-label="חודש קודם"><Icon d={A.chevR} /></button>
          <span className="m">{HEBREW_MONTHS[month - 1]} {year}</span>
          <button onClick={goNext} aria-label="חודש הבא"><Icon d={A.chevL} /></button>
        </div>
        <div className="att-actions">
          <button className="att-btn ghost" onClick={() => setShowSettings(true)}><Icon d={A.gear} /> הגדרות</button>
          <button className="att-btn forest" onClick={downloadReport} disabled={downloadBusy}><Icon d={A.download} /> {downloadBusy ? 'מוריד…' : 'הורד דו״ח'}</button>
          <button className="att-btn primary" onClick={exportToAccountant} disabled={exportBusy}><Icon d={A.mail} /> {exportBusy ? 'שולח…' : 'שלח לרו״ח'}</button>
        </div>
      </div>

      {/* KPI */}
      <div className="att-kpis">
        <div className="att-kpi"><div className="lbl"><Icon d={A.clock} size={14} /> סה"כ שעות בחודש</div><div className="val">{monthStats.hours.toFixed(0)} <small>ש'</small></div><i className="spark" /></div>
        <div className="att-kpi"><div className="lbl">ימי עבודה</div><div className="val">{monthStats.wdays}</div><i className="spark" /></div>
        <div className="att-kpi"><div className="lbl">עובדים פעילים</div><div className="val">{monthStats.emps}</div><i className="spark" /></div>
        <div className={`att-kpi ${monthStats.warnDays ? 'warn' : ''}`}><div className="lbl">ימים עם התראה</div><div className="val">{monthStats.warnDays}</div><i className="spark" /></div>
      </div>

      {/* Grid */}
      <div className="att-card">
        <div className="att-legend">
          <span><i className="present" /> נוכח</span>
          <span><i className="open" /> משמרת פתוחה</span>
          <span><i className="warn" /> התראה</span>
          <span><i className="we" /> סופ״ש / חג</span>
          <span className="mut">· לחיצה על תא פותחת עריכה</span>
        </div>
        <div className="att-gscroll">
          <table className="att-table">
            <thead>
              <tr>
                <th className="emp">עובד</th>
                {days.map(d => {
                  const dw = dayOfWeekFor(year, month, d);
                  const weekend = dw === 5 || dw === 6;
                  return <th key={d} className={weekend ? 'we' : ''}><div>{d}</div><div className="dw">{DAY_LABELS[dw]}</div></th>;
                })}
                <th className="tot">סה״כ</th>
              </tr>
            </thead>
            <tbody>
              {employees.map(emp => {
                const total = monthlyTotal(emp.id);
                return (
                  <tr key={emp.id}>
                    <td className="emp">
                      <div className="emp-inner">
                        <div className="att-av" style={{ background: avatarColor(emp.id) }}>{initials(emp.name)}</div>
                        <span className="emp-nm">{emp.name}</span>
                        <button className="emp-off" title="סיום העסקה" aria-label={`סיום העסקה ${emp.name}`} onClick={() => offBoard(emp)}><Icon d={A.logout} size={15} /></button>
                      </div>
                    </td>
                    {days.map(d => {
                      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                      const dayEvents = eventsByEmpDay.get(`${emp.id}|${dateStr}`) ?? [];
                      const s = dayEvents.length ? summarizeDay(dayEvents) : null;
                      const dw = dayOfWeekFor(year, month, d);
                      const weekend = dw === 5 || dw === 6;
                      const state = !s ? '' : s.isOpen ? 'open' : (s.warnings.length ? 'warn' : 'present');
                      return (
                        <td key={d} className={`cell ${state} ${weekend && !s ? 'we' : ''}`}
                          onClick={() => setEditTarget({ employee: emp, dateStr, events: dayEvents })}>
                          {s && state !== 'present' && <span className="flag" />}
                          {s ? (<>
                            <div className="io">{s.firstIn ? israelTimeOf(s.firstIn.toISOString()) : '—'}</div>
                            <div className="io">{s.lastOut ? israelTimeOf(s.lastOut.toISOString()) : '—'}</div>
                            <div className="hh">{s.hours > 0 ? s.hours.toFixed(1) : '·'}</div>
                          </>) : null}
                        </td>
                      );
                    })}
                    <td className="tot"><div className="th">{total.hours.toFixed(1)}</div><div className="td">{total.days} ימים</div></td>
                  </tr>
                );
              })}
              {employees.length === 0 && (
                <tr><td className="att-empty" colSpan={days.length + 2}>אין עובדים פעילים</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Settings drawer */}
      {showSettings && (
        <>
          <div className="att-ov open" onClick={() => setShowSettings(false)} />
          <aside className="att-drawer open" role="dialog" aria-modal="true">
            <div className="att-dh">
              <div className="att-dh-ico"><Icon d={A.gear} size={20} /></div>
              <h2>הגדרות נוכחות</h2>
              <button className="att-ico att-dx" onClick={() => setShowSettings(false)} aria-label="סגור"><Icon d={A.x} /></button>
            </div>
            <div className="att-db">
              <SettingsCard settings={settings} onSave={reload} />
              <HolidaysCard />
            </div>
          </aside>
        </>
      )}

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

