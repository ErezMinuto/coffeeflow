import React, { useState } from 'react';

function MFlowSync({ data, showToast }) {
  const [loading, setLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);

  const importProducts = async () => {
    setLoading(true);
    showToast('מייבא מוצרים מ-MFlow...', 'info');
    
    try {
      const response = await fetch('/api/mflow-import-products', {
        method: 'POST'
      });
      
      const result = await response.json();
      
      if (result.success) {
        showToast(`✅ יובאו ${result.count} מוצרים מ-MFlow!`);
        setSyncStatus(result);
      } else {
        showToast(`❌ שגיאה: ${result.error}`, 'error');
      }
    } catch (error) {
      showToast('❌ שגיאה בייבוא מוצרים', 'error');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const syncSales = async () => {
    setLoading(true);
    showToast('מסנכרן מכירות מ-MFlow...', 'info');
    
    try {
      const response = await fetch('/api/mflow-sync-sales', {
        method: 'POST'
      });
      
      const result = await response.json();
      
      if (result.success) {
        showToast(`✅ סונכרנו ${result.salesCount} מכירות!`);
        setSyncStatus(result);
      } else {
        showToast(`❌ שגיאה: ${result.error}`, 'error');
      }
    } catch (error) {
      showToast('❌ שגיאה בסנכרון מכירות', 'error');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <h1>🔄 סנכרון MFlow</h1>
      
      <div className="section">
        <h2>📦 ייבוא מוצרים</h2>
        <p style={{ color: '#666', marginBottom: '1rem' }}>
          ייבוא מוצרים מ-MFlow למערכת. המוצרים הקיימים יוחלפו במוצרים החדשים.
          לאחר הייבוא תצטרך להגדיר את המתכון (Recipe) לכל מוצר.
        </p>
        <button 
          onClick={importProducts} 
          disabled={loading}
          className="btn-primary"
          style={{ background: '#3B82F6' }}
        >
          {loading ? '⏳ מייבא...' : '📥 ייבא מוצרים מ-MFlow'}
        </button>
      </div>

      <div className="section" style={{ marginTop: '2rem' }}>
        <h2>💰 סנכרון מכירות</h2>
        <p style={{ color: '#666', marginBottom: '1rem' }}>
          סנכרון מכירות מ-MFlow ועדכון מלאי קלוי.
          הסנכרון רץ אוטומטית כל יום בשעה 10:00.
        </p>
        <button 
          onClick={syncSales} 
          disabled={loading}
          className="btn-primary"
          style={{ background: '#10B981' }}
        >
          {loading ? '⏳ מסנכרן...' : '🔄 סנכרן מכירות עכשיו'}
        </button>
      </div>

      {syncStatus && (
        <div className="section" style={{ marginTop: '2rem', background: '#F0FDF4', padding: '1.5rem', borderRadius: '8px' }}>
          <h3>📊 סטטוס סנכרון אחרון</h3>
          <pre style={{ background: 'white', padding: '1rem', borderRadius: '4px', overflow: 'auto' }}>
            {JSON.stringify(syncStatus, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export default MFlowSync;
