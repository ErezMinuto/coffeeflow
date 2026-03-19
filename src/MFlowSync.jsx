import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from './lib/supabase';
import { useUser } from '@clerk/clerk-react';

function MFlowSync({ showToast }) {
  const { user } = useUser();
  const [loading, setLoading] = useState(false);
  const [importResults, setImportResults] = useState(null);

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    if (!user) {
      showToast('❌ משתמש לא מחובר', 'error');
      return;
    }

    setLoading(true);
    showToast('מעבד את הקובץ...', 'info');

    try {
      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = XLSX.utils.sheet_to_json(worksheet);

      let imported = 0;
      let skipped = 0;
      const errors = [];
      const productMap = new Map();

      for (const row of jsonData) {
        try {
          const name = row['שם המוצר'];
          const quantityField = row['כמות / טחינה'];
          
          if (!name) continue;

         let size = null;

          // Try to extract size from quantity field
          if (quantityField) {
            const sizeMatch = quantityField.toString().match(/^(\d+)/);
            if (sizeMatch) {
              size = parseInt(sizeMatch[1]);
            }
          }
          
          // If no size in quantity field, try to extract from name
          if (!size) {
            // Look for patterns like "1 ק״ג" or "330 גרם" or "330g"
            const nameMatch = name.match(/(\d+)\s*(ק״ג|קג|kg|גרם|גר|g)/i);
            if (nameMatch) {
              size = parseInt(nameMatch[1]);
              // Convert kg to grams
              if (nameMatch[2].match(/ק״ג|קג|kg/i)) {
                size = size * 1000;
              }
            }
          }
          
          // Skip if no size found
          if (!size) continue;
          const key = `${name}-${size}`;

          if (productMap.has(key)) continue;
          
          const sku = row['מק"ט'] || row['מק״ט וריאציה'];

          productMap.set(key, {
            name: name,
            size: size,
            type: 'single',
            description: '',
            recipe: [{ originId: null, percentage: 100 }],
            user_id: user.id,
            sku: sku ? String(sku) : null
          });

        } catch (err) {
          errors.push(`שגיאה בשורה: ${row['שם המוצר'] || 'לא ידוע'}`);
        }
      }

      for (const [key, product] of productMap) {
        try {
          const { data: existing } = await supabase
            .from('products')
            .select('id')
            .eq('name', product.name)
            .eq('size', product.size)
            .single();

          if (existing) {
            skipped++;
            continue;
          }

          const { error } = await supabase
            .from('products')
            .insert([product]);

          if (error) throw error;
          imported++;

        } catch (err) {
          if (err.message && !err.message.includes('single row')) {
            errors.push(`${product.name} ${product.size}g: ${err.message}`);
          }
        }
      }

      setImportResults({
        total: jsonData.length,
        unique: productMap.size,
        imported,
        skipped,
        errors
      });

      if (imported > 0) {
        showToast(`✅ יובאו ${imported} מוצרים!`, 'success');
        setTimeout(() => window.location.reload(), 2000);
      } else {
        showToast('⚠️ לא יובאו מוצרים חדשים', 'warning');
      }

    } catch (error) {
      showToast('❌ שגיאה בעיבוד הקובץ', 'error');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <h1>🔄 ייבוא מוצרים מ-MFlow</h1>
      
      <div className="section">
        <h2>📦 העלאת קובץ Excel</h2>
        <p style={{ color: '#666', marginBottom: '1rem' }}>
          ייבוא מוצרים מקובץ Excel של MFlow (Products.xlsx).
          <br/>
          <strong>שים לב:</strong> המוצרים ייווצרו ללא מתכון - תצטרך להגדיר את המתכון לכל מוצר ידנית.
        </p>
        
        <div className="form-card">
          <label 
            style={{
              display: 'block',
              padding: '2rem',
              border: '2px dashed #3B82F6',
              borderRadius: '8px',
              cursor: loading ? 'not-allowed' : 'pointer',
              background: loading ? '#F3F4F6' : '#F0F9FF',
              textAlign: 'center'
            }}
          >
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileUpload}
              disabled={loading}
              style={{ display: 'none' }}
            />
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📊</div>
            <div style={{ fontSize: '1.1rem', color: '#3B82F6', fontWeight: 'bold' }}>
              {loading ? '⏳ מעבד...' : 'לחץ לבחירת קובץ Excel'}
            </div>
          </label>
        </div>
      </div>

      {importResults && (
        <div className="section" style={{ marginTop: '2rem' }}>
          <h3>📊 תוצאות ייבוא</h3>
          <div className="form-card" style={{ background: importResults.imported > 0 ? '#F0FDF4' : '#FFFBEB' }}>
            <div style={{ marginBottom: '1rem' }}>
              <strong>סה"כ שורות:</strong> {importResults.total}
            </div>
            <div style={{ marginBottom: '1rem' }}>
              <strong>מוצרים ייחודיים:</strong> {importResults.unique}
            </div>
            <div style={{ marginBottom: '1rem', color: '#10B981' }}>
              <strong>יובאו:</strong> {importResults.imported}
            </div>
            {importResults.skipped > 0 && (
              <div style={{ marginBottom: '1rem', color: '#F59E0B' }}>
                <strong>דולגו:</strong> {importResults.skipped}
              </div>
            )}
            {importResults.errors?.length > 0 && (
              <div>
                <strong style={{ color: '#DC2626' }}>שגיאות:</strong>
                <ul style={{ maxHeight: '200px', overflow: 'auto' }}>
                  {importResults.errors.slice(0, 10).map((err, i) => (
                    <li key={i} style={{ fontSize: '0.85rem' }}>{err}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default MFlowSync;
