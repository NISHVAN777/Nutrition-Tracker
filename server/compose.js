// Builds the full meal report from "which foods, how many grams" using only the datasets
// (USDA FoodData Central + INDB) and the rules in rules.js. No paid AI involved.
// Used for a fresh scan, for "not right? pick another dish", and for adding/removing foods.
import { getFoodById, nutrientsFor, micronutrientsFor, sourceOf, computeTotals } from './foods.js';
import { describeMeal } from './rules.js';

const DATASET_NAMES = { FNDDS: 'USDA FNDDS', 'SR Legacy': 'USDA SR Legacy', Foundation: 'USDA Foundation Foods', INDB: 'Indian Nutrient Databank (INDB)' };

// "Rice, white, cooked, made with oil" -> "Rice, white, cooked" style short names for the plate list.
const shortName = (d) => d.replace(/\s*\(([^)]*)\)\s*/g, ' ').split(',').slice(0, 2).join(',').replace(/\s+/g, ' ').trim();

/**
 * @param {object} p
 * @param {string} p.title          meal name to show (dish name, or the food's name)
 * @param {Array}  p.parts          [{ food_id, grams, approx?, name? }]
 * @param {string} [p.cuisine]
 * @param {string} [p.confidence]   high | medium | low
 * @param {object} [p.recognition]  what the model saw (for the accuracy section)
 * @param {object} p.goals
 */
export function composeAnalysis({ title, parts, cuisine = '', confidence = 'medium', recognition = null, goals }) {
  const resolved = parts.map((p) => ({ ...p, food: getFoodById(p.food_id) })).filter((p) => p.food && p.grams > 0);
  if (!resolved.length) return { is_food: false, message: 'No food selected.', items: [], totals: computeTotals([]) };

  const items = resolved.map((p) => ({
    name: p.name || shortName(p.food.description),
    portion: p.portion || (p.food.serving_desc && Math.abs((p.food.serving_g ?? 0) - p.grams) < 1 ? p.food.serving_desc : `${Math.round(p.grams)} g`),
    estimated_grams: Math.round(p.grams),
    ...nutrientsFor(p.food, p.grams),
    source: { ...sourceOf(p.food), approx: Boolean(p.approx) },
  }));
  const totals = computeTotals(items);
  const spread = { high: 0.2, medium: 0.3, low: 0.4 }[confidence] ?? 0.3; // portion size is the main uncertainty
  const to10 = (n) => Math.round(n / 10) * 10;
  const words = describeMeal({ mealName: title, items, totals, goals });

  const datasets = [...new Set(items.map((it) => DATASET_NAMES[it.source.dataset] ?? it.source.dataset))];
  const approx = items.filter((it) => it.source.approx);
  const assumptions = [
    `Portion: a typical serving of ${items.map((it) => `${it.estimated_grams} g ${it.name.toLowerCase()}`).join(' + ')}. Use − / + if yours was bigger or smaller.`,
    ...approx.map((it) => `No exact dataset entry for this dish, so "${it.source.description}" is used as the closest similar food.`),
  ];
  const description = recognition?.kind === 'dish'
    ? `${title}${cuisine ? `, ${/^[AEIOU]/.test(cuisine) ? 'an' : 'a'} ${cuisine} dish` : ''}. Nutrition from ${datasets.join(' and ')}.`
    : `${title}. Nutrition from ${datasets.join(' and ')}.`;

  return {
    engine: 'local',
    is_food: true,
    message: '',
    meal_name: title,
    description,
    cuisine,
    confidence,
    visual_observations: recognition?.summary ?? '',
    assumptions,
    items,
    totals,
    calorie_range: [to10(totals.calories * (1 - spread)), to10(totals.calories * (1 + spread))],
    calories_corrected: false,
    micronutrients: micronutrientsFor(resolved.map((p) => ({ food: p.food, grams: p.grams }))),
    micronutrients_source: 'dataset',
    data_sources: { matched: items.length - approx.length, total: items.length, approximate: approx.length, database: datasets.join(' + ') },
    alternatives: recognition?.alternatives ?? [],
    ...words,
  };
}
