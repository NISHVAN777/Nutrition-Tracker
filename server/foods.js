// Nutrition database: USDA FoodData Central + INDB (Indian Nutrient Databank), built by
// scripts/build-foods-db.mjs into datasets/foods.db. All nutrient values are per 100 g.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(root, 'datasets', 'foods.db');

let fdb = null;
if (fs.existsSync(DB_PATH)) fdb = new DatabaseSync(DB_PATH, { readOnly: true });
else console.warn('Food database not found (datasets/foods.db): run scripts/build-foods-db.mjs.');

export const FOODS_AVAILABLE = Boolean(fdb);
export const USDA_AVAILABLE = FOODS_AVAILABLE; // kept for the optional Grok engine
export const FOOD_COUNT = fdb ? fdb.prepare('SELECT COUNT(*) AS n FROM foods').get().n : 0;

const MACROS = ['protein_g', 'carbs_g', 'fat_g', 'saturated_fat_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'cholesterol_mg'];

// Vitamins & minerals we report, with FDA daily values.
export const MICROS = [
  { col: 'calcium_mg', name: 'Calcium', unit: 'mg', dv: 1300, benefit: 'Keeps bones and teeth strong' },
  { col: 'iron_mg', name: 'Iron', unit: 'mg', dv: 18, benefit: 'Carries oxygen in your blood' },
  { col: 'magnesium_mg', name: 'Magnesium', unit: 'mg', dv: 420, benefit: 'Supports muscles, nerves and energy' },
  { col: 'potassium_mg', name: 'Potassium', unit: 'mg', dv: 4700, benefit: 'Helps control blood pressure' },
  { col: 'vitamin_c_mg', name: 'Vitamin C', unit: 'mg', dv: 90, benefit: 'Boosts immunity and healing' },
  { col: 'vitamin_a_ug', name: 'Vitamin A', unit: 'µg', dv: 900, benefit: 'Good for eyes and skin' },
  { col: 'vitamin_b12_ug', name: 'Vitamin B12', unit: 'µg', dv: 2.4, benefit: 'Helps make red blood cells' },
  { col: 'vitamin_d_ug', name: 'Vitamin D', unit: 'µg', dv: 20, benefit: 'Helps your body absorb calcium' },
];

const STOP = new Set(['with', 'and', 'or', 'the', 'of', 'in', 'on', 'a', 'an', 'side', 'piece', 'pieces', 'serving', 'portion', 'small', 'large', 'medium', 'homemade', 'style', 'dishes', 'dish']);
export const searchTerms = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
  .filter((t) => t.length > 1 && !STOP.has(t)).slice(0, 8);

const stmt = (where) => fdb?.prepare(`
  SELECT f.*, bm25(foods_fts, 10, 1) AS score
  FROM foods_fts JOIN foods f ON f.rowid = foods_fts.rowid
  WHERE foods_fts MATCH ? ${where} ORDER BY score LIMIT ?`);
const searchAll = stmt('');
const searchUsda = stmt('AND f.fdc_id IS NOT NULL');

// Full-text search: foods containing all the words first, then any of them.
export function searchFoods(queries, { limit = 8, usdaOnly = false } = {}) {
  if (!fdb) return [];
  const q = usdaOnly ? searchUsda : searchAll;
  const seen = new Map();
  const add = (rows) => rows.forEach((r) => { if (!seen.has(r.id) && seen.size < limit) seen.set(r.id, r); });
  const lists = [].concat(queries).map(searchTerms).filter((t) => t.length);
  for (const t of lists) add(q.all(t.map((w) => `"${w}"`).join(' AND '), limit));
  for (const t of lists) if (seen.size < limit) add(q.all(t.map((w) => `"${w}"`).join(' OR '), limit * 2));
  return [...seen.values()];
}

// Candidates for the optional Grok matcher (USDA only, as before).
export const findCandidates = (queries, limit = 8) => searchFoods(queries, { limit, usdaOnly: true });

export const getFoodById = (id) => fdb?.prepare('SELECT * FROM foods WHERE id = ?').get(String(id)) ?? null;
export const getFood = (fdcId) => fdb?.prepare('SELECT * FROM foods WHERE fdc_id = ?').get(fdcId) ?? null;

const NUTRIENTS = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'saturated_fat_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'cholesterol_mg'];
const round = (n, d = 0) => { const f = 10 ** d; return Math.round((Number(n) || 0) * f) / f; };

// Meal totals from its items (always computed here, never trusted from a client or model).
export function computeTotals(items) {
  const totals = Object.fromEntries(NUTRIENTS.map((k) => [k, 0]));
  for (const it of items) for (const k of NUTRIENTS) totals[k] += Number(it[k]) || 0;
  for (const k of NUTRIENTS) totals[k] = round(totals[k], k === 'calories' || k.endsWith('_mg') ? 0 : 1);
  return totals;
}

// Nutrients for `grams` of a food, in the shape the app uses for items.
export function nutrientsFor(food, grams) {
  const k = grams / 100;
  const r1 = (n) => Math.round((n ?? 0) * k * 10) / 10;
  return {
    calories: Math.round((food.kcal ?? 0) * k),
    ...Object.fromEntries(MACROS.map((c) => [c, c.endsWith('_mg') ? Math.round((food[c] ?? 0) * k) : r1(food[c])])),
  };
}

// Vitamins & minerals for a list of { food, grams }, as the top 5 by % of daily value.
export function micronutrientsFor(parts) {
  return MICROS.map((m) => {
    const amount = parts.reduce((sum, { food, grams }) => sum + (food[m.col] ?? 0) * grams / 100, 0);
    return { name: m.name, amount: `${amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10} ${m.unit}`, daily_value_percent: Math.round((amount / m.dv) * 100), benefit: m.benefit };
  }).filter((m) => m.daily_value_percent >= 2).sort((a, b) => b.daily_value_percent - a.daily_value_percent).slice(0, 5);
}

export const fdcUrl = (fdcId) => `https://fdc.nal.usda.gov/food-details/${fdcId}/nutrients`;
const INDB_URL = 'https://github.com/lindsayjaacks/Indian-Nutrient-Databank-INDB-';

// Where an item's numbers came from, for the report.
export function sourceOf(food) {
  return {
    dataset: food.dataset,
    id: food.id,
    fdc_id: food.fdc_id ?? null,
    description: food.description,
    kcal_per_100g: Math.round(food.kcal),
    url: food.fdc_id ? fdcUrl(food.fdc_id) : INDB_URL,
  };
}

// Search results for the "add / change food" box.
export const toSearchResult = (f) => ({
  id: f.id, name: f.description, dataset: f.dataset, kcal_per_100g: Math.round(f.kcal),
  serving_g: f.serving_g ? Math.round(f.serving_g) : null, serving_desc: f.serving_desc,
});
