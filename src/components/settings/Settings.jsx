import React, { useState, useEffect } from 'react';
import { useApp } from '../../lib/context';
import RoastProfiles from './RoastProfiles';
import { getTelegramSettings, saveTelegramSettings, sendTelegramMessage } from '../../lib/telegram';

export default function Settings() {
  const { data, operatorsDb, roastsDb, costSettings, updateCostSettings, showToast } = useApp();

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
          הגדר בוט טלגרם כדי לקבל התראות על לקוחות ממתינים לאחר כל קלייה.
        </p>
        <div style={{ background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: '8px', padding: '1rem', marginBottom: '1rem', fontSize: '0.875rem', color: '#0369A1' }}>
          <strong>איך מגדירים בוט:</strong>
          <ol style={{ margin: '0.5rem 0 0 1.2rem', lineHeight: '1.8' }}>
            <li>פתחו טלגרם ושלחו הודעה ל<strong>@BotFather</strong></li>
            <li>שלחו <code>/newbot</code> ועקבו אחרי ההוראות</li>
            <li>קבלו את ה-<strong>Bot Token</strong> והדביקו אותו למטה</li>
            <li>הוסיפו את הבוט לקבוצת הצוות</li>
            <li>כדי לקבל את ה-Chat ID: שלחו הודעה לקבוצה, פתחו <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code></li>
          </ol>
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

      {/* Roast Profiles */}
      <RoastProfiles />
    </div>
  );
}
