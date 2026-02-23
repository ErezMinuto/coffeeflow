  // רכיב מוצרים (Products)
  const Products = () => {
    const [editingProduct, setEditingProduct] = useState(null);
    const [addingProduct, setAddingProduct] = useState(false);
    const [showBreakdownId, setShowBreakdownId] = useState(null);
    const [newProduct, setNewProduct] = useState({
      name: '',
      size: 330,
      type: 'single',
      description: '',
      recipe: [{ originId: '', percentage: 100 }]
    });

    const startAddProduct = () => {
      setAddingProduct(true);
      setNewProduct({
        name: '',
        size: 330,
        type: 'single',
        description: '',
        recipe: [{ originId: '', percentage: 100 }]
      });
    };

    const addRecipeIngredient = (isEditing = false) => {
      if (isEditing) {
        setEditingProduct({
          ...editingProduct,
          recipe: [...editingProduct.recipe, { originId: '', percentage: 0 }]
        });
      } else {
        setNewProduct({
          ...newProduct,
          recipe: [...newProduct.recipe, { originId: '', percentage: 0 }]
        });
      }
    };

    const removeRecipeIngredient = (index, isEditing = false) => {
      if (isEditing) {
        setEditingProduct({
          ...editingProduct,
          recipe: editingProduct.recipe.filter((_, i) => i !== index)
        });
      } else {
        setNewProduct({
          ...newProduct,
          recipe: newProduct.recipe.filter((_, i) => i !== index)
        });
      }
    };

    const updateRecipeIngredient = (index, field, value, isEditing = false) => {
      if (isEditing) {
        const newRecipe = [...editingProduct.recipe];
        newRecipe[index][field] = field === 'originId' ? parseInt(value) : parseFloat(value);
        setEditingProduct({ ...editingProduct, recipe: newRecipe });
      } else {
        const newRecipe = [...newProduct.recipe];
        newRecipe[index][field] = field === 'originId' ? parseInt(value) : parseFloat(value);
        setNewProduct({ ...newProduct, recipe: newRecipe });
      }
    };

    const validateProduct = (product) => {
      if (!product.name.trim()) {
        alert('⚠️ נא למלא שם מוצר');
        return false;
      }
      if (!product.size || product.size <= 0) {
        alert('⚠️ נא למלא גודל מוצר');
        return false;
      }
      if (!product.recipe || product.recipe.length === 0) {
        alert('⚠️ נא להוסיף לפחות רכיב אחד למתכון');
        return false;
      }
      for (let ing of product.recipe) {
        if (!ing.originId) {
          alert('⚠️ נא לבחור זן לכל רכיב במתכון');
          return false;
        }
      }
      const totalPercentage = product.recipe.reduce((sum, ing) => sum + (ing.percentage || 0), 0);
      if (Math.abs(totalPercentage - 100) > 0.1) {
        alert(`⚠️ סכום האחוזים במתכון חייב להיות 100%\n\nכרגע: ${totalPercentage}%`);
        return false;
      }
      return true;
    };

    const saveNewProduct = async () => {
      if (!validateProduct(newProduct)) return;

      try {
        await productsDb.insert({
          name: newProduct.name,
          size: parseInt(newProduct.size),
          type: newProduct.type,
          description: newProduct.description,
          recipe: newProduct.recipe
        });

        setAddingProduct(false);
        alert('✅ מוצר נוסף בהצלחה!');
      } catch (error) {
        console.error('Error adding product:', error);
        alert('❌ שגיאה בהוספת מוצר');
      }
    };

    const startEditProduct = (product) => {
      setEditingProduct({...product});
    };

    const saveEditProduct = async () => {
      if (!validateProduct(editingProduct)) return;

      try {
        await productsDb.update(editingProduct.id, {
          name: editingProduct.name,
          size: parseInt(editingProduct.size),
          type: editingProduct.type,
          description: editingProduct.description,
          recipe: editingProduct.recipe,
          updated_at: new Date().toISOString()
        });

        setEditingProduct(null);
        alert('✅ מוצר עודכן בהצלחה!');
      } catch (error) {
        console.error('Error updating product:', error);
        alert('❌ שגיאה בעדכון מוצר');
      }
    };

    const deleteProduct = async (product) => {
      if (!window.confirm(`⚠️ האם למחוק את המוצר "${product.name} ${product.size}g"?`)) {
        return;
      }

      try {
        await productsDb.remove(product.id);
        alert('✅ מוצר נמחק!');
      } catch (error) {
        console.error('Error deleting product:', error);
        alert('❌ שגיאה במחיקת מוצר');
      }
    };

    const duplicateProduct = async (product) => {
      try {
        await productsDb.insert({
          name: product.name + ' (עותק)',
          size: product.size,
          type: product.type,
          description: product.description,
          recipe: product.recipe
        });
        alert('✅ מוצר שוכפל בהצלחה!');
      } catch (error) {
        console.error('Error duplicating product:', error);
        alert('❌ שגיאה בשכפול מוצר');
      }
    };

    return (
      <div className="page">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h1>📦 מוצרים ({data.products.length})</h1>
          {!addingProduct && !editingProduct && (
            <button onClick={startAddProduct} className="btn-primary">➕ הוסף מוצר</button>
          )}
        </div>

        {/* טופס הוספה */}
        {addingProduct && (
          <div className="form-card" style={{ marginBottom: '20px', background: '#F0F9FF', border: '2px solid #3B82F6' }}>
            <h3>➕ הוסף מוצר חדש</h3>
            
            <div className="form-group">
              <label>שם המוצר *</label>
              <input
                type="text"
                placeholder="למשל: Aristo Blend"
                value={newProduct.name}
                onChange={e => setNewProduct({...newProduct, name: e.target.value})}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group">
                <label>גודל (גרם) *</label>
                <input
                  type="number"
                  placeholder="330"
                  value={newProduct.size}
                  onChange={e => setNewProduct({...newProduct, size: parseInt(e.target.value)})}
                />
              </div>

              <div className="form-group">
                <label>סוג</label>
                <select 
                  value={newProduct.type}
                  onChange={e => setNewProduct({...newProduct, type: e.target.value})}
                >
                  <option value="single">חד-זני</option>
                  <option value="blend">תערובת</option>
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>תיאור (אופציונלי)</label>
              <input
                type="text"
                placeholder="למשל: שוקולדי ומאוזן"
                value={newProduct.description}
                onChange={e => setNewProduct({...newProduct, description: e.target.value})}
              />
            </div>

            <div className="form-group">
              <label>מתכון (סה"כ חייב להיות 100%) *</label>
              {newProduct.recipe.map((ing, index) => (
                <div key={index} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '10px', marginBottom: '10px' }}>
                  <select
                    value={ing.originId}
                    onChange={e => updateRecipeIngredient(index, 'originId', e.target.value, false)}
                  >
                    <option value="">בחר זן...</option>
                    {data.origins.map(origin => (
                      <option key={origin.id} value={origin.id}>{origin.name}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    placeholder="%"
                    value={ing.percentage}
                    onChange={e => updateRecipeIngredient(index, 'percentage', e.target.value, false)}
                  />
                  {newProduct.recipe.length > 1 && (
                    <button onClick={() => removeRecipeIngredient(index, false)} className="btn-small" style={{ background: '#FEE2E2', color: '#991B1B' }}>🗑️</button>
                  )}
                </div>
              ))}
              <button onClick={() => addRecipeIngredient(false)} className="btn-small" style={{ marginTop: '5px' }}>➕ הוסף רכיב</button>
              <div style={{ marginTop: '10px', fontSize: '14px', color: newProduct.recipe.reduce((s, i) => s + (i.percentage || 0), 0) === 100 ? '#059669' : '#DC2626' }}>
                סה"כ: {newProduct.recipe.reduce((sum, ing) => sum + (ing.percentage || 0), 0)}%
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
              <button onClick={saveNewProduct} className="btn-primary" style={{ flex: 1 }}>💾 שמור מוצר</button>
              <button onClick={() => setAddingProduct(false)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
            </div>
          </div>
        )}

        {/* טופס עריכה */}
        {editingProduct && (
          <div className="form-card" style={{ marginBottom: '20px', background: '#FFF9F0', border: '2px solid #FF6B35' }}>
            <h3>✏️ עריכת מוצר: {editingProduct.name}</h3>
            
            <div className="form-group">
              <label>שם המוצר *</label>
              <input
                type="text"
                value={editingProduct.name}
                onChange={e => setEditingProduct({...editingProduct, name: e.target.value})}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group">
                <label>גודל (גרם) *</label>
                <input
                  type="number"
                  value={editingProduct.size}
                  onChange={e => setEditingProduct({...editingProduct, size: parseInt(e.target.value)})}
                />
              </div>

              <div className="form-group">
                <label>סוג</label>
                <select 
                  value={editingProduct.type}
                  onChange={e => setEditingProduct({...editingProduct, type: e.target.value})}
                >
                  <option value="single">חד-זני</option>
                  <option value="blend">תערובת</option>
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>תיאור</label>
              <input
                type="text"
                value={editingProduct.description || ''}
                onChange={e => setEditingProduct({...editingProduct, description: e.target.value})}
              />
            </div>

            <div className="form-group">
              <label>מתכון (סה"כ חייב להיות 100%)</label>
              {editingProduct.recipe.map((ing, index) => (
                <div key={index} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '10px', marginBottom: '10px' }}>
                  <select
                    value={ing.originId}
                    onChange={e => updateRecipeIngredient(index, 'originId', e.target.value, true)}
                  >
                    <option value="">בחר זן...</option>
                    {data.origins.map(origin => (
                      <option key={origin.id} value={origin.id}>{origin.name}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    value={ing.percentage}
                    onChange={e => updateRecipeIngredient(index, 'percentage', e.target.value, true)}
                  />
                  {editingProduct.recipe.length > 1 && (
                    <button onClick={() => removeRecipeIngredient(index, true)} className="btn-small" style={{ background: '#FEE2E2', color: '#991B1B' }}>🗑️</button>
                  )}
                </div>
              ))}
              <button onClick={() => addRecipeIngredient(true)} className="btn-small" style={{ marginTop: '5px' }}>➕ הוסף רכיב</button>
              <div style={{ marginTop: '10px', fontSize: '14px', color: editingProduct.recipe.reduce((s, i) => s + (i.percentage || 0), 0) === 100 ? '#059669' : '#DC2626' }}>
                סה"כ: {editingProduct.recipe.reduce((sum, ing) => sum + (ing.percentage || 0), 0)}%
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
              <button onClick={saveEditProduct} className="btn-primary" style={{ flex: 1 }}>💾 שמור שינויים</button>
              <button onClick={() => setEditingProduct(null)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
            </div>
          </div>
        )}

        {/* רשת מוצרים */}
        {!addingProduct && !editingProduct && (
          <div className="products-grid">
            {data.products.map(product => {
              const cost = calculateProductCost(product);
              const breakdown = calculateProductCost(product, true);
              const isBreakdownOpen = showBreakdownId === product.id;
              
              return (
                <div key={product.id} className="product-card">
                  <div className="product-header">
                    <h3>{product.name}</h3>
                    <span className="badge">{product.size}g</span>
                  </div>
                  
                  {product.description && (
                    <div style={{ 
                      padding: '0.5rem 0', 
                      fontSize: '0.875rem', 
                      color: '#6F4E37',
                      fontStyle: 'italic',
                      borderBottom: '1px solid #F4E8D8',
                      marginBottom: '0.5rem'
                    }}>
                      {product.description}
                    </div>
                  )}
                  
                  <div className="product-recipe">
                    <strong>מתכון:</strong>
                    {product.recipe.map((ing, i) => {
                      const origin = getOriginById(ing.originId);
                      return (
                        <div key={i} className="recipe-item">
                          • {ing.percentage}% {origin?.name}
                        </div>
                      );
                    })}
                  </div>
                  
                  <div className="product-cost">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>עלות ייצור:</span>
                      <strong>₪{cost}</strong>
                    </div>
                    <button 
                      onClick={() => setShowBreakdownId(isBreakdownOpen ? null : product.id)} 
                      style={{ 
                        fontSize: '11px', 
                        padding: '2px 8px', 
                        marginTop: '5px',
                        background: 'transparent',
                        border: '1px solid #D4A574',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        color: '#6F4E37'
                      }}
                    >
                      {isBreakdownOpen ? '🔼 הסתר פירוט' : '🔽 פירוט מלא'}
                    </button>
                    
                    {isBreakdownOpen && (
                      <div style={{ 
                        marginTop: '10px', 
                        padding: '10px', 
                        background: '#FFFBF5', 
                        borderRadius: '6px',
                        fontSize: '12px',
                        border: '1px solid #F4E8D8'
                      }}>
                        <div style={{ marginBottom: '5px' }}>☕ פולים קלויים: ₪{breakdown.beansCost}</div>
                        <div style={{ marginBottom: '5px' }}>🔥 גז: ₪{breakdown.gasCost}</div>
                        <div style={{ marginBottom: '5px' }}>👨‍🍳 עבודה (קלייה): ₪{breakdown.roastingLabor}</div>
                        <div style={{ marginBottom: '5px' }}>📦 אריזה: ₪{breakdown.packagingCost}</div>
                        <div style={{ marginBottom: '5px' }}>👷 עבודה (אריזה): ₪{breakdown.packagingLabor}</div>
                        <div style={{ 
                          marginTop: '8px', 
                          paddingTop: '8px', 
                          borderTop: '1px solid #D4A574',
                          fontWeight: 'bold',
                          color: '#6F4E37'
                        }}>
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
  };
