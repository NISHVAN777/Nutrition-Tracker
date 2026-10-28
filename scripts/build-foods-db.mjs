// Builds datasets/foods.db: one searchable nutrition database (values per 100 g) from
//   - USDA FoodData Central (public domain): Foundation Foods, FNDDS (dishes as eaten), SR Legacy
//   - INDB, the Indian Nutrient Databank (1,014 Indian recipes)
//
// Inputs (one folder):
//   FoodData_Central_foundation_food_json_*.json, surveyDownload.json, FoodData_Central_sr_legacy_food_json_*.json
//     from https://fdc.nal.usda.gov/download-datasets (unzipped)
//   indb.json  made by: python scripts/ml/indb_to_json.py INDB.xlsx indb.json
//     (INDB.xlsx from https://github.com/lindsayjaacks/Indian-Nutrient-Databank-INDB-)
// Usage: node scripts/build-foods-db.mjs <folder>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = process.argv[2];
if (!srcDir) {
  console.error('Usage: node scripts/build-foods-db.mjs <folder-with-source-files>');
  process.exit(1);
}

// USDA nutrient numbers -> our columns.
const NUTRIENTS = {
  kcal: ['208', '958', '957'], // Energy; Foundation foods may only have the Atwater variants
  protein_g: ['203'],
  fat_g: ['204'],
  carbs_g: ['205'],
  fiber_g: ['291'],
  sugar_g: ['269', '269.3'],
  sodium_mg: ['307'],
  cholesterol_mg: ['601'],
  saturated_fat_g: ['606'],
  calcium_mg: ['301'],
  iron_mg: ['303'],
  magnesium_mg: ['304'],
  potassium_mg: ['306'],
  vitamin_c_mg: ['401'],
  vitamin_a_ug: ['320'],
  vitamin_b12_ug: ['418'],
  vitamin_d_ug: ['328'],
};
const COLS = Object.keys(NUTRIENTS);

const USDA = [
  { match: /foundation_food_json.*\.json$/i, key: 'FoundationFoods', dataset: 'Foundation' },
  { match: /^surveyDownload\.json$/i, key: 'SurveyFoods', dataset: 'FNDDS' },
  { match: /sr_legacy_food_json.*\.json$/i, key: 'SRLegacyFoods', dataset: 'SR Legacy' },
];

const outDir = path.join(root, 'datasets');
const outFile = path.join(outDir, 'foods.db');
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(outFile, { force: true });
const db = new DatabaseSync(outFile);
db.exec(`
  CREATE TABLE foods (
    rowid        INTEGER PRIMARY KEY,
    id           TEXT NOT NULL UNIQUE,       -- 'usda:<fdcId>' or 'indb:<code>'
    dataset      TEXT NOT NULL,              -- Foundation | FNDDS | SR Legacy | INDB
    fdc_id       INTEGER,                    -- USDA FoodData Central id (USDA rows only)
    description  TEXT NOT NULL,
    category     TEXT NOT NULL,
    serving_g    REAL,                       -- a typical serving, when the source gives one
    serving_desc TEXT,
    ${COLS.map((c) => `${c} REAL`).join(',\n    ')}
  );
  CREATE INDEX foods_fdc ON foods(fdc_id);
  CREATE VIRTUAL TABLE foods_fts USING fts5(description, category, content='foods', content_rowid='rowid', tokenize='porter unicode61');
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
const insert = db.prepare(`INSERT OR IGNORE INTO foods (id, dataset, fdc_id, description, category, serving_g, serving_desc, ${COLS.join(', ')})
  VALUES (?, ?, ?, ?, ?, ?, ?, ${COLS.map(() => '?').join(', ')})`);

// A typical serving: FNDDS's "Quantity not specified" amount when present, else the first listed portion.
function usdaServing(f) {
  const portions = (f.foodPortions ?? []).filter((p) => p.gramWeight > 0);
  if (!portions.length) return [null, null];
  const p = portions.find((x) => /quantity not specified/i.test(x.portionDescription ?? '')) ?? portions[0];
  let desc = p.portionDescription && !/quantity not specified/i.test(p.portionDescription) ? p.portionDescription
    : [p.amount, p.measureUnit?.name !== 'undetermined' ? p.measureUnit?.name : '', p.modifier].filter(Boolean).join(' ');
  if (/quantity not specified/i.test(p.portionDescription ?? '')) desc = 'typical serving';
  return [Math.round(p.gramWeight), desc || null];
}

const files = fs.readdirSync(srcDir);
const versions = [];
db.exec('BEGIN');
for (const src of USDA) {
  const file = files.find((f) => src.match.test(f));
  if (!file) { console.warn(`! ${src.dataset}: file not found in ${srcDir}`); continue; }
  const foods = JSON.parse(fs.readFileSync(path.join(srcDir, file), 'utf8'))[src.key];
  let kept = 0;
  for (const f of foods) {
    if (!f?.foodNutrients || !f.description) continue; // a few entries in the files are empty
    const byNumber = new Map(f.foodNutrients.filter((n) => typeof n.amount === 'number').map((n) => [n.nutrient.number, n.amount]));
    const v = Object.fromEntries(COLS.map((c) => {
      const num = NUTRIENTS[c].find((n) => byNumber.has(n));
      return [c, num ? byNumber.get(num) : null];
    }));
    if (v.kcal == null && (v.protein_g == null || v.fat_g == null || v.carbs_g == null)) continue;
    if (v.kcal == null) v.kcal = Math.round(v.protein_g * 4 + v.carbs_g * 4 + v.fat_g * 9);
    const category = f.foodCategory?.description ?? f.wweiaFoodCategory?.wweiaFoodCategoryDescription ?? '';
    const [servingG, servingDesc] = usdaServing(f);
    insert.run(`usda:${f.fdcId}`, src.dataset, f.fdcId, f.description, category, servingG, servingDesc, ...COLS.map((c) => v[c]));
    kept++;
  }
  versions.push(`${src.dataset}: ${file}`);
  console.log(`${src.dataset.padEnd(10)} ${kept} of ${foods.length} foods  (${file})`);
}

const indbFile = path.join(srcDir, 'indb.json');
if (fs.existsSync(indbFile)) {
  const all = JSON.parse(fs.readFileSync(indbFile, 'utf8'));
  // INDB's deep-fried recipes count all the frying oil as eaten (40-85 g fat per 100 g,
  // physically implausible), so those entries are left out; USDA covers fried dishes.
  const indb = all.filter((f) => !(f.fat_g > 40));
  console.log(`INDB       skipped ${all.length - indb.length} deep-fried recipes with implausible fat values`);
  for (const f of indb) {
    insert.run(`indb:${f.code}`, 'INDB', null, f.name, 'Indian recipes', f.serving_g, f.serving_desc, ...COLS.map((c) => f[c] ?? null));
  }
  versions.push(`INDB: Indian Nutrient Databank (${indb.length} recipes)`);
  console.log(`INDB       ${indb.length} recipes`);
} else console.warn('! INDB: indb.json not found, skipping Indian recipes');

db.exec("INSERT INTO foods_fts(foods_fts) VALUES ('rebuild')");
db.prepare('INSERT INTO meta VALUES (?, ?)').run('sources', versions.join('\n'));
db.prepare('INSERT INTO meta VALUES (?, ?)').run('built_at', new Date().toISOString());
db.exec('COMMIT');
db.exec('VACUUM');
db.close();
console.log(`Wrote ${path.relative(root, outFile)} (${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB)`);
