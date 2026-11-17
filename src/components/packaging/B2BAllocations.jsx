import React, { useState } from 'react';
import { Plus, Check, ChevronDown, Save } from 'lucide-react';
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
    if (!customerId)  { showToast('נא לבחור לקוח', 'warning'); return; }
    if (!product)     { showToast('נא לבחור מוצר', 'warning'); return; }
    if (count <= 0)   { showToast('נא להזין כמות שקיות', 'warning'); return; }
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
      showToast(`${count} שקיות הוקצו ל${customerById[parseInt(customerId)]?.name}`);
      setProductId(''); setBags(''); setNotes('');
    } catch {
      showToast('שגיאה בהקצאה', 'error');
    } finally {
      setSaving(false);
    }
  };

  const deliver = async (a) => {
    setBusyId(a.id);
    try {
      await bagAllocationsDb.update(a.id, { status: 'delivered', delivered_at: new Date().toISOString() });
      showToast('סומן כנמסר');
    } catch {
      showToast('שגיאה בעדכון', 'error');
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
      showToast('שגיאה בביטול', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="card flush">
      <div className="card-head">
        <h2>הקצאת שקיות ללקוחות B2B</h2>
        {open.length > 0 && (
          <span className="meta num">{open.reduce((s, a) => s + a.bags, 0)} שקיות מוקצות</span>
        )}
      </div>

      <div className="card-body">
        <p className="field-help pack-help">
          שקיות שהוקצו לא נספרות במלאי החנות. סימון <b>נמסר</b> משחרר אותן (MFlow מוריד מהמלאי עם החשבונית).
        </p>

        <div className="pack-alloc-grid">
          <div className="form-group">
            <label htmlFor="alloc-customer">לקוח</label>
            <select id="alloc-customer" value={customerId} onChange={e => setCustomerId(e.target.value)}>
              <option value="">{activeCustomers.length ? 'בחירת לקוח' : 'אין לקוחות. הוסיפו למטה'}</option>
              {activeCustomers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="alloc-product">מוצר</label>
            <select id="alloc-product" value={productId} onChange={e => setProductId(e.target.value)}>
              <option value="">בחירת מוצר</option>
              {data.products.map(p => (
                <option key={p.id} value={p.id}>{p.name} {p.size}g ({storeStock(p, reserved)} בחנות)</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="alloc-bags">כמות שקיות</label>
            <input id="alloc-bags" type="number" min="1" placeholder="0" value={bags} onChange={e => setBags(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="alloc-notes">הערה</label>
            <input id="alloc-notes" placeholder="לא חובה" value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </div>
        <button type="button" className="btn primary" onClick={allocate} disabled={saving}>
          <Plus aria-hidden="true" />
          {saving ? 'שומר...' : 'הקצאת שקיות'}
        </button>
      </div>

      {open.length > 0 && (
        <div className="pack-alloc-list">
          {Object.entries(byCustomer).map(([cid, rows]) => (
            <div className="pack-alloc-group" key={cid}>
              <div className="pack-alloc-cust">
                <span className="attn-what">{customerById[cid]?.name || 'לקוח לא ידוע'}</span>
                <span className="text-muted num">{rows.reduce((s, a) => s + a.bags, 0)} שקיות</span>
              </div>
              {rows.map(a => (
                <div className="pack-alloc-row" key={a.id}>
                  <span className="pack-alloc-text">
                    {productById[a.product_id]?.name || 'מוצר'}{' '}
                    <span className="pack-size">{productById[a.product_id]?.size}g</span>
                    {' × '}<b className="num">{a.bags}</b>
                    {a.notes && <span className="text-muted"> · {a.notes}</span>}
                    <span className="text-muted num"> · {new Date(a.created_at).toLocaleDateString('he-IL')}</span>
                  </span>
                  <button type="button" className="btn sm" onClick={() => deliver(a)} disabled={busyId === a.id}>
                    <Check aria-hidden="true" />נמסר
                  </button>
                  <button type="button" className="btn ghost sm" onClick={() => cancel(a)} disabled={busyId === a.id}>ביטול</button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <CustomerList customers={data.b2bCustomers} db={b2bCustomersDb} showToast={showToast} />
    </section>
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
    if (!name) { showToast('נא להזין שם עסק', 'warning'); return; }
    const dup = customers.find(c => c.id !== editingId && c.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) { showToast(`${dup.name} כבר ברשימה`, 'warning'); return; }

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
      showToast(editingId ? `${name} עודכן` : `${name} נוסף`);
      setForm(EMPTY_CUSTOMER); setEditing(null);
    } catch {
      showToast('שגיאה בשמירת הלקוח', 'error');
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
    catch { showToast('שגיאה בעדכון', 'error'); }
  };

  const field = (key, label, type = 'text') => (
    <div className="form-group">
      <label htmlFor={`b2b-${key}`}>{label}</label>
      <input id={`b2b-${key}`} type={type} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} />
    </div>
  );

  return (
    <div className="pack-cust">
      <button
        type="button"
        className="pack-cust-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>לקוחות B2B <span className="text-muted num">({customers.filter(c => c.active).length})</span></span>
        <ChevronDown aria-hidden="true" className={open ? 'is-open' : undefined} />
      </button>

      {open && (
        <div className="pack-cust-body">
          <div className="pack-cust-grid">
            {field('name', 'שם העסק *')}
            {field('contact_name', 'איש/אשת קשר')}
            {field('phone', 'טלפון', 'tel')}
            {field('email', 'אימייל', 'email')}
          </div>
          {field('notes', 'הערות')}
          <div className="pack-cust-actions">
            <button type="button" className="btn primary" onClick={save} disabled={saving}>
              {editingId ? <Save aria-hidden="true" /> : <Plus aria-hidden="true" />}
              {saving ? 'שומר...' : editingId ? 'עדכון לקוח' : 'הוספת לקוח'}
            </button>
            {editingId && (
              <button type="button" className="btn ghost" onClick={() => { setEditing(null); setForm(EMPTY_CUSTOMER); }}>ביטול</button>
            )}
          </div>

          <div className="pack-cust-list">
            {sorted.map(c => (
              <div className={`pack-cust-row${c.active ? '' : ' is-hidden'}`} key={c.id}>
                <div className="pack-cust-info">
                  <div className="attn-what">{c.name}</div>
                  <div className="pack-cust-contact">
                    {[c.contact_name, c.phone, c.email].filter(Boolean).join(' · ') || 'אין פרטי קשר'}
                  </div>
                </div>
                {!c.active && <span className="tag">מוסתר</span>}
                <button type="button" className="btn ghost sm" onClick={() => startEdit(c)}>עריכה</button>
                <button type="button" className="btn ghost sm" onClick={() => toggleActive(c)}>{c.active ? 'הסתרה' : 'החזרה'}</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
