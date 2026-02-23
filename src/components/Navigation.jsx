  // רכיב ניווט (Navigation)
  const Navigation = () => {
    const menuItems = [
      { id: 'dashboard', icon: '📊', label: 'דשבורד' },
      { id: 'origins', icon: '🌱', label: 'זנים' },
      { id: 'roasting', icon: '🔥', label: 'קלייה' },
      { id: 'products', icon: '📦', label: 'מוצרים' },
      { id: 'settings', icon: '⚙️', label: 'הגדרות' }
    ];

    return (
      <nav className="navbar">
        <div className="nav-brand">
          <h2>☕ CoffeeFlow</h2>
          {user && (
            <div style={{ fontSize: '0.875rem', color: '#999' }}>
              {user.primaryEmailAddress?.emailAddress}
            </div>
          )}
        </div>
        <div className="nav-menu">
          {menuItems.map(item => (
            <button
              key={item.id}
              className={`nav-item ${currentPage === item.id ? 'active' : ''}`}
              onClick={() => setCurrentPage(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </div>
        <div style={{ marginRight: 'auto', paddingLeft: '1rem' }}>
          <UserButton afterSignOutUrl="/" />
        </div>
      </nav>
    );
  };
