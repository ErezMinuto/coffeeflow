import React, { useState, useEffect } from 'react';
import { useApp } from '../../lib/context';
import RoastProfiles from './RoastProfiles';
import { getTelegramSettings, saveTelegramSettings, sendTelegramMessage } from '../../lib/telegram';

export default function Settings() {
  const { data, operatorsDb, roastsDb, costSettings, updateCostSettings, showToast, user } = useApp();

  const [newOperator,     setNewOperator]     = useState('');
  const [editingOperator, setEditingOperator] = useState(null);
  const [telegram,        setTelegram]        = useState({ botToken: '', chatId: '' });
  const [telegramSaved,   setTelegramSaved]   = useState(false);
  const [telegramTesting, setTelegramTesting] = useState(false);

  useEffect(() => {
    const saved = getTelegramSettings();
    if (saved.botToken || saved.chatId) setTelegram(saved);
  }, []);

  const saveTelegram = () => {
    saveTelegramSettings(telegram);
    setTelegramSaved(true);
    setTimeout(() => setTelegramSaved(false), 2000);
    showToast('✅ הגדרות טלגרם נשמרו!');
  };

  const testTelegram = async () => {
    if (!telegram.botToken || !telegram.chatId) { showToast('⚠️ נא למלא טוקן וצ\'אט ID', 'warning'); return; }
    setTelegramTesting(true);
    try {
      await sendTelegramMessage(telegram.botToken, telegram.chatId, '✅ CoffeeFlow מחובר בהצלחה לטלגרם! 🎉');
      showToast('✅ הודעת בדיקה נשלחה לטלגרם!');
    } catch (err) {
      showToast(`❌ שגיאת טלגרם: ${err.message}`, 'error');
    } finally {
      setTelegramTesting(false);
    }
  };

  // ── OPERATORS ─────────────────────────────────────────────────────────────────

  const addOperator = async () => {
    if (!newOperator.trim()) return;
    try {
      await operatorsDb.insert({ name: newOperator.trim() });
      setNewOperator('');
      showToast('✅ מפעיל נוסף!');
    } catch (error) {
      console.error('Error adding operator:', error);
      showToast('❌ שגיאה בהוספת מפעיל', 'error');
    }
  };

  const saveEditOperator = async () => {
    if (!editingOperator.name.trim()) { showToast('⚠️ נא למלא שם מפעיל', 'warning'); return; }
    try {
      await operatorsDb.update(editingOperator.id, { name: editingOperator.name.trim() });
      // Cascade name change to all roasts
      const oldOperator = data.operators.find(op => op.id === editingOperator.id);
      if (oldOperator && oldOperator.name !== editingOperator.name.trim()) {
        for (const roast of data.roasts.filter(r => r.operator === oldOperator.name)) {
          await roastsDb.update(roast.id, { operator: editingOperator.name.trim() });
        }
      }
      setEditingOperator(null);
      showToast('✅ מפעיל עודכן!');
    } catch (error) {
      console.error('Error updating operator:', error);
      showToast('❌ שגיאה בעדכון מפעיל', 'error');
    }
  };

  const deleteOperator = async (operator) => {
    const roastCount = data.roasts.filter(r => r.operator === operator.name).length;
    if (roastCount > 0) {
      if (!window.confirm(`⚠️ למפעיל "${operator.name}" יש ${roastCount} קליות.\n\nהקליות יישארו עם השם שלו.\n\nהאם למחוק את המפעיל מהרשימה?`)) return;
    } else {
      if (!window.confirm(`האם למחוק את המפעיל "${operator.name}"?`)) return;
    }
    try {
      await operatorsDb.remove(operator.id);
      showToast('✅ מפעיל נמחק!');
    } catch (error) {
      console.error('Error deleting operator:', error);
      showToast('❌ שגיאה במחיקת מפעיל', 'error');
    }
  };

  // ── RENDER ────────────────────────────────────────────────────────────────────

  return (
    <div className="page">
      <h1>⚙️ Settings</h1>

      {/* Operators */}
      <div className="section">
        <h2>👥 ניהול מפעילים ({data.operators.length})</h2>

        <div className="form-card">
          <div style={{ display: 'flex', gap: '10px' }}>
            <input
              type="text"
              placeholder="שם מפעיל חדש..."
              value={newOperator}
              onChange={e => setNewOperator(e.target.value)}
              onKeyPress={e => e.key === 'Enter' && addOperator()}
              style={{ flex: 1 }}
            />
            <button onClick={addOperator} className="btn-primary">➕ הוסף מפעיל</button>
          </div>
        </div>

        {editingOperator && (
          <div className="form-card" style={{ background: '#FFF9F0', border: '2px solid #FF6B35', marginTop: '15px' }}>
            <h3>✏️ עריכת מפעיל</h3>
            <input type="text" value={editingOperator.name} onChange={e => setEditingOperator({...editingOperator, name: e.target.value})} />
            <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
              <button onClick={saveEditOperator} className="btn-primary" style={{ flex: 1 }}>💾 שמור</button>
              <button onClick={() => setEditingOperator(null)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
            </div>
          </div>
        )}

        <div className="table-container" style={{ marginTop: '15px' }}>
          <table className="data-table">
            <thead>
              <tr><th>שם</th><th>מספר קליות</th><th>פעולות</th></tr>
            </thead>
            <tbody>
              {data.operators.map(operator => {
                const roastCount = data.roasts.filter(r => r.operator === operator.name).length;
                return (
                  <tr key={operator.id}>
                    <td><strong>{operator.name}</strong></td>
                    <td>{roastCount}</td>
                    <td>
                      <div className="action-buttons">
                        <button onClick={() => setEditingOperator({ ...operator })} className="btn-icon">✏️</button>
                        <button onClick={() => deleteOperator(operator)} className="btn-icon">🗑️</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {data.operators.length === 0 && <div className="empty-state">אין מפעילים. הוסף מפעיל ראשון!</div>}
      </div>

      {/* Cost settings */}
      <div className="section" style={{ marginTop: '2rem' }}>
        <h2>💰 הגדרות עלויות</h2>
        <p style={{ color: '#666', marginBottom: '1rem' }}>
          ניתן לערוך את העלויות הקבועות כאן. השינויים ישפיעו על חישוב עלויות המוצרים.
        </p>

        {costSettings ? (
          <div className="form-card">
            <div className="form-grid">
              <div className="form-group">
                <label>שקית 330g (₪)</label>
                <input type="number" step="0.01" value={costSettings.bag_330g} onChange={async e => { await updateCostSettings({ bag_330g: parseFloat(e.target.value) }); }} />
              </div>
              <div className="form-group">
                <label>שקית 250g (₪)</label>
                <input type="number" step="0.01" value={costSettings.bag_250g ?? 0.60} onChange={async e => { await updateCostSettings({ bag_250g: parseFloat(e.target.value) }); }} />
              </div>
              <div className="form-group">
                <label>שקית 1kg (₪)</label>
                <input type="number" step="0.01" value={costSettings.bag_1000g ?? 2.00} onChange={async e => { await updateCostSettings({ bag_1000g: parseFloat(e.target.value) }); }} />
              </div>
              <div className="form-group">
                <label>מדבקה (₪)</label>
                <input type="number" step="0.01" value={costSettings.label} onChange={async e => { await updateCostSettings({ label: parseFloat(e.target.value) }); }} />
              </div>
              <div className="form-group">
                <label>גז לקלייה (₪)</label>
                <input type="number" step="0.01" value={costSettings.gas_per_roast} onChange={async e => { await updateCostSettings({ gas_per_roast: parseFloat(e.target.value) }); }} />
              </div>
              <div className="form-group">
                <label>שכר/שעה (₪)</label>
                <input type="number" step="1" value={costSettings.labor_per_hour} onChange={async e => { await updateCostSettings({ labor_per_hour: parseFloat(e.target.value) }); }} />
              </div>
              <div className="form-group">
                <label>זמן קלייה (דק׳)</label>
                <input type="number" step="1" value={costSettings.roasting_time_minutes} onChange={async e => { await updateCostSettings({ roasting_time_minutes: parseFloat(e.target.value) }); }} />
              </div>
              <div className="form-group">
                <label>זמן אריזה (דק׳)</label>
                <input type="number" step="0.1" value={costSettings.packaging_time_minutes} onChange={async e => { await updateCostSettings({ packaging_time_minutes: parseFloat(e.target.value) }); }} />
              </div>
            </div>
            <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: '#666' }}>💾 השינויים נשמרים אוטומטית</p>
          </div>
        ) : (
          <div className="empty-state">טוען הגדרות...</div>
        )}
      </div>

      {/* Telegram */}
      <div className="section" style={{ marginTop: '2rem' }}>
        <h2>📱 חיבור טלגרם</h2>
        <p style={{ color: '#666', marginBottom: '1rem' }}>
          הגדר בוט טלגרם לקבלת התראות וכדי לאפשר לצוות להוסיף לקוחות ממתינים ישירות מהקבוצה.
        </p>

        {/* User ID copy box */}
        {user && (
          <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '8px', padding: '1rem', marginBottom: '1rem', fontSize: '0.875rem' }}>
            <strong style={{ color: '#065F46' }}>🔑 ה-User ID שלך (נדרש להגדרת הבוט):</strong>
            <div style={{ display: 'flex', gap: '8px', marginTop: '6px', alignItems: 'center' }}>
              <code style={{ background: '#DCFCE7', padding: '4px 10px', borderRadius: '4px', fontSize: '0.8rem', flex: 1, wordBreak: 'break-all' }}>
                {user.id}
              </code>
              <button
                onClick={() => { navigator.clipboard.writeText(user.id); showToast('✅ User ID הועתק!'); }}
                className="btn-small"
              >📋 העתק</button>
            </div>
          </div>
        )}

        <div style={{ background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: '8px', padding: '1rem', marginBottom: '1rem', fontSize: '0.875rem', color: '#0369A1' }}>
          <strong>איך מגדירים את הבוט לקבלת פקודות מהקבוצה:</strong>
          <ol style={{ margin: '0.5rem 0 0 1.2rem', lineHeight: '2' }}>
            <li>שמור את ה-Bot Token וה-Chat ID למטה</li>
            <li>פתח <strong>Supabase → Edge Functions → Secrets</strong> והוסף:
              <ul style={{ marginTop: '4px', marginRight: '1rem' }}>
                <li><code>TELEGRAM_BOT_TOKEN</code> = ה-token של הבוט</li>
                <li><code>TELEGRAM_CHAT_ID</code> = ה-Chat ID של הקבוצה</li>
                <li><code>COFFEEFLOW_USER_ID</code> = ה-User ID שלמעלה</li>
              </ul>
            </li>
            <li>הרץ פעם אחת בטרמינל: <br/>
              <code style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>
                curl "https://api.telegram.org/bot{'<TOKEN>'}/setWebhook?url=https://{'<PROJECT>'}.supabase.co/functions/v1/telegram-bot"
              </code>
            </li>
          </ol>
          <div style={{ marginTop: '0.75rem', padding: '0.5rem', background: '#E0F2FE', borderRadius: '6px' }}>
            <strong>פקודות בקבוצה:</strong>
            <div><code>/task ירון מנחם, מקינטה מוקה מקט 387874, טלפון 054-7373737</code></div>
            <div><code>/tasks</code> — רשימת ממתינים</div>
            <div><code>/done 2</code> — סמן #2 כטופל</div>
          </div>
        </div>
        <div className="form-card">
          <div className="form-group">
            <label>Bot Token</label>
            <input
              type="text" placeholder="1234567890:AAF..."
              value={telegram.botToken}
              onChange={e => setTelegram({ ...telegram, botToken: e.target.value })}
              style={{ fontFamily: 'monospace' }}
            />
          </div>
          <div className="form-group">
            <label>Chat ID (קבוצת הצוות)</label>
            <input
              type="text" placeholder="-1001234567890"
              value={telegram.chatId}
              onChange={e => setTelegram({ ...telegram, chatId: e.target.value })}
              style={{ fontFamily: 'monospace' }}
            />
          </div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
            <button onClick={saveTelegram} className="btn-primary" style={{ flex: 1 }}>
              {telegramSaved ? '✅ נשמר!' : '💾 שמור הגדרות'}
            </button>
            <button onClick={testTelegram} disabled={telegramTesting} className="btn-small" style={{ flex: 1 }}>
              {telegramTesting ? '⏳ שולח...' : '📨 שלח הודעת בדיקה'}
            </button>
          </div>
        </div>
      </div>

      {/* Brevo Marketing */}
      <div className="section" style={{ marginTop: '2rem' }}>
        <h2>📧 Brevo Marketing</h2>
        <p style={{ color: '#666', marginBottom: '1rem' }}>
          הגדר את Brevo לשליחת קמפיינים במייל ו-WhatsApp לאנשי הקשר שלך.
        </p>

        <div style={{ background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: '8px', padding: '1rem', marginBottom: '1rem', fontSize: '0.875rem', color: '#0369A1' }}>
          <strong>איך מגדירים:</strong>
          <ol style={{ margin: '0.5rem 0 0 1.2rem', lineHeight: '2' }}>
            <li>הירשם ל-<a href="https://www.brevo.com" target="_blank" rel="noopener noreferrer" style={{ color: '#0369A1', fontWeight: 600 }}>Brevo</a> וצור חשבון</li>
            <li>צור API Key ב-<strong>Settings → SMTP & API → API Keys</strong></li>
            <li>פתח <strong>Supabase → Edge Functions → Secrets</strong> והוסף:
              <ul style={{ marginTop: '4px', marginRight: '1rem' }}>
                <li><code>BREVO_API_KEY</code> = ה-API Key מ-Brevo</li>
              </ul>
            </li>
            <li>ודא שיש לך Sender Domain מאומת ב-Brevo</li>
          </ol>
        </div>

        <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '8px', padding: '1rem', fontSize: '0.875rem', color: '#065F46' }}>
          <strong>✅ לאחר ההגדרה:</strong> עבור לדף <strong>Marketing</strong> בתפריט כדי לייבא אנשי קשר, ליצור קמפיינים ולשלוח הודעות.
        </div>
      </div>

      {/* Roast Profiles */}
      <RoastProfiles />
    </div>
  );
}
