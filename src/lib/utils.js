/**
 * Pure utility functions — no hooks, no imports
 */

export const blendedWeightLoss = (profileIngredients, origins) => {
  return profileIngredients.reduce((sum, ing) => {
    const origin = origins.find(o => o.id === ing.origin_id);
    return sum + ((origin?.weight_loss || 0) * ing.percentage / 100);
  }, 0);
};

export const calculateRoastedWeight = (greenWeight, weightLossPercent) => {
  return (greenWeight * (1 - weightLossPercent / 100)).toFixed(1);
};

export const getOriginById = (origins, id) => {
  return origins.find(o => o.id === id);
};

/**
 * Calculate product cost.
 * Recipe ingredients can be:
 *   - New format:    { sourceType: 'origin'|'profile', sourceId: number, percentage }
 *   - Legacy format: { originId: number, percentage }
 *
 * Profile ingredients use the profile's blend recipe (from roastProfileIngredients)
 * to compute a blended cost-per-kg-roasted.
 */
export const calculateProductCost = (
  product, origins, costSettings, breakdown = false,
  roastProfiles = [], roastProfileIngredients = []
) => {
  const settings = costSettings || {
    bag_330g: 0.70,
    bag_250g: 0.60,
    bag_1000g: 2.00,
    label: 0.08,
    gas_per_roast: 10.00,
    labor_per_hour: 60,
    roasting_time_minutes: 17,
    packaging_time_minutes: 0.5,
    batch_size_kg: 15
  };

  let beansCost = 0;

  product.recipe.forEach(ingredient => {
    if (ingredient.sourceType === 'profile' && ingredient.sourceId) {
      // Profile ingredient — compute blended green cost + blended weight loss
      const profileIngs = roastProfileIngredients.filter(pi => pi.profile_id === ingredient.sourceId);
      const wl = blendedWeightLoss(profileIngs, origins);
      const blendedGreenCostPerKg = profileIngs.reduce((sum, pi) => {
        const o = origins.find(o => o.id === pi.origin_id);
        return sum + ((o?.cost_per_kg || 0) * pi.percentage / 100);
      }, 0);
      const yieldPct = wl < 100 ? 1 - wl / 100 : 1;
      const costPerKgRoasted = blendedGreenCostPerKg / yieldPct;
      beansCost += (product.size / 1000) * (ingredient.percentage / 100) * costPerKgRoasted;
    } else {
      // Origin ingredient — new { sourceType:'origin', sourceId } or legacy { originId }
      const originId = ingredient.sourceId || ingredient.originId;
      const origin = origins.find(o => o.id === originId);
      if (origin) {
        const weight = (product.size / 1000) * (ingredient.percentage / 100);
        const yieldPercent = 1 - (origin.weight_loss / 100);
        const costPerKgRoasted = origin.cost_per_kg / yieldPercent;
        beansCost += weight * costPerKgRoasted;
      }
    }
  });

  const avgWeightLoss = product.recipe.reduce((sum, ing) => {
    if (ing.sourceType === 'profile' && ing.sourceId) {
      const profileIngs = roastProfileIngredients.filter(pi => pi.profile_id === ing.sourceId);
      return sum + (blendedWeightLoss(profileIngs, origins) * (ing.percentage / 100));
    } else {
      const originId = ing.sourceId || ing.originId;
      const origin = origins.find(o => o.id === originId);
      return sum + (origin ? origin.weight_loss * (ing.percentage / 100) : 0);
    }
  }, 0);

  const roastedKgPerRoast = settings.batch_size_kg * (1 - avgWeightLoss / 100);
  const bagsPerRoast = (roastedKgPerRoast * 1000) / product.size;
  const gasCost = settings.gas_per_roast / bagsPerRoast;
  const roastingLaborPerRoast = (settings.labor_per_hour / 60) * settings.roasting_time_minutes;
  const roastingLabor = roastingLaborPerRoast / bagsPerRoast;
  const packagingLabor = (settings.labor_per_hour / 60) * settings.packaging_time_minutes;

  let packagingCost = settings.label;
  if (product.size === 250) packagingCost += settings.bag_250g;
  else if (product.size === 330) packagingCost += settings.bag_330g;
  else if (product.size === 1000) packagingCost += settings.bag_1000g;
  else packagingCost += settings.bag_330g;

  const totalCost = beansCost + gasCost + roastingLabor + packagingLabor + packagingCost;

  if (breakdown) {
    return {
      beansCost: beansCost.toFixed(2),
      gasCost: gasCost.toFixed(2),
      roastingLabor: roastingLabor.toFixed(2),
      packagingLabor: packagingLabor.toFixed(2),
      packagingCost: packagingCost.toFixed(2),
      totalCost: totalCost.toFixed(2),
      bagsPerRoast: bagsPerRoast.toFixed(1)
    };
  }
  return totalCost.toFixed(2);
};
