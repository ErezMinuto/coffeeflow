import React, { useState } from 'react';
import { useApp } from '../../lib/context';
import { RESERVING_STATUS, reservedBagsByProduct } from '../../lib/reservedStock';

const STATUS_CONFIG = {
  pending:   { label: 'ממתין',    color: '#F59E0B', bg: '#FFFBEB' },
  roasting:  { label: 'בקלייה',   color: '#DC2626', bg: '#FEF2F2' },
  ready:     { label: 'מוכן',     color: '#059669', bg: '#ECFDF5' },
  fulfilled: { label: 'הושלם',    color: '#6B7280', bg: '#F3F4F6' },
};

const STATUS_ORDER = ['pending', 'roasting', 'ready', 'fulfilled'];

function nextStatus(current) {
  const idx = STATUS_ORDER.indexOf(current);
  return STATUS_ORDER[(idx + 1) % STATUS_ORDER.length];
}

export default function PendingOrders() {
  const { data, pendingOrdersDb, b2bCustomersDb, showToast } = useApp();

  const [customerId, setCustomerId]     = useState('');
  const [productId, setProductId]       = useState('');
  const [quantityBags, setQuantityBags] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes]               = useState('');
  const [submitting, setSubmitting]     = useState(false);
  const [updatingId, setUpdatingId]     = useState(null);

  const orders = [...(data.pendingOrders || [])]
    .sort((a, b) => {
      const si = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
      if (si !== 0) return si;
      return new Date(b.created_at) - new Date(a.created_at);
    });

  const activeOrders    = orders.filter(o => o.status !== 'fulfilled');
  const fulfilledOrders = orders.filter(o => o.status === 'fulfilled');

  const selectedProduct  = data.products.find(p => p.id === parseInt(productId));
  const activeCustomers  = data.b2bCustomers.filter(c => c.active).sort((a, b) => a.name.localeCompare(b.name, 'he'));
  const selectedCustomer = data.b2bCustomers.find(c => c.id === parseInt(customerId));

  const handleSubmit = async () => {
    if (!selectedCustomer) { showToast('⚠️ נא לבחור לקוח', 'warning'); return; }
    if (!quantityBags || parseInt(quantityBags) <= 0) { showToast('⚠️ נא להזין כמות שקיות', 'warning'); return; }

    setSubmitting(true);
    try {
      await pendingOrdersDb.insert({
        customer_id:   selectedCustomer.id,
        customer_name: selectedCustomer.name,
        product_id:    selectedProduct?.id || null,
        product_name:  selectedProduct ? `${selectedProduct.name} ${selectedProduct.size}g` : 'לא צוין',
        quantity_bags: parseInt(quantityBags),
        expected_date: expectedDate || null,
        notes:         notes.trim() || null,
        status:        'pending',
      });
      showToast(`✅ הזמנה נרשמה: ${selectedCustomer.name}`);
      setCustomerId(''); setProductId(''); setQuantityBags(''); setExpectedDate(''); setNotes('');
    } catch (err) {
      showToast('❌ שגיאה ברישום ההזמנה', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusClick = async (order) => {
    if (updatingId === order.id) return;
    const next = nextStatus(order.status);
    if (next === RESERVING_STATUS && order.product_id) {
      const product  = data.products.find(p => p.id === order.product_id);
      const reserved = reservedBagsByProduct(data.pendingOrders)[order.product_id] || 0;
      const free     = (product?.packed_stock ?? 0) - reserved;
      if (free < order.quantity_bags) {
        showToast(`⚠️ במלאי רשומות רק ${Math.max(0, free)} שקיות פנויות. ודאו שהאריזה דווחה`, 'warning');
      }
    }
    setUpdatingId(order.id);
    try {
      await pendingOrdersDb.update(order.id, { status: next });
    } catch {
      showToast('❌ שגיאה בעדכון סטטוס', 'error');
    } finally {
      setUpdatingId(null);
    }
  };

  const handleDelete = async (order) => {
    if (!window.confirm(`למחוק את הזמנת ${order.customer_name}?`)) return;
    try {
      await pendingOrdersDb.remove(order.id);
      showToast('🗑️ הזמנה נמחקה');
    } catch {
      showToast('❌ שגיאה במחיקה', 'error');
    }
  };

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <h2 style={{ fontFamily: 'serif', color: '#2c1a0e', marginBottom: '1.5rem' }}>
        📋 הזמנות ממתינות
      </h2>

      {/* ── Add Order Form ── */}
      <div style={{ background: '#FFF9F0', border: '1px solid #E8D5B7', borderRadius: 12, padding: '1.25rem', marginBottom: '2rem' }}>
        <h3 style={{ margin: '0 0 1rem', color: '#6b3a1f', fontSize: '1rem' }}>הזמנה חדשה</h3>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
          <div>
            <label style={labelStyle}>לקוח *</label>
            <select style={inputStyle} value={customerId} onChange={e => setCustomerId(e.target.value)}>
              <option value="">{activeCustomers.length ? 'בחר לקוח' : 'אין לקוחות. הוסיפו למטה'}</option>
              {activeCustomers.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>מוצר</label>
            <select style={inputStyle} value={productId} onChange={e => setProductId(e.target.value)}>
              <option value="">בחר מוצר (נדרש לשמירת שקיות)</option>
              {data.products.map(p => (
                <option key={p.id} value={p.id}>{p.name} {p.size}g</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>כמות שקיות *</label>
            <input
              style={inputStyle}
              type="number"
              min="1"
              value={quantityBags}
              onChange={e => setQuantityBags(e.target.value)}
              placeholder="0"
            />
          </div>
          <div>
            <label style={labelStyle}>תאריך אספקה</label>
            <input
              style={inputStyle}
              type="date"
              value={expectedDate}
              onChange={e => setExpectedDate(e.target.value)}
            />
          </div>
        </div>

        <div style={{ marginBottom: '0.75rem' }}>
          <label style={labelStyle}>הערות</label>
          <textarea
            style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="פרטים נוספים..."
          />
        </div>

        <button
          onClick={handleSubmit}
          disabled={submitting}
          style={{
            background: submitting ? '#9CA3AF' : '#2c1a0e',
            color: 'white', border: 'none', borderRadius: 8,
            padding: '0.6rem 1.5rem', cursor: submitting ? 'not-allowed' : 'pointer',
            fontWeight: 600, fontSize: '0.9rem',
          }}
        >
          {submitting ? '⏳ שומר...' : '✅ רשום הזמנה'}
        </button>
      </div>

      <div style={{ fontSize: '0.8rem', color: '#6b3a1f', background: '#F5EDE3', borderRadius: 8, padding: '0.6rem 0.9rem', marginBottom: '1.5rem' }}>
        🏷️ הזמנה בסטטוס <b>מוכן</b> שומרת את השקיות ללקוח: הן לא נספרות במלאי החנות, ולכן המערכת תבקש לארוז לחנות בנפרד.
        סימון <b>הושלם</b> משחרר את השמירה (MFlow מוריד את השקיות מהמלאי עם החשבונית).
      </div>

      <CustomerList customers={data.b2bCustomers} db={b2bCustomersDb} showToast={showToast} />

      {/* ── Active Orders ── */}
      {activeOrders.length === 0 && fulfilledOrders.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#9CA3AF', padding: '2rem' }}>
          אין הזמנות ממתינות
        </div>
      ) : (
        <>
          {activeOrders.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
              {activeOrders.map(order => (
                <OrderCard key={order.id} order={order} onStatusClick={handleStatusClick} onDelete={handleDelete} updatingId={updatingId} />
              ))}
            </div>
          )}

          {/* ── Fulfilled Orders ── */}
          {fulfilledOrders.length > 0 && (
            <>
              <h3 style={{ color: '#9CA3AF', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>הושלמו</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', opacity: 0.6 }}>
                {fulfilledOrders.map(order => (
                  <OrderCard key={order.id} order={order} onStatusClick={handleStatusClick} onDelete={handleDelete} updatingId={updatingId} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function OrderCard({ order, onStatusClick, onDelete, updatingId }) {
  const cfg = STATUS_CONFIG[order.status] || STATUS_CONFIG.pending;
  const isUpdating = updatingId === order.id;

  return (
    <div style={{
      background: 'white',
      border: `1px solid ${cfg.color}33`,
      borderRight: `4px solid ${cfg.color}`,
      borderRadius: 10,
      padding: '0.9rem 1rem',
      display: 'flex',
      alignItems: 'flex-start',
      gap: '1rem',
    }}>
      {/* Status badge — click to advance */}
      <button
        onClick={() => onStatusClick(order)}
        disabled={isUpdating}
        title="לחץ לעדכון סטטוס"
        style={{
          background: cfg.bg,
          color: cfg.color,
          border: `1px solid ${cfg.color}`,
          borderRadius: 20,
          padding: '3px 10px',
          fontSize: '0.75rem',
          fontWeight: 700,
          cursor: isUpdating ? 'wait' : 'pointer',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        {isUpdating ? '...' : cfg.label}
      </button>

      {/* Order details */}
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, color: '#1a1208', fontSize: '0.95rem' }}>{order.customer_name}</span>
          {order.expected_date && (
            <span style={{ fontSize: '0.75rem', color: '#6B7280' }}>
              📅 {new Date(order.expected_date).toLocaleDateString('he-IL')}
            </span>
          )}
        </div>
        <div style={{ fontSize: '0.85rem', color: '#6b3a1f', marginTop: 2 }}>
          {order.product_name} · {order.quantity_bags} שקיות
          {order.status === RESERVING_STATUS && order.product_id && (
            <span style={{ marginRight: 8, fontSize: '0.75rem', color: '#059669' }}>🏷️ שמורות</span>
          )}
        </div>
        {order.notes && (
          <div style={{ fontSize: '0.8rem', color: '#9CA3AF', marginTop: 4 }}>{order.notes}</div>
        )}
      </div>

      {/* Delete */}
      <button
        onClick={() => onDelete(order)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#D1D5DB', fontSize: '1rem', flexShrink: 0, padding: '2px 4px' }}
        title="מחק הזמנה"
      >
        🗑️
      </button>
    </div>
  );
}

const EMPTY_CUSTOMER = { name: '', contact_name: '', phone: '', email: '', notes: '' };

// The B2B customer list: add, edit, and hide customers who stopped ordering.
// Hidden (not deleted) so their past orders keep a valid customer_id.
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
      <label style={labelStyle}>{label}</label>
      <input style={inputStyle} type={type} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} />
    </div>
  );

  return (
    <div style={{ border: '1px solid #E8D5B7', borderRadius: 12, marginBottom: '2rem', background: 'white' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{ width: '100%', textAlign: 'right', background: 'none', border: 'none', padding: '0.9rem 1.25rem', cursor: 'pointer', fontWeight: 600, color: '#6b3a1f', fontSize: '0.95rem' }}
      >
        {open ? '🔼' : '🔽'} לקוחות B2B ({customers.filter(c => c.active).length})
      </button>

      {open && (
        <div style={{ padding: '0 1.25rem 1.25rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem', marginBottom: '0.75rem' }}>
            {field('name', 'שם העסק *')}
            {field('contact_name', 'איש/אשת קשר')}
            {field('phone', 'טלפון', 'tel')}
            {field('email', 'אימייל', 'email')}
          </div>
          <div style={{ marginBottom: '0.75rem' }}>{field('notes', 'הערות')}</div>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <button onClick={save} disabled={saving} style={{ background: '#6b3a1f', color: 'white', border: 'none', borderRadius: 8, padding: '0.5rem 1.2rem', cursor: 'pointer', fontWeight: 600 }}>
              {saving ? '⏳' : editingId ? '💾 עדכן לקוח' : '➕ הוסף לקוח'}
            </button>
            {editingId && (
              <button onClick={() => { setEditing(null); setForm(EMPTY_CUSTOMER); }} style={{ background: 'none', border: '1px solid #E8D5B7', borderRadius: 8, padding: '0.5rem 1rem', cursor: 'pointer' }}>
                ביטול
              </button>
            )}
          </div>

          {sorted.map(c => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem 0', borderTop: '1px solid #F4E8D8', opacity: c.active ? 1 : 0.5 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: '#1a1208' }}>{c.name}</div>
                <div style={{ fontSize: '0.8rem', color: '#6B7280', overflowWrap: 'anywhere' }}>
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

const smallBtn = {
  fontSize: '0.75rem', padding: '2px 8px', background: 'transparent',
  border: '1px solid #D4A574', borderRadius: 4, cursor: 'pointer', color: '#6F4E37', flexShrink: 0,
};

const labelStyle = {
  display: 'block',
  fontSize: '0.8rem',
  fontWeight: 600,
  color: '#6b3a1f',
  marginBottom: 4,
};

const inputStyle = {
  width: '100%',
  padding: '0.5rem 0.75rem',
  border: '1px solid #E8D5B7',
  borderRadius: 8,
  fontSize: '0.9rem',
  fontFamily: 'inherit',
  background: 'white',
  boxSizing: 'border-box',
  direction: 'rtl',
};
