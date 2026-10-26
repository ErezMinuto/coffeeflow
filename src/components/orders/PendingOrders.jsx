import React, { useState } from 'react';
import { useApp } from '../../lib/context';

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
  const { data, pendingOrdersDb, showToast } = useApp();

  const [customerName, setCustomerName] = useState('');
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

  const selectedProduct = data.products.find(p => p.id === parseInt(productId));

  const handleSubmit = async () => {
    if (!customerName.trim()) { showToast('⚠️ נא להזין שם לקוח', 'warning'); return; }
    if (!quantityBags || parseInt(quantityBags) <= 0) { showToast('⚠️ נא להזין כמות שקיות', 'warning'); return; }

    setSubmitting(true);
    try {
      await pendingOrdersDb.insert({
        customer_name: customerName.trim(),
        product_id:    selectedProduct?.id || null,
        product_name:  selectedProduct ? `${selectedProduct.name} ${selectedProduct.size}g` : 'לא צוין',
        quantity_bags: parseInt(quantityBags),
        expected_date: expectedDate || null,
        notes:         notes.trim() || null,
        status:        'pending',
      });
      showToast(`✅ הזמנה נרשמה: ${customerName}`);
      setCustomerName(''); setProductId(''); setQuantityBags(''); setExpectedDate(''); setNotes('');
    } catch (err) {
      showToast('❌ שגיאה ברישום ההזמנה', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusClick = async (order) => {
    if (updatingId === order.id) return;
    const next = nextStatus(order.status);
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
            <label style={labelStyle}>שם לקוח *</label>
            <input
              style={inputStyle}
              value={customerName}
              onChange={e => setCustomerName(e.target.value)}
              placeholder="שם הלקוח"
            />
          </div>
          <div>
            <label style={labelStyle}>מוצר</label>
            <select style={inputStyle} value={productId} onChange={e => setProductId(e.target.value)}>
              <option value="">בחר מוצר (אופציונלי)</option>
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
