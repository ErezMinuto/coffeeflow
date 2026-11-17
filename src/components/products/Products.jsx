import React, { useState } from 'react';
import { Plus, Pencil, Copy, Trash2, Check, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useApp } from '../../lib/context';
import { reservedBagsByProduct, storeStock, webOwed } from '../../lib/reservedStock';
import { PageHeader } from '../shared/ui';
import './products.css';

// ── Helpers ───────────────────────────────────────────────────────────────────

const emptyIngredient = () => ({ sourceType: 'origin', sourceId: '', percentage: 0 });

const toSelectValue = (ing) => {
  if (ing.sourceType === 'profile' && ing.sourceId) return `profile:${ing.sourceId}`;
  const sid = ing.sourceId || ing.originId || '';
  return sid ? `origin:${sid}` : '';
};

const fromSelectValue = (val) => {
  if (!val) return { sourceType: 'origin', sourceId: '' };
  const [type, id] = val.split(':');
  return { sourceType: type, sourceId: parseInt(id) };
};

// ── RecipeForm — defined OUTSIDE Products so React never remounts it ──────────

function RecipeForm({ recipe, onChange, origins, roastProfiles }) {
  const total = recipe.reduce((s, i) => s + (parseFloat(i.percentage) || 0), 0);

  const updateIngredient = (index, changes) =>
    onChange(recipe.map((ing, i) => i === index ? { ...ing, ...changes } : ing));

  const addIngredient = () =>
    onChange([...recipe, emptyIngredient()]);

  const removeIngredient = (index) =>
    onChange(recipe.filter((_, i) => i !== index));

  return (
    <div className="form-group prod-recipe-form">
      <span className="field-label">מתכון *</span>
      <span className="field-help">סך האחוזים צריך להיות 100%</span>
      {recipe.map((ing, index) => (
        <div key={index} className="prod-recipe-row">
          <select
            aria-label={`מקור לרכיב ${index + 1}`}
            value={toSelectValue(ing)}
            onChange={e => updateIngredient(index, fromSelectValue(e.target.value))}
          >
            <option value="">בחירת מקור...</option>
            {roastProfiles.length > 0 && (
              <optgroup label="פרופילי קלייה">
                {roastProfiles.map(p => (
                  <option key={`profile:${p.id}`} value={`profile:${p.id}`}>
                    {p.name}{p.roast_level && p.roast_level !== 'none' ? ` (${p.roast_level})` : ''}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="זנים">
              {origins.map(o => (
                <option key={`origin:${o.id}`} value={`origin:${o.id}`}>{o.name}</option>
              ))}
            </optgroup>
          </select>
          <input
            type="number" placeholder="%" min="0" max="100" step="0.1"
            aria-label={`אחוז לרכיב ${index + 1}`}
            value={ing.percentage}
            onChange={e => updateIngredient(index, { percentage: parseFloat(e.target.value) || 0 })}
          />
          {recipe.length > 1 ? (
            <button
              type="button"
              onClick={() => removeIngredient(index)}
              className="btn-icon danger"
              aria-label={`הסרת רכיב ${index + 1}`}
              title="הסרת רכיב"
            ><Trash2 aria-hidden="true" /></button>
          ) : <span className="prod-recipe-spacer" aria-hidden="true" />}
        </div>
      ))}
      <div className="prod-recipe-foot">
        <button type="button" onClick={addIngredient} className="btn sm"><Plus aria-hidden="true" />הוספת רכיב</button>
        <span className={`prod-recipe-total num ${total === 100 ? 'ok' : 'off'}`}>
          סה״כ {total}%
        </span>
      </div>
    </div>
  );
}

// ── Products ──────────────────────────────────────────────────────────────────

export default function Products() {
  const { data, productsDb, calculateProductCost, showToast } = useApp();
  const reserved = reservedBagsByProduct(data.bagAllocations);

  const [editingProduct,    setEditingProduct]    = useState(null);
  const [addingProduct,     setAddingProduct]     = useState(false);
  const [showBreakdownId,   setShowBreakdownId]   = useState(null);
  const [adjustingStockId,  setAdjustingStockId]  = useState(null);
  const [adjustValue,       setAdjustValue]       = useState("");
  const [newProduct, setNewProduct] = useState({
    name: '', size: 330, type: 'single', description: '', min_packed_stock: 0,
    recipe: [{ sourceType: 'origin', sourceId: '', percentage: 100 }]
  });

  // ── Ingredient name display ─────────────────────────────────────────────────

  const getIngredientLabel = (ing) => {
    if (ing.sourceType === 'profile' && ing.sourceId) {
      return data.roastProfiles.find(p => p.id === ing.sourceId)?.name || '—';
    }
    const originId = ing.sourceId || ing.originId;
    return data.origins.find(o => o.id === originId)?.name || '—';
  };

  // ── Validation ──────────────────────────────────────────────────────────────

  const validateProduct = (product) => {
    if (!product.name.trim()) { showToast('נא למלא שם מוצר', 'warning'); return false; }
    if (!product.size || product.size <= 0) { showToast('נא למלא גודל מוצר', 'warning'); return false; }
    if (!product.recipe || product.recipe.length === 0) { showToast('נא להוסיף לפחות רכיב אחד', 'warning'); return false; }
    for (const ing of product.recipe) {
      if (!ing.sourceId && !ing.originId) { showToast('נא לבחור מקור לכל רכיב', 'warning'); return false; }
    }
    const total = product.recipe.reduce((s, i) => s + (parseFloat(i.percentage) || 0), 0);
    if (Math.abs(total - 100) > 0.1) {
      showToast(`סכום האחוזים חייב להיות 100% (כרגע: ${total}%)`, 'warning');
      return false;
    }
    return true;
  };

  // ── CRUD ────────────────────────────────────────────────────────────────────

  const saveNewProduct = async () => {
    if (!validateProduct(newProduct)) return;
    try {
      await productsDb.insert({
        name: newProduct.name, size: parseInt(newProduct.size),
        type: newProduct.type, description: newProduct.description,
        min_packed_stock: parseInt(newProduct.min_packed_stock) || 0,
        recipe: newProduct.recipe
      });
      await productsDb.refresh();
      setAddingProduct(false);
      setNewProduct({ name: '', size: 330, type: 'single', description: '', min_packed_stock: 0, recipe: [{ sourceType: 'origin', sourceId: '', percentage: 100 }] });
      showToast('מוצר נוסף בהצלחה!');
    } catch (err) {
      console.error(err);
      showToast('שגיאה בהוספת מוצר', 'error');
    }
  };

  const startEditProduct = (product) => {
    const recipe = (product.recipe || []).map(ing =>
      ing.sourceType ? { ...ing } : { sourceType: 'origin', sourceId: ing.originId, percentage: ing.percentage }
    );
    setEditingProduct({ ...product, recipe });
  };

  const saveEditProduct = async () => {
    if (!validateProduct(editingProduct)) return;
    try {
      await productsDb.update(editingProduct.id, {
        name: editingProduct.name, size: parseInt(editingProduct.size),
        type: editingProduct.type, description: editingProduct.description,
        min_packed_stock: parseInt(editingProduct.min_packed_stock) || 0,
        recipe: editingProduct.recipe, updated_at: new Date().toISOString()
      });
      setEditingProduct(null);
      showToast('מוצר עודכן בהצלחה!');
    } catch (err) {
      console.error(err);
      showToast('שגיאה בעדכון מוצר', 'error');
    }
  };

  const deleteProduct = async (product) => {
    if (!window.confirm(`האם למחוק את המוצר "${product.name} ${product.size}g"?`)) return;
    try {
      await productsDb.remove(product.id);
      showToast('מוצר נמחק!');
    } catch (err) {
      console.error(err);
      showToast('שגיאה במחיקת מוצר', 'error');
    }
  };

  const savePackedStock = async (product) => {
    const val = parseInt(adjustValue);
    if (isNaN(val) || val < 0) { showToast('כמות לא תקינה', 'warning'); return; }
    try {
      await productsDb.update(product.id, { packed_stock: val });
      setAdjustingStockId(null);
      showToast('מלאי עודכן!');
    } catch (err) {
      console.error(err);
      showToast('שגיאה בעדכון מלאי', 'error');
    }
  };

  const duplicateProduct = async (product) => {
    try {
      await productsDb.insert({ name: product.name + ' (עותק)', size: product.size, type: product.type, description: product.description, recipe: product.recipe });
      showToast('מוצר שוכפל!');
    } catch (err) {
      console.error(err);
      showToast('שגיאה בשכפול מוצר', 'error');
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="page products-page">
      <PageHeader
        title="מוצרים"
        subtitle={`${data.products.length} מוצרים בקטלוג`}
        actions={!addingProduct && !editingProduct && (
          <button type="button" onClick={() => setAddingProduct(true)} className="btn primary">
            <Plus aria-hidden="true" />מוצר חדש
          </button>
        )}
      />

      {/* Add form */}
      {addingProduct && (
        <section className="card prod-form">
          <h2>מוצר חדש</h2>
          <div className="form-group">
            <label htmlFor="prod-new-name">שם המוצר *</label>
            <input id="prod-new-name" type="text" placeholder="למשל: Kenya Light 330g" value={newProduct.name} onChange={e => setNewProduct({...newProduct, name: e.target.value})} />
          </div>
          <div className="prod-form-row">
            <div className="form-group">
              <label htmlFor="prod-new-size">גודל (גרם) *</label>
              <input id="prod-new-size" type="number" placeholder="330" value={newProduct.size} onChange={e => setNewProduct({...newProduct, size: e.target.value})} />
            </div>
            <div className="form-group">
              <label htmlFor="prod-new-type">סוג</label>
              <select id="prod-new-type" value={newProduct.type} onChange={e => setNewProduct({...newProduct, type: e.target.value})}>
                <option value="single">חד-זני</option>
                <option value="blend">תערובת</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="prod-new-desc">תיאור (אופציונלי)</label>
            <input id="prod-new-desc" type="text" placeholder="למשל: פירותי ומרענן" value={newProduct.description} onChange={e => setNewProduct({...newProduct, description: e.target.value})} />
          </div>
          <div className="form-group">
            <label htmlFor="prod-new-min">מינימום שקיות ארוזות</label>
            <input id="prod-new-min" type="number" min="0" placeholder="0" value={newProduct.min_packed_stock} onChange={e => setNewProduct({...newProduct, min_packed_stock: e.target.value})} />
            <span className="field-help">מתחת לכמות הזו תופיע התראת מלאי</span>
          </div>
          <RecipeForm
            recipe={newProduct.recipe}
            onChange={recipe => setNewProduct({ ...newProduct, recipe })}
            origins={data.origins}
            roastProfiles={data.roastProfiles}
          />
          <div className="prod-form-actions">
            <button type="button" onClick={saveNewProduct} className="btn primary">שמירת מוצר</button>
            <button type="button" onClick={() => setAddingProduct(false)} className="btn">ביטול</button>
          </div>
        </section>
      )}

      {/* Edit form */}
      {editingProduct && (
        <section className="card prod-form">
          <h2>עריכת מוצר: {editingProduct.name}</h2>
          <div className="form-group">
            <label htmlFor="prod-edit-name">שם המוצר *</label>
            <input id="prod-edit-name" type="text" value={editingProduct.name} onChange={e => setEditingProduct({...editingProduct, name: e.target.value})} />
          </div>
          <div className="prod-form-row">
            <div className="form-group">
              <label htmlFor="prod-edit-size">גודל (גרם) *</label>
              <input id="prod-edit-size" type="number" value={editingProduct.size} onChange={e => setEditingProduct({...editingProduct, size: e.target.value})} />
            </div>
            <div className="form-group">
              <label htmlFor="prod-edit-type">סוג</label>
              <select id="prod-edit-type" value={editingProduct.type} onChange={e => setEditingProduct({...editingProduct, type: e.target.value})}>
                <option value="single">חד-זני</option>
                <option value="blend">תערובת</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="prod-edit-desc">תיאור</label>
            <input id="prod-edit-desc" type="text" value={editingProduct.description || ''} onChange={e => setEditingProduct({...editingProduct, description: e.target.value})} />
          </div>
          <div className="form-group">
            <label htmlFor="prod-edit-min">מינימום שקיות ארוזות</label>
            <input id="prod-edit-min" type="number" min="0" value={editingProduct.min_packed_stock ?? 0} onChange={e => setEditingProduct({...editingProduct, min_packed_stock: e.target.value})} />
            <span className="field-help">מתחת לכמות הזו תופיע התראת מלאי</span>
          </div>
          <RecipeForm
            recipe={editingProduct.recipe}
            onChange={recipe => setEditingProduct({ ...editingProduct, recipe })}
            origins={data.origins}
            roastProfiles={data.roastProfiles}
          />
          <div className="prod-form-actions">
            <button type="button" onClick={saveEditProduct} className="btn primary">שמירת שינויים</button>
            <button type="button" onClick={() => setEditingProduct(null)} className="btn">ביטול</button>
          </div>
        </section>
      )}

      {/* Products grid */}
      {!addingProduct && !editingProduct && (
        <div className="prod-grid">
          {data.products.map(product => {
            const cost      = calculateProductCost(product);
            const breakdown = calculateProductCost(product, true);
            const isOpen    = showBreakdownId === product.id;
            const stockTone = storeStock(product, reserved) === 0 ? 'danger'
                            : (product.min_packed_stock > 0 && storeStock(product, reserved) <= product.min_packed_stock) ? 'warn'
                            : 'ok';

            return (
              <article key={product.id} className="card flush prod-card">
                <header className="prod-head">
                  <div className="prod-title">
                    <h3>{product.name}</h3>
                    {product.description && <p className="prod-desc">{product.description}</p>}
                  </div>
                  <span className="tag num">{product.size}g</span>
                </header>

                <div className="prod-recipe-block">
                  <div className="prod-label">מתכון</div>
                  <ul className="prod-recipe">
                    {(product.recipe || []).map((ing, i) => (
                      <li key={i}>
                        <span className="prod-recipe-name">{getIngredientLabel(ing)}</span>
                        <span className="prod-recipe-pct num">{ing.percentage}%</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="prod-stats">
                  {adjustingStockId === product.id ? (
                    <div className="prod-stat prod-stat-editing">
                      <label className="prod-label" htmlFor={`prod-stock-${product.id}`}>שקיות ארוזות</label>
                      <div className="prod-stock-edit">
                        <input
                          id={`prod-stock-${product.id}`}
                          type="number" min="0"
                          value={adjustValue}
                          onChange={e => setAdjustValue(e.target.value)}
                          autoFocus
                        />
                        <button type="button" onClick={() => savePackedStock(product)} className="btn-icon" aria-label="שמירת כמות" title="שמירה"><Check aria-hidden="true" /></button>
                        <button type="button" onClick={() => setAdjustingStockId(null)} className="btn-icon" aria-label="ביטול עדכון" title="ביטול"><X aria-hidden="true" /></button>
                      </div>
                    </div>
                  ) : (
                    <div className="prod-stat">
                      <span className="prod-label">שקיות ארוזות</span>
                      <div className="prod-stat-value">
                        <span className={`dot ${stockTone}`} aria-hidden="true" />
                        <span className="num">{Math.max(0, product.packed_stock ?? 0)}</span>
                      </div>
                      <button
                        type="button"
                        className="btn ghost sm prod-stat-link"
                        onClick={() => { setAdjustingStockId(product.id); setAdjustValue(String(product.packed_stock ?? 0)); }}
                      >עדכון כמות</button>
                    </div>
                  )}

                  <div className="prod-stat">
                    <span className="prod-label">עלות ייצור</span>
                    <div className="prod-stat-value"><span className="num">₪{cost}</span></div>
                    <button
                      type="button"
                      className="btn ghost sm prod-stat-link"
                      aria-expanded={isOpen}
                      onClick={() => setShowBreakdownId(isOpen ? null : product.id)}
                    >
                      {isOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                      {isOpen ? 'הסתרת פירוט' : 'פירוט עלות'}
                    </button>
                  </div>
                </div>

                {(webOwed(product) > 0 || (reserved[product.id] || 0) > 0) && (
                  <div className="prod-stock-notes">
                    {webOwed(product) > 0 && (
                      <span className="tag warn num" title="הזמנות אתר שנמכרו לפני שנארזו. האריזה הבאה מכסה אותן קודם.">
                        {webOwed(product)} חסרות להזמנות אתר
                      </span>
                    )}
                    {(reserved[product.id] || 0) > 0 && (
                      <span className="tag num">{reserved[product.id]} מוקצות ללקוחות עסקיים</span>
                    )}
                  </div>
                )}

                {isOpen && (
                  <dl className="prod-breakdown">
                    <div><dt>פולים קלויים</dt><dd className="num">₪{breakdown.beansCost}</dd></div>
                    <div><dt>גז</dt><dd className="num">₪{breakdown.gasCost}</dd></div>
                    <div><dt>עבודה (קלייה)</dt><dd className="num">₪{breakdown.roastingLabor}</dd></div>
                    <div><dt>אריזה</dt><dd className="num">₪{breakdown.packagingCost}</dd></div>
                    <div><dt>עבודה (אריזה)</dt><dd className="num">₪{breakdown.packagingLabor}</dd></div>
                    <div className="prod-breakdown-total"><dt>סה״כ</dt><dd className="num">₪{breakdown.totalCost}</dd></div>
                  </dl>
                )}

                <footer className="prod-actions action-buttons">
                  <button type="button" onClick={() => startEditProduct(product)} className="btn-icon" aria-label={`עריכת ${product.name}`} title="עריכה"><Pencil aria-hidden="true" /></button>
                  <button type="button" onClick={() => duplicateProduct(product)} className="btn-icon" aria-label={`שכפול ${product.name}`} title="שכפול"><Copy aria-hidden="true" /></button>
                  <button type="button" onClick={() => deleteProduct(product)} className="btn-icon danger" aria-label={`מחיקת ${product.name}`} title="מחיקה"><Trash2 aria-hidden="true" /></button>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {data.products.length === 0 && (
        <div className="card empty-state">אין מוצרים עדיין. אפשר להתחיל ב״מוצר חדש״.</div>
      )}
    </div>
  );
}
