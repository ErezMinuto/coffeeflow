// Shrinking a supplier-invoice photo before upload, and the small helpers the
// invoices page shares (base64, file names, warnings).
//
// A phone photo is 3–8 MB; an invoice stays readable at 1600 px on the long
// side as a 60% JPEG, which is ~150–300 KB. A PDF is sent as the supplier made
// it: a digital PDF is already small and it is the original document.

export const MAX_SIDE = 1600;
export const JPEG_QUALITY = 0.6;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;   // = the bucket's limit

// Israeli VAT law: above this pre-VAT amount a tax invoice needs a מספר הקצאה
// for the input VAT to be deductible. 5,000 ₪ from June 2026 per the amending
// bill — confirm with the accountant; it is only used to show a warning.
export const ALLOCATION_THRESHOLD = 5000;

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Image file → small JPEG Blob. Throws when the browser cannot read the image. */
export async function shrinkImage(file) {
  let src;
  try { src = await decode(file); }
  catch { throw new Error('לא הצלחנו לקרוא את התמונה. נסו לצלם שוב או לשמור אותה כ-JPEG'); }
  const w = src.width, h = src.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';                        // a transparent PNG would turn black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  if (src.close) src.close();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error('כיווץ התמונה נכשל');
  return blob;
}

/** File → { blob, mime } ready for upload. */
export async function prepareInvoiceFile(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const prepared = isPdf
    ? { blob: file, mime: 'application/pdf' }
    : { blob: await shrinkImage(file), mime: 'image/jpeg' };
  if (prepared.blob.size > MAX_UPLOAD_BYTES) throw new Error('הקובץ גדול מ-10MB');
  return prepared;
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export const DOC_TYPE_LABELS = {
  tax_invoice:         'חשבונית מס',
  tax_invoice_receipt: 'חשבונית מס קבלה',
  receipt:             'קבלה',
  credit_note:         'חשבונית זיכוי',
  transaction_invoice: 'חשבון עסקה',
  other:               'אחר',
};

/** What the uploader should look at again before confirming. */
export function invoiceWarnings(inv) {
  const w = [];
  const n = (v) => (v === '' || v == null ? null : Number(v));
  const before = n(inv.amount_before_vat), vat = n(inv.vat_amount), total = n(inv.total_incl_vat);
  if (!inv.supplier_name) w.push('חסר שם ספק');
  if (!inv.invoice_number) w.push('חסר מספר חשבונית');
  if (!inv.invoice_date) w.push('חסר תאריך');
  else {
    const days = (Date.now() - Date.parse(inv.invoice_date)) / 86400000;
    if (!(inv.invoice_date >= '2000-01-01')) w.push('התאריך לא תקין. בדקו את השנה');
    else if (days > 183) w.push('התאריך לפני יותר מחצי שנה. בדקו את השנה (אולי 25 במקום 26?)');
    else if (days < -7) w.push('התאריך בעתיד. בדקו את התאריך');
  }
  if (total == null) w.push('חסר סכום כולל מע״מ');
  if (before != null && vat != null && total != null && Math.abs(before + vat - total) > 1) {
    w.push('הסכומים לא מסתכמים: לפני מע״מ + מע״מ ≠ סה״כ');
  }
  const taxDoc = inv.doc_type === 'tax_invoice' || inv.doc_type === 'tax_invoice_receipt';
  if (taxDoc && before != null && Math.abs(before) >= ALLOCATION_THRESHOLD && !inv.allocation_number) {
    w.push(`מעל ${ALLOCATION_THRESHOLD.toLocaleString('he-IL')} ₪ לפני מע״מ ואין מספר הקצאה. בלעדיו לא ניתן לקזז את המע״מ`);
  }
  return w;
}

const safe = (s) => String(s ?? '').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

/** "2026-10-14_קפה ירוק_10234_1180.00.jpg" */
export function invoiceFileName(inv) {
  const ext = inv.file_path.split('.').pop();
  const parts = [
    inv.invoice_date || 'ללא-תאריך',
    safe(inv.supplier_name) || 'ספק-לא-ידוע',
    safe(inv.invoice_number) || 'ללא-מספר',
    inv.total_incl_vat != null ? Number(inv.total_incl_vat).toFixed(2) : '',
  ].filter(Boolean);
  return `${parts.join('_')}.${ext}`;
}
