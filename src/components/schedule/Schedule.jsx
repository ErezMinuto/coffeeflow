import React, { useState, useMemo, useEffect } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';

// ── Constants ────────────────────────────────────────────────────────────────

const DAYS = [
  { code: 'sun', label: 'ראשון' },
  { code: 'mon', label: 'שני'   },
  { code: 'tue', label: 'שלישי' },
  { code: 'wed', label: 'רביעי' },
  { code: 'thu', label: 'חמישי' },
  { code: 'fri', label: 'שישי'  },
];

const POSITIONS = [
  { id: 'opening',  label: 'פתיחת קפה', time: '07:30', icon: '☕', always: true },
  { id: 'cafe',     label: 'בית קפה',   time: '07:45', icon: '🏠', fridayOnly: true },
  { id: 'roasting', label: 'קלייה',     time: '',       icon: '🔥', roastingOnly: true },

  { id: 'store1',   label: 'חנות',      time: '09:30', timeFriday: '09:00', icon: '🏪', always: true },
  { id: 'store2',   label: 'חנות',      time: '09:30', timeFriday: '09:00', icon: '🏪', always: true },
  { id: 'store3',   label: 'חנות',      time: '09:30', timeFriday: '09:00', icon: '🏪', always: true },
];

const ROLE_LABELS = { barista: '☕ בריסטה', roaster: '🔥 קולה', general: '👤 כללי' };
const ROLE_COLORS = { barista: '#8B5CF6', roaster: '#F59E0B', general: '#6B7280' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function getNextSunday() {
  const d = new Date();
  const diff = d.getDay() === 0 ? 7 : 7 - d.getDay();
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDate(date) {
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function EmployeeRow({ emp, onApprove, onUpdate, onRemove }) {
  const isPending = emp.user_id === 'pending';
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft]     = React.useState({});

  const startEdit = () => {
    setDraft({
      name:           emp.name,
      role:           emp.role || 'general',
      barista_skills: !!emp.barista_skills,
      max_days:       emp.max_days || 5,
      end_time:       emp.end_time || '',
      phone:          emp.phone || '',
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    await onUpdate(emp.id, {
      name:           draft.name.trim(),
      role:           draft.role,
      barista_skills: draft.barista_skills,
      max_days:       draft.max_days,
      end_time:       draft.end_time || null,
      phone:          draft.phone.trim() || null,
    });
    setEditing(false);
  };

  if (editing) {
    return (
      <tr style={{ background: '#F0FDF4', borderBottom: '2px solid #10B981' }}>
        <td colSpan={8} style={{ padding: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: '#6B7280', marginBottom: '3px' }}>שם מלא</label>
              <input value={draft.name} onChange={e => setDraft(p => ({ ...p, name: e.target.value }))}
                style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: '#6B7280', marginBottom: '3px' }}>טלפון</label>
              <input value={draft.phone} onChange={e => setDraft(p => ({ ...p, phone: e.target.value }))}
                placeholder="050-0000000"
                style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: '#6B7280', marginBottom: '3px' }}>תפקיד</label>
              <select value={draft.role} onChange={e => setDraft(p => ({ ...p, role: e.target.value }))}
                style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #ddd', boxSizing: 'border-box' }}>
                <option value="general">👤 כללי</option>
                <option value="barista">☕ בריסטה</option>
                <option value="roaster">🔥 קולה</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: '#6B7280', marginBottom: '3px' }}>מקס׳ ימים</label>
              <input type="number" min={1} max={6} value={draft.max_days}
                onChange={e => setDraft(p => ({ ...p, max_days: parseInt(e.target.value) || 5 }))}
                style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', color: '#6B7280', marginBottom: '3px' }}>עובד עד שעה</label>
              <input type="time" value={draft.end_time}
                onChange={e => setDraft(p => ({ ...p, end_time: e.target.value }))}
                style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #ddd', boxSizing: 'border-box' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', padding: '6px 8px', borderRadius: '6px', border: '1px solid #ddd', background: draft.barista_skills ? '#EDE9FE' : 'white', width: '100%', boxSizing: 'border-box' }}>
                <input type="checkbox" checked={draft.barista_skills}
                  onChange={e => setDraft(p => ({ ...p, barista_skills: e.target.checked }))} />
                <span style={{ fontSize: '0.85rem', color: draft.barista_skills ? '#7C3AED' : '#6B7280' }}>☕ כישורי בריסטה</span>
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid #ddd', background: 'white', cursor: 'pointer' }}>ביטול</button>
            <button onClick={saveEdit} style={{ padding: '6px 14px', borderRadius: '6px', border: 'none', background: '#10B981', color: 'white', cursor: 'pointer', fontWeight: 600 }}>✅ שמור</button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr style={{ borderBottom: '1px solid #f0f0f0' }}>
      <td style={{ padding: '0.75rem 0.5rem', fontWeight: 600 }}>{emp.name}</td>
      <td style={{ padding: '0.75rem 0.5rem' }}>
        {isPending
          ? <span style={{ background: '#FEF3C7', color: '#92400E', padding: '2px 8px', borderRadius: '12px', fontSize: '0.75rem' }}>⏳ ממתין לאישור</span>
          : <span style={{ color: ROLE_COLORS[emp.role], fontWeight: 600, fontSize: '0.85rem' }}>{ROLE_LABELS[emp.role]}</span>
        }
      </td>
      <td style={{ padding: '0.75rem 0.5rem', textAlign: 'center', fontSize: '0.85rem' }}>
        {emp.barista_skills ? <span style={{ color: '#7C3AED' }}>☕ כן</span> : <span style={{ color: '#ccc' }}>—</span>}
      </td>
      <td style={{ padding: '0.75rem 0.5rem', textAlign: 'center', fontSize: '0.85rem' }}>{emp.max_days}</td>
      <td style={{ padding: '0.75rem 0.5rem', fontSize: '0.85rem', color: emp.end_time ? '#F59E0B' : '#ccc' }}>
        {emp.end_time || '—'}
      </td>
      <td style={{ padding: '0.75rem 0.5rem', color: '#666', fontSize: '0.85rem' }}>
        {emp.phone || <span style={{ color: '#ccc' }}>—</span>}
      </td>
      <td style={{ padding: '0.75rem 0.5rem', fontSize: '0.8rem' }}>
        {emp.telegram_id ? <span style={{ color: '#10B981' }}>✅ מחובר</span> : <span style={{ color: '#ccc' }}>לא מחובר</span>}
      </td>
      <td style={{ padding: '0.75rem 0.5rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {isPending && (
            <button onClick={() => onApprove(emp.id)} style={{ background: '#10B981', color: 'white', border: 'none', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', fontSize: '0.8rem' }}>✅ אשר</button>
          )}
          {!isPending && (
            <button onClick={startEdit} style={{ background: '#6B7280', color: 'white', border: 'none', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', fontSize: '0.8rem' }}>✏️</button>
          )}
          <button onClick={() => onRemove(emp.id)} style={{ background: '#EF4444', color: 'white', border: 'none', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', fontSize: '0.8rem' }}>🗑</button>
        </div>
      </td>
    </tr>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function Schedule() {
  const { data, employeesDb, availabilityDb, schedulesDb, assignmentsDb, showToast, user } = useApp();

  const [tab, setTab]           = useState('employees');
  const [weekStart, setWeekStart] = useState(toISO(getNextSunday()));
  const [dayTypes, setDayTypes]  = useState({ sun: 'regular', mon: 'regular', tue: 'regular', wed: 'regular', thu: 'regular', fri: 'friday' });
  const [roastDays, setRoastDays] = useState({ sun: true, tue: true, wed: false });
  const [schedule, setSchedule]  = useState({}); // { "sun_opening": "עד", ... }
  const [scheduleId, setScheduleId] = useState(null);
  const [publishing, setPublishing]   = useState(false);
  const [generating, setGenerating]   = useState(false);
  const [exporting,  setExporting]    = useState(false);
  const [sheetsUrl,  setSheetsUrl]    = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newEmp, setNewEmp]           = useState({ name: '', role: 'general', max_days: 5, phone: '', barista_skills: false, end_time: '' });

  // ── Load saved schedule when week changes ───────────────────────────────────
  useEffect(() => {
    const load = async () => {
      const { data: rows } = await supabase
        .from('schedules')
        .select('id, day_types, roast_days')
        .eq('week_start', weekStart)
        .order('created_at', { ascending: false })
        .limit(1);
      if (!rows?.length) { setSchedule({}); setScheduleId(null); return; }
      const sid = rows[0].id;
      setScheduleId(sid);
      if (rows[0].day_types) setDayTypes(rows[0].day_types);
      if (rows[0].roast_days) setRoastDays(rows[0].roast_days);
      const { data: assignments } = await supabase
        .from('schedule_assignments')
        .select('day, position, employee_name')
        .eq('schedule_id', sid);
      const grid = {};
      (assignments || []).forEach(a => { grid[`${a.day}_${a.position}`] = a.employee_name; });
      setSchedule(grid);
    };
    load();
  }, [weekStart]);

  // ── Save helpers ─────────────────────────────────────────────────────────────
  const saveSchedule = async (grid, sid) => {
    // Delete existing assignments for this schedule then re-insert
    await supabase.from('schedule_assignments').delete().eq('schedule_id', sid);
    const rows = Object.entries(grid)
      .filter(([, name]) => name)
      .map(([key, name]) => {
        const [day, ...posParts] = key.split('_');
        return { schedule_id: sid, day, position: posParts.join('_'), employee_name: name };
      });
    if (rows.length) await supabase.from('schedule_assignments').insert(rows);
  };

  // ── Derived data ────────────────────────────────────────────────────────────

  const weekDates = useMemo(() => {
    const start = new Date(weekStart);
    return DAYS.map((d, i) => ({ ...d, date: addDays(start, i) }));
  }, [weekStart]);

  const activeDays = weekDates.filter(d => dayTypes[d.code] !== 'closed');

  const weekAvailability = useMemo(() =>
    data.availability.filter(a => a.week_start === weekStart),
    [data.availability, weekStart]
  );

  const activeEmployees = data.employees.filter(e => e.active && e.user_id !== 'pending');
  const pendingEmployees = data.employees.filter(e => !e.active || e.user_id === 'pending');

  // ── Employee actions ────────────────────────────────────────────────────────

  const approveEmployee = async (id) => {
    await employeesDb.update(id, { active: true, user_id: user.id });
    showToast('עובד אושר בהצלחה');
  };

  const updateEmployee = async (id, fields) => {
    await employeesDb.update(id, fields);
  };

  const removeEmployee = async (id) => {
    if (!window.confirm('למחוק עובד זה?')) return;
    await employeesDb.remove(id);
    showToast('עובד הוסר');
  };

  const addEmployee = async () => {
    if (!newEmp.name.trim()) return;
    await employeesDb.insert({
      name:           newEmp.name.trim(),
      role:           newEmp.role,
      max_days:       newEmp.max_days,
      phone:          newEmp.phone.trim() || null,
      barista_skills: newEmp.barista_skills,
      end_time:       newEmp.end_time || null,
      active:         true,
    });
    setNewEmp({ name: '', role: 'general', max_days: 5, phone: '', barista_skills: false, end_time: '' });
    setShowAddForm(false);
    showToast('עובד נוסף');
  };

  // ── Schedule helpers ────────────────────────────────────────────────────────

  const cellKey = (dayCode, posId) => `${dayCode}_${posId}`;

  const setCell = async (dayCode, posId, value) => {
    const newSchedule = { ...schedule, [cellKey(dayCode, posId)]: value };
    setSchedule(newSchedule);
    if (!scheduleId) {
      const { data: schedRow } = await supabase.from('schedules')
        .insert({ week_start: weekStart, status: 'draft', day_types: dayTypes, roast_days: roastDays, user_id: user?.id || 'manager' })
        .select('id').single();
      if (schedRow?.id) { setScheduleId(schedRow.id); await saveSchedule(newSchedule, schedRow.id); }
    } else {
      await saveSchedule(newSchedule, scheduleId);
    }
  };

  const visiblePositions = (dayCode) => {
    const isF = dayTypes[dayCode] === 'friday' || dayTypes[dayCode] === 'holiday-eve';
    const isR = roastDays[dayCode];
    return POSITIONS.filter(p => {
      if (p.fridayOnly)   return isF;
      if (p.roastingOnly) return isR && !isF;
      return true;
    });
  };

  // ── AI Generation ───────────────────────────────────────────────────────────

  const generateSchedule = async () => {
    setGenerating(true);
    try {
      const { data: json, error } = await supabase.functions.invoke('generate-schedule', {
        body: {
          employees:    activeEmployees,
          availability: weekAvailability,
          weekStart,
          dayTypes,
          roastDays,
          activeDays: activeDays.map(d => d.code),
        },
      });
      if (error) throw error;
      console.log('Schedule from AI:', json?.schedule);
      if (!json?.schedule || Object.keys(json.schedule).length === 0) {
        showToast('AI לא הצליח לבנות סידור — בדוק זמינות עובדים', 'error');
        return;
      }
      // Save to Supabase — delete old schedule for this week and create fresh
      if (scheduleId) await supabase.from('schedules').delete().eq('id', scheduleId);
      const { data: schedRow } = await supabase.from('schedules')
        .insert({ week_start: weekStart, status: 'draft', day_types: dayTypes, roast_days: roastDays, user_id: user?.id || 'manager' })
        .select('id').single();
      const sid = schedRow?.id;
      if (sid) { setScheduleId(sid); await saveSchedule(json.schedule, sid); }
      setSchedule(json.schedule);
      showToast('סידור עבודה נוצר ונשמר בהצלחה ✨');
    } catch (err) {
      console.error('Generate error:', err);
      showToast('שגיאה ביצירת הסידור', 'error');
    } finally {
      setGenerating(false);
    }
  };

  // ── Publish ─────────────────────────────────────────────────────────────────

  const buildTelegramText = () => {
    const start = new Date(weekStart);
    const end   = addDays(start, 5);
    const weekNum = Math.ceil((start - new Date(start.getFullYear(), 0, 1)) / 604800000);

    let text = `📅 <b>סידור עבודה — שבוע ${weekNum}</b>\n`;
    text += `${formatDate(start)} עד ${formatDate(end)}\n`;

    for (const d of activeDays) {
      const type = dayTypes[d.code];
      const label = type === 'holiday-eve' ? ` (ערב חג — עד 14:00)` : type === 'friday' ? ' (שישי)' : '';
      text += `\n━━━━━━━━━━━━━━━━━\n`;
      text += `☀️ <b>${d.label} ${formatDate(d.date)}${label}</b>\n`;
      text += `━━━━━━━━━━━━━━━━━\n`;

      for (const pos of visiblePositions(d.code)) {
        const name = schedule[cellKey(d.code, pos.id)] || '—';
        const isFri = dayTypes[d.code] === 'friday' || dayTypes[d.code] === 'holiday-eve';
        const t = (isFri && pos.timeFriday) ? pos.timeFriday : pos.time;
        const timeStr = t ? ` (${t})` : '';
        text += `${pos.icon} ${pos.label}${timeStr}: ${name}\n`;
      }
    }

    return text;
  };

  const publish = async () => {
    if (!sheetsUrl) { showToast('יש לייצא ל-Google Sheets קודם', 'error'); return; }
    setPublishing(true);
    try {
      const weekLabel = weekDates.map(d => `${d.label} ${formatDate(d.date)}`).join(' | ');
      const text = `📅 <b>סידור עבודה שבועי</b>\n${weekLabel}\n\n📊 <a href="${sheetsUrl}">לצפייה בסידור המלא לחצו כאן</a>`;
      const { error } = await supabase.functions.invoke('employee-bot', {
        body: { text },
        headers: { 'x-action': 'publish' },
      });
      if (error) throw error;
      showToast('סידור פורסם לקבוצה! 🎉');
    } catch (err) {
      showToast('שגיאה בפרסום', 'error');
    } finally {
      setPublishing(false);
    }
  };

  const exportToSheets = async () => {
    if (!scheduleId) { showToast('יש לשמור את הסידור קודם', 'error'); return; }
    setExporting(true);
    try {
      const { data, error } = await supabase.functions.invoke('export-to-sheets', {
        body: { schedule_id: scheduleId, week_start: weekStart },
      });
      if (error) throw error;
      setSheetsUrl(data.url);
      showToast('סידור יוצא ל-Google Sheets! 📊');
      window.open(data.url, '_blank');
    } catch (err) {
      console.error('Export error:', err);
      showToast('שגיאה בייצוא', 'error');
    } finally {
      setExporting(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  const tabStyle = (t) => ({
    padding: '0.6rem 1.2rem', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem',
    background: tab === t ? '#6F4E37' : '#f5f5f5',
    color:      tab === t ? 'white'   : '#666',
  });

  return (
    <div className="page" style={{ direction: 'rtl' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <h1 style={{ margin: 0 }}>📅 סידור עבודה</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button style={tabStyle('employees')} onClick={() => setTab('employees')}>
            👥 עובדים
            {pendingEmployees.length > 0 && (
              <span style={{ background: '#EF4444', color: 'white', borderRadius: '10px', fontSize: '0.7rem', padding: '1px 6px', marginRight: '6px' }}>
                {pendingEmployees.length}
              </span>
            )}
          </button>
          <button style={tabStyle('availability')} onClick={() => setTab('availability')}>📊 זמינות</button>
          <button style={tabStyle('builder')} onClick={() => setTab('builder')}>🗓 בניית סידור</button>
        </div>
      </div>

      {/* ── EMPLOYEES TAB ───────────────────────────────────────────────── */}
      {tab === 'employees' && (
        <div>
          {pendingEmployees.length > 0 && (
            <div style={{ background: '#FEF3C7', border: '1px solid #F59E0B', borderRadius: '12px', padding: '1rem', marginBottom: '1.5rem' }}>
              <h3 style={{ margin: '0 0 0.75rem', color: '#92400E' }}>⏳ ממתינים לאישור ({pendingEmployees.length})</h3>
              {pendingEmployees.map(emp => (
                <div key={emp.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid #fde68a' }}>
                  <span style={{ fontWeight: 600 }}>{emp.name === '__PENDING__' ? '(שם לא הוזן)' : emp.name}</span>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <select defaultValue="general" id={`role_${emp.id}`} style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid #ddd' }}>
                      <option value="general">👤 כללי</option>
                      <option value="barista">☕ בריסטה</option>
                      <option value="roaster">🔥 קולה</option>
                    </select>
                    <button onClick={() => approveEmployee(emp.id)} style={{ background: '#10B981', color: 'white', border: 'none', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer' }}>✅ אשר</button>
                    <button onClick={() => removeEmployee(emp.id)} style={{ background: '#EF4444', color: 'white', border: 'none', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer' }}>❌</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>עובדים פעילים ({activeEmployees.length})</h3>
              <button onClick={() => setShowAddForm(v => !v)} className="btn btn-primary">
                {showAddForm ? '✕ סגור' : '+ הוסף עובד'}
              </button>
            </div>

            {showAddForm && (
              <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '1.25rem', marginBottom: '1.25rem' }}>
                <h4 style={{ margin: '0 0 1rem', color: '#374151' }}>עובד חדש</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', color: '#6B7280', marginBottom: '4px' }}>שם מלא *</label>
                    <input
                      value={newEmp.name}
                      onChange={e => setNewEmp(p => ({ ...p, name: e.target.value }))}
                      placeholder="לדוגמה: דניאל מטזוני"
                      style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }}
                      onKeyDown={e => e.key === 'Enter' && addEmployee()}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', color: '#6B7280', marginBottom: '4px' }}>טלפון</label>
                    <input
                      value={newEmp.phone}
                      onChange={e => setNewEmp(p => ({ ...p, phone: e.target.value }))}
                      placeholder="050-0000000"
                      style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', color: '#6B7280', marginBottom: '4px' }}>תפקיד</label>
                    <select
                      value={newEmp.role}
                      onChange={e => setNewEmp(p => ({ ...p, role: e.target.value }))}
                      style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }}
                    >
                      <option value="general">👤 כללי</option>
                      <option value="barista">☕ בריסטה</option>
                      <option value="roaster">🔥 קולה</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', color: '#6B7280', marginBottom: '4px' }}>מקסימום ימים בשבוע</label>
                    <input
                      type="number" min={1} max={6}
                      value={newEmp.max_days}
                      onChange={e => setNewEmp(p => ({ ...p, max_days: parseInt(e.target.value) || 5 }))}
                      style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', color: '#6B7280', marginBottom: '4px' }}>עובד עד שעה (אופציונלי)</label>
                    <input
                      type="time"
                      value={newEmp.end_time}
                      onChange={e => setNewEmp(p => ({ ...p, end_time: e.target.value }))}
                      style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid #ddd', boxSizing: 'border-box' }}
                    />
                    <div style={{ fontSize: '0.75rem', color: '#9CA3AF', marginTop: '3px' }}>השאר ריק אם עובד יום מלא</div>
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '8px 10px', borderRadius: '8px', border: '1px solid #ddd', background: newEmp.barista_skills ? '#EDE9FE' : 'white' }}>
                      <input
                        type="checkbox"
                        checked={newEmp.barista_skills}
                        onChange={e => setNewEmp(p => ({ ...p, barista_skills: e.target.checked }))}
                      />
                      <span style={{ fontSize: '0.9rem', color: newEmp.barista_skills ? '#7C3AED' : '#6B7280' }}>
                        ☕ כישורי בריסטה — יכול לשמש כבריסטה במידת הצורך (עדיפות שנייה)
                      </span>
                    </label>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
                  <button onClick={() => setShowAddForm(false)} style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid #ddd', background: 'white', cursor: 'pointer' }}>ביטול</button>
                  <button onClick={addEmployee} className="btn btn-primary" disabled={!newEmp.name.trim()}>✅ הוסף עובד</button>
                </div>
              </div>
            )}

            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f9f9f9', borderBottom: '2px solid #eee' }}>
                  <th style={{ padding: '0.75rem 0.5rem', textAlign: 'right' }}>שם</th>
                  <th style={{ padding: '0.75rem 0.5rem', textAlign: 'right' }}>תפקיד</th>
                  <th style={{ padding: '0.75rem 0.5rem', textAlign: 'center' }}>☕ כישורי בריסטה</th>
                  <th style={{ padding: '0.75rem 0.5rem', textAlign: 'right' }}>מקס׳ ימים</th>
                  <th style={{ padding: '0.75rem 0.5rem', textAlign: 'right' }}>עד שעה</th>
                  <th style={{ padding: '0.75rem 0.5rem', textAlign: 'right' }}>טלפון</th>
                  <th style={{ padding: '0.75rem 0.5rem', textAlign: 'right' }}>טלגרם</th>
                  <th style={{ padding: '0.75rem 0.5rem' }}></th>
                </tr>
              </thead>
              <tbody>
                {activeEmployees.map(emp => (
                  <EmployeeRow key={emp.id} emp={emp} onApprove={approveEmployee} onUpdate={updateEmployee} onRemove={removeEmployee} />
                ))}
                {activeEmployees.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: '#999' }}>אין עובדים פעילים עדיין — לחץ "+ הוסף עובד" כדי להתחיל</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── AVAILABILITY TAB ───────────────────────────────────────────── */}
      {tab === 'availability' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <h3 style={{ margin: 0 }}>זמינות עובדים</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label style={{ fontSize: '0.85rem', color: '#666' }}>שבוע מתחיל:</label>
              <input type="date" value={weekStart} onChange={e => setWeekStart(e.target.value)} style={{ padding: '6px', borderRadius: '6px', border: '1px solid #ddd' }} />
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '600px' }}>
              <thead>
                <tr style={{ background: '#f9f9f9' }}>
                  <th style={{ padding: '0.75rem', textAlign: 'right', fontWeight: 700, borderBottom: '2px solid #eee' }}>עובד</th>
                  {weekDates.map(d => (
                    <th key={d.code} style={{ padding: '0.75rem', textAlign: 'center', borderBottom: '2px solid #eee', minWidth: '80px' }}>
                      <div style={{ fontWeight: 700 }}>{d.label}</div>
                      <div style={{ fontSize: '0.75rem', color: '#999' }}>{formatDate(d.date)}</div>
                    </th>
                  ))}
                  <th style={{ padding: '0.75rem', textAlign: 'center', borderBottom: '2px solid #eee' }}>סה״כ</th>
                </tr>
              </thead>
              <tbody>
                {activeEmployees.map(emp => {
                  const sub = weekAvailability.find(a => a.employee_id === emp.id);
                  const days = sub?.days || {};
                  const total = Object.values(days).filter(v => v).length;
                  return (
                    <tr key={emp.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '0.75rem', fontWeight: 600 }}>
                        <span style={{ background: ROLE_COLORS[emp.role] + '22', color: ROLE_COLORS[emp.role], padding: '2px 6px', borderRadius: '8px', fontSize: '0.75rem', marginLeft: '6px' }}>
                          {emp.role === 'barista' ? '☕' : emp.role === 'roaster' ? '🔥' : '👤'}
                        </span>
                        {emp.name}
                      </td>
                      {DAYS.map(d => (
                        <td key={d.code} style={{ padding: '0.5rem', textAlign: 'center' }}>
                          {!sub ? (
                            <span style={{ color: '#ccc', fontSize: '0.8rem' }}>—</span>
                          ) : days[d.code] === true ? (
                            <span style={{ background: '#D1FAE5', color: '#065F46', borderRadius: '6px', padding: '4px 6px', fontSize: '0.8rem' }}>✓</span>
                          ) : days[d.code] ? (
                            <span style={{ background: '#FEF3C7', color: '#92400E', borderRadius: '6px', padding: '4px 6px', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>עד {days[d.code]}</span>
                          ) : (
                            <span style={{ background: '#FEE2E2', color: '#991B1B', borderRadius: '6px', padding: '4px 6px', fontSize: '0.8rem' }}>✗</span>
                          )}
                        </td>
                      ))}
                      <td style={{ padding: '0.75rem', textAlign: 'center', fontWeight: 700, color: total >= 3 ? '#10B981' : '#F59E0B' }}>
                        {sub ? total : <span style={{ color: '#EF4444', fontSize: '0.8rem' }}>לא שלח</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: '1rem', padding: '0.75rem', background: '#f9f9f9', borderRadius: '8px', fontSize: '0.85rem', color: '#666' }}>
            {weekAvailability.length} מתוך {activeEmployees.length} עובדים שלחו זמינות
          </div>
        </div>
      )}

      {/* ── BUILDER TAB ─────────────────────────────────────────────────── */}
      {tab === 'builder' && (
        <div>
          {/* Controls */}
          <div className="card" style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-end' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#666', marginBottom: '4px' }}>שבוע מתחיל (ראשון)</label>
                <input type="date" value={weekStart} onChange={e => setWeekStart(e.target.value)} style={{ padding: '8px', borderRadius: '8px', border: '1px solid #ddd' }} />
              </div>


              <button onClick={generateSchedule} disabled={generating} style={{ background: generating ? '#ccc' : 'linear-gradient(135deg, #6F4E37, #8B6347)', color: 'white', border: 'none', borderRadius: '8px', padding: '10px 20px', cursor: generating ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '0.9rem' }}>
                {generating ? '⏳ מייצר סידור...' : '✨ צור סידור עם AI'}
              </button>

              <button onClick={publish} disabled={publishing} style={{ background: publishing ? '#ccc' : '#10B981', color: 'white', border: 'none', borderRadius: '8px', padding: '10px 20px', cursor: publishing ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '0.9rem' }}>
                {publishing ? '⏳ שולח...' : '📤 פרסם לקבוצה'}
              </button>

              <button onClick={exportToSheets} disabled={exporting} style={{ background: exporting ? '#ccc' : '#1a73e8', color: 'white', border: 'none', borderRadius: '8px', padding: '10px 20px', cursor: exporting ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '0.9rem' }}>
                {exporting ? '⏳ מייצא...' : '📊 ייצא ל-Google Sheets'}
              </button>

              {sheetsUrl && (
                <a href={sheetsUrl} target="_blank" rel="noreferrer" style={{ color: '#1a73e8', fontWeight: 600, fontSize: '0.9rem', alignSelf: 'center' }}>
                  🔗 פתח Sheet
                </a>
              )}
            </div>
          </div>

          {/* Day type markers */}
          <div className="card" style={{ marginBottom: '1rem' }}>
            <h4 style={{ margin: '0 0 0.75rem' }}>סוג יום</h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {weekDates.map(d => (
                <div key={d.code} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{d.label} {formatDate(d.date)}</span>
                  <select
                    value={dayTypes[d.code]}
                    onChange={e => setDayTypes(prev => ({ ...prev, [d.code]: e.target.value }))}
                    style={{ padding: '4px 6px', borderRadius: '6px', border: '1px solid #ddd', fontSize: '0.75rem' }}
                  >
                    <option value="regular">רגיל</option>
                    <option value="friday">שישי</option>
                    <option value="holiday-eve">ערב חג</option>
                    <option value="closed">סגור</option>
                  </select>
                </div>
              ))}
            </div>

            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#666' }}>ימי קלייה:</span>
              {['sun', 'tue', 'wed'].map(d => (
                <label key={d} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.85rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={roastDays[d] || false} onChange={e => setRoastDays(prev => ({ ...prev, [d]: e.target.checked }))} />
                  {DAYS.find(day => day.code === d)?.label}
                </label>
              ))}
            </div>
          </div>

          {/* Schedule grid */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '700px' }}>
              <thead>
                <tr>
                  <th style={{ padding: '0.75rem 1rem', textAlign: 'right', background: '#6F4E37', color: 'white', borderRadius: '8px 0 0 0', minWidth: '150px' }}>תפקיד / יום</th>
                  {activeDays.map((d, i) => {
                    const type = dayTypes[d.code];
                    const bg = type === 'holiday-eve' ? '#F59E0B' : type === 'friday' ? '#8B5CF6' : '#6F4E37';
                    return (
                      <th key={d.code} style={{ padding: '0.75rem', textAlign: 'center', background: bg, color: 'white', borderLeft: '1px solid rgba(255,255,255,0.2)', borderRadius: i === activeDays.length - 1 ? '0 8px 0 0' : 0 }}>
                        <div style={{ fontWeight: 700 }}>{d.label}</div>
                        <div style={{ fontSize: '0.75rem', opacity: 0.85 }}>{formatDate(d.date)}</div>
                        {type === 'holiday-eve' && <div style={{ fontSize: '0.65rem', opacity: 0.9 }}>ערב חג — עד 14:00</div>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {POSITIONS.map(pos => {
                  // Check if this position appears in ANY active day
                  const appearsInAnyDay = activeDays.some(d => visiblePositions(d.code).find(p => p.id === pos.id));
                  if (!appearsInAnyDay) return null;

                  return (
                    <tr key={pos.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '0.6rem 1rem', fontWeight: 600, background: '#fafafa', fontSize: '0.9rem', whiteSpace: 'nowrap' }}>
                        {pos.icon} {pos.label}
                        {pos.time && <span style={{ fontSize: '0.75rem', color: '#999', marginRight: '0.4rem', fontWeight: 400 }}>{pos.time}</span>}
                      </td>
                      {activeDays.map(d => {
                        const isVisible = visiblePositions(d.code).find(p => p.id === pos.id);
                        const val = schedule[cellKey(d.code, pos.id)] || '';
                        const isEmpty = !val;
                        return (
                          <td key={d.code} style={{ padding: '4px', textAlign: 'center', background: !isVisible ? '#f5f5f5' : isEmpty ? '#FEF2F2' : '#F0FDF4', borderLeft: '1px solid #eee' }}>
                            {isVisible ? (
                              <select
                                value={val}
                                onChange={e => setCell(d.code, pos.id, e.target.value)}
                                style={{ width: '100%', padding: '6px 4px', border: 'none', borderRadius: '6px', background: 'transparent', cursor: 'pointer', fontSize: '0.85rem', textAlign: 'center' }}
                              >
                                <option value="">— בחר —</option>
                                {activeEmployees.map(e => (
                                  <option key={e.id} value={e.name}>{e.name}</option>
                                ))}
                              </select>
                            ) : (
                              <span style={{ color: '#ccc', fontSize: '0.75rem' }}>—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: '0.75rem', display: 'flex', gap: '1rem', fontSize: '0.8rem', color: '#666' }}>
            <span>🔴 תא ריק</span>
            <span>🟢 תא מלא</span>
            <span>⬜ לא רלוונטי ליום זה</span>
          </div>
        </div>
      )}
    </div>
  );
}
