// Race tests for src/lib/hooks.js.
//
//   CI=true npx react-scripts test --watchAll=false src/lib/hooks.test.js
//
// Supabase is replaced by a fake whose queries resolve only when the test says
// so, which lets each test choose the order overlapping requests finish in.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

// Same object every render, like Clerk; a fresh one would re-run the effects.
const mockClerk = { user: { id: 'user_1' } };
jest.mock('@clerk/clerk-react', () => ({
  useUser: () => mockClerk,
}));

// Every awaited query lands in `mockPending` with its description; the test
// resolves it with resolvePending(match, result).
const mockPending = [];
function mockMakeQuery(desc) {
  const q = {
    desc,
    select() { desc.select = true; return q; },
    insert(row) { desc.op = 'insert'; desc.row = row; return q; },
    update(row) { desc.op = 'update'; desc.row = row; return q; },
    delete() { desc.op = 'delete'; return q; },
    eq(col, val) { desc.eq = { ...(desc.eq || {}), [col]: val }; return q; },
    order() { return q; },
    range(from) { desc.from = from; return q; },
    single() { desc.single = true; return q; },
    then(onOk, onErr) {
      return new Promise((resolve) => mockPending.push({ desc, resolve })).then(onOk, onErr);
    },
  };
  return q;
}

jest.mock('./supabase', () => ({
  supabase: {
    from: (table) => mockMakeQuery({ table, op: 'select' }),
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ({ unsubscribe() {} }) };
      return ch;
    },
  },
}));

// eslint-disable-next-line import/first
import { useSupabaseData, useCostSettings } from './hooks';

global.IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function take(match) {
  const i = mockPending.findIndex((p) => match(p.desc));
  if (i < 0) throw new Error('no pending query matches; pending: ' + JSON.stringify(mockPending.map((p) => p.desc)));
  return mockPending.splice(i, 1)[0];
}

async function resolvePending(match, result) {
  const p = take(match);
  await act(async () => { p.resolve(result); });
  await flush();
}

let container, root, hook;
function mount(useHook) {
  function Probe() { hook = useHook(); return null; }
  container = document.createElement('div');
  root = createRoot(container);
  act(() => { root.render(React.createElement(Probe)); });
}

beforeEach(() => { mockPending.length = 0; hook = null; });
afterEach(() => { act(() => root.unmount()); });

const isSelect = (d) => d.op === 'select' && !d.single;

test('an older fetch finishing last does not overwrite newer data (finding 5)', async () => {
  mount(() => useSupabaseData('products', { filterByUser: false }));
  await flush();
  const first = take(isSelect);                 // mount fetch, still in flight

  act(() => { hook.refresh(); });               // a newer fetch starts
  await flush();
  await resolvePending(isSelect, { data: [{ id: 1, name: 'new' }], error: null });
  expect(hook.data).toEqual([{ id: 1, name: 'new' }]);

  await act(async () => { first.resolve({ data: [{ id: 1, name: 'old' }], error: null }); });
  await flush();
  expect(hook.data).toEqual([{ id: 1, name: 'new' }]);
  expect(hook.loading).toBe(false);
});

test('insert refreshes local state without waiting for realtime (finding 4)', async () => {
  mount(() => useSupabaseData('products', { filterByUser: false }));
  await flush();
  await resolvePending(isSelect, { data: [{ id: 1 }], error: null });
  expect(hook.data).toEqual([{ id: 1 }]);

  let inserted;
  act(() => { hook.insert({ name: 'x' }).then((r) => { inserted = r; }); });
  await flush();
  await resolvePending((d) => d.op === 'insert', { data: { id: 2, name: 'x' }, error: null });
  await resolvePending(isSelect, { data: [{ id: 1 }, { id: 2, name: 'x' }], error: null });

  expect(inserted).toEqual({ id: 2, name: 'x' });
  expect(hook.data).toEqual([{ id: 1 }, { id: 2, name: 'x' }]);
});

test('cost settings: losing the default-insert race uses the existing row (finding 6)', async () => {
  mount(() => useCostSettings());
  await flush();
  await resolvePending((d) => d.table === 'cost_settings' && d.op === 'select' && d.single,
    { data: null, error: { code: 'PGRST116' } });
  await resolvePending((d) => d.op === 'insert',
    { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
  await resolvePending((d) => d.table === 'cost_settings' && d.op === 'select' && d.single,
    { data: { user_id: 'user_1', bag_330g: 0.7 }, error: null });

  expect(hook.settings).toEqual({ user_id: 'user_1', bag_330g: 0.7 });
  expect(hook.loading).toBe(false);
});

test('cost settings: first mount still creates defaults', async () => {
  mount(() => useCostSettings());
  await flush();
  await resolvePending((d) => d.op === 'select', { data: null, error: { code: 'PGRST116' } });
  const ins = take((d) => d.op === 'insert');
  expect(ins.desc.row.user_id).toBe('user_1');
  await act(async () => { ins.resolve({ data: { ...ins.desc.row, id: 9 }, error: null }); });
  await flush();
  expect(hook.settings.id).toBe(9);
});
