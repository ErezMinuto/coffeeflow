/**
 * Minuto coffee quiz: the recommendation rules, as the owner set them
 * (2026-10-30). Pure logic, no DOM, so every rule is covered by engine_test.ts.
 *
 * answers = {
 *   brew:     'auto' | 'combo' | 'manual' | 'moka' | 'filter' | 'press',
 *   brand:    'simple' | 'premium'            (auto only),
 *   milk:     'none' | 'cow' | 'alt',
 *   taste:    'chocolate' | 'fruity' | 'floral' | 'unknown',
 *   strength: 'gentle' | 'balanced' | 'strong' | 'very_strong',
 *   light:    boolean  (asked for a light roast),
 *   natural:  boolean  (asked for natural process),
 *   noSour:   boolean  (no sourness at all),
 *   decaf:    boolean,
 * }
 * available = { all, light, extras }: `all` and `light` are the named coffees
 * in stock. `extras` come from the Quiz box on the product page, so a new
 * coffee or a limited-edition jar needs no code change:
 *   { key, flavor, milk, brews: ['espresso','moka','filter'], limited, light }
 * Named coffees keep their rules. A limited edition that fits takes the third
 * place; other new coffees only fill places left empty.
 */
(function (root) {
  'use strict';

  var ROBUSTA = ['intenso', 'trieste', 'prestige'];
  // Never for alternative milk unless a light roast was asked for.
  var FRUITY = ['bensa_m', 'bensa_l', 'kenya_m', 'kenya_l', 'guji', 'aji', 'leona', 'yirgacheffe'];
  var COW_MILK = ['bensa_m', 'jungle'];
  var ALT_MILK = ['sertao', 'jungle', 'velvet'];
  var NO_SOUR = ['jungle', 'velvet'];
  var LIGHT_ORDER = ['kenya_l', 'bensa_l', 'guji', 'aji', 'leona'];
  // Espresso without milk: one of these joins the machine's two leads.
  var BLACK = { chocolate: 'jungle', fruity: 'kenya_m', floral: 'velvet', unknown: 'bensa_m' };
  // Natural process only. Kenya, Aji (anaerobic washed) and Leona (honey) are not.
  var NATURAL = ['guji', 'sertao', 'dark'];
  var MAX = 3;

  function lightList(light) {
    var extra = (light || []).filter(function (k) { return LIGHT_ORDER.indexOf(k) === -1; });
    return LIGHT_ORDER.concat(extra);
  }

  // What the brew method and strength alone call for.
  function brewPicks(a, light) {
    var veryStrong = a.strength === 'very_strong';
    var strong = a.strength === 'strong';
    switch (a.brew) {
      case 'auto':
        if (a.brand === 'premium') {         // Jura, Melitta, Nivona
          if (veryStrong) return ROBUSTA;
          return strong ? ['dark', 'aristo'] : ['aristo', 'sertao'];
        }
        // Simple automatics: robusta blends are recommended by default.
        if (veryStrong || strong) return ROBUSTA;
        return ['prestige', 'aristo', 'intenso'];
      case 'combo':                          // built-in grinder
        if (veryStrong) return ROBUSTA;
        return strong ? ['dark', 'aristo'] : ['aristo', 'dark'];
      case 'manual':
        if (veryStrong) return ROBUSTA;
        return strong ? ['aristo', 'sertao', 'jungle'] : ['sertao', 'jungle', 'aristo'];
      case 'moka':
        if (veryStrong) return ['sertao'].concat(ROBUSTA);
        return strong ? ['sertao'] : ['jungle', 'antigua'];
      default:                               // filter, and French press / cold brew
        if (veryStrong) return ['dark', 'aristo'].concat(ROBUSTA);
        if (strong) return ['jungle', 'velvet'];
        if (a.taste === 'fruity') return ['kenya_l', 'kenya_m', 'bensa_m'];
        if (a.taste === 'floral') return ['leona', 'yirgacheffe', 'velvet'];
        if (a.taste === 'chocolate') return ['jungle', 'velvet', 'antigua'];
        return ['kenya_l', 'kenya_m', 'jungle'];
    }
  }

  function isEspresso(a) {
    return a.brew === 'auto' || a.brew === 'combo' || a.brew === 'manual';
  }

  function blackPicks(a, base) {
    if (!isEspresso(a) || (a.strength !== 'gentle' && a.strength !== 'balanced')) return base;
    return base.slice(0, 2).concat(BLACK[a.taste] || BLACK.unknown, base.slice(2));
  }

  function uniq(list) {
    return list.filter(function (k, i) { return list.indexOf(k) === i; });
  }

  function brewGroup(brew) {
    if (brew === 'moka') return 'moka';
    return brew === 'filter' || brew === 'press' ? 'filter' : 'espresso';
  }

  // Does a coffee from the Quiz box fit these answers?
  function extraFits(x, a) {
    if (a.decaf || a.natural || a.strength === 'very_strong') return false;
    // Asked for light: any light coffee works, as the named ones do, and
    // nothing else does.
    if (a.light) return !!x.light;
    if ((x.brews || []).indexOf(brewGroup(a.brew)) === -1) return false;
    if (a.milk !== 'none' && !x.milk) return false;
    var bright = x.light || x.flavor === 'fruity';
    if (bright && (a.noSour || a.milk === 'alt')) return false;
    return a.taste === 'unknown' || !a.taste || x.flavor === a.taste;
  }

  function withExtras(picks, a, extras) {
    var fits = (extras || []).filter(function (x) { return extraFits(x, a); });
    var limited = fits.filter(function (x) { return x.limited; })[0];
    var out = picks.slice();
    if (limited && out.indexOf(limited.key) === -1) {
      out = out.slice(0, MAX - 1).concat(limited.key);
    }
    fits.forEach(function (x) {
      if (out.length < MAX && out.indexOf(x.key) === -1) out.push(x.key);
    });
    return out;
  }

  function recommend(a, available) {
    var inStock = available.all || [];
    var light = available.light || [];
    var pick = function (list) {
      return uniq(list).filter(function (k) { return inStock.indexOf(k) !== -1; });
    };
    var picks;

    if (a.decaf) {
      picks = pick(['decaf']);
    } else if (a.natural) {
      // Alternative milk still rules out the fruity one.
      picks = pick(NATURAL).filter(function (k) { return a.milk !== 'alt' || FRUITY.indexOf(k) === -1; });
    } else if (a.light) {
      // An explicit ask beats the milk rules. With cow's milk, Daye Bensa
      // leads. The flavor answer keeps Aji and Sweet Leona in rotation.
      var byTaste = { fruity: ['kenya_l', 'aji'], floral: ['kenya_l', 'leona'] }[a.taste] || [];
      var cow = a.milk === 'cow' ? ['bensa_l'] : [];
      picks = pick(cow.concat(byTaste, lightList(light)));
    } else if (a.milk === 'alt' || a.noSour) {
      picks = pick(a.strength === 'very_strong' ? ['aristo', 'dark'] : (a.noSour ? NO_SOUR : ALT_MILK));
    } else if (a.milk === 'cow' && a.strength !== 'very_strong') {
      // Two from the milk rule, one from the machine rule.
      // Kenya regular takes the second place for fruity espresso with milk.
      var milkList = isEspresso(a) && a.taste === 'fruity' ? ['bensa_m', 'kenya_m', 'jungle'] : COW_MILK;
      var milk = pick(milkList).slice(0, 2);
      var machine = pick(brewPicks(a, light)).filter(function (k) { return milk.indexOf(k) === -1; });
      picks = milk.concat(machine.slice(0, 1));
    } else {
      picks = pick(blackPicks(a, brewPicks(a, light)));
    }

    // Never come back empty: closest safe matches, still honouring alt milk.
    if (picks.length === 0) {
      var fallback = a.decaf ? [] : ['jungle', 'aristo', 'sertao', 'velvet'];
      picks = pick(fallback);
      if (picks.length === 0) {
        picks = inStock.filter(function (k) {
          return ROBUSTA.indexOf(k) === -1 && !((a.milk === 'alt' || a.noSour) && FRUITY.indexOf(k) !== -1);
        });
      }
    }
    return withExtras(picks, a, available.extras).slice(0, MAX);
  }

  root.MinutoQuizEngine = { recommend: recommend, ROBUSTA: ROBUSTA, FRUITY: FRUITY };
})(typeof globalThis !== 'undefined' ? globalThis : this);
