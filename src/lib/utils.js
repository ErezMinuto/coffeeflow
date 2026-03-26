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

export const calculateProductCost = (product, origins, costSettings, breakdown = false) => {
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
    const origin = origins.find(o => o.id === ingredient.originId);
    if (origin) {
      const weight = (product.size / 1000) * (ingredient.percentage / 100);
      const yieldPercent = 1 - (origin.weight_loss / 100);
      const costPerKgRoasted = origin.cost_per_kg / yieldPercent;
      beansCost += weight * costPerKgRoasted;
    }
  });

  const avgWeightLoss = product.recipe.reduce((sum, ing) => {
    const origin = origins.find(o => o.id === ing.originId);
    return sum + (origin ? origin.weight_loss * (ing.percentage / 100) : 0);
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
