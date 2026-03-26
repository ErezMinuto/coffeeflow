import React, { useState } from 'react';
import { useApp } from '../../lib/context';
import { notifyTeamIfWaiting, getTelegramSettings } from '../../lib/telegram';

const emptyCustomer = () => ({ customer_name: '', phone: '', product: '', notes: '' });

// ── CustomerForm — defined OUTSIDE Tasks to prevent focus loss ────────────────

function CustomerForm({ form, onChange, onSave, onCancel, title, bg, border }) {
  return (
    <div className="form-card" style={{ marginBottom: '20px', background: bg, border: `2px solid ${border}` }}>
      <h3>{title}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <div className="form-group">
          <label>שם לקוח *</label>
          <input
            type="text" placeholder="דוד כהן"
            value={form.customer_name}
            onChange={e => onChange({ ...form, customer_name: e.target.value })}
          />
        </div>
        <div className="form-group">
          <label>טלפון</label>
          <input
            type="text" placeholder="050-0000000"
            value={form.phone}
            onChange={e => onChange({ ...form, phone: e.target.value })}
          />
        </div>
      </div>
      <div className="form-group">
        <label>מוצר מבוקש *</label>
        <input
          type="text" placeholder="למשל: Kenya Light 250g / SKU: KL250"
          value={form.product}
          onChange={e => onChange({ ...form, product: e.target.value })}
        />
      </div>
      <div className="form-group">
        <label>הערות</label>
        <input
          type="text" placeholder="מידע נוסף..."
          value={form.notes}
          onChange={e => onChange({ ...form, notes: e.target.value })}
        />
      </div>
      <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
        <button onClick={onSave} className="btn-primary" style={{ flex: 1 }}>💾 שמור</button>
        <button onClick={onCancel} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
      </div>
    </div>
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
    if (!form.customer_name.trim()) { showToast('⚠️ נא למלא שם לקוח', 'warning'); return; }
    if (!form.product.trim())       { showToast('⚠️ נא למלא שם מוצר', 'warning'); return; }
    try {
      await waitingCustomersDb.insert({
        customer_name: form.customer_name.trim(),
        phone:         form.phone.trim(),
        product:       form.product.trim(),
        notes:         form.notes.trim(),
      });
      setAdding(false);
      setForm(emptyCustomer());
      showToast('✅ לקוח נוסף לרשימת ממתינים!');
    } catch (err) {
      console.error(err);
      showToast('❌ שגיאה בהוספת לקוח', 'error');
    }
  };

  const startEdit = (wc) => {
    setEditing(wc.id);
    setForm({ customer_name: wc.customer_name, phone: wc.phone || '', product: wc.product || '', notes: wc.notes || '' });
  };

  const saveEdit = async () => {
    if (!form.customer_name.trim()) { showToast('⚠️ נא למלא שם לקוח', 'warning'); return; }
    try {
      await waitingCustomersDb.update(editing, {
        customer_name: form.customer_name.trim(),
        phone:         form.phone.trim(),
        product:       form.product.trim(),
        notes:         form.notes.trim(),
      });
      setEditing(null);
      setForm(emptyCustomer());
      showToast('✅ לקוח עודכן!');
    } catch (err) {
      console.error(err);
      showToast('❌ שגיאה בעדכון לקוח', 'error');
    }
  };

  const markHandled = async (wc) => {
    try {
      await waitingCustomersDb.update(wc.id, { notified_at: new Date().toISOString() });
      showToast(`✅ ${wc.customer_name} סומן כטופל`);
    } catch (err) {
      showToast('❌ שגיאה', 'error');
    }
  };

  const unmarkHandled = async (wc) => {
    try {
      await waitingCustomersDb.update(wc.id, { notified_at: null });
      showToast(`↩️ ${wc.customer_name} הועבר בחזרה לממתינים`);
    } catch (err) {
      showToast('❌ שגיאה', 'error');
    }
  };

  const deleteCustomer = async (wc) => {
    if (!window.confirm(`למחוק את ${wc.customer_name}?`)) return;
    try {
      await waitingCustomersDb.remove(wc.id);
      showToast('✅ לקוח נמחק');
    } catch (err) {
      showToast('❌ שגיאה במחיקה', 'error');
    }
  };

  // ── Manual Telegram send ─────────────────────────────────────────────────────

  const sendNow = async () => {
    const settings = getTelegramSettings();
    if (!settings.botToken || !settings.chatId) {
      showToast('⚠️ הגדר בוט טלגרם בהגדרות קודם', 'warning'); return;
    }
    if (pending.length === 0) { showToast('⚠️ אין לקוחות ממתינים', 'warning'); return; }
    setSending(true);
    try {
      await notifyTeamIfWaiting({ waitingCustomers: pending, roastLabel: null, showToast });
    } finally {
      setSending(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h1>📋 Tasks</h1>
          {pending.length > 0 && (
            <div style={{ fontSize: '0.9rem', color: '#DC2626', fontWeight: '600' }}>
              {pending.length} לקוחות ממתינים לטיפול
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          {pending.length > 0 && (
            <button
              onClick={sendNow} disabled={sending}
              className="btn-small"
              style={{ background: '#0088CC', color: 'white', border: 'none' }}
            >
              {sending ? '⏳ שולח...' : `📱 שלח לטלגרם (${pending.length})`}
            </button>
          )}
          {!adding && !editing && (
            <button onClick={() => setAdding(true)} className="btn-primary">➕ הוסף לקוח ממתין</button>
          )}
        </div>
      </div>

      {/* Add form */}
      {adding && (
        <CustomerForm
          form={form} onChange={setForm}
          title="➕ לקוח ממתין חדש"
          bg="#F0F9FF" border="#3B82F6"
          onSave={saveNew}
          onCancel={() => { setAdding(false); setForm(emptyCustomer()); }}
        />
      )}

      {/* Edit form */}
      {editing && (
        <CustomerForm
          form={form} onChange={setForm}
          title="✏️ עריכת לקוח"
          bg="#FFF9F0" border="#FF6B35"
          onSave={saveEdit}
          onCancel={() => { setEditing(null); setForm(emptyCustomer()); }}
        />
      )}

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
        {[
          ['pending', `⏳ ממתינים (${pending.length})`],
          ['done',    `✅ טופלו (${done.length})`],
          ['all',     'כל הרשימה'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            style={{
              padding: '6px 16px', borderRadius: '20px', border: 'none', cursor: 'pointer',
              fontWeight: filter === key ? '700' : '400',
              background: filter === key ? '#6F4E37' : '#F4E8D8',
              color: filter === key ? 'white' : '#6F4E37',
              fontSize: '0.875rem'
            }}
          >{label}</button>
        ))}
      </div>

      {/* Customer list */}
      {displayed.length === 0 ? (
        <div className="empty-state">
          {filter === 'pending' ? 'אין לקוחות ממתינים כרגע 🎉' : 'אין רשומות'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {displayed.map(wc => {
            const isDone = !!wc.notified_at;
            return (
              <div
                key={wc.id}
                style={{
                  background: isDone ? '#F9FAFB' : 'white',
                  border: `1px solid ${isDone ? '#E5E7EB' : '#FCA5A5'}`,
                  borderRadius: '12px', padding: '1rem',
                  opacity: isDone ? 0.75 : 1,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: '1rem', textDecoration: isDone ? 'line-through' : 'none', color: isDone ? '#9CA3AF' : '#111' }}>
                        {wc.customer_name}
                      </strong>
                      {wc.phone && (
                        <a href={`tel:${wc.phone}`} style={{ color: '#0369A1', fontSize: '0.875rem', textDecoration: 'none' }}>
                          📞 {wc.phone}
                        </a>
                      )}
                      {isDone && (
                        <span style={{ background: '#D1FAE5', color: '#065F46', padding: '0.1rem 0.5rem', borderRadius: '12px', fontSize: '0.75rem', fontWeight: '600' }}>
                          ✅ טופל
                        </span>
                      )}
                    </div>
                    {wc.product && (
                      <div style={{ fontSize: '0.9rem', color: '#374151', background: '#FEF3C7', display: 'inline-block', padding: '0.2rem 0.6rem', borderRadius: '6px', marginBottom: '0.3rem' }}>
                        📦 {wc.product}
                      </div>
                    )}
                    {wc.notes && (
                      <div style={{ fontSize: '0.8rem', color: '#6B7280', marginTop: '0.3rem' }}>📝 {wc.notes}</div>
                    )}
                    <div style={{ fontSize: '0.75rem', color: '#9CA3AF', marginTop: '0.3rem' }}>
                      נוסף: {new Date(wc.created_at).toLocaleDateString('he-IL')}
                      {wc.notified_at && ` · טופל: ${new Date(wc.notified_at).toLocaleDateString('he-IL')}`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    {!isDone
                      ? <button onClick={() => markHandled(wc)} className="btn-small" style={{ background: '#D1FAE5', color: '#065F46' }} title="סמן כטופל">✅</button>
                      : <button onClick={() => unmarkHandled(wc)} className="btn-small" title="החזר לממתינים">↩️</button>
                    }
                    <button onClick={() => startEdit(wc)} className="btn-small" title="ערוך">✏️</button>
                    <button onClick={() => deleteCustomer(wc)} className="btn-small" style={{ background: '#FEE2E2', color: '#991B1B' }} title="מחק">🗑️</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
