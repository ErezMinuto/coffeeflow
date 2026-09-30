// ============================================================================
// render-smoke — prove the roasting page renders
// ============================================================================
//
//   node scripts/render-smoke.cjs "$PWD"
//
// This project has no frontend test setup, and a runtime render error on the
// roasting page would white-screen a screen used every day — something the
// production build does not catch, since it only compiles.
//
// So: transpile with the project's own babel preset, stub the AppContext
// module (it is not exported, and stubbing avoids touching real Supabase),
// and render the page server-side across the states that matter. Uses only
// dependencies already in package.json.
// babel-preset-react-app requires NODE_ENV to be set explicitly.
process.env.NODE_ENV = 'development';
process.env.REACT_APP_SUPABASE_URL = 'http://localhost:1';
process.env.REACT_APP_SUPABASE_ANON_KEY = 'stub';

const path = require('path'), fs = require('fs'), Module = require('module');
const babel = require('@babel/core');
const preset = require.resolve('babel-preset-react-app');
const ROOT = process.argv[2];

// on-the-fly JSX transform
for (const ext of ['.js', '.jsx']) {
  Module._extensions[ext] = function (mod, filename) {
    if (filename.includes('node_modules')) return mod._compile(fs.readFileSync(filename, 'utf8'), filename);
    const { code } = babel.transformFileSync(filename, { presets: [preset], sourceMaps: 'inline' });
    return mod._compile(code, filename);
  };
}

const CTX = path.join(ROOT, 'src/lib/context.jsx');
let ctxValue = null;
const stub = new Module(CTX, null);
stub.filename = CTX; stub.loaded = true;
stub.exports = { useApp: () => ctxValue };
require.cache[CTX] = stub;

const React = require('react');
const { renderToString } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');
const Roasting = require(path.join(ROOT, 'src/components/roasting/Roasting.jsx')).default;

const noop = async () => {};
const db = { data: [], insert: noop, update: noop, remove: noop, refresh: noop };

function ctx({ roasts = [], artisanProfiles = [] } = {}) {
  return {
    data: {
      origins: [{ id: 7, name: 'Yirgacheffe', stock: 50, weight_loss: 16, roasted_stock: 10, user_id: 'u1' }],
      products: [], roasts, operators: [{ id: 1, name: 'ארז' }],
      roastProfiles: [], roastProfileIngredients: [], roastComponents: [],
      waitingCustomers: [], artisanProfiles, roastChecklistTemplates: [],
    },
    originsDb: db, roastsDb: db, roastProfilesDb: db, roastProfileIngredientsDb: db,
    roastComponentsDb: db, artisanProfilesDb: db,
    getOriginById: (id) => ({ id, name: 'Yirgacheffe', weight_loss: 16, stock: 50 }),
    calculateRoastedWeight: (w) => (w * 0.84).toFixed(2),
    showToast: () => {},
  };
}

const roastNoArtisan = { id: 1, origin_id: 7, roast_profile_id: null, green_weight: 15, roasted_weight: 12.6,
  operator: 'ארז', date: new Date().toISOString(), batch_number: 'BATCH-1', color_reading: null,
  charge_et: null, charge_bt: null, drop_et: null, drop_bt: null, artisan_uuid: null };
const roastWithArtisan = { ...roastNoArtisan, id: 2, batch_number: 'BATCH-2',
  charge_et: 196.5, charge_bt: 92.4, drop_et: 211, drop_bt: 208.9, artisan_uuid: 'abc' };

const cases = [
  ['empty log',                      { roasts: [] }],
  ['roast with no Artisan file',     { roasts: [roastNoArtisan] }],
  ['roast with Artisan readings',    { roasts: [roastWithArtisan], artisanProfiles: [{ id: 9, roast_id: 2, beans: "אתיופיה יירגצ'ף", filename: 'r.alog' }] }],
  ['artisanProfiles undefined',      { roasts: [roastWithArtisan], artisanProfiles: undefined }],
];

let bad = 0;
for (const [name, opts] of cases) {
  try {
    ctxValue = ctx(opts);
    const html = renderToString(React.createElement(MemoryRouter, null, React.createElement(Roasting)));
    const checks = [];
    if (opts.roasts && opts.roasts.length) {
      checks.push(['הטענה column header', html.includes('הטענה')]);
      checks.push(['סיום column header', html.includes('סיום')]);
    }
    if (name.includes('readings')) {
      checks.push(['charge_et rendered as 196.5°', html.includes('196.5°')]);
      checks.push(['drop_bt rendered as 208.9°', html.includes('208.9°')]);
      checks.push(['row marked has-artisan', html.includes('has-artisan')]);
    }
    if (name.includes('no Artisan file')) {
      checks.push(['empty readings render as —', (html.match(/—/g) || []).length >= 2]);
      checks.push(['row not marked has-artisan', !html.includes('has-artisan')]);
    }
    const failed = checks.filter(([, ok]) => !ok);
    console.log(`${failed.length ? '❌' : '✅'} ${name}  (${(html.length / 1024).toFixed(1)} KB rendered)`);
    for (const [c] of failed) { console.log(`     missing: ${c}`); bad++; }
  } catch (e) {
    console.log(`❌ ${name} — THREW: ${e.message.split('\n')[0]}`);
    bad++;
  }
}
console.log(bad === 0 ? '\nthe roasting page renders in every case' : `\n${bad} problems`);
process.exit(bad ? 1 : 0);
