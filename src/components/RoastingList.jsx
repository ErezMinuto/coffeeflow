import React, { useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.REACT_APP_SUPABASE_URL,
  process.env.REACT_APP_SUPABASE_ANON_KEY
);

const DEFAULT_ROAST_KG = 15;

  export default function RoastingList({ data, originsDb, roastsDb, showToast }) {
  const [checked, setChecked] = useState({});
  const [amounts, setAmounts] = useState({});
  const [notes, setNotes] = useState({});
  const [saving, setSaving] = useState(false);

  const userId = data.origins[0]?.user_id;

  // Calculate which origins need roasting
  const roastingNeeded = data.origins
    .map(origin => {
      const daily = origin.daily_average || 0;
      const critical = daily * 7;
      const current = origin.roasted_stock || 0;
      const needed = critical - current;
      return { ...origin, critical_stock: critical, needed };
    })
    .filter(o => o.needed > 0)
    .sort((a, b) => b.needed - a.needed);

  const toggleCheck = (id) => {
    setChecked(prev => ({ ...prev, [id]: !prev[id] }));
    if (!amounts[id]) {
      setAmounts(prev => ({ ...prev, [id]: DEFAULT_ROAST_KG }));
    }
  };

  const confirmRoasting = async () => {
    const toRoast = roastingNeeded.filter(o => checked[o.id]);
    if (toRoast.length === 0) {
      showToast('לא נבחרו זנים לקלייה', 'warning');
      return;
    }

    setSaving(true);
    const syncTime = new Date().toISOString();
    let success = 0;

    for (const origin of toRoast) {
      const greenKg = parseFloat(amounts[origin.id] || DEFAULT_ROAST_KG);
      const yieldPercent = 1 - (origin.weight_loss / 100);
      const roastedKg = greenKg * yieldPercent;
      const newRoastedStock = (origin.roasted_stock || 0) + roastedKg;
      const newGreenStock = (origin.stock || 0) - greenKg;

      if (newGreenStock < 0) {
        showToast(`אין מספיק מלאי ירוק ל${origin.name}`, 'error');
        continue;
      }

      try {
        // Update origin stock
        await originsDb.update(origin.id, {
          roasted_stock: newRoastedStock,
          stock: newGreenStock
        });

        // Save roasting session
        await supabase.from('roasts').insert({
          origin_id: origin.id,
          green_weight: greenKg,
          roasted_weight: parseFloat(roastedKg),
          operator: 'מנהל קלייה',
          date: syncTime,
          user_id: userId
        });
        success++;
      } catch (err) {
        showToast('שגיאה ב' + origin.name + ': ' + err.message, 'error');
      }
    }

    await originsDb.refresh();
    await roastsDb.refresh();
    setSaving(false);
    setChecked({});
    setAmounts({});
    setNotes({});
    showToast(`✅ ${success} קליות נרשמו בהצלחה!`);
  };

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1>📋 רשימת קלייה</h1>
        {Object.values(checked).some(Boolean) && (
          <button
            onClick={confirmRoasting}
            disabled={saving}
            className="btn-primary"
            style={{ background: '#6F4E37' }}
          >
            {saving ? '⏳ שומר...' : `✅ אשר קלייה (${Object.values(checked).filter(Boolean).length})`}
          </button>
        )}
      </div>

      {roastingNeeded.length === 0 ? (
        <div className="empty-state">
          <h3>✅ אין צורך בקלייה כרגע</h3>
          <p>כל הזנים מעל המלאי הקריטי</p>
          <p style={{ fontSize: '0.85rem', color: '#999', marginTop: '0.5rem' }}>
            כדי שהמערכת תדע מתי לקלות, הגדר ממוצע מכירות יומי לכל זן בדף הזנים
          </p>
        </div>
      ) : (
        <>
          <p style={{ color: '#666', marginBottom: '1.5rem' }}>
            {roastingNeeded.length} זנים צריכים קלייה. סמן את מה שתקלה היום.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {roastingNeeded.map(origin => {
              const isChecked = !!checked[origin.id];
              const greenKg = parseFloat(amounts[origin.id] || DEFAULT_ROAST_KG);
              const yieldPercent = 1 - (origin.weight_loss / 100);
              const roastedKg = (greenKg * yieldPercent).toFixed(1);

              return (
                <div
                  key={origin.id}
                  style={{
                    background: isChecked ? '#F0FDF4' : 'white',
                    border: isChecked ? '2px solid #10B981' : '1px solid #E5E7EB',
                    borderRadius: '12px',
                    padding: '1.25rem',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                  onClick={() => toggleCheck(origin.id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleCheck(origin.id)}
                      onClick={e => e.stopPropagation()}
                      style={{ width: '20px', height: '20px', cursor: 'pointer' }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong style={{ fontSize: '1.1rem' }}>{origin.name}</strong>
                        <span style={{ background: '#FEE2E2', color: '#DC2626', padding: '0.2rem 0.6rem', borderRadius: '6px', fontSize: '0.85rem', fontWeight: 'bold' }}>
                          חסר {origin.needed.toFixed(1)} ק"ג
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem', fontSize: '0.875rem', color: '#666' }}>
                        <span>מלאי קלוי: <strong>{(origin.roasted_stock || 0).toFixed(1)} ק"ג</strong></span>
                        <span>מלאי קריטי: <strong>{origin.critical_stock.toFixed(1)} ק"ג</strong></span>
                        <span>מלאי ירוק: <strong>{(origin.stock || 0).toFixed(1)} ק"ג</strong></span>
                      </div>
                    </div>
                  </div>

                  {isChecked && (
                    <div
                      style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #D1FAE5' }}
                      onClick={e => e.stopPropagation()}
                    >
                      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        <div className="form-group" style={{ margin: 0 }}>
                          <label>משקל ירוק לקלייה (ק"ג)</label>
                          <input
                            type="number"
                            step="0.5"
                            value={amounts[origin.id] || DEFAULT_ROAST_KG}
                            onChange={e => setAmounts(prev => ({ ...prev, [origin.id]: e.target.value }))}
                            style={{ width: '120px' }}
                          />
                        </div>
                        <div style={{ fontSize: '0.875rem', color: '#059669', paddingBottom: '0.5rem' }}>
                          → {roastedKg} ק"ג קלוי ({origin.weight_loss}% איבוד)
                        </div>
                        <div className="form-group" style={{ margin: 0, flex: 1 }}>
                          <label>הערות (אופציונלי)</label>
                          <input
                            type="text"
                            placeholder="למשל: דלי #1234"
                            value={notes[origin.id] || ''}
                            onChange={e => setNotes(prev => ({ ...prev, [origin.id]: e.target.value }))}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div style={{ marginTop: '2rem', padding: '1rem', background: '#FFF9F0', borderRadius: '8px', border: '1px solid #F4E8D8' }}>
        <p style={{ fontSize: '0.875rem', color: '#666', margin: 0 }}>
          💡 כדי שרשימה זו תעבוד נכון, הגדר <strong>ממוצע מכירות יומי</strong> לכל זן.
          ניתן לערוך זאת בדף הזנים (לחיצה על ✏️).
        </p>
      </div>
    </div>
  );
}
