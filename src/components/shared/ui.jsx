import React from 'react';

// Small shared building blocks for the CoffeeFlow design system.
// Styling lives in App.css; these only fix the markup so every page matches.

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="page-sub">{subtitle}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, meta, action, children, flush = false, className = '' }) {
  return (
    <section className={`card${flush ? ' flush' : ''}${className ? ` ${className}` : ''}`}>
      {(title || meta || action) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {(meta || action) && (
            <div className="card-head-end">
              {meta && <span className="meta num">{meta}</span>}
              {action}
            </div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

export function Tag({ tone, children }) {
  return <span className={`tag${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

export function Kpi({ label, value, unit, note }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}{unit && <small>{unit}</small>}</div>
      {note && <div className="kpi-note">{note}</div>}
    </div>
  );
}
