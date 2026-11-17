import React, { useState, useMemo, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Package, PackageMinus, Plus, Minus, Search, Download, Pencil, Copy, Trash2,
  EllipsisVertical, ShoppingCart, TriangleAlert, X,
} from 'lucide-react';
import { useApp } from '../../lib/context';
import { Kpi } from '../shared/ui';

// Line icons from lucide-react; stroke weight comes from the shared svg.lucide rule.
const Icon = ({ d: Glyph, size = 16 }) => <Glyph size={size} aria-hidden="true" />;
const I = {
  box: Package, out: PackageMinus, plus: Plus, minus: Minus, search: Search,
  download: Download, edit: Pencil, dup: Copy, trash: Trash2, dots: EllipsisVertical,
  cart: ShoppingCart, alert: TriangleAlert, x: X,
};

const EMPTY_ORIGIN = { name: '', weightLoss: 20, costPerKg: '', stock: 0, minStock: 10, dailyAverage: 0, notes: '' };

// status + derived metrics for one origin
function derive(o) {
  const stock    = parseFloat(o.stock) || 0;
  const roasted  = parseFloat(o.roasted_stock) || 0;
  const minStock = parseFloat(o.min_stock) || 10;
  const avg      = parseFloat(o.daily_average) || 0;
  const status   = stock === 0 ? 'out' : stock < minStock ? 'low' : 'ok';
  const days     = avg > 0 ? Math.round(stock / avg) : null;
  return { stock, roasted, minStock, avg, status, days };
}

export default function Origins() {
  const { data, originsDb, getOriginById, showToast, dataLoading } = useApp();

  const [searchTerm, setSearchTerm]   = useState('');
  const [sortBy, setSortBy]           = useState('name');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'low' | 'out'
  const [openMenuId, setOpenMenuId]   = useState(null);
  const [menuPos, setMenuPos]         = useState(null); // {top,left} in viewport px
  const [bannerOpen, setBannerOpen]   = useState(true);

  // drawer: { mode: 'in' | 'out' | 'add' | 'edit' } | null
  const [drawer, setDrawer] = useState(null);

  const [newOrigin, setNewOrigin]     = useState(EMPTY_ORIGIN);
  const [editingOrigin, setEditingOrigin] = useState(null);
  const [stockEntry, setStockEntry]   = useState({ originId: '', quantity: '', notes: '' });
  const [stockOut, setStockOut]       = useState({ originId: '', quantity: '', notes: '' });

  // ── Kebab menu: rendered in a portal with fixed coords ──────────────────────
  // The table lives in an `overflow-x: auto` scroller, which makes overflow-y
  // `auto` too — an absolutely positioned menu on the last row gets clipped and
  // becomes unreachable. Position it against the viewport instead, flipping it
  // above the button when there is no room below.
  const menuBtnRef = useRef(null);
  const menuRef    = useRef(null);

  const closeMenu = useCallback(() => {
    menuBtnRef.current = null;
    setOpenMenuId(null);
    setMenuPos(null);
  }, []);

  const toggleMenu = (id, el) => {
    if (openMenuId === id) { closeMenu(); return; }
    menuBtnRef.current = el;
    setMenuPos(null);          // measured on the next layout pass
    setOpenMenuId(id);
  };

  const placeMenu = useCallback(() => {
    const btn = menuBtnRef.current, menu = menuRef.current;
    if (!btn || !menu) return;
    const EDGE = 8, GAP = 6;
    const b = btn.getBoundingClientRect();
    const { width: mw, height: mh } = menu.getBoundingClientRect();
    let top = b.bottom + GAP;
    if (top + mh > window.innerHeight - EDGE) top = Math.max(EDGE, b.top - GAP - mh);
    // match the old `inset-inline-end: 0`: the menu's inline-end edge sits on the
    // button's, so it grows rightward in RTL and leftward in LTR
    const rtl = getComputedStyle(btn).direction === 'rtl';
    const raw = rtl ? b.left : b.right - mw;
    const left = Math.min(Math.max(EDGE, raw), Math.max(EDGE, window.innerWidth - mw - EDGE));
    setMenuPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (openMenuId === null) return;
    placeMenu();
    const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
    window.addEventListener('resize', placeMenu);
    window.addEventListener('scroll', placeMenu, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', placeMenu);
      window.removeEventListener('scroll', placeMenu, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenuId, placeMenu, closeMenu]);

  const closeDrawer = () => setDrawer(null);

  // ── CRUD ─────────────────────────────────────────────────────────────────────
  const addOrigin = async () => {
    if (!newOrigin.name || !newOrigin.costPerKg) { showToast('נא למלא שם ועלות', 'warning'); return; }
    try {
      await originsDb.insert({
        name: newOrigin.name,
        weight_loss:   parseFloat(newOrigin.weightLoss),
        cost_per_kg:   parseFloat(newOrigin.costPerKg),
        stock:         parseFloat(newOrigin.stock) || 0,
        roasted_stock: 0,
        min_stock:     parseFloat(newOrigin.minStock) || 10,
        daily_average: parseFloat(newOrigin.dailyAverage) || 0,
        notes:         newOrigin.notes,
      });
      await originsDb.refresh();
      setNewOrigin(EMPTY_ORIGIN);
      closeDrawer();
      showToast('זן נוסף בהצלחה!');
    } catch (error) {
      console.error('Error adding origin:', error);
      showToast('שגיאה בהוספת זן', 'error');
    }
  };

  const openEdit = (origin) => {
    setEditingOrigin({
      id: origin.id, name: origin.name, weightLoss: origin.weight_loss, costPerKg: origin.cost_per_kg,
      stock: origin.stock, roastedStock: origin.roasted_stock || 0, minStock: origin.min_stock || 10,
      dailyAverage: origin.daily_average || 0, notes: origin.notes || '',
    });
    closeMenu();
    setDrawer({ mode: 'edit' });
  };

  const saveEdit = async () => {
    if (!editingOrigin.name || !editingOrigin.costPerKg) { showToast('נא למלא שם ועלות', 'warning'); return; }
    try {
      await originsDb.update(editingOrigin.id, {
        name: editingOrigin.name,
        weight_loss:   parseFloat(editingOrigin.weightLoss),
        cost_per_kg:   parseFloat(editingOrigin.costPerKg),
        stock:         parseFloat(editingOrigin.stock),
        roasted_stock: parseFloat(editingOrigin.roastedStock) || 0,
        min_stock:     parseFloat(editingOrigin.minStock) || 10,
        daily_average: parseFloat(editingOrigin.dailyAverage) || 0,
        notes:         editingOrigin.notes,
        updated_at:    new Date().toISOString(),
      });
      await originsDb.refresh();
      setEditingOrigin(null);
      closeDrawer();
      showToast('זן עודכן בהצלחה!');
    } catch (error) {
      console.error('Error updating origin:', error);
      showToast('שגיאה בעדכון זן', 'error');
    }
  };

  const deleteOrigin = async (origin) => {
    closeMenu();
    const roastsCount = data.roasts.filter(r => r.origin_id === origin.id).length;
    if (roastsCount > 0) {
      if (!window.confirm(`לזן זה יש ${roastsCount} קליות. האם למחוק בכל זאת?`)) return;
    } else if (!window.confirm(`האם למחוק את "${origin.name}"?`)) return;
    try {
      await originsDb.remove(origin.id);
      showToast('זן נמחק!');
    } catch (error) {
      console.error('Error deleting origin:', error);
      showToast('שגיאה במחיקת זן', 'error');
    }
  };

  const duplicateOrigin = async (origin) => {
    closeMenu();
    try {
      await originsDb.insert({
        name: origin.name + ' (עותק)', weight_loss: origin.weight_loss, cost_per_kg: origin.cost_per_kg,
        stock: 0, roasted_stock: 0, notes: origin.notes,
      });
      await originsDb.refresh();
      showToast('זן שוכפל בהצלחה!');
    } catch (error) {
      console.error('Error duplicating origin:', error);
      showToast('שגיאה בשכפול זן', 'error');
    }
  };

  // ── STOCK IN / OUT ────────────────────────────────────────────────────────────
  const openStockIn = (originId = '') => {
    setStockEntry({ originId: originId ? String(originId) : '', quantity: '', notes: '' });
    closeMenu();
    setDrawer({ mode: 'in' });
  };

  const openStockOut = (originId = '') => {
    let quantity = '';
    if (originId) {
      const origin = getOriginById(parseInt(originId));
      const yieldPercent = origin ? (1 - (origin.weight_loss / 100)) : 1;
      quantity = (15 * yieldPercent).toFixed(1);
    }
    setStockOut({ originId: originId ? String(originId) : '', quantity, notes: '' });
    closeMenu();
    setDrawer({ mode: 'out' });
  };

  const addStockEntry = async () => {
    if (!stockEntry.originId || !stockEntry.quantity) { showToast('נא לבחור זן ולהזין כמות', 'warning'); return; }
    const quantity = parseFloat(stockEntry.quantity);
    if (quantity <= 0) { showToast('כמות חייבת להיות גדולה מ-0', 'warning'); return; }
    const origin = getOriginById(parseInt(stockEntry.originId));
    if (!origin) { showToast('זן לא נמצא', 'warning'); return; }
    try {
      const newStock = (origin.stock || 0) + quantity;
      await originsDb.update(origin.id, { stock: newStock });
      await originsDb.refresh();
      setStockEntry({ originId: '', quantity: '', notes: '' });
      closeDrawer();
      showToast(`הוספת ${quantity} ק"ג ל${origin.name} • מלאי חדש: ${newStock} ק"ג`);
    } catch (error) {
      console.error('Error adding stock:', error);
      showToast('שגיאה בהוספת מלאי', 'error');
    }
  };

  const removeStockForPackaging = async () => {
    if (!stockOut.originId || !stockOut.quantity) { showToast('נא לבחור זן ולהזין כמות', 'warning'); return; }
    const quantity = parseFloat(stockOut.quantity);
    if (quantity <= 0) { showToast('כמות חייבת להיות גדולה מ-0', 'warning'); return; }
    const origin = getOriginById(parseInt(stockOut.originId));
    if (!origin) { showToast('זן לא נמצא', 'warning'); return; }
    const currentRoastedStock = origin.roasted_stock || 0;
    if (quantity > currentRoastedStock) {
      showToast(`אין מספיק מלאי קלוי! קיים: ${currentRoastedStock} ק"ג`, 'warning');
      return;
    }
    try {
      const newRoastedStock = currentRoastedStock - quantity;
      await originsDb.update(origin.id, { roasted_stock: newRoastedStock });
      await originsDb.refresh();
      setStockOut({ originId: '', quantity: '', notes: '' });
      closeDrawer();
      showToast(`הוצאו ${quantity} ק"ג מ${origin.name} לאריזה • נותר: ${newRoastedStock} ק"ג`);
    } catch (error) {
      console.error('Error removing stock:', error);
      showToast('שגיאה בהוצאת מלאי', 'error');
    }
  };

  // Reorder is a UI reminder — there is no purchasing/PO backend yet.
  const reorder = (origin) => showToast(`${origin.name} נרשם לרשימת ההזמנות`);
  const reorderAll = (list) => showToast(`${list.length} זנים חסרים נרשמו לרשימת ההזמנות`);

  const bumpInQty = (delta) => {
    const q = Math.max(0, (parseFloat(stockEntry.quantity || 0) + delta));
    setStockEntry({ ...stockEntry, quantity: q ? String(q.toFixed(1)) : '' });
  };
  const bumpOutQty = (delta) => {
    const q = Math.max(0, (parseFloat(stockOut.quantity || 0) + delta));
    setStockOut({ ...stockOut, quantity: q ? String(q.toFixed(1)) : '' });
  };

  // ── CSV EXPORT ──────────────────────────────────────────────────────────────
  const exportToCSV = () => {
    const headers = ['שם,איבוד משקל %,עלות ק"ג,מלאי ק"ג,מלאי קלוי ק"ג,הערות'];
    const rows = filteredOrigins.map(o =>
      `"${o.name}",${o.weight_loss},${o.cost_per_kg},${o.stock || 0},${o.roasted_stock || 0},"${o.notes || ''}"`
    );
    const csv = [...headers, ...rows].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `coffeeflow-origins-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  // ── DERIVED DATA ──────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    let green = 0, roasted = 0, value = 0, low = 0, out = 0;
    const shortlist = [];
    for (const o of data.origins) {
      const d = derive(o);
      green += d.stock; roasted += d.roasted; value += d.stock * (parseFloat(o.cost_per_kg) || 0);
      if (d.status === 'out') { out++; shortlist.push(o); }
      else if (d.status === 'low') { low++; shortlist.push(o); }
    }
    return { count: data.origins.length, green, roasted, value, low, out, shortlist };
  }, [data.origins]);

  const maxStock = useMemo(
    () => Math.max(10, ...data.origins.map(o => parseFloat(o.stock) || 0)),
    [data.origins]
  );

  const filteredOrigins = data.origins
    .filter(o => o.name.toLowerCase().includes(searchTerm.toLowerCase()))
    .filter(o => statusFilter === 'all' ? true : derive(o).status === statusFilter)
    .sort((a, b) => {
      if (sortBy === 'name')  return a.name.localeCompare(b.name);
      if (sortBy === 'stock') return (b.stock || 0) - (a.stock || 0);
      if (sortBy === 'cost')  return (b.cost_per_kg || 0) - (a.cost_per_kg || 0);
      if (sortBy === 'days')  { const da = derive(a).days ?? 1e9, db = derive(b).days ?? 1e9; return da - db; }
      return 0;
    });

  const num = (n, digits = 1) => (parseFloat(n) || 0).toFixed(digits);
  const money = (n) => '₪' + (parseFloat(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

  // ── RENDER ──────────────────────────────────────────────────────────────────
  return (
    <div className="page origins-page">
      {/* Header */}
      <div className="origins-head">
        <div className="origins-title">
          <h1>ניהול זנים</h1>
          <p>מלאי פולי קפה ירוקים וקלויים, עלויות ותחזית התכלות, במבט אחד.</p>
        </div>
        <div className="origins-head-actions">
          <button className="btn" onClick={() => openStockIn()}><Icon d={I.box} /> קליטת מלאי</button>
          <button className="btn" onClick={() => openStockOut()}><Icon d={I.out} /> הוצאה לאריזה</button>
          <button className="btn primary" onClick={() => { setNewOrigin(EMPTY_ORIGIN); setDrawer({ mode: 'add' }); }}>
            <Icon d={I.plus} /> זן חדש
          </button>
        </div>
      </div>

      {/* Alert banner */}
      {bannerOpen && (stats.low > 0 || stats.out > 0) && (
        <div className={`notice ${stats.out > 0 ? 'danger' : 'warn'} origins-alert`} role="status">
          <Icon d={I.alert} size={18} />
          <div className="oa-txt">
            {stats.out > 0 && <b>{stats.out} זנים אזלו מהמלאי</b>}
            {stats.out > 0 && stats.low > 0 && ' · '}
            {stats.low > 0 && <b>{stats.low} זנים במלאי נמוך</b>}
            {'. כדאי לחדש מלאי.'}
          </div>
          <button className="btn sm" onClick={() => reorderAll(stats.shortlist)}>הזמנת החסרים</button>
          <button className="btn-icon" onClick={() => setBannerOpen(false)} aria-label="סגירת ההתראה"><Icon d={I.x} /></button>
        </div>
      )}

      {/* KPI strip */}
      <div className="kpis origins-kpis">
        <Kpi label="זנים פעילים" value={stats.count} />
        <Kpi label="מלאי ירוק" value={num(stats.green, 0)} unit='ק"ג' />
        <Kpi label="מלאי קלוי" value={num(stats.roasted, 0)} unit='ק"ג' />
        <Kpi label="שווי מלאי ירוק" value={money(Math.round(stats.value))} />
        <Kpi label={<>{stats.low > 0 && <span className="dot warn" />}מלאי נמוך</>} value={stats.low} />
        <Kpi label={<>{stats.out > 0 && <span className="dot danger" />}אזל מהמלאי</>} value={stats.out} />
      </div>

      {/* Toolbar */}
      <div className="origins-toolbar">
        <div className="osearch">
          <Icon d={I.search} size={17} />
          <input type="text" aria-label="חיפוש זן" placeholder="חיפוש זן…" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
        </div>
        <div className="ochips" role="tablist" aria-label="סינון לפי סטטוס">
          <button className={`ochip ${statusFilter === 'all' ? 'active' : ''}`} onClick={() => setStatusFilter('all')}>הכל <span className="n">{stats.count}</span></button>
          <button className={`ochip ${statusFilter === 'low' ? 'active' : ''}`} onClick={() => setStatusFilter('low')}><span className="dot warn" />נמוך <span className="n">{stats.low}</span></button>
          <button className={`ochip ${statusFilter === 'out' ? 'active' : ''}`} onClick={() => setStatusFilter('out')}><span className="dot crit" />אזל <span className="n">{stats.out}</span></button>
        </div>
        <div className="ospacer" />
        <select className="osort" aria-label="מיון" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="name">מיון: שם</option>
          <option value="stock">מיון: מלאי</option>
          <option value="days">מיון: ימים למלאי</option>
          <option value="cost">מיון: עלות</option>
        </select>
        <button className="btn" onClick={exportToCSV}><Icon d={I.download} /> ייצוא CSV</button>
      </div>

      {/* Table */}
      <div className="origins-table-card">
        <div className="origins-scroll">
          <table className="origins-table">
            <thead>
              <tr>
                <th>זן</th><th>סטטוס</th>
                <th className="num">מלאי ירוק</th><th className="num">מלאי קלוי</th>
                <th className="num">ממוצע יומי</th><th className="num">ימים למלאי</th>
                <th className="num">עלות / ק"ג</th><th className="num">פעולות</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrigins.map(origin => {
                const d = derive(origin);
                const yieldPercent = 1 - (origin.weight_loss / 100);
                const roastedCost  = (origin.cost_per_kg / yieldPercent).toFixed(2);
                const barPct       = Math.min(100, Math.round((d.stock / maxStock) * 100));
                const ab           = (origin.name || '').trim().slice(0, 2);
                const rowCls       = d.status === 'ok' ? '' : d.status;
                return (
                  <tr key={origin.id} className={rowCls}>
                    <td className="name">
                      <div className="bean">
                        <div className="swatch">{ab}</div>
                        <div>
                          <div className="nm">{origin.name}</div>
                          <div className="sub">איבוד {origin.weight_loss}%</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`opill ${d.status}`}><span className="dot" />
                        {d.status === 'out' ? 'אזל' : d.status === 'low' ? 'מלאי נמוך' : 'במלאי'}
                      </span>
                    </td>
                    <td className="num ostock">
                      <div className="kg">{num(d.stock)} <small>ק"ג</small></div>
                      <div className="bar"><i style={{ width: `${barPct}%` }} /></div>
                    </td>
                    <td className="num">{num(d.roasted)} ק"ג</td>
                    <td className="num">{num(d.avg)} ק"ג</td>
                    <td className={`num odays ${d.status === 'out' ? 'crit' : d.status === 'low' ? 'warn' : ''}`}>
                      {d.days === null ? '—' : <>{d.days} <small>ימים</small></>}
                    </td>
                    <td className="num ocost">₪{num(origin.cost_per_kg, 2)}<div className="roasted">קלוי ₪{roastedCost}</div></td>
                    <td className="num">
                      <div className="oacts">
                        {(d.status === 'low' || d.status === 'out') && (
                          <button className="qbtn reorder" onClick={() => reorder(origin)}><Icon d={I.cart} size={15} /> הזמנה</button>
                        )}
                        <button className="qbtn in" title="קליטת מלאי" aria-label={`קליטת מלאי ל${origin.name}`} onClick={() => openStockIn(origin.id)}><Icon d={I.plus} size={15} /></button>
                        <button className="qbtn out" title="הוצאה לאריזה" aria-label={`הוצאה לאריזה מ${origin.name}`} onClick={() => openStockOut(origin.id)}><Icon d={I.minus} size={15} /></button>
                        <span className="odivider" />
                        <div className="okebab">
                          <button className="oico" title="עוד פעולות" aria-label={`עוד פעולות ל${origin.name}`}
                            aria-haspopup="menu" aria-expanded={openMenuId === origin.id}
                            onClick={(e) => toggleMenu(origin.id, e.currentTarget)}><Icon d={I.dots} /></button>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filteredOrigins.length === 0 && (
          <div className="empty-state">
            {searchTerm || statusFilter !== 'all' ? 'לא נמצאו תוצאות'
              : dataLoading ? 'טוען זנים…'
              : 'אין זנים עדיין. אפשר להתחיל בהוספת זן ראשון.'}
          </div>
        )}
      </div>

      {/* Kebab menu — portalled to <body> so no scroll container can clip it */}
      {openMenuId !== null && (() => {
        const origin = getOriginById(openMenuId);
        if (!origin) return null;
        return createPortal(
          <div className="omenu-portal">
            <div className="omenu-backdrop" onClick={closeMenu} />
            <div className="omenu" role="menu" ref={menuRef}
              style={{ top: menuPos ? menuPos.top : 0, left: menuPos ? menuPos.left : 0, visibility: menuPos ? 'visible' : 'hidden' }}>
              <button role="menuitem" onClick={() => openEdit(origin)}><Icon d={I.edit} /> עריכה</button>
              <button role="menuitem" onClick={() => duplicateOrigin(origin)}><Icon d={I.dup} /> שכפול</button>
              <button role="menuitem" className="del" onClick={() => deleteOrigin(origin)}><Icon d={I.trash} /> מחיקה</button>
            </div>
          </div>,
          document.body
        );
      })()}

      {/* Drawer */}
      {drawer && (
        <>
          <div className="odrawer-overlay open" onClick={closeDrawer} />
          <aside className={`odrawer open mode-${drawer.mode}`} role="dialog" aria-modal="true">
            {drawer.mode === 'in'   && StockInBody()}
            {drawer.mode === 'out'  && StockOutBody()}
            {drawer.mode === 'add'  && AddBody()}
            {drawer.mode === 'edit' && EditBody()}
          </aside>
        </>
      )}
    </div>
  );

  // ── Drawer bodies (closures over state) ───────────────────────────────────────
  function DrawerHeader({ icon, title, sub }) {
    return (
      <div className="odh">
        <div className="odh-ico">{icon}</div>
        <div><h2>{title}</h2><p>{sub}</p></div>
        <button className="oico odx" onClick={closeDrawer} aria-label="סגירה"><Icon d={I.x} /></button>
      </div>
    );
  }

  function StockInBody() {
    const origin = stockEntry.originId ? getOriginById(parseInt(stockEntry.originId)) : null;
    const next = origin ? (origin.stock || 0) + (parseFloat(stockEntry.quantity) || 0) : null;
    return (
      <>
        {DrawerHeader({ icon: <Icon d={I.box} size={18} />, title: 'קליטת מלאי', sub: 'הוספת פולים ירוקים למלאי הזן' })}
        <div className="odb">
          <div className="ofield">
            <label>זן</label>
            <select value={stockEntry.originId} onChange={e => setStockEntry({ ...stockEntry, originId: e.target.value })}>
              <option value="">בחירת זן…</option>
              {data.origins.map(o => <option key={o.id} value={o.id}>{o.name} (מלאי: {num(o.stock)} ק"ג)</option>)}
            </select>
          </div>
          <div className="ofield">
            <label>כמות להוספה (ק"ג)</label>
            <div className="ostepper">
              <button type="button" aria-label="פחות" onClick={() => bumpInQty(-1)}><Icon d={I.minus} /></button>
              <input type="number" step="0.5" placeholder="למשל: 25" value={stockEntry.quantity} onChange={e => setStockEntry({ ...stockEntry, quantity: e.target.value })} />
              <button type="button" aria-label="יותר" onClick={() => bumpInQty(1)}><Icon d={I.plus} /></button>
            </div>
            <div className="ohelper">משקל הפולים הירוקים שנקלטו</div>
          </div>
          <div className="ofield">
            <label>הערות (אופציונלי)</label>
            <textarea rows="2" placeholder="למשל: ספק, מספר הזמנה…" value={stockEntry.notes} onChange={e => setStockEntry({ ...stockEntry, notes: e.target.value })} />
          </div>
          {origin && <div className="olive">מלאי ירוק של <b>{origin.name}</b>: <b>{num(origin.stock)}</b> ← <b>{num(next)} ק"ג</b></div>}
        </div>
        <div className="odf">
          <button className="btn" onClick={closeDrawer}>ביטול</button>
          <button className="btn primary" onClick={addStockEntry}>הוספה למלאי</button>
        </div>
      </>
    );
  }

  function StockOutBody() {
    const origin = stockOut.originId ? getOriginById(parseInt(stockOut.originId)) : null;
    const next = origin ? Math.max(0, (origin.roasted_stock || 0) - (parseFloat(stockOut.quantity) || 0)) : null;
    return (
      <>
        {DrawerHeader({ icon: <Icon d={I.out} size={18} />, title: 'הוצאה לאריזה', sub: 'הוצאת מלאי קלוי לאריזה' })}
        <div className="odb">
          <div className="ofield">
            <label>זן</label>
            <select value={stockOut.originId} onChange={e => {
              const originId = e.target.value;
              const o = getOriginById(parseInt(originId));
              const yieldPercent = o ? (1 - (o.weight_loss / 100)) : 1;
              setStockOut({ ...stockOut, originId, quantity: originId ? (15 * yieldPercent).toFixed(1) : '' });
            }}>
              <option value="">בחירת זן…</option>
              {data.origins.map(o => <option key={o.id} value={o.id}>{o.name} (מלאי קלוי: {num(o.roasted_stock)} ק"ג)</option>)}
            </select>
          </div>
          <div className="ofield">
            <label>משקל להוצאה (ק"ג)</label>
            <div className="ostepper">
              <button type="button" aria-label="פחות" onClick={() => bumpOutQty(-1)}><Icon d={I.minus} /></button>
              <input type="number" step="0.5" placeholder="משקל דלי" value={stockOut.quantity} onChange={e => setStockOut({ ...stockOut, quantity: e.target.value })} />
              <button type="button" aria-label="יותר" onClick={() => bumpOutQty(1)}><Icon d={I.plus} /></button>
            </div>
            {stockOut.originId && <div className="ohelper">ברירת מחדל: משקל אחרי קלייה (15 ק"ג ירוק)</div>}
          </div>
          <div className="ofield">
            <label>הערות (אופציונלי)</label>
            <textarea rows="2" placeholder="למשל: דלי #1234, מיועד לאריזה…" value={stockOut.notes} onChange={e => setStockOut({ ...stockOut, notes: e.target.value })} />
          </div>
          {origin && <div className="olive">מלאי קלוי של <b>{origin.name}</b>: <b>{num(origin.roasted_stock)}</b> ← <b>{num(next)} ק"ג</b></div>}
        </div>
        <div className="odf">
          <button className="btn" onClick={closeDrawer}>ביטול</button>
          <button className="btn primary" onClick={removeStockForPackaging}>הוצאה מהמלאי</button>
        </div>
      </>
    );
  }

  function AddBody() {
    return (
      <>
        {DrawerHeader({ icon: <Icon d={I.plus} size={18} />, title: 'הוספת זן חדש', sub: 'פרטי הזן ומלאי התחלתי' })}
        <div className="odb">
          <div className="ofield"><label>שם הזן</label><input type="text" placeholder="למשל: ברזיל סנטוס" value={newOrigin.name} onChange={e => setNewOrigin({ ...newOrigin, name: e.target.value })} /></div>
          <div className="ofield"><label>איבוד משקל בקלייה (%)</label><input type="number" value={newOrigin.weightLoss} onChange={e => setNewOrigin({ ...newOrigin, weightLoss: e.target.value })} /></div>
          <div className="ofield"><label>עלות לק"ג ירוק (₪)</label><input type="number" step="0.01" placeholder="45.00" value={newOrigin.costPerKg} onChange={e => setNewOrigin({ ...newOrigin, costPerKg: e.target.value })} /></div>
          <div className="ofield"><label>מלאי התחלתי (ק"ג)</label><input type="number" step="0.1" value={newOrigin.stock} onChange={e => setNewOrigin({ ...newOrigin, stock: e.target.value })} /></div>
          <div className="ofield"><label>מלאי מינימום (ק"ג)</label><input type="number" step="0.1" placeholder="10" value={newOrigin.minStock} onChange={e => setNewOrigin({ ...newOrigin, minStock: e.target.value })} /></div>
          <div className="ofield"><label>הערות</label><textarea rows="2" placeholder="פרטים נוספים…" value={newOrigin.notes} onChange={e => setNewOrigin({ ...newOrigin, notes: e.target.value })} /></div>
        </div>
        <div className="odf">
          <button className="btn" onClick={closeDrawer}>ביטול</button>
          <button className="btn primary" onClick={addOrigin}>הוספת זן</button>
        </div>
      </>
    );
  }

  function EditBody() {
    if (!editingOrigin) return null;
    const set = (patch) => setEditingOrigin({ ...editingOrigin, ...patch });
    return (
      <>
        {DrawerHeader({ icon: <Icon d={I.edit} size={18} />, title: 'עריכת זן', sub: editingOrigin.name })}
        <div className="odb">
          <div className="ofield"><label>שם הזן</label><input type="text" value={editingOrigin.name} onChange={e => set({ name: e.target.value })} /></div>
          <div className="ofield"><label>איבוד משקל בקלייה (%)</label><input type="number" value={editingOrigin.weightLoss} onChange={e => set({ weightLoss: e.target.value })} /></div>
          <div className="ofield"><label>עלות לק"ג ירוק (₪)</label><input type="number" step="0.01" value={editingOrigin.costPerKg} onChange={e => set({ costPerKg: e.target.value })} /></div>
          <div className="ofield"><label>מלאי ירוק (ק"ג)</label><input type="number" step="0.1" value={editingOrigin.stock} onChange={e => set({ stock: e.target.value })} /></div>
          <div className="ofield"><label>מלאי קלוי (ק"ג)</label><input type="number" step="0.1" value={editingOrigin.roastedStock} onChange={e => set({ roastedStock: e.target.value })} /></div>
          <div className="ofield"><label>ממוצע מכירות יומי (ק"ג)</label><input type="number" step="0.1" value={editingOrigin.dailyAverage} onChange={e => set({ dailyAverage: e.target.value })} /></div>
          <div className="ofield"><label>מלאי מינימום (ק"ג)</label><input type="number" step="0.1" value={editingOrigin.minStock} onChange={e => set({ minStock: e.target.value })} /></div>
          <div className="ofield"><label>הערות</label><textarea rows="2" value={editingOrigin.notes} onChange={e => set({ notes: e.target.value })} /></div>
        </div>
        <div className="odf">
          <button className="btn" onClick={() => { setEditingOrigin(null); closeDrawer(); }}>ביטול</button>
          <button className="btn primary" onClick={saveEdit}>שמירת שינויים</button>
        </div>
      </>
    );
  }
}
