import React, { useState } from 'react';
import { ClipboardList, MessageCircle, CircleCheck } from 'lucide-react';
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
      showToast('לא הצלחנו לטעון את נתוני המכירות', 'error');
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
      showToast('שגיאה בשמירת המספר', 'error');
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
    if (digits.length < 11) { showToast('נא להזין מספר וואטסאפ תקין', 'warning'); return; }
    // Open first: a window.open after an await loses the click and gets popup-blocked.
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(message())}`, '_blank');
    savePhone();
  };

  return (
    <section className="card flush">
      <div className="card-head">
        <h2>מה לארוז לחנות</h2>
        <button type="button" className="btn sm" onClick={build} disabled={loading}>
          <ClipboardList aria-hidden="true" />
          {loading ? 'מחשב...' : 'יצירת רשימת אריזה'}
        </button>
      </div>
      <div className="card-body pack-list-intro text-muted">
        מלאי ל־{COVER_DAYS} ימים לפי ממוצע המכירות ב־{LOOKBACK_DAYS} הימים האחרונים: חנות ואתר, ובנפרד צפי B2B
      </div>

      {rows && (
        rows.length === 0 ? (
          <div className="card-body pack-list-body">
            <div className="notice ok">
              <CircleCheck size={18} aria-hidden="true" />
              <span>יש מספיק שקיות ל־{COVER_DAYS} ימים</span>
            </div>
          </div>
        ) : (
          <>
            <div className="pack-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>מוצר</th>
                    <th className="end">בחנות</th>
                    <th className="end">יעד חנות</th>
                    <th className="end">צפי B2B</th>
                    <th className="end">לארוז</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.product.id}>
                      <td className="pack-td-name">{r.product.name} <span className="pack-size">{r.product.size}g</span></td>
                      <td className="end">{r.stock}</td>
                      <td className="end">{r.target}</td>
                      <td className="end">
                        {r.b2bTarget}
                        {r.allocated > 0 && <span className="pack-allocated"> ({r.allocated} מוקצות)</span>}
                      </td>
                      <td className="end pack-topack">{r.toPack}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card-body pack-send">
              <input
                className="pack-phone"
                type="tel"
                aria-label="מספר וואטסאפ לשליחת הרשימה"
                placeholder="מספר וואטסאפ (למשל 0501234567)"
                value={phoneValue}
                onChange={e => setPhone(e.target.value)}
                onBlur={savePhone}
              />
              <button type="button" className="btn primary" onClick={sendWhatsapp}>
                <MessageCircle aria-hidden="true" />
                שליחה בוואטסאפ
              </button>
            </div>
          </>
        )
      )}
    </section>
  );
}
