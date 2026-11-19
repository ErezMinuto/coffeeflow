/**
 * Minuto machine advisor: the rules, as the owner set them (2026-11-18).
 * Pure logic, no DOM, so every rule is covered by engine_test.ts.
 *
 * answers = {
 *   use:     'auto' | 'manual' | 'lever' | 'go' | 'filter' | 'business',
 *   milk:    auto: 'none' | 'hand' | 'button'
 *            manual: 'rarely' | 'daily' | 'many'  (picks the boiler),
 *   budget:  0..3, a price range from RANGES (auto, manual and lever),
 *   grinder: 'yes' | 'no'   (manual only),
 *   water:   'yes' | 'no'   (manual, from the third price range up),
 *   takes:   'ground' | 'capsule'  (on the go only),
 * }
 * machines = in-stock, visible machines from the catalog route:
 *   { key, brand, kind, price, milk, boiler, grinder, plumb, takes }
 *
 * Returns { route: 'whatsapp' } for coffee shops and offices, otherwise
 * { keys, near, needGrinder }: near means nothing sat inside the chosen
 * price range, so the closest machines are shown instead.
 */
(function (root) {
  'use strict';

  var MAX = 3;
  var MAX_SMALL = 6;   // on the go and filter: few machines, show them all
  // Price ranges per machine kind. The middle of each range decides which
  // machines show first; the open top range is given a nominal ceiling.
  var RANGES = {
    auto:   [[1500, 2500], [2500, 4000], [4000, 6000], [6000, 10000]],
    manual: [[2000, 3500], [3500, 7000], [7000, 12000], [12000, 20000]],
  };
  RANGES.lever = RANGES.manual;
  var BOILER = { rarely: 'single', daily: 'hx', many: 'dual' };
  // Nivona goes last: it shows only when fewer than three machines from
  // other brands fit the answers (owner, 2026-11-18).
  var LAST_BRAND = 'nivona';
  // Asked only where machines that connect to the water line exist.
  var WATER_FROM_RANGE = 2;

  function rangeIndex(price, ranges) {
    for (var i = 0; i < ranges.length - 1; i++) {
      if (price <= ranges[i][1]) return i;
    }
    return ranges.length - 1;
  }

  function middle(range) { return (range[0] + range[1]) / 2; }

  function brandOf(m) { return String(m.brand || '').toLowerCase(); }

  function byPrice(a, b) { return a.price - b.price; }

  // Closest to the middle of the range, one per brand, Nivona last.
  function pickThree(list, mid) {
    var sorted = list.slice().sort(function (a, b) {
      return Math.abs(a.price - mid) - Math.abs(b.price - mid) || a.price - b.price;
    });
    var others = sorted.filter(function (m) { return brandOf(m) !== LAST_BRAND; });
    var last = sorted.filter(function (m) { return brandOf(m) === LAST_BRAND; });
    var out = [];
    var brands = [];
    others.forEach(function (m) {
      if (out.length < MAX && brands.indexOf(brandOf(m)) === -1) {
        out.push(m); brands.push(brandOf(m));
      }
    });
    others.forEach(function (m) {
      if (out.length < MAX && out.indexOf(m) === -1) out.push(m);
    });
    last.forEach(function (m) {
      if (out.length < MAX) out.push(m);
    });
    return out;
  }

  // Machines that fit every answer except the budget.
  function candidates(a, machines) {
    var kind = function (k) { return machines.filter(function (m) { return m.kind === k; }); };
    switch (a.use) {
      case 'auto':
        return kind('auto').filter(function (m) { return m.milk === a.milk; });
      case 'manual': {
        var manual = kind('manual');
        // No grinder and the lowest range: the machines with one built in.
        if (a.grinder === 'no' && a.budget === 0) {
          return manual.filter(function (m) { return m.grinder; });
        }
        var fit = manual.filter(function (m) { return !m.grinder && m.boiler === BOILER[a.milk]; });
        if (a.water === 'yes' && a.budget >= WATER_FROM_RANGE) {
          var plumbed = fit.filter(function (m) { return m.plumb; });
          // No match with that boiler: any machine that connects.
          return plumbed.length ? plumbed : manual.filter(function (m) { return !m.grinder && m.plumb; });
        }
        return fit;
      }
      case 'lever':
        return kind('lever');
      case 'go':
        return kind('go').filter(function (m) { return (m.takes || []).indexOf(a.takes) !== -1; });
      case 'filter':
        return kind('filter');
      default:
        return [];
    }
  }

  function recommend(a, machines) {
    if (a.use === 'business') return { route: 'whatsapp' };
    var list = candidates(a, machines || []).filter(function (m) { return m.price > 0; });
    var result = { keys: [], near: false, needGrinder: false };
    if (a.use === 'manual' && a.grinder === 'no' && a.budget > 0) result.needGrinder = true;

    var ranges = RANGES[a.use];
    if (!ranges) {
      result.keys = list.sort(byPrice).slice(0, MAX_SMALL).map(function (m) { return m.key; });
      return result;
    }
    if (!list.length) return result;
    var budget = Math.max(0, Math.min(ranges.length - 1, a.budget | 0));
    var at = function (i) { return list.filter(function (m) { return rangeIndex(m.price, ranges) === i; }); };
    var chosen = budget;
    if (!at(budget).length) {
      // Nothing inside the range: the nearest range that has machines,
      // the cheaper one on a tie, picked by the same rule.
      result.near = true;
      for (var step = 1; step < ranges.length; step++) {
        if (budget - step >= 0 && at(budget - step).length) { chosen = budget - step; break; }
        if (budget + step < ranges.length && at(budget + step).length) { chosen = budget + step; break; }
      }
    }
    result.keys = pickThree(at(chosen), middle(ranges[chosen])).map(function (m) { return m.key; });
    return result;
  }

  // The water question only makes sense where such machines exist.
  function asksWater(a) {
    return a.use === 'manual' && (a.budget | 0) >= WATER_FROM_RANGE;
  }

  /**
   * The coffee quiz answers for a machine, so its own engine and its live
   * stock pick the coffee. Null when the machine takes no beans we sell.
   */
  function coffeeAnswers(m, a) {
    var milkDrinks = a.milk === 'hand' || a.milk === 'button' || a.milk === 'daily' || a.milk === 'many';
    var base = { milk: milkDrinks ? 'cow' : 'none', taste: 'unknown', strength: 'balanced' };
    var premium = ['jura', 'melitta', 'nivona'];
    switch (m.kind) {
      case 'auto':
        base.brew = 'auto';
        // Gaggia and any other automatic: the simple-automatic rule.
        base.brand = premium.indexOf(brandOf(m)) !== -1 ? 'premium' : 'simple';
        return base;
      case 'manual':
        base.brew = m.grinder ? 'combo' : 'manual';
        return base;
      case 'lever':
        base.brew = 'manual';
        return base;
      case 'go':
        if (a.takes !== 'ground') return null;
        base.brew = 'manual';
        return base;
      case 'filter':
        base.brew = 'filter';
        return base;
      default:
        return null;
    }
  }

  root.MinutoAdvisorEngine = {
    recommend: recommend,
    asksWater: asksWater,
    coffeeAnswers: coffeeAnswers,
    rangeIndex: rangeIndex,
    RANGES: RANGES,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
