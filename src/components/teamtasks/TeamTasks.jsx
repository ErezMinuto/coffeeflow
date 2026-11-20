import React, { useMemo, useState } from 'react';
import { Plus, Trash2, Check, RotateCcw } from 'lucide-react';
import { useApp } from '../../lib/context';
import { PageHeader } from '../shared/ui';
import { supabase } from '../../lib/supabase';
import './teamtasks.css';

// ── Team tasks (משימות לצוות) ────────────────────────────────────────────────
// The owner assigns a task to a staff member; employee-bot DMs them with a ✅
// button and reminds every morning while it's due or overdue. Staff with a
// linked login (employees.clerk_user_id) see their own tasks here, tick them
// off, and can add tasks for themselves. Table manager_tasks; RLS decides who
// sees and writes what (20261120120000_manager_tasks.sql).

const TZ = 'Asia/Jerusalem';
const todayIL = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
const LAST_ASSIGNEE_KEY = 'teamTasks.lastAssignee';

const ddmm = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '');
const daysLate = (due, today) =>
  Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${due}T12:00:00Z`)) / 86400000);

function DueTag({ due, today }) {
  const late = daysLate(due, today);
  if (late > 0) return <span className="tag danger num">באיחור {late === 1 ? 'יום' : `${late} ימים`}</span>;
  if (late === 0) return <span className="tag warn">להיום</span>;
  if (late === -1) return <span className="tag">למחר</span>;
  return <span className="tag num">עד {ddmm(due)}</span>;
}

const readLastAssignee = () => {
  try { return localStorage.getItem(LAST_ASSIGNEE_KEY) || ''; } catch { return ''; }
};
const saveLastAssignee = (id) => {
  try { localStorage.setItem(LAST_ASSIGNEE_KEY, String(id)); } catch { /* private mode */ }
};

export default function TeamTasks() {
  const { user, isAdmin, employees, data, managerTasksDb, showToast } = useApp();
  const tasks = data.managerTasks;
  const today = todayIL();

  // The signed-in user's employee row, if their login is linked.
  const me = (employees || []).find((e) => e.clerk_user_id && e.clerk_user_id === user?.id) || null;

  // Admins can assign to any active employee who has Telegram; default to the
  // last one used, else the first linked login that isn't the admin.
  const assignable = useMemo(() => (employees || [])
    .filter((e) => e.active !== false && e.telegram_id)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'he')), [employees]);
  const defaultAssignee = () => {
    if (!isAdmin) return me ? String(me.id) : '';
    const last = readLastAssignee();
    if (last && assignable.some((e) => String(e.id) === last)) return last;
    const linked = assignable.find((e) => e.clerk_user_id && e.id !== me?.id);
    return linked ? String(linked.id) : '';
  };

  const [form, setForm] = useState(() => ({ title: '', notes: '', due: todayIL(), assignee: '' }));
  const assignee = form.assignee || defaultAssignee();
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [filter, setFilter] = useState('open');

  const nameOf = (id) => (employees || []).find((e) => e.id === id)?.name || '—';
  const canEdit = (t) => isAdmin || (me && t.assignee_employee_id === me.id && t.created_by === user?.id);

  const open = tasks.filter((t) => t.status === 'open')
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id - b.id);
  const done = tasks.filter((t) => t.status === 'done')
    .sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)));
  const shown = filter === 'open' ? open : done;
  const lateCount = open.filter((t) => t.due_date < today).length;

  async function invokeBot(action, taskId) {
    const { data: res, error } = await supabase.functions.invoke('employee-bot', {
      body: { task_id: taskId },
      headers: { 'x-action': action },
    });
    if (error) throw error;
    return res;
  }

  async function addTask(e) {
    e.preventDefault();
    const title = form.title.trim();
    if (!title) { showToast('נא לכתוב מה צריך לעשות', 'warning'); return; }
    if (!assignee) { showToast('נא לבחור למי המשימה', 'warning'); return; }
    if (!form.due) { showToast('נא לבחור תאריך יעד', 'warning'); return; }
    setSaving(true);
    try {
      const { data: row, error } = await supabase
        .from('manager_tasks')
        .insert({
          title,
          notes: form.notes.trim() || null,
          due_date: form.due,
          assignee_employee_id: Number(assignee),
          created_by: user.id,
        })
        .select()
        .single();
      if (error) throw error;
      if (isAdmin) saveLastAssignee(assignee);
      setForm({ title: '', notes: '', due: todayIL(), assignee: form.assignee });
      managerTasksDb.refresh();

      const to = Number(assignee) === me?.id ? 'אליך' : `ל${nameOf(Number(assignee)).split(' ')[0]}`;
      try {
        const res = await invokeBot('task-notify', row.id);
        if (res?.sent === 1) showToast(`המשימה נוספה ונשלחה ${to} בטלגרם`, 'success');
        else if (res?.reason === 'no telegram') showToast('המשימה נוספה, אבל אין טלגרם מחובר לעובד/ת הזה/ו', 'warning');
        else showToast('המשימה נוספה, אבל ההודעה בטלגרם לא נשלחה. התזכורת של הבוקר תנסה שוב', 'warning');
      } catch {
        showToast('המשימה נוספה, אבל ההודעה בטלגרם לא נשלחה. התזכורת של הבוקר תנסה שוב', 'warning');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function setDone(t, doneFlag) {
    setBusyId(t.id);
    try {
      const { data: rows, error } = await supabase.rpc('set_manager_task_done', { p_id: t.id, p_done: doneFlag });
      if (error) throw error;
      if (!rows?.length) showToast('המשימה כבר עודכנה', 'warning');
      else if (doneFlag) {
        showToast('סומן כבוצע', 'success');
        invokeBot('task-done-notify', t.id).catch(() => {});
      }
      managerTasksDb.refresh();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function changeDue(t, due) {
    if (!due || due === t.due_date) return;
    // Moving the date makes the task "new" for reminders again.
    const { error } = await supabase.from('manager_tasks')
      .update({ due_date: due, last_reminded_on: null }).eq('id', t.id);
    if (error) { showToast(error.message, 'error'); return; }
    showToast(`התאריך עודכן ל-${ddmm(due)}`, 'success');
    managerTasksDb.refresh();
  }

  async function remove(t) {
    if (!window.confirm(`למחוק את המשימה "${t.title}"?`)) return;
    const { error } = await supabase.from('manager_tasks').delete().eq('id', t.id);
    if (error) { showToast(error.message, 'error'); return; }
    showToast('המשימה נמחקה', 'success');
    managerTasksDb.refresh();
  }

  const subtitle = isAdmin
    ? 'משימות שנשלחות לצוות בטלגרם, עם תזכורת כל בוקר עד שמסמנים בוצע'
    : 'המשימות שלך. כל בוקר מגיעה תזכורת בטלגרם על מה שעוד פתוח';

  return (
    <div className="page teamtasks-page">
      <PageHeader title="משימות לצוות" subtitle={subtitle} />

      <section className="card flush">
        <div className="card-head"><h2>{isAdmin ? 'משימה חדשה' : 'משימה חדשה לעצמי'}</h2></div>
        <form className="card-body teamtasks-form" onSubmit={addTask}>
          <div className="form-group span-all">
            <label htmlFor="tt-title">מה צריך לעשות</label>
            <input id="tt-title" type="text" value={form.title} maxLength={300} autoComplete="off"
              placeholder="למשל: להזמין חלב שיבולת שועל לשבוע הבא"
              onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="form-group span-all">
            <label htmlFor="tt-notes">פרטים (לא חובה)</label>
            <input id="tt-notes" type="text" value={form.notes} maxLength={2000} autoComplete="off"
              onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          {isAdmin && (
            <div className="form-group">
              <label htmlFor="tt-who">למי</label>
              <select id="tt-who" value={assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })}>
                <option value="">בחירה…</option>
                {assignable.map((e) => (
                  <option key={e.id} value={e.id}>{e.id === me?.id ? `${e.name} (אני)` : e.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="form-group">
            <label htmlFor="tt-due">עד מתי</label>
            <input id="tt-due" type="date" value={form.due} min={today}
              onChange={(e) => setForm({ ...form, due: e.target.value })} />
          </div>
          <div className="teamtasks-submit">
            <button type="submit" className="btn primary" disabled={saving}>
              <Plus aria-hidden="true" />{saving ? 'בשמירה…' : 'הוספה ושליחה'}
            </button>
          </div>
        </form>
      </section>

      <section className="card flush">
        <div className="card-head">
          <div className="teamtasks-tabs" role="tablist" aria-label="סינון משימות">
            <button type="button" role="tab" aria-selected={filter === 'open'}
              className={`teamtasks-tab${filter === 'open' ? ' active' : ''}`} onClick={() => setFilter('open')}>
              פתוחות <span className="num">{open.length}</span>
            </button>
            <button type="button" role="tab" aria-selected={filter === 'done'}
              className={`teamtasks-tab${filter === 'done' ? ' active' : ''}`} onClick={() => setFilter('done')}>
              בוצעו <span className="num">{done.length}</span>
            </button>
          </div>
          {filter === 'open' && lateCount > 0 && <span className="meta num">{lateCount} באיחור</span>}
        </div>

        {shown.length === 0 ? (
          <p className="empty-state">
            {filter === 'open' ? 'אין משימות פתוחות.' : 'עוד לא סומנו משימות כבוצעו.'}
          </p>
        ) : (
          <ul className="teamtasks-list">
            {shown.map((t) => (
              <li key={t.id} className={`teamtasks-item${t.status === 'done' ? ' is-done' : ''}`}>
                <button type="button"
                  className={`teamtasks-check${t.status === 'done' ? ' checked' : ''}`}
                  disabled={busyId === t.id}
                  aria-label={t.status === 'done' ? `החזרת "${t.title}" לפתוחות` : `סימון "${t.title}" כבוצע`}
                  title={t.status === 'done' ? 'החזרה לפתוחות' : 'סימון כבוצע'}
                  onClick={() => setDone(t, t.status !== 'done')}>
                  {t.status === 'done' ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}
                </button>

                <div className="teamtasks-body">
                  <div className="teamtasks-title">{t.title}</div>
                  {t.notes && <div className="teamtasks-notes">{t.notes}</div>}
                  <div className="teamtasks-meta">
                    {isAdmin && <span className="teamtasks-who">{nameOf(t.assignee_employee_id)}</span>}
                    {t.status === 'open' ? (
                      <>
                        <DueTag due={t.due_date} today={today} />
                        {t.reminder_count > 0 && <span className="text-muted num">{t.reminder_count} תזכורות</span>}
                      </>
                    ) : (
                      <span className="text-muted num">
                        בוצע {t.done_at ? new Date(t.done_at).toLocaleString('he-IL', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                        {t.done_via === 'telegram' ? ' · בטלגרם' : ''}
                      </span>
                    )}
                  </div>
                </div>

                {canEdit(t) && (
                  <div className="teamtasks-actions">
                    {t.status === 'open' && (
                      <input type="date" className="teamtasks-date" value={t.due_date}
                        aria-label={`שינוי תאריך יעד ל"${t.title}"`}
                        onChange={(e) => changeDue(t, e.target.value)} />
                    )}
                    <button type="button" className="btn-icon danger" title="מחיקה"
                      aria-label={`מחיקת "${t.title}"`} onClick={() => remove(t)}>
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
