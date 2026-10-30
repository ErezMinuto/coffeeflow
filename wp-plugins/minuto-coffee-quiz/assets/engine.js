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
 * available = keys in stock, in catalog order; `light` lists every coffee
 * tagged light in WooCommerce, so a new light roast joins by itself.
 */
(function (root) {
  'use strict';

  var ROBUSTA = ['intenso', 'trieste', 'prestige'];
  // Never for alternative milk unless a light roast was asked for.
  var FRUITY = ['bensa_m', 'bensa_l', 'kenya_m', 'kenya_l', 'guji', 'aji', 'leona', 'yirgacheffe'];
  var COW_MILK = ['bensa_m', 'jungle'];
  var ALT_MILK = ['sertao', 'jungle', 'velvet'];
  var NO_SOUR = ['jungle', 'velvet'];
  var LIGHT_ORDER = ['kenya_l', 'guji', 'aji', 'leona', 'bensa_l'];
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
        if (a.taste === 'fruity') return lightList(light);
        if (a.taste === 'floral') return ['leona', 'yirgacheffe', 'velvet'];
        if (a.taste === 'chocolate') return ['jungle', 'velvet', 'antigua'];
        return ['kenya_l', 'jungle', 'velvet'];
    }
  }

  function uniq(list) {
    return list.filter(function (k, i) { return list.indexOf(k) === i; });
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
      picks = pick(lightList(light));        // an explicit ask beats the milk rules
    } else if (a.milk === 'alt' || a.noSour) {
      picks = pick(a.strength === 'very_strong' ? ['aristo', 'dark'] : (a.noSour ? NO_SOUR : ALT_MILK));
    } else if (a.milk === 'cow' && a.strength !== 'very_strong') {
      // Two from the milk rule, one from the machine rule.
      var milk = pick(COW_MILK).slice(0, 2);
      var machine = pick(brewPicks(a, light)).filter(function (k) { return milk.indexOf(k) === -1; });
      picks = milk.concat(machine.slice(0, 1));
    } else {
      picks = pick(brewPicks(a, light));
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
    return picks.slice(0, MAX);
  }

  root.MinutoQuizEngine = { recommend: recommend, ROBUSTA: ROBUSTA, FRUITY: FRUITY };
})(typeof globalThis !== 'undefined' ? globalThis : this);
