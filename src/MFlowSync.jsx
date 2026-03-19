import React, { useState } from 'react';

function MFlowSync({ data, showToast, productsDb }) {
  const [loading, setLoading] = useState(false);
  const [importResults, setImportResults] = useState(null);

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setLoading(true);
    showToast('מעבד את הקובץ...', 'info');

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/import-products-excel', {
        method: 'POST',
        body: formData
      });

      const result = await response.json();

      if (result.success) {
        setImportResults(result);
        showToast(`✅ יובאו ${result.imported} מוצרים מ-${result.total}!`);
      } else {
        showToast(`❌ שגיאה: ${result.error}`, 'error');
      }
    } catch (error) {
      showToast('❌ שגיאה בייבוא קובץ', 'error');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <h1>🔄 סנכרון MFlow</h1>
      
      <div className="section">
        <h2>📦 ייבוא מוצרים מ-Excel</h2>
        <p style={{ color: '#666', marginBottom: '1rem' }}>
          ייבוא מוצרים מקובץ Excel של MFlow. 
          <br/>
          המוצרים ייווצרו ללא מתכון - תצטרך להגדיר את המתכון לכל מוצר ידנית.
        </p>
        
        <div className="form-card">
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileUpload}
            disabled={loading}
            style={{
              padding: '1rem',
              border: '2px dashed #3B82F6',
              borderRadius: '8px',
              width: '100%',
              cursor: 'pointer',
              background: '#F0F9FF'
            }}
          />
          {loading && (
            <div style={{ marginTop: '1rem', textAlign: 'center', color: '#3B82F6' }}>
              ⏳ מייבא מוצרים...
            </div>
          )}
        </div>
      </div>

      {importResults && (
        <div className="section" style={{ marginTop: '2rem' }}>
          <h3>📊 תוצאות ייבוא</h3>
          <div className="form-card" style={{ background: '#F0FDF4' }}>
            <div style={{ marginBottom: '1rem' }}>
              <strong>סה"כ שורות בקובץ:</strong> {importResults.total}
            </div>
            <div style={{ marginBottom: '1rem' }}>
              <strong>יובאו בהצלחה:</strong> {importResults.imported}
            </div>
            {importResults.skipped > 0 && (
              <div style={{ marginBottom: '1rem', color: '#F59E0B' }}>
                <strong>דולגו:</strong> {importResults.skipped} (כבר קיימים)
              </div>
            )}
            {importResults.errors?.length > 0 && (
              <div>
                <strong style={{ color: '#DC2626' }}>שגיאות:</strong>
                <ul>
                  {importResults.errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          
          <button 
            onClick={() => window.location.href = '/'}
            className="btn-primary"
            style={{ marginTop: '1rem' }}
          >
            ↩️ חזור לדשבורד
          </button>
        </div>
      )}
    </div>
  );
}

export default MFlowSync;
