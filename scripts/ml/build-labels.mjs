// Builds the label files the app needs alongside the trained classifier:
//   ml/labels.json   every trained dish: display name, cuisine, and its nutrition entry + serving
//   ml/vocab.json    + ml/vocab.i8   CLIP text embeddings of ~6,400 dish names (USDA FNDDS + INDB)
//                    used to recognise foods outside the trained dishes ("zero-shot")
//   ml/gate.json     + ml/gate.i8    food / not-food prompts, to reject photos that aren't food
// Embeddings are stored as int8 with a per-vector scale (4x smaller than float32).
// Usage: node scripts/ml/build-labels.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { env, AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DS = path.join(ROOT, '.cache', 'datasets');
const ML = path.join(ROOT, 'ml');
fs.mkdirSync(ML, { recursive: true });
const foodsDb = new DatabaseSync(path.join(ROOT, 'datasets', 'foods.db'), { readOnly: true });
const { searchFoods } = await import(new URL('../../server/foods.js', import.meta.url));

// ---------- Trained dishes (must match scripts/ml/train.py canonical names) ----------
const ALIASES = { hamburger: 'burger', samosas: 'samosa', omelet: 'omelette' };
const canonical = (n) => { const c = n.trim().toLowerCase().replace(/[_\s]+/g, ' '); return ALIASES[c] ?? c; };
const display = (c) => c.charAt(0).toUpperCase() + c.slice(1);

const CUISINE_101 = {
  Japanese: ['sushi', 'sashimi', 'ramen', 'gyoza', 'takoyaki', 'edamame', 'miso soup', 'seaweed salad'],
  Korean: ['bibimbap'], Vietnamese: ['pho'], Thai: ['pad thai'],
  Chinese: ['peking duck', 'dumplings', 'hot and sour soup', 'fried rice', 'spring rolls'],
  Indian: ['samosa', 'chicken curry'],
  Mexican: ['tacos', 'nachos', 'churros', 'guacamole', 'huevos rancheros', 'breakfast burrito', 'chicken quesadilla'],
  Italian: ['spaghetti carbonara', 'spaghetti bolognese', 'lasagna', 'risotto', 'tiramisu', 'ravioli', 'gnocchi', 'bruschetta', 'caprese salad', 'panna cotta', 'cannoli', 'pizza', 'beef carpaccio'],
  French: ['croque madame', 'escargots', 'foie gras', 'french onion soup', 'macarons', 'creme brulee', 'beignets', 'french toast', 'french fries', 'beef tartare', 'mussels'],
  Spanish: ['paella', 'churros'], Greek: ['greek salad', 'baklava'], 'Middle Eastern': ['falafel', 'hummus'],
  Peruvian: ['ceviche'], Canadian: ['poutine'], British: ['fish and chips'],
  American: ['burger', 'hot dog', 'club sandwich', 'pulled pork sandwich', 'baby back ribs', 'chicken wings', 'clam chowder', 'lobster roll sandwich', 'macaroni and cheese', 'grilled cheese sandwich', 'pancakes', 'waffles', 'eggs benedict', 'red velvet cake', 'cheesecake', 'apple pie', 'donuts', 'onion rings', 'deviled eggs', 'carrot cake', 'cup cakes', 'strawberry shortcake', 'filet mignon', 'steak', 'prime rib', 'shrimp and grits', 'crab cakes', 'fried calamari', 'lobster bisque', 'caesar salad', 'oysters', 'scallops', 'tuna tartare', 'beet salad', 'bread pudding', 'chocolate cake', 'chocolate mousse', 'frozen yogurt', 'ice cream', 'garlic bread', 'omelette', 'chicken quesadilla'],
};
const cuisineOf101 = Object.fromEntries(Object.entries(CUISINE_101).flatMap(([c, list]) => list.map((d) => [d, c])));
// Items in the Indian dataset that aren't Indian dishes.
const GENERIC = new Set(['bread', 'cake', 'burger', 'pizza', 'brownie', 'doughnut', 'cooked pasta', 'cooked oatmeal', 'corn', 'cucumber', 'cabbage', 'custard', 'chow mein', 'chop suey', 'ice cream', 'apple pie', 'chicken wings', 'fried rice', 'garlic bread', 'omelette', 'spring rolls', 'tiramisu', 'chicken pizza', 'canned potatoes', 'chilli pepper']);

const classes = new Map();
const addClasses = (src, cuisine) => {
  for (const raw of JSON.parse(fs.readFileSync(path.join(DS, src, 'classes.json'), 'utf8'))) {
    const key = canonical(raw);
    const c = classes.get(key) ?? { key, name: display(key), sources: [], cuisine: '' };
    c.sources.push(src);
    if (!c.cuisine) c.cuisine = typeof cuisine === 'function' ? cuisine(key) : cuisine;
    classes.set(key, c);
  }
};
addClasses('food101', (k) => cuisineOf101[k] ?? '');
addClasses('indian', (k) => (GENERIC.has(k) ? '' : 'Indian'));
addClasses('vietnamese', 'Vietnamese');
addClasses('malaysian', 'Malaysian');

// ---------- Nutrition entry for each dish ----------
// scripts/ml/food-overrides.json holds the hand-checked choice for each dish:
//   "F:<exact name>" / "I:..." / "S:..."  exact entry in FNDDS / INDB / SR Legacy
//   "?F:<words>"                          best full-text match within that dataset
//   "...@<grams>"                         serving size to use
//   leading "~"                            an approximation (a similar dish), shown as such in the app
//   [ ..., ... ]                           a meal made of several parts (e.g. a thali)
const OVERRIDES = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ml', 'food-overrides.json'), 'utf8'));
const DATASET = { F: 'FNDDS', I: 'INDB', S: 'SR Legacy' };
const exact = foodsDb.prepare('SELECT * FROM foods WHERE dataset = ? AND description = ?');
const prefix = foodsDb.prepare("SELECT * FROM foods WHERE dataset = ? AND description LIKE ? || '%' ORDER BY length(description) LIMIT 1");
const problems = [];

function resolvePart(spec, key) {
  const m = /^(~)?(\?)?([FIS]):(.+?)(?:@(\d+))?$/.exec(spec.trim());
  if (!m) { problems.push(`${key}: bad spec "${spec}"`); return null; }
  const [, approx, search, ds, text, grams] = m;
  const dataset = DATASET[ds];
  let f;
  if (search) {
    const terms = text.toLowerCase().split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '')}"`);
    const q = foodsDb.prepare(`SELECT f.* FROM foods_fts JOIN foods f ON f.rowid = foods_fts.rowid
      WHERE foods_fts MATCH ? AND f.dataset = ? ORDER BY bm25(foods_fts, 10, 1) LIMIT 1`);
    f = q.get(terms.join(' AND '), dataset) ?? q.get(terms.join(' OR '), dataset);
  } else {
    f = exact.get(dataset, text) ?? prefix.get(dataset, text);
  }
  if (!f) { problems.push(`${key}: not found "${spec}"`); return null; }
  const g = Number(grams) || Math.round(f.serving_g || 100);
  return { food_id: f.id, food: f.description, dataset: f.dataset, grams: g, approx: Boolean(approx), kcal_per_100g: Math.round(f.kcal), serving_desc: grams ? null : f.serving_desc };
}

const labels = [];
for (const c of [...classes.values()].sort((a, b) => a.key.localeCompare(b.key))) {
  const spec = OVERRIDES[c.key];
  if (!spec) problems.push(`${c.key}: no entry in food-overrides.json`);
  const parts = spec ? [].concat(spec).map((x) => resolvePart(x, c.key)).filter(Boolean) : [];
  labels.push({ key: c.key, name: c.name, cuisine: c.cuisine, sources: c.sources, parts });
}
fs.writeFileSync(path.join(ML, 'labels.json'), JSON.stringify(labels, null, 1));
const review = labels.map((l) => `${l.key.padEnd(28)} -> ${l.parts.map((p) => `${p.approx ? '~' : ''}[${p.dataset}] ${p.food} ${p.grams} g = ${Math.round(p.kcal_per_100g * p.grams / 100)} kcal`).join(' + ') || 'NONE'}`);
fs.writeFileSync(path.join(ROOT, '.cache', 'labels-review.txt'), review.join('\n'));
const approxCount = labels.filter((l) => l.parts.some((p) => p.approx)).length;
console.log(`labels: ${labels.length} dishes; ${labels.filter((l) => l.parts.length && !l.parts.some((p) => p.approx)).length} with exact dataset entries, ${approxCount} approximated (similar dish), ${labels.filter((l) => !l.parts.length).length} missing`);
if (problems.length) console.log('problems:\n  ' + problems.join('\n  '));

// ---------- Text embeddings: zero-shot vocabulary and food gate ----------
if (process.argv.includes('--labels-only')) process.exit(0);
env.localModelPath = path.join(ROOT, 'models') + path.sep;
env.allowRemoteModels = false;
const MODEL = 'Xenova/clip-vit-base-patch32';
const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
const textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: 'q8' });

async function embedTexts(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const { text_embeds } = await textModel(tokenizer(batch, { padding: true, truncation: true }));
    const d = text_embeds.dims[1];
    for (let j = 0; j < batch.length; j++) {
      const v = text_embeds.data.slice(j * d, (j + 1) * d);
      const len = Math.hypot(...v);
      out.push(v.map((x) => x / len));
    }
  }
  return out;
}
function writeInt8(name, vectors) {
  const buf = Buffer.alloc(vectors.length * (4 + 512));
  vectors.forEach((v, i) => {
    const scale = Math.max(...v.map(Math.abs)) / 127;
    buf.writeFloatLE(scale, i * 516);
    for (let j = 0; j < 512; j++) buf.writeInt8(Math.round(v[j] / scale), i * 516 + 4 + j);
  });
  fs.writeFileSync(path.join(ML, `${name}.i8`), buf);
}

// Short, photo-like names: "Rice, white, cooked, made with oil" -> kept whole (CLIP handles it),
// but skip baby foods, supplements and ingredients nobody photographs as a meal.
const vocabRows = foodsDb.prepare(`SELECT id, description, dataset, serving_g FROM foods
  WHERE dataset IN ('FNDDS', 'INDB') AND serving_g IS NOT NULL
    AND description NOT LIKE '%baby food%' AND description NOT LIKE '%infant formula%'
    AND description NOT LIKE '%nutritional supplement%' AND description NOT LIKE '%formula%'`).all();
const vocab = vocabRows.map((r) => ({ id: r.id, name: r.description, dataset: r.dataset }));
console.log(`embedding ${vocab.length} food names for zero-shot…`);
writeInt8('vocab', await embedTexts(vocab.map((v) => `a photo of ${v.name}, a type of food.`)));
fs.writeFileSync(path.join(ML, 'vocab.json'), JSON.stringify(vocab));

const GATE = {
  food: ['a photo of food', 'a photo of a meal on a plate', 'a photo of a dish', 'a photo of a drink', 'a photo of a snack', 'a photo of fruit', 'a photo of a dessert', 'a bowl of food'],
  other: ['a photo of a person', 'a selfie', 'a photo of a car', 'a screenshot', 'a photo of text', 'a photo of a laptop', 'a photo of a phone', 'a photo of a dog', 'a photo of a cat', 'a photo of a building', 'a photo of a landscape', 'a photo of furniture', 'a photo of a room', 'a photo of clothes', 'a photo of a document', 'a blank wall', 'a photo of a toy', 'a photo of a plant'],
};
const gateTexts = [...GATE.food, ...GATE.other];
writeInt8('gate', await embedTexts(gateTexts));
fs.writeFileSync(path.join(ML, 'gate.json'), JSON.stringify({ food: GATE.food.length, other: GATE.other.length, prompts: gateTexts }));
console.log(`wrote ml/vocab.json + vocab.i8 (${(fs.statSync(path.join(ML, 'vocab.i8')).size / 1e6).toFixed(1)} MB), ml/gate.json + gate.i8`);
