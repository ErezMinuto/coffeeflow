  // רכיב הגדרות (Settings)
  const Settings = () => {
    const [newOperator, setNewOperator] = useState('');
    const [editingOperator, setEditingOperator] = useState(null);

    const addOperator = async () => {
      if (newOperator.trim()) {
        try {
          await operatorsDb.insert({ name: newOperator.trim() });
          setNewOperator('');
          alert('✅ מפעיל נוסף!');
        } catch (error) {
          console.error('Error adding operator:', error);
          alert('❌ שגיאה בהוספת מפעיל');
        }
      }
    };

    const startEditOperator = (operator) => {
      setEditingOperator({ ...operator });
    };

    const saveEditOperator = async () => {
      if (!editingOperator.name.trim()) {
        alert('⚠️ נא למלא שם מפעיל');
        return;
      }

      try {
        // Update operator
        await operatorsDb.update(editingOperator.id, {
          name: editingOperator.name.trim()
        });

        // Update all roasts with this operator (by old name)
        const oldOperator = data.operators.find(op => op.id === editingOperator.id);
        if (oldOperator && oldOperator.name !== editingOperator.name.trim()) {
          const roastsToUpdate = data.roasts.filter(r => r.operator === oldOperator.name);
          for (const roast of roastsToUpdate) {
            await roastsDb.update(roast.id, {
              operator: editingOperator.name.trim()
            });
          }
        }

        setEditingOperator(null);
        alert('✅ מפעיל עודכן!');
      } catch (error) {
        console.error('Error updating operator:', error);
        alert('❌ שגיאה בעדכון מפעיל');
      }
    };

    const deleteOperator = async (operator) => {
      const roastCount = data.roasts.filter(r => r.operator === operator.name).length;
      
      if (roastCount > 0) {
        if (!window.confirm(`⚠️ למפעיל "${operator.name}" יש ${roastCount} קליות.\n\nהקליות יישארו עם השם שלו.\n\nהאם למחוק את המפעיל מהרשימה?`)) {
          return;
        }
      } else {
        if (!window.confirm(`האם למחוק את המפעיל "${operator.name}"?`)) {
          return;
        }
      }

      try {
        await operatorsDb.remove(operator.id);
        alert('✅ מפעיל נמחק!');
      } catch (error) {
        console.error('Error deleting operator:', error);
        alert('❌ שגיאה במחיקת מפעיל');
      }
    };

    return (
      <div className="page">
        <h1>⚙️ הגדרות</h1>

        <div className="section">
          <h2>👥 ניהול מפעילים ({data.operators.length})</h2>
          
          <div className="form-card">
            <div style={{ display: 'flex', gap: '10px' }}>
              <input
                type="text"
                placeholder="שם מפעיל חדש..."
                value={newOperator}
                onChange={(e) => setNewOperator(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && addOperator()}
                style={{ flex: 1 }}
              />
              <button onClick={addOperator} className="btn-primary">➕ הוסף מפעיל</button>
            </div>
          </div>

          {editingOperator && (
            <div className="form-card" style={{ background: '#FFF9F0', border: '2px solid #FF6B35', marginTop: '15px' }}>
              <h3>✏️ עריכת מפעיל</h3>
              <input
                type="text"
                value={editingOperator.name}
                onChange={(e) => setEditingOperator({...editingOperator, name: e.target.value})}
              />
              <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                <button onClick={saveEditOperator} className="btn-primary" style={{ flex: 1 }}>💾 שמור</button>
                <button onClick={() => setEditingOperator(null)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
              </div>
            </div>
          )}

          <div className="table-container" style={{ marginTop: '15px' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>שם</th>
                  <th>מספר קליות</th>
                  <th>פעולות</th>
                </tr>
              </thead>
              <tbody>
                {data.operators.map(operator => {
                  const roastCount = data.roasts.filter(r => r.operator === operator.name).length;
                  return (
                    <tr key={operator.id}>
                      <td><strong>{operator.name}</strong></td>
                      <td>{roastCount}</td>
                      <td>
                        <div className="action-buttons">
                          <button onClick={() => startEditOperator(operator)} className="btn-icon">✏️</button>
                          <button onClick={() => deleteOperator(operator)} className="btn-icon">🗑️</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {data.operators.length === 0 && (
            <div className="empty-state">אין מפעילים. הוסף מפעיל ראשון!</div>
          )}
        </div>

        <div className="section" style={{ marginTop: '2rem' }}>
          <h2>💰 הגדרות עלויות</h2>
          <p style={{ color: '#666', marginBottom: '1rem' }}>
            ניתן לערוך את העלויות הקבועות כאן. השינויים ישפיעו על חישוב עלויות המוצרים.
          </p>
          
          {costSettings ? (
            <div className="form-card">
              <div className="form-grid">
                <div className="form-group">
                  <label>שקית 330g (₪)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={costSettings.bag_330g}
                    onChange={async (e) => {
                      await updateCostSettings({ bag_330g: parseFloat(e.target.value) });
                    }}
                  />
                </div>
                <div className="form-group">
                  <label>מדבקה (₪)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={costSettings.label}
                    onChange={async (e) => {
                      await updateCostSettings({ label: parseFloat(e.target.value) });
                    }}
                  />
                </div>
                <div className="form-group">
                  <label>גז לקלייה (₪)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={costSettings.gas_per_roast}
                    onChange={async (e) => {
                      await updateCostSettings({ gas_per_roast: parseFloat(e.target.value) });
                    }}
                  />
                </div>
                <div className="form-group">
                  <label>שכר/שעה (₪)</label>
                  <input
                    type="number"
                    step="1"
                    value={costSettings.labor_per_hour}
                    onChange={async (e) => {
                      await updateCostSettings({ labor_per_hour: parseFloat(e.target.value) });
                    }}
                  />
                </div>
                <div className="form-group">
                  <label>זמן קלייה (דק׳)</label>
                  <input
                    type="number"
                    step="1"
                    value={costSettings.roasting_time_minutes}
                    onChange={async (e) => {
                      await updateCostSettings({ roasting_time_minutes: parseFloat(e.target.value) });
                    }}
                  />
                </div>
                <div className="form-group">
                  <label>זמן אריזה (דק׳)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={costSettings.packaging_time_minutes}
                    onChange={async (e) => {
                      await updateCostSettings({ packaging_time_minutes: parseFloat(e.target.value) });
                    }}
                  />
                </div>
              </div>
              <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: '#666' }}>
                💾 השינויים נשמרים אוטומטית
              </p>
            </div>
          ) : (
            <div className="empty-state">טוען הגדרות...</div>
          )}
        </div>
      </div>
    );
  };
