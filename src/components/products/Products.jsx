import React, { useState } from 'react';
import { useApp } from '../../lib/context';

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
    <div className="form-group">
      <label>מתכון (סה"כ חייב להיות 100%) *</label>
      {recipe.map((ing, index) => (
        <div key={index} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '10px', marginBottom: '10px' }}>
          <select
            value={toSelectValue(ing)}
            onChange={e => updateIngredient(index, fromSelectValue(e.target.value))}
          >
            <option value="">בחר מקור...</option>
            {roastProfiles.length > 0 && (
              <optgroup label="🔥 פרופילי קלייה">
                {roastProfiles.map(p => (
                  <option key={`profile:${p.id}`} value={`profile:${p.id}`}>
                    {p.name}{p.roast_level && p.roast_level !== 'none' ? ` (${p.roast_level})` : ''}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="🌱 זנים">
              {origins.map(o => (
                <option key={`origin:${o.id}`} value={`origin:${o.id}`}>{o.name}</option>
              ))}
            </optgroup>
          </select>
          <input
            type="number" placeholder="%" min="0" max="100" step="0.1"
            value={ing.percentage}
            onChange={e => updateIngredient(index, { percentage: parseFloat(e.target.value) || 0 })}
          />
          {recipe.length > 1 && (
            <button
              onClick={() => removeIngredient(index)}
              className="btn-small"
              style={{ background: '#FEE2E2', color: '#991B1B' }}
            >🗑️</button>
          )}
        </div>
      ))}
      <button onClick={addIngredient} className="btn-small" style={{ marginTop: '5px' }}>➕ הוסף רכיב</button>
      <div style={{ marginTop: '10px', fontSize: '14px', color: total === 100 ? '#059669' : '#DC2626' }}>
        סה"כ: {total}%
      </div>
    </div>
  );
}

// ── Products ──────────────────────────────────────────────────────────────────

export default function Products() {
  const { data, productsDb, calculateProductCost, showToast } = useApp();

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
    if (!product.name.trim()) { showToast('⚠️ נא למלא שם מוצר', 'warning'); return false; }
    if (!product.size || product.size <= 0) { showToast('⚠️ נא למלא גודל מוצר', 'warning'); return false; }
    if (!product.recipe || product.recipe.length === 0) { showToast('⚠️ נא להוסיף לפחות רכיב אחד', 'warning'); return false; }
    for (const ing of product.recipe) {
      if (!ing.sourceId && !ing.originId) { showToast('⚠️ נא לבחור מקור לכל רכיב', 'warning'); return false; }
    }
    const total = product.recipe.reduce((s, i) => s + (parseFloat(i.percentage) || 0), 0);
    if (Math.abs(total - 100) > 0.1) {
      showToast(`⚠️ סכום האחוזים חייב להיות 100% (כרגע: ${total}%)`, 'warning');
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
      showToast('✅ מוצר נוסף בהצלחה!');
    } catch (err) {
      console.error(err);
      showToast('❌ שגיאה בהוספת מוצר', 'error');
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
      showToast('✅ מוצר עודכן בהצלחה!');
    } catch (err) {
      console.error(err);
      showToast('❌ שגיאה בעדכון מוצר', 'error');
    }
  };

  const deleteProduct = async (product) => {
    if (!window.confirm(`⚠️ האם למחוק את המוצר "${product.name} ${product.size}g"?`)) return;
    try {
      await productsDb.remove(product.id);
      showToast('✅ מוצר נמחק!');
    } catch (err) {
      console.error(err);
      showToast('❌ שגיאה במחיקת מוצר', 'error');
    }
  };

  const savePackedStock = async (product) => {
    const val = parseInt(adjustValue);
    if (isNaN(val) || val < 0) { showToast('⚠️ כמות לא תקינה', 'warning'); return; }
    try {
      await productsDb.update(product.id, { packed_stock: val });
      setAdjustingStockId(null);
      showToast('✅ מלאי עודכן!');
    } catch (err) {
      console.error(err);
      showToast('❌ שגיאה בעדכון מלאי', 'error');
    }
  };

  const duplicateProduct = async (product) => {
    try {
      await productsDb.insert({ name: product.name + ' (עותק)', size: product.size, type: product.type, description: product.description, recipe: product.recipe });
      showToast('✅ מוצר שוכפל!');
    } catch (err) {
      console.error(err);
      showToast('❌ שגיאה בשכפול מוצר', 'error');
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1>📦 מוצרים ({data.products.length})</h1>
        {!addingProduct && !editingProduct && (
          <button onClick={() => setAddingProduct(true)} className="btn-primary">➕ הוסף מוצר</button>
        )}
      </div>

      {/* Add form */}
      {addingProduct && (
        <div className="form-card" style={{ marginBottom: '20px', background: '#F0F9FF', border: '2px solid #3B82F6' }}>
          <h3>➕ הוסף מוצר חדש</h3>
          <div className="form-group">
            <label>שם המוצר *</label>
            <input type="text" placeholder="למשל: Kenya Light 250g" value={newProduct.name} onChange={e => setNewProduct({...newProduct, name: e.target.value})} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group">
              <label>גודל (גרם) *</label>
              <input type="number" placeholder="330" value={newProduct.size} onChange={e => setNewProduct({...newProduct, size: e.target.value})} />
            </div>
            <div className="form-group">
              <label>סוג</label>
              <select value={newProduct.type} onChange={e => setNewProduct({...newProduct, type: e.target.value})}>
                <option value="single">חד-זני</option>
                <option value="blend">תערובת</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>תיאור (אופציונלי)</label>
            <input type="text" placeholder="למשל: פירותי ומרענן" value={newProduct.description} onChange={e => setNewProduct({...newProduct, description: e.target.value})} />
          </div>
          <div className="form-group">
            <label>מינימום שקיות ארוזות (התראת מלאי)</label>
            <input type="number" min="0" placeholder="0" value={newProduct.min_packed_stock} onChange={e => setNewProduct({...newProduct, min_packed_stock: e.target.value})} />
          </div>
          <RecipeForm
            recipe={newProduct.recipe}
            onChange={recipe => setNewProduct({ ...newProduct, recipe })}
            origins={data.origins}
            roastProfiles={data.roastProfiles}
          />
          <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
            <button onClick={saveNewProduct} className="btn-primary" style={{ flex: 1 }}>💾 שמור מוצר</button>
            <button onClick={() => setAddingProduct(false)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
          </div>
        </div>
      )}

      {/* Edit form */}
      {editingProduct && (
        <div className="form-card" style={{ marginBottom: '20px', background: '#FFF9F0', border: '2px solid #FF6B35' }}>
          <h3>✏️ עריכת מוצר: {editingProduct.name}</h3>
          <div className="form-group">
            <label>שם המוצר *</label>
            <input type="text" value={editingProduct.name} onChange={e => setEditingProduct({...editingProduct, name: e.target.value})} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group">
              <label>גודל (גרם) *</label>
              <input type="number" value={editingProduct.size} onChange={e => setEditingProduct({...editingProduct, size: e.target.value})} />
            </div>
            <div className="form-group">
              <label>סוג</label>
              <select value={editingProduct.type} onChange={e => setEditingProduct({...editingProduct, type: e.target.value})}>
                <option value="single">חד-זני</option>
                <option value="blend">תערובת</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>תיאור</label>
            <input type="text" value={editingProduct.description || ''} onChange={e => setEditingProduct({...editingProduct, description: e.target.value})} />
          </div>
          <div className="form-group">
            <label>מינימום שקיות ארוזות (התראת מלאי)</label>
            <input type="number" min="0" value={editingProduct.min_packed_stock ?? 0} onChange={e => setEditingProduct({...editingProduct, min_packed_stock: e.target.value})} />
          </div>
          <RecipeForm
            recipe={editingProduct.recipe}
            onChange={recipe => setEditingProduct({ ...editingProduct, recipe })}
            origins={data.origins}
            roastProfiles={data.roastProfiles}
          />
          <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
            <button onClick={saveEditProduct} className="btn-primary" style={{ flex: 1 }}>💾 שמור שינויים</button>
            <button onClick={() => setEditingProduct(null)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
          </div>
        </div>
      )}

      {/* Products grid */}
      {!addingProduct && !editingProduct && (
        <div className="products-grid">
          {data.products.map(product => {
            const cost      = calculateProductCost(product);
            const breakdown = calculateProductCost(product, true);
            const isOpen    = showBreakdownId === product.id;

            return (
              <div key={product.id} className="product-card">
                <div className="product-header">
                  <h3>{product.name}</h3>
                  <span className="badge">{product.size}g</span>
                </div>

                {product.description && (
                  <div style={{ padding: '0.5rem 0', fontSize: '0.875rem', color: '#6F4E37', fontStyle: 'italic', borderBottom: '1px solid #F4E8D8', marginBottom: '0.5rem' }}>
                    {product.description}
                  </div>
                )}

                <div className="product-recipe">
                  <strong>מתכון:</strong>
                  {(product.recipe || []).map((ing, i) => (
                    <div key={i} className="recipe-item">• {ing.percentage}% {getIngredientLabel(ing)}</div>
                  ))}
                </div>

                <div style={{ padding: '0.5rem 0', borderBottom: '1px solid #F4E8D8', marginBottom: '0.5rem' }}>
                  {adjustingStockId === product.id ? (
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <span style={{ fontSize: '13px', color: '#6F4E37' }}>שקיות ארוזות:</span>
                      <input
                        type="number" min="0"
                        value={adjustValue}
                        onChange={e => setAdjustValue(e.target.value)}
                        style={{ width: '70px', padding: '2px 6px', border: '1px solid #D4A574', borderRadius: '4px', fontSize: '13px' }}
                        autoFocus
                      />
                      <button onClick={() => savePackedStock(product)} className="btn-small" style={{ background: '#D1FAE5', color: '#065F46', padding: '2px 8px' }}>✓</button>
                      <button onClick={() => setAdjustingStockId(null)} className="btn-small" style={{ padding: '2px 8px' }}>✕</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '13px', color: '#6F4E37' }}>שקיות ארוזות:</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{
                          fontWeight: 'bold', fontSize: '14px',
                          color: (product.packed_stock ?? 0) === 0 ? '#DC2626'
                               : (product.min_packed_stock > 0 && (product.packed_stock ?? 0) <= product.min_packed_stock) ? '#D97706'
                               : '#059669'
                        }}>
                          {product.packed_stock ?? 0}
                        </span>
                        <button
                          onClick={() => { setAdjustingStockId(product.id); setAdjustValue(String(product.packed_stock ?? 0)); }}
                          style={{ fontSize: '11px', padding: '1px 6px', background: 'transparent', border: '1px solid #D4A574', borderRadius: '4px', cursor: 'pointer', color: '#6F4E37' }}
                        >עדכן</button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="product-cost">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>עלות ייצור:</span>
                    <strong>₪{cost}</strong>
                  </div>
                  <button
                    onClick={() => setShowBreakdownId(isOpen ? null : product.id)}
                    style={{ fontSize: '11px', padding: '2px 8px', marginTop: '5px', background: 'transparent', border: '1px solid #D4A574', borderRadius: '4px', cursor: 'pointer', color: '#6F4E37' }}
                  >
                    {isOpen ? '🔼 הסתר פירוט' : '🔽 פירוט מלא'}
                  </button>
                  {isOpen && (
                    <div style={{ marginTop: '10px', padding: '10px', background: '#FFFBF5', borderRadius: '6px', fontSize: '12px', border: '1px solid #F4E8D8' }}>
                      <div style={{ marginBottom: '5px' }}>☕ פולים קלויים: ₪{breakdown.beansCost}</div>
                      <div style={{ marginBottom: '5px' }}>🔥 גז: ₪{breakdown.gasCost}</div>
                      <div style={{ marginBottom: '5px' }}>👨‍🍳 עבודה (קלייה): ₪{breakdown.roastingLabor}</div>
                      <div style={{ marginBottom: '5px' }}>📦 אריזה: ₪{breakdown.packagingCost}</div>
                      <div style={{ marginBottom: '5px' }}>👷 עבודה (אריזה): ₪{breakdown.packagingLabor}</div>
                      <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #D4A574', fontWeight: 'bold', color: '#6F4E37' }}>
                        💰 סה"כ: ₪{breakdown.totalCost}
                      </div>
                    </div>
                  )}
                </div>

                <div className="product-actions">
                  <button onClick={() => startEditProduct(product)} className="btn-small">✏️</button>
                  <button onClick={() => duplicateProduct(product)} className="btn-small" style={{ background: '#D1FAE5', color: '#065F46' }}>📋</button>
                  <button onClick={() => deleteProduct(product)} className="btn-small" style={{ background: '#FEE2E2', color: '#991B1B' }}>🗑️</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {data.products.length === 0 && (
        <div className="empty-state">אין מוצרים עדיין. הוסף מוצר ראשון!</div>
      )}
    </div>
  );
}
