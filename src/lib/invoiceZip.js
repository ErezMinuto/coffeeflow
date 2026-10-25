// One ZIP of supplier invoices: the files (a folder per invoice month, since a
// delivery package mixes months) and a Hebrew CSV index that opens in Excel.
// Used for a delivery package to the bookkeeper and for a month's download.

import { supabase } from './supabase';
import { invoiceFileName, DOC_TYPE_LABELS } from './invoiceFiles';

const BUCKET = 'supplier-invoices';
const dateIL = (d) => (d ? d.split('-').reverse().join('/') : '');
const csvCell = (c) => `"${String(c ?? '').replace(/"/g, '""')}"`;

/**
 * rows: supplier_invoices rows. onProgress(done, total) while files download.
 * → { blob, failed: [file names that could not be downloaded] }
 */
export async function buildInvoiceZip(rows, { indexName, onProgress, booked } = {}) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const used = new Set();
  const failed = [];
  const names = new Map();

  for (let i = 0; i < rows.length; i++) {
    const inv = rows[i];
    const folder = inv.invoice_date ? inv.invoice_date.slice(0, 7) : 'ללא-תאריך';
    let name = `${folder}/${invoiceFileName(inv)}`;
    for (let n = 2; used.has(name); n++) name = `${folder}/${invoiceFileName(inv).replace(/(\.[^.]+)$/, `_${n}$1`)}`;
    used.add(name);
    names.set(inv.id, name);
    const { data, error } = await supabase.storage.from(BUCKET).download(inv.file_path);
    if (error) failed.push(name); else zip.file(name, data);
    onProgress?.(i + 1, rows.length);
  }

  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const header = ['חודש', 'תאריך', 'ספק', 'ח.פ', 'מספר חשבונית', 'סוג', 'לפני מע"מ', 'מע"מ', 'סה"כ כולל מע"מ', 'מספר הקצאה', 'סטטוס',
    ...(booked ? ['נקלט בהנה"ח'] : []), 'הועלה ע"י', 'קובץ'];
  const lines = rows.map((r) => [
    r.invoice_date ? r.invoice_date.slice(0, 7) : '', dateIL(r.invoice_date), r.supplier_name, r.supplier_tax_id, r.invoice_number,
    DOC_TYPE_LABELS[r.doc_type] || r.doc_type, r.amount_before_vat, r.vat_amount, r.total_incl_vat, r.allocation_number,
    r.status === 'confirmed' ? 'אושר' : 'ממתין לבדיקה', ...(booked ? [booked.has(r.id) ? 'כן' : ''] : []),
    r.uploaded_by_name, names.get(r.id),
  ]);
  lines.push(['', '', 'סה"כ', '', '', '', sum('amount_before_vat').toFixed(2), sum('vat_amount').toFixed(2), sum('total_incl_vat').toFixed(2)]);
  zip.file(indexName || 'סיכום.csv', '﻿' + [header, ...lines].map((r) => r.map(csvCell).join(',')).join('\r\n'));

  return { blob: await zip.generateAsync({ type: 'blob' }), failed };
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
