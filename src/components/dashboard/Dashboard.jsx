import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../lib/context';

export default function Dashboard() {
  const { data, showToast } = useApp();
  const navigate = useNavigate();

  const lowStockOrigins   = data.origins.filter(o => (o.stock || 0) < (o.min_stock || 10) && (o.stock || 0) > 0);
  const outOfStockOrigins = data.origins.filter(o => (o.stock || 0) === 0);

  const outOfPackedStock  = data.products.filter(p => (p.packed_stock ?? 0) === 0 && (p.min_packed_stock ?? 0) > 0);
  const lowPackedStock    = data.products.filter(p => (p.packed_stock ?? 0) > 0 && (p.min_packed_stock ?? 0) > 0 && (p.packed_stock ?? 0) <= p.min_packed_stock);

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1>📊 דשבורד ראשי</h1>
      </div>

      {/* Packed bag alerts */}
      {(outOfPackedStock.length > 0 || lowPackedStock.length > 0) && (
        <div style={{ marginBottom: '1.5rem' }}>
          {outOfPackedStock.length > 0 && (
            <div style={{ background: '#FEE2E2', border: '2px solid #DC2626', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
              <h3 style={{ color: '#DC2626', marginBottom: '0.5rem' }}>❌ אזהרה: מוצרים ללא שקיות ארוזות ({outOfPackedStock.length})</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {outOfPackedStock.map(p => (
                  <span key={p.id} style={{ background: 'white', padding: '0.25rem 0.75rem', borderRadius: '4px', fontSize: '0.9rem', color: '#DC2626', fontWeight: 'bold' }}>
                    {p.name} {p.size}g
                  </span>
                ))}
              </div>
            </div>
          )}
          {lowPackedStock.length > 0 && (
            <div style={{ background: '#FEF3C7', border: '2px solid #F59E0B', borderRadius: '8px', padding: '1rem' }}>
              <h3 style={{ color: '#D97706', marginBottom: '0.5rem' }}>⚠️ מלאי שקיות נמוך — {lowPackedStock.length} מוצרים</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {lowPackedStock.map(p => (
                  <span key={p.id} style={{ background: 'white', padding: '0.25rem 0.75rem', borderRadius: '4px', fontSize: '0.9rem', color: '#D97706' }}>
                    {p.name} {p.size}g: {p.packed_stock} שקיות
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stock alerts */}
      {(outOfStockOrigins.length > 0 || lowStockOrigins.length > 0) && (
        <div style={{ marginBottom: '1.5rem' }}>
          {outOfStockOrigins.length > 0 && (
            <div style={{ background: '#FEE2E2', border: '2px solid #DC2626', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
              <h3 style={{ color: '#DC2626', marginBottom: '0.5rem' }}>❌ אזהרה: זנים ללא מלאי ({outOfStockOrigins.length})</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {outOfStockOrigins.map(o => (
                  <span key={o.id} style={{ background: 'white', padding: '0.25rem 0.75rem', borderRadius: '4px', fontSize: '0.9rem', color: '#DC2626', fontWeight: 'bold' }}>
                    {o.name}
                  </span>
                ))}
              </div>
            </div>
          )}
          {lowStockOrigins.length > 0 && (
            <div style={{ background: '#FEF3C7', border: '2px solid #F59E0B', borderRadius: '8px', padding: '1rem' }}>
              <h3 style={{ color: '#D97706', marginBottom: '0.5rem' }}>⚠️ מלאי נמוך — {lowStockOrigins.length} זנים</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {lowStockOrigins.map(o => (
                  <span key={o.id} style={{ background: 'white', padding: '0.25rem 0.75rem', borderRadius: '4px', fontSize: '0.9rem', color: '#D97706' }}>
                    {o.name}: {o.stock} ק"ג
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card" onClick={() => navigate('/origins')} style={{ cursor: 'pointer' }}>
          <div className="stat-icon">🌱</div>
          <div className="stat-info">
            <div className="stat-label">זנים במלאי</div>
            <div className="stat-value">{data.origins.length}</div>
          </div>
        </div>
        <div className="stat-card" onClick={() => navigate('/products')} style={{ cursor: 'pointer' }}>
          <div className="stat-icon">📦</div>
          <div className="stat-info">
            <div className="stat-label">מוצרים</div>
            <div className="stat-value">{data.products.length}</div>
          </div>
        </div>
        <div className="stat-card" onClick={() => navigate('/roasting')} style={{ cursor: 'pointer' }}>
          <div className="stat-icon">🔥</div>
          <div className="stat-info">
            <div className="stat-label">קליות החודש</div>
            <div className="stat-value">{data.roasts.length}</div>
          </div>
        </div>
        <div className="stat-card" onClick={() => navigate('/settings')} style={{ cursor: 'pointer' }}>
          <div className="stat-icon">👥</div>
          <div className="stat-info">
            <div className="stat-label">מפעילים</div>
            <div className="stat-value">{data.operators.length}</div>
          </div>
        </div>
      </div>

      <div className="section">
        <h2>📈 סטטיסטיקות</h2>
        <div className="stats-details">
          <div className="stat-row">
            <span>סה"כ מלאי ירוק:</span>
            <strong>{data.origins.reduce((sum, o) => sum + (o.stock || 0), 0).toFixed(1)} ק"ג</strong>
          </div>
          <div className="stat-row">
            <span>ערך מלאי:</span>
            <strong>₪{data.origins.reduce((sum, o) => sum + ((o.stock || 0) * (o.cost_per_kg || 0)), 0).toFixed(2)}</strong>
          </div>
          <div className="stat-row">
            <span>איבוד משקל ממוצע:</span>
            <strong>
              {data.origins.length > 0
                ? (data.origins.reduce((sum, o) => sum + (o.weight_loss || 0), 0) / data.origins.length).toFixed(1)
                : 0}%
            </strong>
          </div>
        </div>
      </div>

      {data.origins.length === 0 && (
        <div className="empty-state" style={{ marginTop: '2rem' }}>
          <h3>👋 ברוך הבא ל-CoffeeFlow!</h3>
          <p>לחץ על "➕ נתוני דוגמה" כדי להתחיל, או צור זנים ומוצרים משלך!</p>
        </div>
      )}
    </div>
  );
}
