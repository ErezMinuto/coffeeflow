import React, { useState, useEffect } from 'react';
import { useApp } from '../../lib/context';
import RoastProfiles from './RoastProfiles';
import { getTelegramSettings, saveTelegramSettings, sendTelegramMessage } from '../../lib/telegram';
import { supabase } from '../../lib/supabase';

// ── Sidebar categories ────────────────────────────────────────────────────────
const CATEGORIES = [
  { id: 'operators',  icon: '👥', label: 'מפעילים' },
  { id: 'costs',      icon: '💰', label: 'עלויות' },
  { id: 'roast',      icon: '🔥', label: 'פרופילי קלייה' },
  { id: 'roles',      icon: '🔐', label: 'תפקידים' },
  { id: 'telegram',   icon: '📱', label: 'טלגרם' },
];

// ── Shared section wrapper ────────────────────────────────────────────────────
function Section({ title, description, children }) {
  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ margin: 0, fontSize: '1.3rem', color: '#2c1a0e' }}>{title}</h2>
        {description && <p style={{ margin: '6px 0 0', color: '#777', fontSize: '0.9rem' }}>{description}</p>}
      </div>
      {children}
    </div>
  );
}

// ── Operators ─────────────────────────────────────────────────────────────────
function OperatorsSection({ data, operatorsDb, roastsDb, showToast }) {
  const [newOperator,     setNewOperator]     = useState('');
  const [editingOperator, setEditingOperator] = useState(null);

  const addOperator = async () => {
    if (!newOperator.trim()) return;
    try {
      await operatorsDb.insert({ name: newOperator.trim() });
      setNewOperator('');
      showToast('✅ מפעיל נוסף!');
    } catch (error) {
      showToast('❌ שגיאה בהוספת מפעיל', 'error');
    }
  };

  const saveEditOperator = async () => {
    if (!editingOperator.name.trim()) { showToast('⚠️ נא למלא שם מפעיל', 'warning'); return; }
    try {
      await operatorsDb.update(editingOperator.id, { name: editingOperator.name.trim() });
      const oldOperator = data.operators.find(op => op.id === editingOperator.id);
      if (oldOperator && oldOperator.name !== editingOperator.name.trim()) {
        for (const roast of data.roasts.filter(r => r.operator === oldOperator.name)) {
          await roastsDb.update(roast.id, { operator: editingOperator.name.trim() });
        }
      }
      setEditingOperator(null);
      showToast('✅ מפעיל עודכן!');
    } catch (error) {
      showToast('❌ שגיאה בעדכון מפעיל', 'error');
    }
  };

  const deleteOperator = async (operator) => {
    const roastCount = data.roasts.filter(r => r.operator === operator.name).length;
    const msg = roastCount > 0
      ? `⚠️ למפעיל "${operator.name}" יש ${roastCount} קליות.\n\nהאם למחוק?`
      : `האם למחוק את המפעיל "${operator.name}"?`;
    if (!window.confirm(msg)) return;
    try {
      await operatorsDb.remove(operator.id);
      showToast('✅ מפעיל נמחק!');
    } catch (error) {
      showToast('❌ שגיאה במחיקת מפעיל', 'error');
    }
  };

  return (
    <Section title="👥 ניהול מפעילים" description="מפעילים הם עובדים הקושרים לרשומות קלייה.">
      <div className="form-card">
        <div style={{ display: 'flex', gap: '10px' }}>
          <input
            type="text" placeholder="שם מפעיל חדש..."
            value={newOperator} onChange={e => setNewOperator(e.target.value)}
            onKeyPress={e => e.key === 'Enter' && addOperator()}
            style={{ flex: 1 }}
          />
          <button onClick={addOperator} className="btn-primary">➕ הוסף</button>
        </div>
      </div>

      {editingOperator && (
        <div className="form-card" style={{ background: '#FFF9F0', border: '2px solid #FF6B35', marginTop: '15px' }}>
          <h3>✏️ עריכת מפעיל</h3>
          <input type="text" value={editingOperator.name}
            onChange={e => setEditingOperator({ ...editingOperator, name: e.target.value })} />
          <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
            <button onClick={saveEditOperator} className="btn-primary" style={{ flex: 1 }}>💾 שמור</button>
            <button onClick={() => setEditingOperator(null)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
          </div>
        </div>
      )}

      <div className="table-container" style={{ marginTop: '15px' }}>
        <table className="data-table">
          <thead><tr><th>שם</th><th>קליות</th><th>פעולות</th></tr></thead>
          <tbody>
            {data.operators.map(op => (
              <tr key={op.id}>
                <td><strong>{op.name}</strong></td>
                <td>{data.roasts.filter(r => r.operator === op.name).length}</td>
                <td>
                  <div className="action-buttons">
                    <button onClick={() => setEditingOperator({ ...op })} className="btn-icon">✏️</button>
                    <button onClick={() => deleteOperator(op)} className="btn-icon">🗑️</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.operators.length === 0 && <div className="empty-state">אין מפעילים.</div>}
      </div>
    </Section>
  );
}

// ── Costs ─────────────────────────────────────────────────────────────────────
function CostsSection({ costSettings, updateCostSettings }) {
  return (
    <Section title="💰 הגדרות עלויות" description="עלויות קבועות המשפיעות על חישוב מחיר המוצרים.">
      {costSettings ? (
        <div className="form-card">
          <div className="form-grid">
            {[
              ['שקית 250g (₪)',    'bag_250g',              0.60, 0.01],
              ['שקית 330g (₪)',    'bag_330g',              0,    0.01],
              ['שקית 1kg (₪)',     'bag_1000g',             2.00, 0.01],
              ['מדבקה (₪)',        'label',                 0,    0.01],
              ['גז לקלייה (₪)',   'gas_per_roast',         0,    0.01],
              ['שכר/שעה (₪)',      'labor_per_hour',        0,    1   ],
              ['זמן קלייה (דק׳)', 'roasting_time_minutes', 0,    1   ],
              ['זמן אריזה (דק׳)', 'packaging_time_minutes',0,    0.1 ],
            ].map(([label, key, fallback, step]) => (
              <div className="form-group" key={key}>
                <label>{label}</label>
                <input
                  type="number" step={step}
                  value={costSettings[key] ?? fallback}
                  onChange={async e => updateCostSettings({ [key]: parseFloat(e.target.value) })}
                />
              </div>
            ))}
          </div>
          <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: '#666' }}>💾 השינויים נשמרים אוטומטית</p>
        </div>
      ) : (
        <div className="empty-state">טוען הגדרות...</div>
      )}
    </Section>
  );
}

// ── Roles ─────────────────────────────────────────────────────────────────────
function RolesSection({ user, showToast }) {
  const [roles,       setRoles]       = useState([]);
  const [newEmail,    setNewEmail]    = useState('');
  const [newRoleRole, setNewRoleRole] = useState('employee');
  const [looking,     setLooking]     = useState(false);

  const fetchRoles = async () => {
    const { data: rows } = await supabase.from('user_roles').select('*').order('created_at', { ascending: true });
    const roles = rows || [];
    setRoles(roles);

    // Auto-populate email/name for rows missing them
    const missing = roles.filter(r => !r.email).map(r => r.user_id);
    if (missing.length === 0) return;

    try {
      const { data: users } = await supabase.functions.invoke('clerk-user-lookup', {
        body: { user_ids: missing },
      });
      if (!users || !Array.isArray(users)) return;

      await Promise.all(users.map(u =>
        supabase.from('user_roles').update({ email: u.email, full_name: u.full_name })
          .eq('user_id', u.user_id)
      ));

      // Refresh to show updated values
      const { data: updated } = await supabase.from('user_roles').select('*').order('created_at', { ascending: true });
      setRoles(updated || []);
    } catch (_) {}
  };

  useEffect(() => { fetchRoles(); }, []);

  const addRole = async () => {
    if (!newEmail.trim()) { showToast('⚠️ נא להזין אימייל', 'warning'); return; }
    setLooking(true);
    try {
      const { data, error } = await supabase.functions.invoke('clerk-user-lookup', {
        body: { email: newEmail.trim() },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message || 'משתמש לא נמצא');

      await supabase.from('user_roles').upsert(
        { user_id: data.user_id, email: data.email, full_name: data.full_name, role: newRoleRole },
        { onConflict: 'user_id', ignoreDuplicates: false }
      );
      setNewEmail('');
      fetchRoles();
      showToast(`✅ ${data.full_name || data.email} נוסף כ${newRoleRole === 'admin' ? 'מנהל' : 'עובד'}!`);
    } catch (err) {
      showToast(`❌ ${err.message}`, 'error');
    } finally {
      setLooking(false);
    }
  };

  const updateRole = async (userId, role) => {
    await supabase.from('user_roles').update({ role }).eq('user_id', userId);
    fetchRoles();
    showToast(`✅ תפקיד עודכן`);
  };

  const deleteRole = async (userId) => {
    if (!window.confirm('להסיר תפקיד? המשתמש יקבל גישת עובד.')) return;
    await supabase.from('user_roles').delete().eq('user_id', userId);
    fetchRoles();
    showToast('✅ תפקיד הוסר');
  };

  return (
    <Section title="🔐 ניהול תפקידים" description="מנהל — גישה מלאה. עובד — דשבורד + ייצור בלבד.">
      {/* Add */}
      <div className="form-card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 2, minWidth: '200px', marginBottom: 0 }}>
            <label>אימייל משתמש</label>
            <input
              type="email" placeholder="user@example.com"
              value={newEmail} onChange={e => setNewEmail(e.target.value)}
              onKeyPress={e => e.key === 'Enter' && addRole()}
            />
          </div>
          <div className="form-group" style={{ flex: 1, minWidth: '120px', marginBottom: 0 }}>
            <label>תפקיד</label>
            <select value={newRoleRole} onChange={e => setNewRoleRole(e.target.value)}
              style={{ padding: '8px', borderRadius: '6px', border: '1px solid #ddd' }}>
              <option value="employee">👤 עובד</option>
              <option value="admin">👑 מנהל</option>
            </select>
          </div>
          <button onClick={addRole} disabled={looking} className="btn-primary" style={{ marginBottom: 0 }}>
            {looking ? '⏳...' : '➕ הוסף'}
          </button>
        </div>
      </div>

      {/* Table */}
      {roles.length > 0 ? (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr><th>משתמש</th><th>תפקיד</th><th>פעולות</th></tr>
            </thead>
            <tbody>
              {roles.map(r => (
                <tr key={r.id}>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <strong style={{ fontSize: '0.9rem' }}>
                          {r.full_name || r.email || r.user_id}
                        </strong>
                        {r.user_id === user?.id && (
                          <span style={{ background: '#DCFCE7', color: '#065F46', padding: '1px 7px', borderRadius: '10px', fontSize: '0.7rem', fontWeight: 600 }}>
                            אני
                          </span>
                        )}
                      </div>
                      {r.full_name && r.email && (
                        <span style={{ fontSize: '0.78rem', color: '#888' }}>{r.email}</span>
                      )}
                      <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: '#bbb' }}>{r.user_id}</span>
                    </div>
                  </td>
                  <td>
                    <select value={r.role} onChange={e => updateRole(r.user_id, e.target.value)}
                      style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid #ddd', fontSize: '0.85rem' }}>
                      <option value="employee">👤 עובד</option>
                      <option value="admin">👑 מנהל</option>
                    </select>
                  </td>
                  <td>
                    <button onClick={() => deleteRole(r.user_id)} className="btn-icon"
                      disabled={r.user_id === user?.id} title={r.user_id === user?.id ? 'לא ניתן להסיר את עצמך' : ''}>
                      🗑️
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">אין תפקידים. כל המשתמשים מקבלים גישת עובד.</div>
      )}

      {user && (
        <div style={{ marginTop: '12px', padding: '10px 14px', background: '#F0FDF4', borderRadius: '8px', fontSize: '0.8rem', color: '#065F46', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>🔑 ה-User ID שלך:</span>
          <code style={{ background: '#DCFCE7', padding: '2px 8px', borderRadius: '4px', flex: 1 }}>{user.id}</code>
          <button onClick={() => { navigator.clipboard.writeText(user.id); showToast('✅ הועתק!'); }}
            className="btn-small">📋</button>
        </div>
      )}
    </Section>
  );
}

// ── Telegram ──────────────────────────────────────────────────────────────────
function TelegramSection({ user, showToast }) {
  const [telegram,      setTelegram]      = useState({ botToken: '', chatId: '' });
  const [telegramSaved, setTelegramSaved] = useState(false);
  const [testing,       setTesting]       = useState(false);

  useEffect(() => {
    const saved = getTelegramSettings();
    if (saved.botToken || saved.chatId) setTelegram(saved);
  }, []);

  const save = () => {
    saveTelegramSettings(telegram);
    setTelegramSaved(true);
    setTimeout(() => setTelegramSaved(false), 2000);
    showToast('✅ הגדרות טלגרם נשמרו!');
  };

  const test = async () => {
    if (!telegram.botToken || !telegram.chatId) { showToast('⚠️ נא למלא טוקן וצ\'אט ID', 'warning'); return; }
    setTesting(true);
    try {
      await sendTelegramMessage(telegram.botToken, telegram.chatId, '✅ CoffeeFlow מחובר לטלגרם! 🎉');
      showToast('✅ הודעת בדיקה נשלחה!');
    } catch (err) {
      showToast(`❌ שגיאת טלגרם: ${err.message}`, 'error');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Section title="📱 חיבור טלגרם" description="הגדר בוט לקבלת התראות ולניהול לקוחות ממתינים מהקבוצה.">
      {user && (
        <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '8px', padding: '10px 14px', marginBottom: '1rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: '#065F46' }}>🔑 ה-User ID שלך:</span>
          <code style={{ background: '#DCFCE7', padding: '2px 8px', borderRadius: '4px', flex: 1 }}>{user.id}</code>
          <button onClick={() => { navigator.clipboard.writeText(user.id); showToast('✅ הועתק!'); }} className="btn-small">📋</button>
        </div>
      )}

      <div style={{ background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: '8px', padding: '1rem', marginBottom: '1rem', fontSize: '0.85rem', color: '#0369A1' }}>
        <strong>הגדרת הבוט:</strong>
        <ol style={{ margin: '0.5rem 0 0 1.2rem', lineHeight: 2 }}>
          <li>שמור Bot Token ו-Chat ID למטה</li>
          <li>פתח <strong>Supabase → Edge Functions → Secrets</strong> והוסף:
            <ul style={{ marginRight: '1rem' }}>
              <li><code>TELEGRAM_BOT_TOKEN</code></li>
              <li><code>TELEGRAM_CHAT_ID</code></li>
              <li><code>COFFEEFLOW_USER_ID</code> = ה-User ID למעלה</li>
            </ul>
          </li>
          <li>הרץ פעם אחת:<br/>
            <code style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>
              curl "https://api.telegram.org/bot{'<TOKEN>'}/setWebhook?url=https://{'<PROJECT>'}.supabase.co/functions/v1/telegram-bot"
            </code>
          </li>
        </ol>
        <div style={{ marginTop: '0.75rem', padding: '0.5rem', background: '#E0F2FE', borderRadius: '6px' }}>
          <strong>פקודות בקבוצה:</strong>
          <div><code>/task ירון, מקינטה מוקה 387874, 054-7373737</code></div>
          <div><code>/tasks</code> — רשימת ממתינים | <code>/done 2</code> — סמן #2 כטופל</div>
        </div>
      </div>

      <div className="form-card">
        <div className="form-group">
          <label>Bot Token</label>
          <input type="text" placeholder="1234567890:AAF..."
            value={telegram.botToken} onChange={e => setTelegram({ ...telegram, botToken: e.target.value })}
            style={{ fontFamily: 'monospace' }} />
        </div>
        <div className="form-group">
          <label>Chat ID</label>
          <input type="text" placeholder="-1001234567890"
            value={telegram.chatId} onChange={e => setTelegram({ ...telegram, chatId: e.target.value })}
            style={{ fontFamily: 'monospace' }} />
        </div>
        <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
          <button onClick={save} className="btn-primary" style={{ flex: 1 }}>
            {telegramSaved ? '✅ נשמר!' : '💾 שמור'}
          </button>
          <button onClick={test} disabled={testing} className="btn-small" style={{ flex: 1 }}>
            {testing ? '⏳ שולח...' : '📨 בדוק'}
          </button>
        </div>
      </div>
    </Section>
  );
}

// ── Main Settings ─────────────────────────────────────────────────────────────
export default function Settings() {
  const { data, operatorsDb, roastsDb, costSettings, updateCostSettings, showToast, user } = useApp();
  const [activeCategory, setActiveCategory] = useState('operators');

  return (
    <div className="page" style={{ padding: 0 }}>
      <div style={{ display: 'flex', height: 'calc(100vh - 70px)', overflow: 'hidden' }}>

        {/* Sidebar */}
        <div style={{
          width: 200,
          background: '#f7f2ea',
          borderLeft: '1px solid #e4d8c8',
          padding: '24px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          flexShrink: 0,
          overflowY: 'auto',
        }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#aaa', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8, paddingRight: 8 }}>
            הגדרות
          </div>
          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '9px 12px', borderRadius: 10, border: 'none',
                cursor: 'pointer', fontSize: '0.88rem', fontWeight: 600,
                textAlign: 'right', width: '100%',
                background: activeCategory === cat.id ? '#2c1a0e' : 'transparent',
                color: activeCategory === cat.id ? '#f7f2ea' : '#555',
                transition: 'all 0.15s',
              }}
            >
              <span>{cat.icon}</span>
              <span>{cat.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '32px 36px', direction: 'rtl' }}>
          {activeCategory === 'operators' && (
            <OperatorsSection data={data} operatorsDb={operatorsDb} roastsDb={roastsDb} showToast={showToast} />
          )}
          {activeCategory === 'costs' && (
            <CostsSection costSettings={costSettings} updateCostSettings={updateCostSettings} />
          )}
          {activeCategory === 'roast' && <RoastProfiles />}
          {activeCategory === 'roles' && <RolesSection user={user} showToast={showToast} />}
          {activeCategory === 'telegram' && <TelegramSection user={user} showToast={showToast} />}
        </div>
      </div>
    </div>
  );
}
