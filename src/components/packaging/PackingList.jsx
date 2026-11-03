import React, { useState } from 'react';
import { useApp } from '../../lib/context';
import { supabase } from '../../lib/supabase';
import {
  COVER_DAYS, LOOKBACK_DAYS, packingList, reservedBagsByProduct, whatsappDigits,
} from '../../lib/reservedStock';

const PHONE_KEY = 'packing_whatsapp_number';

// "What do we pack for the store?" — bags needed so store stock (packed minus
// B2B allocations) covers COVER_DAYS of café + website sales, then sent as a
// WhatsApp message. Demand comes from the store_bags_sold RPC (MFlow lines,
// B2B excluded) plus a B2B forecast (b2b_bags_sold), averaged over LOOKBACK_DAYS.
export default function PackingList() {
  const { data, appSettingsDb, showToast } = useApp();

  const phoneRow = data.appSettings.find(s => s.key === PHONE_KEY);
  const [phone,   setPhone]   = useState(null);   // null = not edited, show saved value
  const [rows,    setRows]    = useState(null);
  const [loading, setLoading] = useState(false);

  const phoneValue = phone ?? phoneRow?.value ?? '';

  const build = async () => {
    setLoading(true);
    try {
      const [store, b2b] = await Promise.all([
        supabase.rpc('store_bags_sold', { p_days: LOOKBACK_DAYS }),
        supabase.rpc('b2b_bags_sold',   { p_days: LOOKBACK_DAYS }),
      ]);
      if (store.error) throw store.error;
      if (b2b.error)   throw b2b.error;
      const byProduct = rows => Object.fromEntries((rows || []).map(r => [r.product_id, Number(r.bags) || 0]));
      setRows(packingList(data.products, reservedBagsByProduct(data.bagAllocations), byProduct(store.data), byProduct(b2b.data)));
    } catch (err) {
      console.error('store_bags_sold', err);
      showToast('❌ לא הצלחנו לטעון את נתוני המכירות', 'error');
    } finally {
      setLoading(false);
    }
  };

  const savePhone = async () => {
    const value = phoneValue.trim();
    if (value === (phoneRow?.value ?? '')) return;
    try {
      if (phoneRow) await appSettingsDb.update(phoneRow.id, { value, updated_at: new Date().toISOString() });
      else          await appSettingsDb.insert({ key: PHONE_KEY, value });
      setPhone(null);
    } catch {
      showToast('❌ שגיאה בשמירת המספר', 'error');
    }
  };

  const message = () => [
    `📦 רשימת אריזה למלאי החנות (${COVER_DAYS} ימים)`,
    new Date().toLocaleDateString('he-IL'),
    '',
    ...rows.map(r => `• ${r.product.name} ${r.product.size}g: ${r.toPack} שקיות${r.b2bTarget > 0 || r.allocated > 0 ? ' (כולל B2B)' : ''}`),
    '',
    `סה"כ: ${rows.reduce((s, r) => s + r.toPack, 0)} שקיות`,
  ].join('\n');

  const sendWhatsapp = () => {
    const digits = whatsappDigits(phoneValue);
    if (digits.length < 11) { showToast('⚠️ נא להזין מספר וואטסאפ תקין', 'warning'); return; }
    // Open first: a window.open after an await loses the click and gets popup-blocked.
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(message())}`, '_blank');
    savePhone();
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0 }}>📝 מה לארוז לחנות</h3>
          <div style={{ fontSize: '12px', color: '#6B7280', marginTop: 4 }}>
            מלאי ל-{COVER_DAYS} ימים לפי ממוצע המכירות ב-{LOOKBACK_DAYS} הימים האחרונים: חנות ואתר, ובנפרד צפי B2B
          </div>
        </div>
        <button onClick={build} disabled={loading} style={primaryBtn}>
          {loading ? '⏳ מחשב...' : '📋 צור רשימת אריזה'}
        </button>
      </div>

      {rows && (
        <div style={{ marginTop: '1rem' }}>
          {rows.length === 0 ? (
            <div style={{ color: '#059669', fontWeight: 600 }}>✓ יש מספיק שקיות ל-{COVER_DAYS} ימים</div>
          ) : (
            <>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ color: '#6B7280', textAlign: 'right' }}>
                    <th style={th}>מוצר</th><th style={th}>בחנות</th><th style={th}>יעד חנות</th><th style={th}>צפי B2B</th><th style={th}>לארוז</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.product.id} style={{ borderTop: '1px solid #F4E8D8' }}>
                      <td style={{ ...td, overflowWrap: 'anywhere' }}>{r.product.name} {r.product.size}g</td>
                      <td style={td}>{r.stock}</td>
                      <td style={td}>{r.target}</td>
                      <td style={td}>{r.b2bTarget}{r.allocated > 0 && <span style={{ color: '#9CA3AF' }}> ({r.allocated} מוקצות)</span>}</td>
                      <td style={{ ...td, fontWeight: 700, color: '#6b3a1f' }}>{r.toPack}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
                <input
                  style={{ ...input, flex: '1 1 180px' }}
                  type="tel"
                  placeholder="מספר וואטסאפ (למשל 0501234567)"
                  value={phoneValue}
                  onChange={e => setPhone(e.target.value)}
                  onBlur={savePhone}
                />
                <button onClick={sendWhatsapp} style={{ ...primaryBtn, background: '#25D366' }}>💬 שלח בוואטסאפ</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const card = { background: '#FFF9F0', border: '1px solid #E8D5B7', borderRadius: 10, padding: '1rem 1.1rem', marginBottom: '1.5rem' };
const input = {
  padding: '0.45rem 0.65rem', border: '1px solid #E8D5B7', borderRadius: 8,
  fontSize: '0.9rem', fontFamily: 'inherit', background: 'white', boxSizing: 'border-box', direction: 'ltr', textAlign: 'right',
};
const primaryBtn = { background: '#6b3a1f', color: 'white', border: 'none', borderRadius: 8, padding: '0.5rem 1.2rem', cursor: 'pointer', fontWeight: 600 };
const th = { padding: '4px 6px', fontWeight: 600 };
const td = { padding: '6px' };
