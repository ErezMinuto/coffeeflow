import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import TeamTasks from './TeamTasks';

global.IS_REACT_ACT_ENVIRONMENT = true;

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockInsert = jest.fn();
const mockRpc = jest.fn();
const mockInvoke = jest.fn();

jest.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      insert: (row) => {
        mockInsert(row);
        return { select: () => ({ single: async () => ({ data: { id: 99, ...row }, error: null }) }) };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
    rpc: (...args) => { mockRpc(...args); return Promise.resolve({ data: [{ id: args[1].p_id }], error: null }); },
    functions: { invoke: (...args) => { mockInvoke(...args); return Promise.resolve({ data: { ok: true, sent: 1 }, error: null }); } },
  },
}));

let mockApp;
jest.mock('../../lib/context', () => ({ useApp: () => mockApp }));

const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });

const employees = [
  { id: 27, name: 'ארז אלבז', active: true, telegram_id: 1, clerk_user_id: 'user_erez' },
  { id: 19, name: 'פלג אורג', active: true, telegram_id: 2, clerk_user_id: 'user_peleg' },
  { id: 40, name: 'איזבל כנפו', active: true, telegram_id: 3, clerk_user_id: null },
  { id: 41, name: 'בלי טלגרם', active: true, telegram_id: null, clerk_user_id: null },
];
const tasks = [
  { id: 1, title: 'להזמין חלב', notes: 'שיבולת שועל', assignee_employee_id: 19, due_date: yesterday, status: 'open', created_by: 'user_erez', reminder_count: 1 },
  { id: 2, title: 'לעצמי', assignee_employee_id: 19, due_date: today, status: 'open', created_by: 'user_peleg', reminder_count: 0 },
  { id: 3, title: 'סגור', assignee_employee_id: 19, due_date: yesterday, status: 'done', done_at: new Date().toISOString(), done_via: 'telegram', created_by: 'user_erez' },
];

function setup(userId, isAdmin, extraTasks = []) {
  mockApp = {
    // Same shape as AppContext: table rows live under `data`, nothing top-level.
    user: { id: userId }, isAdmin,
    data: { managerTasks: [...tasks, ...extraTasks], employees },
    managerTasksDb: { refresh: jest.fn() },
    showToast: jest.fn(),
  };
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => { root.render(<TeamTasks />); });
  return { el, root };
}

function setInput(input, value) {
  const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}

beforeEach(() => { localStorage.clear(); mockInsert.mockClear(); mockRpc.mockClear(); mockInvoke.mockClear(); });
afterEach(() => { document.body.innerHTML = ''; });

test('admin: assignee picker defaults to Peleg, lists only Telegram-linked staff', () => {
  const { el } = setup('user_erez', true);
  const select = el.querySelector('#tt-who');
  expect(select.value).toBe('19');
  const names = [...select.options].map((o) => o.textContent);
  expect(names).toContain('ארז אלבז (אני)');
  expect(names).not.toContain('בלי טלגרם');
  expect(el.querySelector('#tt-due').value).toBe(today);
  // open list: overdue first, with assignee name and late tag
  const items = el.querySelectorAll('.teamtasks-item');
  expect(items).toHaveLength(2);
  expect(items[0].textContent).toContain('להזמין חלב');
  expect(items[0].textContent).toContain('באיחור יום');
  expect(items[0].textContent).toContain('פלג אורג');
  expect(items[1].textContent).toContain('להיום');
});

test('admin: adding a task inserts it and sends the Telegram DM', async () => {
  const { el } = setup('user_erez', true);
  act(() => { setInput(el.querySelector('#tt-title'), '  לבדוק מלאי  '); });
  await act(async () => { el.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
    title: 'לבדוק מלאי', assignee_employee_id: 19, due_date: today, created_by: 'user_erez', notes: null,
  }));
  expect(mockInvoke).toHaveBeenCalledWith('employee-bot', { body: { task_id: 99 }, headers: { 'x-action': 'task-notify' } });
  expect(mockApp.showToast).toHaveBeenCalledWith('המשימה נוספה ונשלחה לפלג בטלגרם', 'success');
});

test('Peleg: picker defaults to himself, and he can send a task to Erez', async () => {
  const { el } = setup('user_peleg', false);
  const select = el.querySelector('#tt-who');
  expect(select).not.toBeNull();
  expect(select.value).toBe('19');
  expect(el.textContent).not.toContain('לעצמי ');
  act(() => { setInput(select, '27'); });
  act(() => { setInput(el.querySelector('#tt-title'), 'לאשר הזמנה'); });
  await act(async () => { el.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ assignee_employee_id: 27, created_by: 'user_peleg' }));
  expect(mockApp.showToast).toHaveBeenCalledWith('המשימה נוספה ונשלחה לארז בטלגרם', 'success');
});

test('Peleg: a self task goes to himself', async () => {
  const { el } = setup('user_peleg', false);
  act(() => { setInput(el.querySelector('#tt-title'), 'להתקשר לספק'); });
  await act(async () => { el.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ assignee_employee_id: 19, created_by: 'user_peleg' }));
  expect(mockApp.showToast).toHaveBeenCalledWith('המשימה נוספה ונשלחה אליך בטלגרם', 'success');
});

test('Peleg: edits what he created, ticks only what is his', () => {
  const sentToErez = { id: 4, title: 'לאשר הזמנה', assignee_employee_id: 27, due_date: today, status: 'open', created_by: 'user_peleg', reminder_count: 0 };
  const { el } = setup('user_peleg', false, [sentToErez]);
  const items = [...el.querySelectorAll('.teamtasks-item')];
  const fromErez = items.find((li) => li.textContent.includes('להזמין חלב'));
  const selfTask = items.find((li) => li.textContent.includes('לעצמי'));
  const toErez = items.find((li) => li.textContent.includes('לאשר הזמנה'));
  // Erez's task to Peleg: Peleg ticks it, can't edit or delete it.
  expect(fromErez.querySelector('.teamtasks-actions')).toBeNull();
  expect(fromErez.querySelector('.teamtasks-check').disabled).toBe(false);
  // His own and the one he sent to Erez: he can edit and delete them.
  expect(selfTask.querySelector('.teamtasks-actions')).not.toBeNull();
  expect(toErez.querySelector('.teamtasks-actions')).not.toBeNull();
  // Only Erez marks Erez's task done; the chip says whose it is.
  expect(toErez.querySelector('.teamtasks-check').disabled).toBe(true);
  expect(toErez.querySelector('.teamtasks-who').textContent).toBe('אחראי/ת: ארז אלבז');
});

test('ticking a task calls the RPC and notifies the creator', async () => {
  const { el } = setup('user_peleg', false);
  const btn = el.querySelector('.teamtasks-item .teamtasks-check');
  await act(async () => { btn.click(); });
  expect(mockRpc).toHaveBeenCalledWith('set_manager_task_done', { p_id: 1, p_done: true });
  expect(mockInvoke).toHaveBeenCalledWith('employee-bot', { body: { task_id: 1 }, headers: { 'x-action': 'task-done-notify' } });
});

test('every row says whose task it is, and who sent it', () => {
  // Admin view: Peleg's tasks show his name.
  let { el } = setup('user_erez', true);
  let chips = [...el.querySelectorAll('.teamtasks-who')].map((c) => c.textContent);
  expect(chips).toEqual(['אחראי/ת: פלג אורג', 'אחראי/ת: פלג אורג']);
  document.body.innerHTML = '';

  // Peleg's view: his own tasks say "שלי"; the one Erez sent says "מארז".
  ({ el } = setup('user_peleg', false));
  const items = [...el.querySelectorAll('.teamtasks-item')];
  const fromErez = items.find((li) => li.textContent.includes('להזמין חלב'));
  const selfTask = items.find((li) => li.textContent.includes('לעצמי'));
  expect(fromErez.querySelector('.teamtasks-who').textContent).toBe('אחראי/ת: שלי');
  expect(fromErez.textContent).toContain('מארז');
  expect(selfTask.textContent).not.toContain('מארז');
});

test('done tab shows finished tasks with re-open', () => {
  const { el } = setup('user_erez', true);
  const doneTab = [...el.querySelectorAll('.teamtasks-tab')].find((b) => b.textContent.includes('בוצעו'));
  act(() => { doneTab.click(); });
  const items = el.querySelectorAll('.teamtasks-item');
  expect(items).toHaveLength(1);
  expect(items[0].textContent).toContain('בטלגרם');
  expect(items[0].querySelector('.teamtasks-check').getAttribute('aria-label')).toContain('החזרת');
});
