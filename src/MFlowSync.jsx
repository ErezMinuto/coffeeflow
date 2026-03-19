import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from './lib/supabase';

function MFlowSync({ data, showToast }) {
  const [loading, setLoading] = useState(false);
  const [importResults, setImportResults] = useState(null);

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setLoading(true);
    showToast('מעבד את הקובץ...', 'info');

    try {
      // Read Excel file
      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = XLSX.utils.sheet_to_json(worksheet);

      let imported = 0;
      let skipped = 0;
      const errors = [];
      const productMap = new Map();

      // Parse products
      for (const row of jsonData) {
        try {
          const name = row['שם המוצר'];
          const quantityField = row['כמות / טחינה'];
          
          if (!name || !quantityField) continue;

          const sizeMatch = quantityField.toString().match(/^(\d+)/);
          if (!sizeMatch) continue;
          
          const size = parseInt(sizeMatch[1]);
          const key = `${name}-${size}`;

          if (productMap.has(key)) continue;
          
          productMap.set(key, {
            name: name,
            size: size,
            type: 'single',
            description: '',
            recipe: [{ originId: null, percentage: 100 }]
          });

        } catch (err) {
          errors.push(`שגיאה בשורה: ${row['שם המוצר'] || 'לא ידוע'}`);
        }
      }

      // Insert into Supabase
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
          errors.push(`${product.name} ${product.size}g: ${err.message}`);
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
        showToast(`✅ יובאו ${imported} מוצרים!`);
        setTimeout(() => window.location.reload(), 2000);
      } else {
        showToast('⚠️ לא יובאו מוצרים חדשים', 'warning');
      }

    } catch (error) {
      showToast('❌ שגיאה בעיבוד הקובץ', 'error');
      console.error(er
