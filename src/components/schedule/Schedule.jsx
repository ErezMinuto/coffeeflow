import React, { useState, useMemo, useEffect } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';
import {
  Users, ChartColumn, CalendarCheck, Plus, Pencil, Trash2, Check, X, Clock, Send,
  Sparkles, Sheet, Info, Star, ExternalLink,
} from 'lucide-react';
import { useAnimatedProgress } from '../shared/ProgressBar';
import { Kpi } from '../shared/ui';

// ── Constants ────────────────────────────────────────────────────────────────

const DAYS = [
  { code: 'sun', label: 'ראשון' },
  { code: 'mon', label: 'שני'   },
  { code: 'tue', label: 'שלישי' },
  { code: 'wed', label: 'רביעי' },
  { code: 'thu', label: 'חמישי' },
  { code: 'fri', label: 'שישי'  },
];

// `icon` only appears in the Telegram post (buildTelegramText), not in the UI.
const POSITIONS = [
  { id: 'opening',  label: 'פתיחת קפה', time: '07:30', icon: '☕', always: true },
  { id: 'cafe',     label: 'בית קפה',   time: '07:45', icon: '🏠', fridayOnly: true },
  { id: 'roasting', label: 'קלייה',     time: '',       icon: '🔥', roastingOnly: true },

  { id: 'store1',   label: 'חנות',      time: '09:30', timeFriday: '09:00', icon: '🏪', always: true },
  { id: 'store2',   label: 'חנות',      time: '09:30', timeFriday: '09:00', icon: '🏪', always: true },
  { id: 'store3',   label: 'חנות',      time: '09:30', timeFriday: '09:00', icon: '🏪', always: true },
  { id: 'store4',   label: 'חנות',      time: '09:30', timeFriday: '09:00', icon: '🏪', always: true },
];

const ROLE_LABELS = { barista: 'בריסטה', roaster: 'קולה', general: 'כללי' };
const ROLE_CLASS  = { barista: 'barista', roaster: 'roaster', general: 'general' };

const initials = (n) => (n || '').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('');

// Line icons from lucide-react; stroke weight comes from the shared svg.lucide rule.
const Icon = ({ d: Glyph, size = 16 }) => <Glyph size={size} aria-hidden="true" />;
const SI = {
  users: Users, chart: ChartColumn, calCheck: CalendarCheck, plus: Plus, edit: Pencil,
  trash: Trash2, check: Check, x: X, clock: Clock, send: Send, spark: Sparkles,
  sheets: Sheet, info: Info, link: ExternalLink,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getNextSunday() {
  const d = new Date();
  const day = d.getDay();
  // If today is Sunday, use today (current week). Otherwise jump to next Sunday.
  const diff = day === 0 ? 0 : 7 - day;
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

function StarPicker({ value, onChange }) {
  return (
    <div className="sc-starpick" role="group" aria-label="רמה">
      {[1,2,3].map(n => (
        <button key={n} type="button" onClick={() => onChange(n)} className={n <= value ? 'on' : ''}
          aria-label={`רמה ${n}`} aria-pressed={n <= value}>
          <Star size={18} fill={n <= value ? 'currentColor' : 'none'} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function EmployeeRow({ emp, onApprove, onUpdate, onRemove }) {
  const isPending = emp.user_id === 'pending';
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft]     = React.useState({});

  const showBaristaLevel = emp.role === 'barista' || emp.barista_skills;
  const showRoasterLevel = emp.role === 'roaster';

  const startEdit = () => {
    setDraft({
      name:           emp.name,
      role:           emp.role || 'general',
      barista_skills: !!emp.barista_skills,
      barista_level:  emp.barista_level || 1,
      roaster_level:  emp.roaster_level || 1,
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
      barista_level:  draft.barista_level,
      roaster_level:  draft.roaster_level,
      max_days:       draft.max_days,
      end_time:       draft.end_time || null,
      phone:          draft.phone.trim() || null,
    });
    setEditing(false);
  };

  if (editing) {
    return (
      <tr className="sc-editrow">
        <td colSpan={8}>
          <div className="sc-editgrid">
            <div className="sc-field">
              <label>שם מלא</label>
              <input value={draft.name} onChange={e => setDraft(p => ({ ...p, name: e.target.value }))} />
            </div>
            <div className="sc-field">
              <label>טלפון</label>
              <input value={draft.phone} onChange={e => setDraft(p => ({ ...p, phone: e.target.value }))}
                placeholder="050-0000000" />
            </div>
            <div className="sc-field">
              <label>תפקיד</label>
              <select value={draft.role} onChange={e => setDraft(p => ({ ...p, role: e.target.value }))}>
                <option value="general">כללי</option>
                <option value="barista">בריסטה</option>
                <option value="roaster">קולה</option>
              </select>
            </div>
            <div className="sc-field">
              <label>מקס׳ ימים</label>
              <input type="number" min={1} max={6} value={draft.max_days}
                onChange={e => setDraft(p => ({ ...p, max_days: parseInt(e.target.value) || 5 }))} />
            </div>
            <div className="sc-field">
              <label>שעת סיום</label>
              <input type="time" value={draft.end_time}
                onChange={e => setDraft(p => ({ ...p, end_time: e.target.value }))} />
            </div>
            <div className="sc-field sc-field-end">
              <label className={`sc-checkline ${draft.barista_skills ? 'on' : ''}`}>
                <input type="checkbox" checked={draft.barista_skills}
                  onChange={e => setDraft(p => ({ ...p, barista_skills: e.target.checked }))} />
                כישורי בריסטה
              </label>
            </div>
            {(draft.role === 'barista' || draft.barista_skills) && (
              <div className="sc-field">
                <label>רמת בריסטה</label>
                <StarPicker value={draft.barista_level} onChange={v => setDraft(p => ({ ...p, barista_level: v }))} />
              </div>
            )}
            {draft.role === 'roaster' && (
              <div className="sc-field">
                <label>רמת קלייה</label>
                <StarPicker value={draft.roaster_level} onChange={v => setDraft(p => ({ ...p, roaster_level: v }))} />
              </div>
            )}
          </div>
          <div className="sc-editacts">
            <button className="btn sm" onClick={() => setEditing(false)}>ביטול</button>
            <button className="btn primary sm" onClick={saveEdit}>שמירה</button>
          </div>
        </td>
      </tr>
    );
  }

  const level = showBaristaLevel ? emp.barista_level : showRoasterLevel ? emp.roaster_level : 0;
  return (
    <tr>
      <td>
        <div className="sc-person">
          <div className="sc-avatar">{initials(emp.name)}</div>
          <span className="sc-pname">{emp.name}</span>
        </div>
      </td>
      <td>
        {isPending
          ? <span className="sc-rolepill pending"><Icon d={SI.clock} size={13} /> ממתין לאישור</span>
          : <span className={`sc-rolepill ${ROLE_CLASS[emp.role] || 'general'}`}>{ROLE_LABELS[emp.role]}</span>}
      </td>
      <td className="c">
        {emp.barista_skills ? <span className="sc-skill-yes">כן</span> : <span className="sc-skill-no">—</span>}
        {level > 1 && <div className="sc-stars">{'★'.repeat(level)}</div>}
      </td>
      <td className="c num">{emp.max_days}</td>
      <td className="c">{emp.end_time ? <span className="sc-endtime">{emp.end_time}</span> : <span className="sc-dash">—</span>}</td>
      <td className="num sc-phone">{emp.phone || <span className="sc-dash">—</span>}</td>
      <td className="c">{emp.telegram_id ? <span className="sc-tg-yes"><Icon d={SI.check} size={13} /> מחובר</span> : <span className="sc-tg-no">לא מחובר</span>}</td>
      <td className="c">
        <div className="sc-racts">
          {isPending && <button className="btn primary sm" onClick={() => onApprove(emp.id)}>אישור</button>}
          {!isPending && <button className="sc-ico" title="עריכה" aria-label={`עריכת ${emp.name}`} onClick={startEdit}><Icon d={SI.edit} /></button>}
          <button className="sc-ico danger" title="הסרה" aria-label={`הסרת ${emp.name}`} onClick={() => onRemove(emp.id)}><Icon d={SI.trash} /></button>
        </div>
      </td>
    </tr>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function Schedule() {
  const { data, employeesDb, showToast, user } = useApp();

  const [tab, setTab]           = useState('employees');
  const [weekStart, setWeekStart] = useState(toISO(getNextSunday()));
  const [dayTypes, setDayTypes]  = useState({ sun: 'regular', mon: 'regular', tue: 'regular', wed: 'regular', thu: 'regular', fri: 'friday' });
  const [roastDays, setRoastDays] = useState({ sun: true, mon: false, tue: true, wed: false, thu: false });
  const [schedule, setSchedule]  = useState({}); // { "sun_opening": "עד", ... }
  const [scheduleId, setScheduleId] = useState(null);
  const [publishing, setPublishing]   = useState(false);
  const [generating, setGenerating]   = useState(false);
  const [exporting,  setExporting]    = useState(false);
  const [reminding,  setReminding]    = useState(false);
  const genProgress = useAnimatedProgress(generating, 20);
  const [sheetsUrl,  setSheetsUrl]    = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newEmp, setNewEmp]           = useState({ name: '', role: 'general', max_days: 5, phone: '', barista_skills: false, end_time: '', barista_level: 1, roaster_level: 1 });

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

  // ── Default to the week that actually needs you ─────────────────────────────
  // Priority: the earliest upcoming week that HAS availability submissions and
  // is not published yet. Employees submitting is the signal that a week wants
  // attention; a week nobody has submitted for has nothing to look at.
  //
  // WHY NOT "the first week with no schedule row", which is what this used to do:
  // a schedules row appears as soon as the week is opened, so an already-touched
  // week counted as done and got skipped — even when fresh availability had
  // arrived for it afterwards.
  //
  // That happened on 2026-08-28: six employees submitted for the week of 08-30
  // (last one 08-27 18:01), the week already had a schedule row, and the page
  // opened on 09-06 showing nothing. The submissions were never lost — they were
  // one week back, and the only clue was a date field nobody had reason to
  // change. Silence looked identical to "no one submitted".
  //
  // Published weeks are finished and skipped. If no upcoming week has
  // submissions, fall back to the old behaviour so creating a fresh schedule
  // still lands somewhere sensible.
  useEffect(() => {
    const pickWeekNeedingAttention = async () => {
      const first = getNextSunday();
      const firstIso = toISO(first);
      const [{ data: scheduleRows }, { data: availRows }] = await Promise.all([
        supabase.from('schedules').select('week_start, status').gte('week_start', firstIso),
        supabase.from('availability_submissions').select('week_start').gte('week_start', firstIso),
      ]);
      const published = new Set(
        (scheduleRows || []).filter(r => r.status === 'published').map(r => r.week_start)
      );
      const withSubmissions = [...new Set((availRows || []).map(r => r.week_start))]
        .filter(w => !published.has(w))
        .sort();
      if (withSubmissions.length > 0) { setWeekStart(withSubmissions[0]); return; }

      // Nothing submitted yet for any upcoming week — fall back to the first
      // week without a schedule row, so starting a new one still works.
      const taken = new Set((scheduleRows || []).map(r => r.week_start));
      const candidate = new Date(first);
      for (let i = 0; i < 52; i++) {
        const iso = toISO(candidate);
        if (!taken.has(iso)) { setWeekStart(iso); return; }
        candidate.setDate(candidate.getDate() + 7);
      }
    };
    pickWeekNeedingAttention();
  }, []); // once on mount

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
    // Was showing "success" toast even when RLS rejected the update —
    // employees table has admin-only UPDATE policy (20260411_admin_only_employees.sql)
    // so non-admin users would silently fail. Toast also fired immediately
    // before the async update resolved, so even genuine errors went unseen.
    try {
      const row = await employeesDb.update(id, { active: true, user_id: user.id });
      if (!row) {
        showToast('העדכון לא החזיר שורה. ייתכן שאין לך הרשאת אדמין לעובדים', 'error');
        return;
      }
      showToast('עובד אושר בהצלחה');
    } catch (err) {
      const msg = err?.message ?? 'שגיאה לא ידועה';
      console.error('approveEmployee failed:', err);
      // Most likely cause: RLS requires is_admin(). Surface it clearly.
      if (msg.includes('row-level security') || msg.includes('policy')) {
        showToast('אין לך הרשאת אדמין לאישור עובדים. אפשר לפנות למנהל המערכת', 'error');
      } else {
        showToast(`שגיאה באישור: ${msg.slice(0, 120)}`, 'error');
      }
    }
  };

  const updateEmployee = async (id, fields) => {
    await employeesDb.update(id, fields);
  };

  const removeEmployee = async (id) => {
    const emp  = (data.employees || []).find(e => e.id === id);
    const name = emp && emp.name && emp.name !== '__PENDING__' ? emp.name : 'עובד זה';
    const isPending = emp?.user_id === 'pending';

    const msg = isPending
      ? `לדחות את הבקשה של ${name}?`
      : `למחוק את ${name} לצמיתות?\n\n` +
        `הפעולה בלתי הפיכה. שיבוצי העבר יישמרו לפי השם, ` +
        `אבל החיבור לטלגרם והזמינות יימחקו, ותצטרכו להוסיף מחדש ולצרף שוב לבוט.`;

    if (!window.confirm(msg)) return;
    await employeesDb.remove(id);
    showToast(isPending ? `הבקשה של ${name} נדחתה` : `${name} הוסר/ה מהרשימה`);
  };

  const addEmployee = async () => {
    if (!newEmp.name.trim()) return;
    await employeesDb.insert({
      name:           newEmp.name.trim(),
      role:           newEmp.role,
      max_days:       newEmp.max_days,
      phone:          newEmp.phone.trim() || null,
      barista_skills: newEmp.barista_skills,
      barista_level:  newEmp.barista_level,
      roaster_level:  newEmp.roaster_level,
      end_time:       newEmp.end_time || null,
      active:         true,
    });
    setNewEmp({ name: '', role: 'general', max_days: 5, phone: '', barista_skills: false, end_time: '', barista_level: 1, roaster_level: 1 });
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
        showToast('AI לא הצליח לבנות סידור. כדאי לבדוק את זמינות העובדים', 'error');
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
      genProgress.complete();
      showToast('סידור עבודה נוצר ונשמר בהצלחה');
    } catch (err) {
      console.error('Generate error:', err);
      showToast('שגיאה ביצירת הסידור', 'error');
    } finally {
      setGenerating(false);
    }
  };

  // ── Send Availability Reminder ───────────────────────────────────────────────

  const sendReminder = async () => {
    setReminding(true);
    try {
      const { data: result, error } = await supabase.functions.invoke('employee-bot', {
        body: {},
        headers: { 'x-action': 'remind' },
      });
      if (error) throw error;
      const sent   = result?.sent   ?? 0;
      const failed = result?.failed ?? 0;
      const failMsg = failed > 0 ? ` (${failed} לא פתחו צ׳אט עם הבוט)` : '';
      showToast(`תזכורת נשלחה ל-${sent} עובדים${failMsg}`);
    } catch (err) {
      console.error('Remind error:', err);
      showToast('שגיאה בשליחת תזכורת', 'error');
    } finally {
      setReminding(false);
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
    setPublishing(true);
    try {
      // Use detailed schedule text always; append Sheets link if available
      let text = buildTelegramText();
      if (sheetsUrl) text += `\n\n📊 <a href="${sheetsUrl}">לצפייה בסידור המלא</a>`;
      const { error } = await supabase.functions.invoke('employee-bot', {
        body: { text },
        headers: { 'x-action': 'publish' },
      });
      if (error) throw error;
      // Mark this schedule as published so the opening-shift confirmation cron
      // only sends reminders off a finalized (hand-edited) schedule — never a draft.
      if (scheduleId) {
        await supabase.from('schedules')
          .update({ status: 'published', published_at: new Date().toISOString() })
          .eq('id', scheduleId);
      }
      showToast('הסידור פורסם בקבוצה');
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
      showToast('הסידור יוצא ל-Google Sheets');
      window.open(data.url, '_blank');
    } catch (err) {
      console.error('Export error:', err);
      showToast('שגיאה בייצוא', 'error');
    } finally {
      setExporting(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  const empStats = {
    total:     activeEmployees.length,
    baristas:  activeEmployees.filter(e => e.role === 'barista').length,
    roasters:  activeEmployees.filter(e => e.role === 'roaster').length,
    tg:        activeEmployees.filter(e => e.telegram_id).length,
  };

  return (
    <div className="page sched-page">
      <div className="sc-head">
        <h1>סידור עבודה</h1>
        <div className="sc-tabs">
          <button className={`sc-tab ${tab === 'employees' ? 'active' : ''}`} onClick={() => setTab('employees')}>
            <Icon d={SI.users} /> עובדים
            {pendingEmployees.length > 0 && <span className="sc-badge">{pendingEmployees.length}</span>}
          </button>
          <button className={`sc-tab ${tab === 'availability' ? 'active' : ''}`} onClick={() => setTab('availability')}><Icon d={SI.chart} /> זמינות</button>
          <button className={`sc-tab ${tab === 'builder' ? 'active' : ''}`} onClick={() => setTab('builder')}><Icon d={SI.calCheck} /> בניית סידור</button>
        </div>
      </div>

      {/* ── EMPLOYEES TAB ───────────────────────────────────────────────── */}
      {tab === 'employees' && (
        <div>
          <div className="kpis sc-kpis">
            <Kpi label='סה"כ עובדים' value={empStats.total} />
            <Kpi label="בריסטות" value={empStats.baristas} />
            <Kpi label="קולים" value={empStats.roasters} />
            <Kpi label={<>{pendingEmployees.length > 0 && <span className="dot warn" />}ממתינים לאישור</>} value={pendingEmployees.length} />
            <Kpi label="מחוברים לטלגרם" value={empStats.tg} unit={`/ ${empStats.total}`} />
          </div>

          {pendingEmployees.length > 0 && (
            <section className="card flush sc-pending">
              <div className="card-head">
                <h2>ממתינים לאישור</h2>
                <span className="meta num">{pendingEmployees.length}</span>
              </div>
              {pendingEmployees.map(emp => (
                <div key={emp.id} className="attn-item">
                  <span className="dot warn" />
                  <span className="attn-what">{emp.name === '__PENDING__' ? '(שם לא הוזן)' : emp.name}</span>
                  <div className="pr-actions">
                    <button className="btn sm" onClick={() => removeEmployee(emp.id)}>דחייה</button>
                    <button className="btn primary sm" onClick={() => approveEmployee(emp.id)}>אישור</button>
                  </div>
                </div>
              ))}
            </section>
          )}

          <div className="sc-card">
            <div className="sc-card-h">
              <h3>עובדים פעילים <span className="sc-count">{activeEmployees.length}</span></h3>
              <button className="btn primary sm" onClick={() => setShowAddForm(true)}><Icon d={SI.plus} /> הוספת עובד</button>
            </div>
            <div className="sc-scroll">
              <table className="sc-table">
                <thead>
                  <tr>
                    <th>עובד</th><th>תפקיד</th><th className="c">כישורי בריסטה</th><th className="c">מקס׳ ימים</th>
                    <th className="c">עד שעה</th><th>טלפון</th><th className="c">טלגרם</th><th className="c">פעולות</th>
                  </tr>
                </thead>
                <tbody>
                  {activeEmployees.map(emp => (
                    <EmployeeRow key={emp.id} emp={emp} onApprove={approveEmployee} onUpdate={updateEmployee} onRemove={removeEmployee} />
                  ))}
                  {activeEmployees.length === 0 && (
                    <tr><td colSpan={8} className="sc-empty">אין עובדים פעילים עדיין. אפשר להתחיל ב"הוספת עובד".</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Add-employee drawer */}
          {showAddForm && (
            <>
              <div className="sc-ov open" onClick={() => setShowAddForm(false)} />
              <aside className="sc-drawer open" role="dialog" aria-modal="true">
                <div className="sc-dh">
                  <div className="sc-dh-ico"><Icon d={SI.users} size={18} /></div>
                  <div><h2>עובד חדש</h2><p>הוספת חבר צוות לסידור</p></div>
                  <button className="sc-ico sc-dx" onClick={() => setShowAddForm(false)} aria-label="סגירה"><Icon d={SI.x} /></button>
                </div>
                <div className="sc-db">
                  <div className="sc-fgrid">
                    <div className="sc-field full"><label>שם מלא *</label>
                      <input value={newEmp.name} onChange={e => setNewEmp(p => ({ ...p, name: e.target.value }))} placeholder="לדוגמה: דניאל מטזוני" onKeyDown={e => e.key === 'Enter' && addEmployee()} /></div>
                    <div className="sc-field"><label>טלפון</label>
                      <input value={newEmp.phone} onChange={e => setNewEmp(p => ({ ...p, phone: e.target.value }))} placeholder="050-0000000" /></div>
                    <div className="sc-field"><label>תפקיד</label>
                      <select value={newEmp.role} onChange={e => setNewEmp(p => ({ ...p, role: e.target.value }))}>
                        <option value="general">כללי</option><option value="barista">בריסטה</option><option value="roaster">קולה</option>
                      </select></div>
                    <div className="sc-field"><label>מקסימום ימים בשבוע</label>
                      <input type="number" min={1} max={6} value={newEmp.max_days} onChange={e => setNewEmp(p => ({ ...p, max_days: parseInt(e.target.value) || 5 }))} /></div>
                    <div className="sc-field"><label>שעת סיום (לא חובה)</label>
                      <input type="time" value={newEmp.end_time} onChange={e => setNewEmp(p => ({ ...p, end_time: e.target.value }))} />
                      <div className="sc-helper">ריק = יום מלא</div></div>
                    <div className="sc-field full">
                      <label className={`sc-checkline ${newEmp.barista_skills ? 'on' : ''}`}>
                        <input type="checkbox" checked={newEmp.barista_skills} onChange={e => setNewEmp(p => ({ ...p, barista_skills: e.target.checked }))} />
                        כישורי בריסטה: אפשר לשבץ כבריסטה בעת הצורך (עדיפות שנייה)
                      </label>
                    </div>
                    {(newEmp.role === 'barista' || newEmp.barista_skills) && (
                      <div className="sc-field"><label>רמת בריסטה</label><StarPicker value={newEmp.barista_level} onChange={v => setNewEmp(p => ({ ...p, barista_level: v }))} /></div>
                    )}
                    {newEmp.role === 'roaster' && (
                      <div className="sc-field"><label>רמת קלייה</label><StarPicker value={newEmp.roaster_level} onChange={v => setNewEmp(p => ({ ...p, roaster_level: v }))} /></div>
                    )}
                  </div>
                </div>
                <div className="sc-df">
                  <button className="btn" onClick={() => setShowAddForm(false)}>ביטול</button>
                  <button className="btn primary" onClick={addEmployee} disabled={!newEmp.name.trim()}>הוספת עובד</button>
                </div>
              </aside>
            </>
          )}
        </div>
      )}

      {/* ── AVAILABILITY TAB ───────────────────────────────────────────── */}
      {tab === 'availability' && (
        <div className="sc-card">
          <div className="sc-card-h">
            <h3>זמינות עובדים</h3>
            <div className="sc-weekpick"><label>שבוע מתחיל:</label>
              <input type="date" value={weekStart} onChange={e => setWeekStart(e.target.value)} /></div>
          </div>
          <div className="sc-card-b">
            <div className="sc-scroll">
              <table className="sc-table sc-avail">
                <thead>
                  <tr>
                    <th>עובד</th>
                    {weekDates.map(d => (
                      <th key={d.code} className="c day"><div>{d.label}</div><div className="sub">{formatDate(d.date)}</div></th>
                    ))}
                    <th className="c">סה״כ</th>
                  </tr>
                </thead>
                <tbody>
                  {activeEmployees.map(emp => {
                    const sub = weekAvailability.find(a => a.employee_id === emp.id);
                    const days = sub?.days || {};
                    const total = Object.values(days).filter(v => v).length;
                    return (
                      <tr key={emp.id}>
                        <td>
                          <div className="sc-person sm">
                            <div className="sc-avatar sm">{initials(emp.name)}</div>
                            <span className="sc-pname">{emp.name}</span>
                          </div>
                        </td>
                        {DAYS.map(d => (
                          <td key={d.code} className="c day">
                            {!sub ? <span className="sc-cell none">—</span>
                              : days[d.code] === true ? <span className="sc-cell yes" title="זמין/ה"><Check size={15} aria-label="זמין/ה" /></span>
                              : days[d.code] ? <span className="sc-cell until">עד {days[d.code]}</span>
                              : <span className="sc-cell no" title="לא זמין/ה"><X size={15} aria-label="לא זמין/ה" /></span>}
                          </td>
                        ))}
                        <td className="c">{sub ? <span className={`sc-tot ${total >= 3 ? 'good' : 'low'}`}>{total}</span> : <span className="sc-tot miss">לא נשלחה</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="sc-avail-note"><Icon d={SI.info} size={15} /> {weekAvailability.length} מתוך {activeEmployees.length} עובדים שלחו זמינות</div>
          </div>
        </div>
      )}

      {/* ── BUILDER TAB ─────────────────────────────────────────────────── */}
      {tab === 'builder' && (
        <div>
          {/* Action bar */}
          <div className="sc-card"><div className="sc-card-b">
            <div className="sc-actionbar">
              <div className="sc-weekpick"><label>שבוע (ראשון):</label>
                <input type="date" value={weekStart} onChange={e => setWeekStart(e.target.value)} /></div>
              <div className="sc-spacer" />
              {sheetsUrl && <a className="sc-sheetlink" href={sheetsUrl} target="_blank" rel="noreferrer"><Icon d={SI.link} size={15} /> פתיחת ה-Sheet</a>}
              <button className="btn" onClick={sendReminder} disabled={reminding}><Icon d={SI.send} /> {reminding ? 'שולח…' : 'שליחת תזכורת'}</button>
              <button className="btn" onClick={exportToSheets} disabled={exporting}><Icon d={SI.sheets} /> {exporting ? 'מייצא…' : 'ייצוא ל-Sheets'}</button>
              <button className="btn" onClick={generateSchedule} disabled={generating}><Icon d={SI.spark} /> {generating ? 'יוצר…' : 'יצירת סידור עם AI'}</button>
              <button className="btn primary" onClick={publish} disabled={publishing}><Icon d={SI.send} /> {publishing ? 'שולח…' : 'פרסום לקבוצה'}</button>
            </div>
            {generating && (
              <div className="sc-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(genProgress.progress)}>
                <div className="sc-progress-top"><span>יוצרים סידור עבודה עם AI…</span><span className="num">{Math.round(genProgress.progress)}%</span></div>
                <div className="meter"><i style={{ width: `${Math.min(100, Math.max(0, genProgress.progress))}%` }} /></div>
              </div>
            )}
          </div></div>

          {/* Day types */}
          <div className="sc-card"><div className="sc-card-b">
            <h4 className="sc-subhead">סוג יום</h4>
            <div className="sc-daytypes">
              {weekDates.map(d => (
                <div key={d.code} className="sc-daytype">
                  <span>{d.label} {formatDate(d.date)}</span>
                  <select value={dayTypes[d.code]} onChange={e => setDayTypes(prev => ({ ...prev, [d.code]: e.target.value }))}>
                    <option value="regular">רגיל</option><option value="friday">שישי</option>
                    <option value="holiday-eve">ערב חג</option><option value="closed">סגור</option>
                  </select>
                </div>
              ))}
            </div>
            <div className="sc-roastdays">
              <span>ימי קלייה:</span>
              {/* Friday excluded — it's always the cafe/pre-holiday day type, no roasting */}
              {['sun', 'mon', 'tue', 'wed', 'thu'].map(d => (
                <label key={d}><input type="checkbox" checked={roastDays[d] || false} onChange={e => setRoastDays(prev => ({ ...prev, [d]: e.target.checked }))} /> {DAYS.find(day => day.code === d)?.label}</label>
              ))}
            </div>
          </div></div>

          {/* Schedule grid */}
          <div className="sc-card"><div className="sc-card-b sc-grid-wrap">
            <div className="sc-grid-scroll">
              <table className="sc-gtable">
                <thead>
                  <tr>
                    <th className="rolehdr">תפקיד / יום</th>
                    {activeDays.map(d => {
                      const type = dayTypes[d.code];
                      const cls = type === 'holiday-eve' ? 'holiday' : type === 'friday' ? 'friday' : 'regular';
                      return (
                        <th key={d.code} className={`dayhdr ${cls}`}>
                          <div className="dn">{d.label}</div><div className="dd">{formatDate(d.date)}</div>
                          {type === 'holiday-eve' && <div className="dd eve">ערב חג, עד 14:00</div>}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {POSITIONS.map(pos => {
                    const appearsInAnyDay = activeDays.some(d => visiblePositions(d.code).find(p => p.id === pos.id));
                    if (!appearsInAnyDay) return null;
                    return (
                      <tr key={pos.id}>
                        <td className="poscell">{pos.label}{pos.time && <span className="pt">{pos.time}</span>}</td>
                        {activeDays.map(d => {
                          const isVisible = visiblePositions(d.code).find(p => p.id === pos.id);
                          const val = schedule[cellKey(d.code, pos.id)] || '';
                          const isEmpty = !val;
                          return (
                            <td key={d.code} className={`slot ${!isVisible ? 'na' : isEmpty ? 'empty' : 'filled'}`}>
                              {isVisible ? (
                                <select value={val} onChange={e => setCell(d.code, pos.id, e.target.value)}>
                                  <option value="">בחירה…</option>
                                  {activeEmployees.map(e => <option key={e.id} value={e.name}>{e.name}</option>)}
                                </select>
                              ) : <span className="naval">—</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="sc-legend">
              <span><i className="filled" /> תא מלא</span>
              <span><i className="empty" /> תא ריק</span>
              <span><i className="na" /> לא רלוונטי ליום</span>
            </div>
          </div></div>
        </div>
      )}
    </div>
  );
}
