// Shared constants for the Marketing page tabs.
// Kept in its own module so each tab file can import only what it needs
// without pulling in the whole Marketing tree.

export const TABS = [
  { id: 'compose',     label: '🚀 קמפיין אוטומטי' },
  { id: 'automations', label: '⚡ אוטומציות' },
  { id: 'contacts',    label: '👥 אנשי קשר' },
  { id: 'groups',      label: '🗂️ קבוצות' },
  { id: 'history',     label: '📊 היסטוריה' },
];

export const THEME_LABELS = {
  tips:      '💡 טיפים',
  story:     '📖 סיפור',
  promo:     '🏷️ מבצע',
  seasonal:  '🌿 עונתי',
  education: '📚 חינוך',
};

// localStorage key used to remember the campaign the user is currently editing
// so a page refresh drops them back into the editor with the same draft loaded.
export const ACTIVE_DRAFT_KEY = 'coffeeflow:marketing:activeDraftId';

// Debounce window (ms) between edits and autosave.
export const AUTOSAVE_DEBOUNCE_MS = 1500;
