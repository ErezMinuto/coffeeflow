import React, { useState } from 'react';
import { useApp } from '../../lib/context';
import { reservedBagsByProduct, storeStock } from '../../lib/reservedStock';

// Set packed bags aside for a B2B customer. An allocation takes its bags out of
// store stock straight away; "נמסר" releases them (the MFlow invoice then takes
// them out of packed_stock). No roasting step — the bags are already packed.
export default function B2BAllocations() {
  const { data, bagAllocationsDb, b2bCustomersDb, showToast } = useApp();

  const [customerId, setCustomerId] = useState('');
  const [productId,  setProductId]  = useState('');
  const [bags,       setBags]       = useState('');
  const [notes,      setNotes]      = useState('');
  const [saving,     setSaving]     = useState(false);
  const [busyId,     setBusyId]     = useState(null);

  const reserved        = reservedBagsByProduct(data.bagAllocations);
  const activeCustomers = data.b2bCustomers.filter(c => c.active).sort((a, b) => a.name.localeCompare(b.name, 'he'));
  const customerById    = Object.fromEntries(data.b2bCustomers.map(c => [c.id, c]));
  const productById     = Object.fromEntries(data.products.map(p => [p.id, p]));
  const product         = productById[parseInt(productId)];
  const count           = parseInt(bags) || 0;
  const free            = product ? storeStock(product, reserved) : null;

  const open = data.bagAllocations.filter(a => a.status === 'allocated');
  const byCustomer = {};
  for (const a of open) (byCustomer[a.customer_id] = byCustomer[a.customer_id] || []).push(a);

  const allocate = async () => {
    if (!customerId)  { showToast('⚠️ נא לבחור לקוח', 'warning'); return; }
    if (!product)     { showToast('⚠️ נא לבחור מוצר', 'warning'); return; }
    if (count <= 0)   { showToast('⚠️ נא להזין כמות שקיות', 'warning'); return; }
    if (count > free) {
      if (!window.confirm(`במלאי החנות רשומות ${free} שקיות בלבד. להקצות ${count} בכל זאת?`)) return;
    }
    setSaving(true);
    try {
      await bagAllocationsDb.insert({
        customer_id: parseInt(customerId),
        product_id:  product.id,
        bags:        count,
        notes:       notes.trim() || null,
      });
      showToast(`✅ ${count} שקיות הוקצו ל${customerById[parseInt(customerId)]?.name}`);
      setProductId(''); setBags(''); setNotes('');
    } catch {
      showToast('❌ שגיאה בהקצאה', 'error');
    } finally {
      setSaving(false);
    }
  };

  const deliver = async (a) => {
    setBusyId(a.id);
    try {
      await bagAllocationsDb.update(a.id, { status: 'delivered', delivered_at: new Date().toISOString() });
      showToast('✅ סומן כנמסר');
    } catch {
      showToast('❌ שגיאה בעדכון', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (a) => {
    if (!window.confirm('לבטל את ההקצאה? השקיות יחזרו למלאי החנות.')) return;
    setBusyId(a.id);
    try {
      await bagAllocationsDb.remove(a.id);
      showToast('ההקצאה בוטלה');
    } catch {
      showToast('❌ שגיאה בביטול', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={card}>
      <h3 style={{ margin: '0 0 0.5rem' }}>🏷️ הקצאת שקיות ללקוחות B2B</h3>
      <div style={{ fontSize: '12px', color: '#6B7280', marginBottom: '0.9rem' }}>
        שקיות שהוקצו לא נספרות במלאי החנות. סימון <b>נמסר</b> משחרר אותן (MFlow מוריד מהמלאי עם החשבונית).
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.6rem', marginBottom: '0.6rem' }}>
        <select style={input} value={customerId} onChange={e => setCustomerId(e.target.value)}>
          <option value="">{activeCustomers.length ? 'בחר לקוח' : 'אין לקוחות. הוסיפו למטה'}</option>
          {activeCustomers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select style={input} value={productId} onChange={e => setProductId(e.target.value)}>
          <option value="">בחר מוצר</option>
          {data.products.map(p => (
            <option key={p.id} value={p.id}>{p.name} {p.size}g ({storeStock(p, reserved)} בחנות)</option>
          ))}
        </select>
        <input style={input} type="number" min="1" placeholder="כמות שקיות" value={bags} onChange={e => setBags(e.target.value)} />
        <input style={input} placeholder="הערה (אופציונלי)" value={notes} onChange={e => setNotes(e.target.value)} />
      </div>
      <button onClick={allocate} disabled={saving} style={primaryBtn}>{saving ? '⏳ שומר...' : '➕ הקצה שקיות'}</button>

      {open.length > 0 && (
        <div style={{ marginTop: '1.2rem' }}>
          {Object.entries(byCustomer).map(([cid, rows]) => (
            <div key={cid} style={{ borderTop: '1px solid #F4E8D8', padding: '0.6rem 0' }}>
              <div style={{ fontWeight: 600, color: '#1a1208', marginBottom: 4 }}>
                {customerById[cid]?.name || 'לקוח לא ידוע'} · {rows.reduce((s, a) => s + a.bags, 0)} שקיות
              </div>
              {rows.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '13px', padding: '2px 0' }}>
                  <span style={{ flex: 1, minWidth: 0, color: '#6b3a1f', overflowWrap: 'anywhere' }}>
                    {productById[a.product_id]?.name || 'מוצר'} {productById[a.product_id]?.size}g × <b>{a.bags}</b>
                    {a.notes && <span style={{ color: '#9CA3AF' }}> · {a.notes}</span>}
                    <span style={{ color: '#9CA3AF' }}> · {new Date(a.created_at).toLocaleDateString('he-IL')}</span>
                  </span>
                  <button onClick={() => deliver(a)} disabled={busyId === a.id} style={{ ...smallBtn, background: '#D1FAE5', color: '#065F46' }}>✓ נמסר</button>
                  <button onClick={() => cancel(a)} disabled={busyId === a.id} style={smallBtn}>ביטול</button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <CustomerList customers={data.b2bCustomers} db={b2bCustomersDb} showToast={showToast} />
    </div>
  );
}

const EMPTY_CUSTOMER = { name: '', contact_name: '', phone: '', email: '', notes: '' };

// The B2B customer list: add, edit, and hide customers who stopped ordering.
// Hidden (not deleted) so their past allocations keep a valid customer_id.
function CustomerList({ customers, db, showToast }) {
  const [open, setOpen]         = useState(false);
  const [form, setForm]         = useState(EMPTY_CUSTOMER);
  const [editingId, setEditing] = useState(null);
  const [saving, setSaving]     = useState(false);

  const sorted = [...customers].sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, 'he'));

  const save = async () => {
    const name = form.name.trim();
    if (!name) { showToast('⚠️ נא להזין שם עסק', 'warning'); return; }
    const dup = customers.find(c => c.id !== editingId && c.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) { showToast(`⚠️ ${dup.name} כבר ברשימה`, 'warning'); return; }

    const row = {
      name,
      contact_name: form.contact_name.trim() || null,
      phone:        form.phone.trim()        || null,
      email:        form.email.trim()        || null,
      notes:        form.notes.trim()        || null,
    };
    setSaving(true);
    try {
      if (editingId) await db.update(editingId, row);
      else           await db.insert(row);
      showToast(editingId ? `✅ ${name} עודכן` : `✅ ${name} נוסף`);
      setForm(EMPTY_CUSTOMER); setEditing(null);
    } catch {
      showToast('❌ שגיאה בשמירת הלקוח', 'error');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (c) => {
    setEditing(c.id);
    setForm({ name: c.name, contact_name: c.contact_name || '', phone: c.phone || '', email: c.email || '', notes: c.notes || '' });
  };

  const toggleActive = async (c) => {
    try { await db.update(c.id, { active: !c.active }); }
    catch { showToast('❌ שגיאה בעדכון', 'error'); }
  };

  const field = (key, label, type = 'text') => (
    <div>
      <label style={label_}>{label}</label>
      <input style={input} type={type} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} />
    </div>
  );

  return (
    <div style={{ borderTop: '1px solid #E8D5B7', marginTop: '1rem' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{ width: '100%', textAlign: 'right', background: 'none', border: 'none', padding: '0.8rem 0', cursor: 'pointer', fontWeight: 600, color: '#6b3a1f', fontSize: '0.9rem' }}
      >
        {open ? '🔼' : '🔽'} לקוחות B2B ({customers.filter(c => c.active).length})
      </button>

      {open && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.6rem', marginBottom: '0.6rem' }}>
            {field('name', 'שם העסק *')}
            {field('contact_name', 'איש/אשת קשר')}
            {field('phone', 'טלפון', 'tel')}
            {field('email', 'אימייל', 'email')}
          </div>
          <div style={{ marginBottom: '0.6rem' }}>{field('notes', 'הערות')}</div>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.8rem' }}>
            <button onClick={save} disabled={saving} style={primaryBtn}>
              {saving ? '⏳' : editingId ? '💾 עדכן לקוח' : '➕ הוסף לקוח'}
            </button>
            {editingId && (
              <button onClick={() => { setEditing(null); setForm(EMPTY_CUSTOMER); }} style={{ ...smallBtn, padding: '0.4rem 1rem' }}>ביטול</button>
            )}
          </div>

          {sorted.map(c => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.45rem 0', borderTop: '1px solid #F4E8D8', opacity: c.active ? 1 : 0.5 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: '#1a1208' }}>{c.name}</div>
                <div style={{ fontSize: '12px', color: '#6B7280', overflowWrap: 'anywhere' }}>
                  {[c.contact_name, c.phone, c.email].filter(Boolean).join(' · ') || 'אין פרטי קשר'}
                </div>
              </div>
              <button onClick={() => startEdit(c)} style={smallBtn}>עריכה</button>
              <button onClick={() => toggleActive(c)} style={smallBtn}>{c.active ? 'הסתר' : 'החזר'}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const card = { background: 'white', border: '1px solid #E8D5B7', borderRadius: 10, padding: '1rem 1.1rem', marginBottom: '1.5rem' };
const input = {
  width: '100%', padding: '0.45rem 0.65rem', border: '1px solid #E8D5B7', borderRadius: 8,
  fontSize: '0.9rem', fontFamily: 'inherit', background: 'white', boxSizing: 'border-box', direction: 'rtl',
};
const label_ = { display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#6b3a1f', marginBottom: 3 };
const primaryBtn = { background: '#6b3a1f', color: 'white', border: 'none', borderRadius: 8, padding: '0.5rem 1.2rem', cursor: 'pointer', fontWeight: 600 };
const smallBtn = {
  fontSize: '0.75rem', padding: '2px 8px', background: 'transparent',
  border: '1px solid #D4A574', borderRadius: 4, cursor: 'pointer', color: '#6F4E37', flexShrink: 0,
};
