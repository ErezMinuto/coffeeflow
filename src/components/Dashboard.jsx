  // רכיב דשבורד
  const Dashboard = () => {
    const resetData = async () => {
      if (!window.confirm('⚠️ האם אתה בטוח? פעולה זו תמחק את כל הנתונים!')) {
        return;
      }

      try {
        // Delete all user data
        await Promise.all([
          supabase.from('roasts').delete().eq('user_id', user.id),
          supabase.from('products').delete().eq('user_id', user.id),
          supabase.from('operators').delete().eq('user_id', user.id),
          supabase.from('origins').delete().eq('user_id', user.id)
        ]);

        // Reload data
        originsDb.refresh();
        productsDb.refresh();
        roastsDb.refresh();
        operatorsDb.refresh();

        alert('✅ הנתונים נמחקו בהצלחה');
      } catch (error) {
        console.error('Error resetting data:', error);
        alert('❌ שגיאה במחיקת נתונים');
      }
    };

    const initializeDemoData = async () => {
      if (!window.confirm('האם להוסיף נתוני דוגמה?')) {
        return;
      }

      try {
        // Add demo origins
        await Promise.all([
          originsDb.insert({
            name: 'ברזיל Fazenda Sertão',
            weight_loss: 20,
            cost_per_kg: 34,
            stock: 50,
            roasted_stock: 0
          }),
          originsDb.insert({
            name: 'ברזיל Cerrado',
            weight_loss: 20,
            cost_per_kg: 33,
            stock: 35,
            roasted_stock: 0
          }),
          originsDb.insert({
            name: 'אתיופיה Yirgacheffe',
            weight_loss: 18,
            cost_per_kg: 37,
            stock: 65,
            roasted_stock: 0
          })
        ]);

        // Add demo operators
        await Promise.all([
          operatorsDb.insert({ name: 'יוסי' }),
          operatorsDb.insert({ name: 'שירה' }),
          operatorsDb.insert({ name: 'מיכאל' })
        ]);

        alert('✅ נתוני דוגמה נוספו!');
      } catch (error) {
        console.error('Error adding demo data:', error);
        alert('❌ שגיאה בהוספת נתונים');
      }
    };

    return (
      <div className="page">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h1>📊 דשבורד ראשי</h1>
          <div style={{ display: 'flex', gap: '10px' }}>
            <UserButton />
            <button onClick={initializeDemoData} className="btn-small" style={{ background: '#10B981', color: 'white' }}>
              ➕ נתוני דוגמה
            </button>
            <button onClick={resetData} className="btn-small" style={{ background: '#DC2626', color: 'white' }}>
              🔄 איפוס נתונים
            </button>
          </div>
        </div>
      
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-icon">🌱</div>
            <div className="stat-info">
              <div className="stat-label">זנים במלאי</div>
              <div className="stat-value">{data.origins.length}</div>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon">📦</div>
            <div className="stat-info">
              <div className="stat-label">מוצרים</div>
              <div className="stat-value">{data.products.length}</div>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon">🔥</div>
            <div className="stat-info">
              <div className="stat-label">קליות החודש</div>
              <div className="stat-value">{data.roasts.length}</div>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon">👥</div>
            <div className="stat-info">
              <div className="stat-label">מפעילים</div>
              <div className="stat-value">{data.operators.length}</div>
            </div>
          </div>
        </div>

        <div className="section">
          <h2>📈 סטטיסטיקות</h2>
          <div className="stats-details">
            <div className="stat-row">
              <span>סה"כ מלאי ירוק:</span>
              <strong>{data.origins.reduce((sum, o) => sum + (o.stock || 0), 0).toFixed(1)} ק"ג</strong>
            </div>
            <div className="stat-row">
              <span>ערך מלאי:</span>
              <strong>₪{data.origins.reduce((sum, o) => sum + ((o.stock || 0) * (o.cost_per_kg || 0)), 0).toFixed(2)}</strong>
            </div>
            <div className="stat-row">
              <span>איבוד משקל ממוצע:</span>
              <strong>
                {data.origins.length > 0
                  ? (data.origins.reduce((sum, o) => sum + (o.weight_loss || 0), 0) / data.origins.length).toFixed(1)
                  : 0}%
              </strong>
            </div>
          </div>
        </div>

        {data.origins.length === 0 && (
          <div className="empty-state" style={{ marginTop: '2rem' }}>
            <h3>👋 ברוך הבא ל-CoffeeFlow!</h3>
            <p>לחץ על "➕ נתוני דוגמה" כדי להתחיל, או צור זנים ומוצרים משלך!</p>
          </div>
        )}
      </div>
    );
  };
