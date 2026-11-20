import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import VehicleLog from './VehicleLog';

global.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../../lib/supabase', () => ({
  supabase: { rpc: () => Promise.resolve({ data: [], error: null }) },
}));

let mockApp;
jest.mock('../../lib/context', () => ({ useApp: () => mockApp }));

afterEach(() => { document.body.innerHTML = ''; });

test('driver dropdown lists employees from context data, active first', async () => {
  // Same shape as AppContext: table rows live under `data`, nothing top-level.
  mockApp = {
    showToast: jest.fn(),
    data: {
      employees: [
        { id: 1, name: 'תמר', active: false },
        { id: 2, name: 'פלג אורג', active: true },
        { id: 3, name: 'איזבל כנפו', active: true },
      ],
    },
  };
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(<VehicleLog />); });

  const names = [...el.querySelectorAll('#veh-driver option')].map((o) => o.textContent);
  expect(names).toEqual(['בחירה…', 'איזבל כנפו', 'פלג אורג', 'תמר (לא פעיל/ה)']);
});
