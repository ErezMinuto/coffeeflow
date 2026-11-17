import React, { useState } from 'react';
import { UserPlus, Send, Check, Undo2, Pencil, Trash2, Phone } from 'lucide-react';
import { useApp } from '../../lib/context';
import { notifyTeamIfWaiting, getTelegramSettings } from '../../lib/telegram';
import { PageHeader } from '../shared/ui';
import './tasks.css';

const emptyCustomer = () => ({ customer_name: '', phone: '', product: '', notes: '' });

// ── CustomerForm — defined OUTSIDE Tasks to prevent focus loss ────────────────

function CustomerForm({ form, onChange, onSave, onCancel, title, idPrefix }) {
  return (
    <section className="card tasks-form">
      <h2>{title}</h2>
      <div className="tasks-form-row">
        <div className="form-group">
          <label htmlFor={`${idPrefix}-name`}>שם לקוח *</label>
          <input
            id={`${idPrefix}-name`}
            type="text" placeholder="דוד כהן"
            value={form.customer_name}
            onChange={e => onChange({ ...form, customer_name: e.target.value })}
          />
        </div>
        <div className="form-group">
          <label htmlFor={`${idPrefix}-phone`}>טלפון</label>
          <input
            id={`${idPrefix}-phone`}
            type="tel" dir="ltr" placeholder="050-0000000"
            value={form.phone}
            onChange={e => onChange({ ...form, phone: e.target.value })}
          />
        </div>
      </div>
      <div className="form-group">
        <label htmlFor={`${idPrefix}-product`}>מוצר מבוקש *</label>
        <input
          id={`${idPrefix}-product`}
          type="text" placeholder="למשל: Kenya Light 330g / SKU: KL330"
          value={form.product}
          onChange={e => onChange({ ...form, product: e.target.value })}
        />
      </div>
      <div className="form-group">
        <label htmlFor={`${idPrefix}-notes`}>הערות</label>
        <input
          id={`${idPrefix}-notes`}
          type="text" placeholder="מידע נוסף..."
          value={form.notes}
          onChange={e => onChange({ ...form, notes: e.target.value })}
        />
      </div>
      <div className="tasks-form-actions">
        <button type="button" onClick={onSave} className="btn primary">שמירה</button>
        <button type="button" onClick={onCancel} className="btn">ביטול</button>
      </div>
    </section>
  );
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export default function Tasks() {
  const { data, waitingCustomersDb, showToast } = useApp();

  const [adding,  setAdding]  = useState(false);
  const [editing, setEditing] = useState(null); // id of row being edited
  const [form,    setForm]    = useState(emptyCustomer());
  const [filter,  setFilter]  = useState('pending'); // 'pending' | 'done' | 'all'
  const [sending, setSending] = useState(false);

  const pending = (data.waitingCustomers || []).filter(wc => !wc.notified_at);
  const done    = (data.waitingCustomers || []).filter(wc => !!wc.notified_at);

  const displayed = filter === 'pending' ? pending
                  : filter === 'done'    ? done
                  : (data.waitingCustomers || []);

  // ── CRUD ────────────────────────────────────────────────────────────────────

  const saveNew = async () => {
    if (!form.customer_name.trim()) { showToast('נא למלא שם לקוח', 'warning'); return; }
    if (!form.product.trim())       { showToast('נא למלא שם מוצר', 'warning'); return; }
    try {
      await waitingCustomersDb.insert({
        customer_name: form.customer_name.trim(),
        phone:         form.phone.trim(),
        product:       form.product.trim(),
        notes:         form.notes.trim(),
      });
      setAdding(false);
      setForm(emptyCustomer());
      showToast('לקוח נוסף לרשימת ממתינים!');
    } catch (err) {
      console.error(err);
      showToast('שגיאה בהוספת לקוח', 'error');
    }
  };

  const startEdit = (wc) => {
    setEditing(wc.id);
    setForm({ customer_name: wc.customer_name, phone: wc.phone || '', product: wc.product || '', notes: wc.notes || '' });
  };

  const saveEdit = async () => {
    if (!form.customer_name.trim()) { showToast('נא למלא שם לקוח', 'warning'); return; }
    try {
      await waitingCustomersDb.update(editing, {
        customer_name: form.customer_name.trim(),
        phone:         form.phone.trim(),
        product:       form.product.trim(),
        notes:         form.notes.trim(),
      });
      setEditing(null);
      setForm(emptyCustomer());
      showToast('לקוח עודכן!');
    } catch (err) {
      console.error(err);
      showToast('שגיאה בעדכון לקוח', 'error');
    }
  };

  const markHandled = async (wc) => {
    try {
      await waitingCustomersDb.update(wc.id, { notified_at: new Date().toISOString() });
      showToast(`${wc.customer_name} סומן כטופל`);
    } catch (err) {
      showToast('שגיאה', 'error');
    }
  };

  const unmarkHandled = async (wc) => {
    try {
      await waitingCustomersDb.update(wc.id, { notified_at: null });
      showToast(`${wc.customer_name} הועבר בחזרה לממתינים`);
    } catch (err) {
      showToast('שגיאה', 'error');
    }
  };

  const deleteCustomer = async (wc) => {
    if (!window.confirm(`למחוק את ${wc.customer_name}?`)) return;
    try {
      await waitingCustomersDb.remove(wc.id);
      showToast('לקוח נמחק');
    } catch (err) {
      showToast('שגיאה במחיקה', 'error');
    }
  };

  // ── Manual Telegram send ─────────────────────────────────────────────────────

  const sendNow = async () => {
    const settings = getTelegramSettings();
    if (!settings.botToken || !settings.chatId) {
      showToast('צריך להגדיר בוט טלגרם בהגדרות קודם', 'warning'); return;
    }
    if (pending.length === 0) { showToast('אין לקוחות ממתינים', 'warning'); return; }
    setSending(true);
    try {
      await notifyTeamIfWaiting({ waitingCustomers: pending, roastLabel: null, showToast });
    } finally {
      setSending(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="page tasks-page">
      <PageHeader
        title="משימות"
        subtitle={pending.length > 0
          ? <span className="tasks-sub"><span className="dot warn" aria-hidden="true" />{pending.length} לקוחות ממתינים לטיפול</span>
          : 'לקוחות שמחכים למוצר שאזל'}
        actions={(pending.length > 0 || (!adding && !editing)) && <>
          {pending.length > 0 && (
            <button type="button" onClick={sendNow} disabled={sending} className="btn">
              <Send aria-hidden="true" />
              {sending ? 'בשליחה...' : <>שליחה לטלגרם <span className="num">({pending.length})</span></>}
            </button>
          )}
          {!adding && !editing && (
            <button type="button" onClick={() => setAdding(true)} className="btn primary">
              <UserPlus aria-hidden="true" />לקוח ממתין חדש
            </button>
          )}
        </>}
      />

      {/* Add form */}
      {adding && (
        <CustomerForm
          form={form} onChange={setForm}
          title="לקוח ממתין חדש"
          idPrefix="wc-new"
          onSave={saveNew}
          onCancel={() => { setAdding(false); setForm(emptyCustomer()); }}
        />
      )}

      {/* Edit form */}
      {editing && (
        <CustomerForm
          form={form} onChange={setForm}
          title="עריכת לקוח"
          idPrefix="wc-edit"
          onSave={saveEdit}
          onCancel={() => { setEditing(null); setForm(emptyCustomer()); }}
        />
      )}

      {/* Filter tabs */}
      <div className="tasks-seg" role="group" aria-label="סינון רשימה">
        {[
          ['pending', 'ממתינים', pending.length],
          ['done',    'טופלו',   done.length],
          ['all',     'הכול',    null],
        ].map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            className={filter === key ? 'active' : ''}
            onClick={() => setFilter(key)}
          >
            {label}
            {count !== null && <span className="tasks-seg-count num">{count}</span>}
          </button>
        ))}
      </div>

      {/* Customer list */}
      {displayed.length === 0 ? (
        <div className="card empty-state">
          {filter === 'pending' ? 'אין לקוחות ממתינים כרגע' : 'אין רשומות'}
        </div>
      ) : (
        <ul className="card flush tasks-list">
          {displayed.map(wc => {
            const isDone = !!wc.notified_at;
            return (
              <li key={wc.id} className={`tasks-row${isDone ? ' done' : ''}`}>
                <span className={`dot ${isDone ? 'ok' : 'warn'}`} aria-hidden="true" />
                <div className="tasks-main">
                  <div className="tasks-line">
                    <span className="tasks-name">{wc.customer_name}</span>
                    {isDone && <span className="tag ok">טופל</span>}
                  </div>
                  {wc.product && <div className="tasks-product">{wc.product}</div>}
                  {wc.notes && <div className="tasks-notes">{wc.notes}</div>}
                  <div className="tasks-meta num">
                    {wc.phone && (
                      <a className="tasks-phone" href={`tel:${wc.phone}`}>
                        <Phone aria-hidden="true" /><span dir="ltr">{wc.phone}</span>
                      </a>
                    )}
                    <span>
                      נוסף: {new Date(wc.created_at).toLocaleDateString('he-IL')}
                      {wc.notified_at && ` · טופל: ${new Date(wc.notified_at).toLocaleDateString('he-IL')}`}
                    </span>
                  </div>
                </div>
                <div className="tasks-actions action-buttons">
                  {!isDone
                    ? <button type="button" onClick={() => markHandled(wc)} className="btn sm tasks-done-btn"><Check aria-hidden="true" />סימון כטופל</button>
                    : <button type="button" onClick={() => unmarkHandled(wc)} className="btn-icon" aria-label={`החזרת ${wc.customer_name} לממתינים`} title="החזרה לממתינים"><Undo2 aria-hidden="true" /></button>
                  }
                  <button type="button" onClick={() => startEdit(wc)} className="btn-icon" aria-label={`עריכת ${wc.customer_name}`} title="עריכה"><Pencil aria-hidden="true" /></button>
                  <button type="button" onClick={() => deleteCustomer(wc)} className="btn-icon danger" aria-label={`מחיקת ${wc.customer_name}`} title="מחיקה"><Trash2 aria-hidden="true" /></button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
