  // רכיב קלייה (Roasting)
  const Roasting = () => {
    const [selectedOrigin, setSelectedOrigin] = useState('');
    const [greenWeight, setGreenWeight] = useState('15');
    const [selectedOperator, setSelectedOperator] = useState('');
    const [editingRoast, setEditingRoast] = useState(null);

    const recordRoast = async () => {
      if (!selectedOrigin || !greenWeight || !selectedOperator) {
        alert('⚠️ נא למלא את כל השדות');
        return;
      }

      const origin = getOriginById(parseInt(selectedOrigin));
      if (!origin) {
        alert('⚠️ זן לא נמצא');
        return;
      }

      const weight = parseFloat(greenWeight);
      if (weight <= 0 || weight > 20) {
        alert('⚠️ משקל לא תקין (1-20 ק"ג)');
        return;
      }

      if (origin.stock < weight) {
        alert(`⚠️ אין מספיק מלאי!\nנדרש: ${weight} ק"ג\nקיים: ${origin.stock} ק"ג`);
        return;
      }

      const roastedWeight = parseFloat(calculateRoastedWeight(weight, origin.weight_loss));

      try {
        // Add roast
        await roastsDb.insert({
          origin_id: origin.id,
          green_weight: weight,
          roasted_weight: roastedWeight,
          operator: selectedOperator,
          date: new Date().toISOString()
        });

        // Update origin stock
        await originsDb.update(origin.id, {
          stock: origin.stock - weight,
          roasted_stock: (origin.roasted_stock || 0) + roastedWeight
        });

        // Reset form
        setGreenWeight('15');
        setSelectedOrigin('');
        setSelectedOperator('');

        alert(`✅ קלייה נרשמה!\n${weight} ק"ג ירוק → ${roastedWeight} ק"ג קלוי`);
      } catch (error) {
        console.error('Error recording roast:', error);
        alert('❌ שגיאה ברישום קלייה');
      }
    };

    const startEditRoast = (roast) => {
      setEditingRoast({
        id: roast.id,
        originId: roast.origin_id,
        greenWeight: roast.green_weight,
        operator: roast.operator,
        oldGreenWeight: roast.green_weight,
        oldOriginId: roast.origin_id
      });
    };

    const saveEditRoast = async () => {
      if (!editingRoast.originId || !editingRoast.greenWeight || !editingRoast.operator) {
        alert('⚠️ נא למלא את כל השדות');
        return;
      }

      const newOrigin = getOriginById(editingRoast.originId);
      const oldOrigin = getOriginById(editingRoast.oldOriginId);
      
      if (!newOrigin || !oldOrigin) {
        alert('⚠️ זן לא נמצא');
        return;
      }

      const newWeight = parseFloat(editingRoast.greenWeight);
      const newRoastedWeight = parseFloat(calculateRoastedWeight(newWeight, newOrigin.weight_loss));
      const oldWeight = parseFloat(editingRoast.oldGreenWeight);
      const oldRoastedWeight = parseFloat(calculateRoastedWeight(oldWeight, oldOrigin.weight_loss));

      try {
        // Update roast
        await roastsDb.update(editingRoast.id, {
          origin_id: newOrigin.id,
          green_weight: newWeight,
          roasted_weight: newRoastedWeight,
          operator: editingRoast.operator,
          updated_at: new Date().toISOString()
        });

        // Return old stock
        if (oldOrigin.id === newOrigin.id) {
          // Same origin - just adjust
          const stockDiff = newWeight - oldWeight;
          const roastedDiff = newRoastedWeight - oldRoastedWeight;
          
          await originsDb.update(oldOrigin.id, {
            stock: oldOrigin.stock - stockDiff,
            roasted_stock: (oldOrigin.roasted_stock || 0) + roastedDiff
          });
        } else {
          // Different origins - return to old, take from new
          await originsDb.update(oldOrigin.id, {
            stock: oldOrigin.stock + oldWeight,
            roasted_stock: (oldOrigin.roasted_stock || 0) - oldRoastedWeight
          });
          
          await originsDb.update(newOrigin.id, {
            stock: newOrigin.stock - newWeight,
            roasted_stock: (newOrigin.roasted_stock || 0) + newRoastedWeight
          });
        }

        setEditingRoast(null);
        alert('✅ קלייה עודכנה!');
      } catch (error) {
        console.error('Error updating roast:', error);
        alert('❌ שגיאה בעדכון קלייה');
      }
    };

    const deleteRoast = async (roast) => {
      const origin = getOriginById(roast.origin_id);
      
      if (!window.confirm(`⚠️ האם למחוק קלייה זו?\n${roast.green_weight} ק"ג ${origin?.name || 'לא ידוע'}\nהמלאי יוחזר לזן`)) {
        return;
      }

      try {
        // Delete roast
        await roastsDb.remove(roast.id);

        // Return stock to origin
        if (origin) {
          await originsDb.update(origin.id, {
            stock: origin.stock + roast.green_weight,
            roasted_stock: (origin.roasted_stock || 0) - roast.roasted_weight
          });
        }

        alert('✅ קלייה נמחקה והמלאי הוחזר!');
      } catch (error) {
        console.error('Error deleting roast:', error);
        alert('❌ שגיאה במחיקת קלייה');
      }
    };

    return (
      <div className="page">
        <h1>🔥 רישום קלייה</h1>

        {editingRoast && (
          <div className="form-card" style={{ marginBottom: '20px', background: '#FFF9F0', border: '2px solid #FF6B35' }}>
            <h3>✏️ עריכת קלייה</h3>
            <div className="form-grid">
              <div className="form-group">
                <label>זן</label>
                <select 
                  value={editingRoast.originId} 
                  onChange={(e) => setEditingRoast({...editingRoast, originId: parseInt(e.target.value)})}
                >
                  <option value="">בחר זן...</option>
                  {data.origins.map(o => (
                    <option key={o.id} value={o.id}>{o.name} (מלאי: {o.stock} ק"ג)</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>משקל ירוק (ק"ג)</label>
                <input
                  type="number"
                  step="0.1"
                  value={editingRoast.greenWeight}
                  onChange={(e) => setEditingRoast({...editingRoast, greenWeight: e.target.value})}
                />
              </div>
              <div className="form-group">
                <label>מפעיל</label>
                <select 
                  value={editingRoast.operator}
                  onChange={(e) => setEditingRoast({...editingRoast, operator: e.target.value})}
                >
                  <option value="">בחר מפעיל...</option>
                  {data.operators.map(op => (
                    <option key={op.id} value={op.name}>{op.name}</option>
                  ))}
                </select>
              </div>
            </div>
            {editingRoast.originId && editingRoast.greenWeight && (
              <div className="calculation-display">
                משקל קלוי משוער: <strong>
                  {calculateRoastedWeight(
                    editingRoast.greenWeight, 
                    getOriginById(editingRoast.originId)?.weight_loss || 20
                  )} ק"ג
                </strong>
              </div>
            )}
            <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
              <button onClick={saveEditRoast} className="btn-primary" style={{ flex: 1 }}>💾 שמור</button>
              <button onClick={() => setEditingRoast(null)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
            </div>
          </div>
        )}

        <div className="form-card">
          <div className="form-grid">
            <div className="form-group">
              <label>בחר זן לקלייה</label>
              <select 
                value={selectedOrigin} 
                onChange={(e) => setSelectedOrigin(e.target.value)}
              >
                <option value="">בחר זן...</option>
                {data.origins
                  .filter(o => o.stock > 0)
                  .map(o => (
                    <option key={o.id} value={o.id}>
                      {o.name} (מלאי: {o.stock} ק"ג)
                    </option>
                  ))}
              </select>
            </div>

            <div className="form-group">
              <label>משקל ירוק (ק"ג)</label>
              <input
                type="number"
                step="0.1"
                placeholder="15"
                value={greenWeight}
                onChange={(e) => setGreenWeight(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label>מפעיל</label>
              <select 
                value={selectedOperator}
                onChange={(e) => setSelectedOperator(e.target.value)}
              >
                <option value="">בחר מפעיל...</option>
                {data.operators.map(op => (
                  <option key={op.id} value={op.name}>{op.name}</option>
                ))}
              </select>
            </div>
          </div>

          {selectedOrigin && greenWeight && (
            <div className="calculation-display">
              <div>איבוד משקל: <strong>{getOriginById(parseInt(selectedOrigin))?.weight_loss}%</strong></div>
              <div>משקל קלוי צפוי: <strong>
                {calculateRoastedWeight(greenWeight, getOriginById(parseInt(selectedOrigin))?.weight_loss || 20)} ק"ג
              </strong></div>
            </div>
          )}

          <button onClick={recordRoast} className="btn-primary">🔥 רשום קלייה</button>
        </div>

        <div className="section">
          <h2>📋 היסטוריית קליות ({data.roasts.length})</h2>
          
          {data.roasts.length === 0 ? (
            <div className="empty-state">אין קליות עדיין. רשום קלייה ראשונה!</div>
          ) : (
            <div className="roasts-list">
              {data.roasts.slice().reverse().map(roast => {
                const origin = getOriginById(roast.origin_id);
                return (
                  <div key={roast.id} className="roast-card">
                    <div className="roast-header">
                      <h3>{origin?.name || 'זן לא ידוע'}</h3>
                      <div className="roast-actions">
                        <button onClick={() => startEditRoast(roast)} className="btn-icon">✏️</button>
                        <button onClick={() => deleteRoast(roast)} className="btn-icon">🗑️</button>
                      </div>
                    </div>
                    <div className="roast-details">
                      <div>🌱 ירוק: <strong>{roast.green_weight} ק"ג</strong></div>
                      <div>🔥 קלוי: <strong>{roast.roasted_weight} ק"ג</strong></div>
                      <div>👨‍🍳 מפעיל: <strong>{roast.operator}</strong></div>
                      <div>📅 תאריך: <strong>{new Date(roast.date).toLocaleDateString('he-IL')}</strong></div>
                      {roast.updated_at && (
                        <div style={{ fontSize: '0.85em', color: '#FF6B35' }}>
                          ✏️ עודכן: {new Date(roast.updated_at).toLocaleString('he-IL')}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };
