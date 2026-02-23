  // רכיב זנים (Origins)
  const Origins = () => {
    const [searchTerm, setSearchTerm] = useState('');
    const [sortBy, setSortBy] = useState('name');
    const [editingOrigin, setEditingOrigin] = useState(null);
    const [newOrigin, setNewOrigin] = useState({
      name: '',
      weightLoss: 20,
      costPerKg: '',
      stock: 0,
      notes: ''
    });

    const addOrigin = async () => {
      if (!newOrigin.name || !newOrigin.costPerKg) {
        alert('⚠️ נא למלא שם ועלות');
        return;
      }

      try {
        await originsDb.insert({
          name: newOrigin.name,
          weight_loss: parseFloat(newOrigin.weightLoss),
          cost_per_kg: parseFloat(newOrigin.costPerKg),
          stock: parseFloat(newOrigin.stock) || 0,
          roasted_stock: 0,
          notes: newOrigin.notes
        });

        setNewOrigin({ name: '', weightLoss: 20, costPerKg: '', stock: 0, notes: '' });
        alert('✅ זן נוסף בהצלחה!');
      } catch (error) {
        console.error('Error adding origin:', error);
        alert('❌ שגיאה בהוספת זן');
      }
    };

    const startEdit = (origin) => {
      setEditingOrigin({
        id: origin.id,
        name: origin.name,
        weightLoss: origin.weight_loss,
        costPerKg: origin.cost_per_kg,
        stock: origin.stock,
        notes: origin.notes || ''
      });
    };

    const saveEdit = async () => {
      if (!editingOrigin.name || !editingOrigin.costPerKg) {
        alert('⚠️ נא למלא שם ועלות');
        return;
      }

      try {
        await originsDb.update(editingOrigin.id, {
          name: editingOrigin.name,
          weight_loss: parseFloat(editingOrigin.weightLoss),
          cost_per_kg: parseFloat(editingOrigin.costPerKg),
          stock: parseFloat(editingOrigin.stock),
          notes: editingOrigin.notes,
          updated_at: new Date().toISOString()
        });

        setEditingOrigin(null);
        alert('✅ זן עודכן בהצלחה!');
      } catch (error) {
        console.error('Error updating origin:', error);
        alert('❌ שגיאה בעדכון זן');
      }
    };

    const deleteOrigin = async (origin) => {
      const roastsCount = data.roasts.filter(r => r.origin_id === origin.id).length;
      
      if (roastsCount > 0) {
        if (!window.confirm(`⚠️ לזן זה יש ${roastsCount} קליות. האם למחוק בכל זאת?`)) {
          return;
        }
      } else {
        if (!window.confirm(`האם למחוק את "${origin.name}"?`)) {
          return;
        }
      }

      try {
        await originsDb.remove(origin.id);
        alert('✅ זן נמחק!');
      } catch (error) {
        console.error('Error deleting origin:', error);
        alert('❌ שגיאה במחיקת זן');
      }
    };

    const duplicateOrigin = async (origin) => {
      try {
        await originsDb.insert({
          name: origin.name + ' (עותק)',
          weight_loss: origin.weight_loss,
          cost_per_kg: origin.cost_per_kg,
          stock: 0,
          roasted_stock: 0,
          notes: origin.notes
        });
        alert('✅ זן שוכפל בהצלחה!');
      } catch (error) {
        console.error('Error duplicating origin:', error);
        alert('❌ שגיאה בשכפול זן');
      }
    };

    const exportToCSV = () => {
      const headers = ['שם,איבוד משקל %,עלות ק"ג,מלאי ק"ג,מלאי קלוי ק"ג,הערות'];
      const rows = filteredOrigins.map(o => 
        `"${o.name}",${o.weight_loss},${o.cost_per_kg},${o.stock || 0},${o.roasted_stock || 0},"${o.notes || ''}"`
      );
      const csv = [...headers, ...rows].join('\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `coffeeflow-origins-${new Date().toISOString().split('T')[0]}.csv`;
      link.click();
    };

    const filteredOrigins = data.origins
      .filter(o => o.name.toLowerCase().includes(searchTerm.toLowerCase()))
      .sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name);
        if (sortBy === 'stock') return (b.stock || 0) - (a.stock || 0);
        if (sortBy === 'cost') return (b.cost_per_kg || 0) - (a.cost_per_kg || 0);
        return 0;
      });

    return (
      <div className="page">
        <h1>🌱 ניהול זנים ({data.origins.length})</h1>

        <div className="toolbar">
          <input
            type="text"
            placeholder="🔍 חיפוש זן..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="sort-select">
            <option value="name">מיון לפי שם</option>
            <option value="stock">מיון לפי מלאי</option>
            <option value="cost">מיון לפי מחיר</option>
          </select>
          <button onClick={exportToCSV} className="btn-small">📥 ייצא CSV</button>
        </div>

        {editingOrigin && (
          <div className="form-card" style={{ marginBottom: '20px', background: '#FFF9F0', border: '2px solid #FF6B35' }}>
            <h3>✏️ עריכת זן</h3>
            <div className="form-grid">
              <div className="form-group">
                <label>שם הזן</label>
                <input
                  type="text"
                  value={editingOrigin.name}
                  onChange={(e) => setEditingOrigin({...editingOrigin, name: e.target.value})}
                />
              </div>
              <div className="form-group">
                <label>איבוד משקל בקלייה (%)</label>
                <input
                  type="number"
                  value={editingOrigin.weightLoss}
                  onChange={(e) => setEditingOrigin({...editingOrigin, weightLoss: e.target.value})}
                />
              </div>
              <div className="form-group">
                <label>עלות לק"ג (₪)</label>
                <input
                  type="number"
                  step="0.01"
                  value={editingOrigin.costPerKg}
                  onChange={(e) => setEditingOrigin({...editingOrigin, costPerKg: e.target.value})}
                />
              </div>
              <div className="form-group">
                <label>מלאי (ק"ג)</label>
                <input
                  type="number"
                  step="0.1"
                  value={editingOrigin.stock}
                  onChange={(e) => setEditingOrigin({...editingOrigin, stock: e.target.value})}
                />
              </div>
            </div>
            <div className="form-group">
              <label>הערות</label>
              <textarea
                value={editingOrigin.notes}
                onChange={(e) => setEditingOrigin({...editingOrigin, notes: e.target.value})}
                rows="2"
              />
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
              <button onClick={saveEdit} className="btn-primary" style={{ flex: 1 }}>💾 שמור</button>
              <button onClick={() => setEditingOrigin(null)} className="btn-small" style={{ flex: 1 }}>❌ ביטול</button>
            </div>
          </div>
        )}

        <div className="form-card">
          <h3>➕ הוסף זן חדש</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>שם הזן</label>
              <input
                type="text"
                placeholder="למשל: ברזיל סנטוס"
                value={newOrigin.name}
                onChange={(e) => setNewOrigin({...newOrigin, name: e.target.value})}
              />
            </div>
            <div className="form-group">
              <label>איבוד משקל בקלייה (%)</label>
              <input
                type="number"
                value={newOrigin.weightLoss}
                onChange={(e) => setNewOrigin({...newOrigin, weightLoss: e.target.value})}
              />
            </div>
            <div className="form-group">
              <label>עלות לק"ג (₪)</label>
              <input
                type="number"
                step="0.01"
                placeholder="45.00"
                value={newOrigin.costPerKg}
                onChange={(e) => setNewOrigin({...newOrigin, costPerKg: e.target.value})}
              />
            </div>
            <div className="form-group">
              <label>מלאי התחלתי (ק"ג)</label>
              <input
                type="number"
                step="0.1"
                value={newOrigin.stock}
                onChange={(e) => setNewOrigin({...newOrigin, stock: e.target.value})}
              />
            </div>
          </div>
          <div className="form-group">
            <label>הערות</label>
            <textarea
              placeholder="פרטים נוספים..."
              value={newOrigin.notes}
              onChange={(e) => setNewOrigin({...newOrigin, notes: e.target.value})}
              rows="2"
            />
          </div>
          <button onClick={addOrigin} className="btn-primary">➕ הוסף זן</button>
        </div>

        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>שם</th>
                <th>איבוד משקל</th>
                <th>עלות/ק"ג ירוק</th>
                <th>עלות/ק"ג קלוי</th>
                <th>מלאי ירוק</th>
                <th>מלאי קלוי</th>
                <th>פעולות</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrigins.map(origin => {
                const yieldPercent = 1 - (origin.weight_loss / 100);
                const costPerKgRoasted = (origin.cost_per_kg / yieldPercent).toFixed(2);
                
                return (
                  <tr key={origin.id}>
                    <td><strong>{origin.name}</strong></td>
                    <td>{origin.weight_loss}%</td>
                    <td>₪{origin.cost_per_kg}</td>
                    <td>₪{costPerKgRoasted}</td>
                    <td>{origin.stock || 0} ק"ג</td>
                    <td>{origin.roasted_stock || 0} ק"ג</td>
                    <td>
                      <div className="action-buttons">
                        <button onClick={() => startEdit(origin)} className="btn-icon">✏️</button>
                        <button onClick={() => duplicateOrigin(origin)} className="btn-icon">📋</button>
                        <button onClick={() => deleteOrigin(origin)} className="btn-icon">🗑️</button>
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
            {searchTerm ? 'לא נמצאו תוצאות' : 'אין זנים עדיין. הוסף זן ראשון!'}
          </div>
        )}
      </div>
    );
  };
