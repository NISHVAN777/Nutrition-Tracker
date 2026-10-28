import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, IMAGE_DIR, getGoals, setGoals, DEFAULT_GOALS, dayKey } from './db.js';
import { computeTotals, searchFoods, toSearchResult, getFoodById, FOOD_COUNT } from './foods.js';
import { composeAnalysis } from './compose.js';
import { dailyAdvice } from './rules.js';
import { VISION_AVAILABLE, recognise, warmUp, modelInfo } from './vision.js';

// Which engine analyses photos:
//   local (default): free, self-hosted CLIP + trained classifier + USDA/INDB data + rules
//   grok:            paid xAI Grok vision (needs XAI_API_KEY and credits)
const ENGINE = (process.env.AI_ENGINE ?? 'local').toLowerCase() === 'grok' ? 'grok' : 'local';
const grok = ENGINE === 'grok' ? await import('./ai.js') : null;
class BudgetError extends Error {}
const isBudgetError = (err) => err instanceof BudgetError || (grok && err instanceof grok.BudgetError);
if (ENGINE === 'local' && !VISION_AVAILABLE) {
  console.error('Local engine: model or classifier files are missing (models/, ml/). See README "Food recognition model".');
  process.exit(1);
}
const LABELS = new Map(JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ml', 'labels.json'), 'utf8')).map((l) => [l.key, l]));
// Cached scan results are tied to the model, labels and report rules: change any and scans refresh.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLASSIFIER_VERSION = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(HERE, '..', 'ml', 'classifier.f32')))
  .update(fs.readFileSync(path.join(HERE, '..', 'ml', 'labels.json')))
  .update(fs.readFileSync(path.join(HERE, 'rules.js')))
  .update(fs.readFileSync(path.join(HERE, 'compose.js')))
  .update(fs.readFileSync(path.join(HERE, 'index.js'))) // includes the dish-vs-name-matching decision
  .digest('hex').slice(0, 12);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8787);
const PER_MINUTE_LIMIT = Number(process.env.PER_MINUTE_LIMIT ?? 6);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const LAN_ACCESS = process.env.LAN_ACCESS === 'true';
// Deployed on Fly.io (FLY_APP_NAME is set by the platform). Login is on by default there;
// REQUIRE_LOGIN=false makes the deployed app open (the AI budget caps still apply).
const ON_FLY = Boolean(process.env.FLY_APP_NAME);
const NEEDS_LOGIN = LAN_ACCESS || (ON_FLY && process.env.REQUIRE_LOGIN !== 'false');
const ACCESS_PIN = process.env.ACCESS_PIN ?? '';
const SESSION_COOKIE = 'nl_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
// Backstop against guessing from many addresses at once: past this many wrong codes in
// LOGIN_WINDOW (from anyone), new logins pause. Devices already logged in keep working.
const LOGIN_MAX_FAILS_TOTAL = 100;

if (ON_FLY && NEEDS_LOGIN && ACCESS_PIN.length < 6) {
  console.error('On Fly.io the app is public: set an ACCESS_PIN secret of at least 6 characters (fly secrets set ACCESS_PIN=...).');
  process.exit(1);
}
if (LAN_ACCESS && ACCESS_PIN.length < 6) {
  console.error('LAN_ACCESS=true needs an ACCESS_PIN of at least 6 characters in .env (it stops others on your Wi-Fi from using your AI credits).');
  process.exit(1);
}

// The visitor's real address. Behind Fly's proxy every request arrives from the proxy,
// so use the Fly-Client-IP header it sets (clients cannot override it).
const clientIp = (req) => (ON_FLY && req.get('fly-client-ip')) || req.ip;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' }));

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  if (ON_FLY) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.set('X-Robots-Tag', 'noindex, nofollow'); // a personal app: keep it out of search results
  }
  next();
});

// Health check for the hosting platform (no data, no login).
app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.use(express.static(path.join(root, 'public')));
if (NEEDS_LOGIN) setupPinAuth(app);
app.use('/images', express.static(IMAGE_DIR, { maxAge: '30d', immutable: true }));

// ---------- Login (phone access on Wi-Fi, or always when deployed) ----------
// Locally, this computer needs no code. Any other device (and everyone, when deployed)
// must log in with ACCESS_PIN before it can reach /api/* or /images/*.

function setupPinAuth(app) {
  const fails = new Map(); // ip -> timestamps of failed logins
  let allFails = [];       // timestamps of every failed login
  const pinHash = crypto.createHash('sha256').update(ACCESS_PIN).digest();
  // Sessions live in SQLite (as hashes), so logins survive restarts and sleeping machines.
  const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

  // Never trust "loopback" when deployed: there, every request comes through a proxy.
  const isLoopback = (req) => !ON_FLY && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const tokenOf = (req) => (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('='))
    .find(([k]) => k === SESSION_COOKIE)?.[1];
  const hasSession = (req) => {
    const token = tokenOf(req);
    if (!token) return false;
    const row = db.prepare('SELECT expires FROM sessions WHERE token_hash = ?').get(tokenHash(token));
    return Boolean(row && row.expires > Date.now());
  };

  app.post('/api/login', (req, res) => {
    const now = Date.now();
    const ip = clientIp(req);
    allFails = allFails.filter((t) => now - t < LOGIN_WINDOW);
    if (allFails.length >= LOGIN_MAX_FAILS_TOTAL) {
      return res.status(429).json({ error: 'Logins are paused for a few minutes. Please try again later.' });
    }
    const recent = (fails.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW);
    if (recent.length >= LOGIN_MAX_FAILS) {
      fails.set(ip, recent);
      return res.status(429).json({ error: 'Too many wrong attempts. Try again in 15 minutes.' });
    }
    // Hash both sides so the compare is constant-time regardless of PIN length.
    const given = crypto.createHash('sha256').update(String(req.body?.pin ?? '')).digest();
    if (!crypto.timingSafeEqual(given, pinHash)) {
      recent.push(now);
      fails.set(ip, recent);
      allFails.push(now);
      const left = LOGIN_MAX_FAILS - recent.length;
      return res.status(401).json({ error: left ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong attempts. Try again in 15 minutes.' });
    }
    fails.delete(ip);
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, expires) VALUES (?, ?)').run(tokenHash(token), now + SESSION_TTL);
    const secure = ON_FLY ? '; Secure' : '';
    res.set('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${secure}`);
    res.json({ ok: true });
  });

  app.use(['/api', '/images'], (req, res, next) => {
    if (isLoopback(req) || hasSession(req)) return next();
    res.status(401).json({ error: 'Access code required.' });
  });
}

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${PORT}`);
}

// Simple sliding-window limiter for the paid endpoints.
// Sliding-window limiter per visitor, one bucket per kind of request.
function limiter(perMinute, message) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const ip = clientIp(req);
    const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= perMinute) return res.status(429).json({ error: message });
    list.push(now);
    hits.set(ip, list);
    next();
  };
}
// Paid AI calls are strictly limited; the free local model only needs protection from floods.
const rateLimit = limiter(ENGINE === 'grok' ? PER_MINUTE_LIMIT : Math.max(PER_MINUTE_LIMIT, 20), 'Too many scans. Please wait a minute.');
const editLimit = limiter(60, 'Too many changes. Please wait a few seconds.');

const asyncRoute = (fn) => (req, res) => fn(req, res).catch((err) => {
  const status = isBudgetError(err) ? 402 : (err.status ?? 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

function parseImage(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!m) throw badRequest('Please upload a JPEG, PNG or WebP image.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGE_BYTES) throw badRequest('Image is too large (max 2 MB after compression).');
  const magic = { jpeg: [0xff, 0xd8], png: [0x89, 0x50], webp: [0x52, 0x49] }[m[1]];
  if (buf[0] !== magic[0] || buf[1] !== magic[1]) throw badRequest('The file is not a valid image.');
  return { buf, ext: m[1] === 'jpeg' ? 'jpg' : m[1], hash: crypto.createHash('sha256').update(buf).digest('hex') };
}

const rowToMeal = (r) => ({ ...r, analysis: JSON.parse(r.analysis), image_url: r.image_hash ? `/images/${r.image_hash}.jpg` : null });

// ---------- API ----------

function usageSummary() {
  if (grok) return { engine: 'grok', ...grok.usageSummary() };
  return { engine: 'local', free: true, model: 'CLIP + trained food classifier', dishes: LABELS.size, foods: FOOD_COUNT };
}
app.get('/api/usage', (req, res) => res.json(usageSummary()));
app.get('/api/model', asyncRoute(async (req, res) => res.json({ engine: ENGINE, ...(ENGINE === 'local' ? await modelInfo() : { model: grok.MODEL }) })));

const pct = (p) => `${Math.round(p * 100)}%`;
const titleCase = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const shortFoodName = (d) => d.replace(/\s*\(([^)]*)\)\s*/g, ' ').split(',').slice(0, 2).join(',').replace(/\s+/g, ' ').trim();

// Local engine: recognise the dish, then build the report from dataset values + rules.
async function analyzeLocally(buf) {
  const r = await recognise(buf);
  if (!r.isFood) {
    return { engine: 'local', is_food: false, message: 'This doesn’t look like food. Try a clear photo of your meal, taken from above.', items: [], totals: computeTotals([]) };
  }
  const top = r.dishes[0];
  // The classifier beats name matching on real food photos even when unsure (31% right below 30% confidence),
  // so name matching is only used when it is really lost (e.g. not a dish it was trained on).
  const useDish = top.probability >= 0.18 && top.parts.length;
  const confidence = useDish ? (top.probability >= 0.7 ? 'high' : top.probability >= 0.45 ? 'medium' : 'low') : 'low';
  const others = r.dishes.slice(useDish ? 1 : 0).filter((d) => d.probability >= 0.02 && d.parts.length);
  const alternatives = [
    ...others.slice(0, 5).map((d) => ({ choice: `dish:${d.key}`, name: d.name, probability: Math.round(d.probability * 100) })),
    ...r.foods.slice(0, 4).map((f) => ({ choice: `food:${f.id}`, name: shortFoodName(f.name), similarity: Math.round(f.similarity * 100) })),
  ].filter((a, i, list) => list.findIndex((x) => x.name.toLowerCase() === a.name.toLowerCase()) === i).slice(0, 7);

  const summary = useDish
    ? `The model recognised ${top.name} (${pct(top.probability)} sure).${others.length ? ` Other possibilities: ${others.slice(0, 3).map((d) => `${d.name} (${pct(d.probability)})`).join(', ')}.` : ''}`
    : `Not one of the ${LABELS.size} trained dishes with confidence (best guess ${top.name}, ${pct(top.probability)}), so it was matched by name to the closest food in the nutrition database.`;

  if (useDish) {
    return composeAnalysis({
      title: top.name, cuisine: top.cuisine, confidence, goals: getGoals(),
      parts: top.parts.map((p) => ({ food_id: p.food_id, grams: p.grams, approx: p.approx })),
      recognition: { kind: 'dish', summary, alternatives },
    });
  }
  const f = getFoodById(r.foods[0].id);
  return composeAnalysis({
    title: titleCase(shortFoodName(f.description)), confidence, goals: getGoals(),
    parts: [{ food_id: f.id, grams: f.serving_g || 150 }],
    recognition: { kind: 'food', summary, alternatives: alternatives.filter((a) => a.choice !== `food:${f.id}`) },
  });
}

app.post('/api/analyze', rateLimit, asyncRoute(async (req, res) => {
  const { buf, ext, hash } = parseImage(req.body.image);
  const note = String(req.body.note ?? '').trim().slice(0, 200);
  const version = ENGINE === 'local' ? `local|${CLASSIFIER_VERSION}` : `${grok.MODEL}|${grok.PROMPT_VERSION}|${note.toLowerCase()}`;
  const cacheKey = crypto.createHash('sha256').update(`${hash}|${version}`).digest('hex');

  const cached = db.prepare('SELECT analysis FROM analysis_cache WHERE cache_key = ?').get(cacheKey);
  let analysis;
  if (cached) analysis = JSON.parse(cached.analysis);
  else {
    analysis = ENGINE === 'local' ? await analyzeLocally(buf) : (await grok.analyzeFoodImage(req.body.image, note)).analysis;
    db.prepare('INSERT OR REPLACE INTO analysis_cache (cache_key, image_hash, analysis, model) VALUES (?, ?, ?, ?)')
      .run(cacheKey, hash, JSON.stringify(analysis), ENGINE === 'local' ? `local:${CLASSIFIER_VERSION}` : grok.MODEL);
  }
  // Client always sends JPEG; other formats are stored under .jpg only if already JPEG.
  if (ext === 'jpg') {
    const file = path.join(IMAGE_DIR, `${hash}.jpg`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  }
  res.json({ analysis, image_hash: ext === 'jpg' ? hash : null, cached: Boolean(cached) && ENGINE === 'grok', usage: usageSummary() });
}));

// Rebuild a report from a chosen dish/food or an edited list of foods (free, no photo needed).
app.post('/api/compose', editLimit, asyncRoute(async (req, res) => {
  const { choice } = req.body;
  let title = String(req.body.title ?? '').slice(0, 80);
  let cuisine = String(req.body.cuisine ?? '').slice(0, 40);
  let parts;
  if (typeof choice === 'string' && choice.startsWith('dish:')) {
    const l = LABELS.get(choice.slice(5));
    if (!l?.parts.length) throw badRequest('Unknown dish.');
    title = l.name; cuisine = l.cuisine;
    parts = l.parts.map((p) => ({ food_id: p.food_id, grams: p.grams, approx: p.approx }));
  } else if (typeof choice === 'string' && choice.startsWith('food:')) {
    const f = getFoodById(choice.slice(5));
    if (!f) throw badRequest('Unknown food.');
    title = titleCase(shortFoodName(f.description)); cuisine = '';
    parts = [{ food_id: f.id, grams: f.serving_g || 150 }];
  } else if (Array.isArray(req.body.parts)) {
    parts = req.body.parts.slice(0, 12).map((p) => ({
      food_id: String(p.food_id ?? ''), grams: Math.min(Math.max(Number(p.grams) || 0, 1), 3000),
      approx: Boolean(p.approx), name: p.name ? String(p.name).slice(0, 80) : undefined,
    })).filter((p) => /^(usda|indb):[\w.-]+$/.test(p.food_id));
    if (!parts.length) throw badRequest('Add at least one food.');
    if (!title) title = titleCase(shortFoodName(getFoodById(parts[0].food_id)?.description ?? 'Meal'));
  } else throw badRequest('Nothing to compose.');
  const analysis = composeAnalysis({ title, cuisine, parts, confidence: 'high', goals: getGoals(), recognition: { kind: 'manual', summary: 'Chosen by you.' } });
  res.json({ analysis, usage: usageSummary() });
}));

// Food search for "add a food" / "pick the right food".
app.get('/api/foods/search', editLimit, (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 80);
  res.json({ results: q.trim().length < 2 ? [] : searchFoods([q], { limit: 12 }).map(toSearchResult) });
});

app.post('/api/meals', asyncRoute(async (req, res) => {
  const { analysis, image_hash } = req.body;
  const servings = Math.min(Math.max(Number(req.body.servings) || 1, 0.25), 10);
  const mealType = MEAL_TYPES.includes(req.body.meal_type) ? req.body.meal_type : 'snack';
  if (!analysis?.is_food || !Array.isArray(analysis.items)) throw badRequest('Nothing to log.');
  // Re-derive totals server-side so the log can't drift from its items.
  const clean = { ...analysis, totals: computeTotals(analysis.items) };
  const hash = /^[a-f0-9]{64}$/.test(image_hash ?? '') && fs.existsSync(path.join(IMAGE_DIR, `${image_hash}.jpg`)) ? image_hash : null;
  const now = new Date();
  const info = db.prepare('INSERT INTO meals (logged_at, day, meal_type, servings, image_hash, analysis) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now.toISOString(), dayKey(now), mealType, servings, hash, JSON.stringify(clean));
  res.json(rowToMeal(db.prepare('SELECT * FROM meals WHERE id = ?').get(info.lastInsertRowid)));
}));

app.delete('/api/meals/:id', (req, res) => {
  db.prepare('DELETE FROM meals WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

function dayData(day) {
  const meals = db.prepare('SELECT * FROM meals WHERE day = ? ORDER BY logged_at').all(day).map(rowToMeal);
  const totals = computeTotals(meals.flatMap((m) => m.analysis.items.map((it) =>
    Object.fromEntries(Object.entries(it).map(([k, v]) => [k, typeof v === 'number' ? v * m.servings : v])))));
  return { day, meals, totals, goals: getGoals() };
}

app.get('/api/day/:day', (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.params.day) ? req.params.day : dayKey();
  res.json(dayData(day));
});

app.get('/api/history', (req, res) => {
  const days = db.prepare('SELECT DISTINCT day FROM meals ORDER BY day DESC LIMIT 30').all();
  res.json({ goals: getGoals(), days: days.map(({ day }) => { const d = dayData(day); return { day, meal_count: d.meals.length, totals: d.totals }; }) });
});

app.post('/api/insight', ENGINE === 'grok' ? rateLimit : editLimit, asyncRoute(async (req, res) => {
  const data = dayData(dayKey());
  if (!data.meals.length) throw badRequest('Log at least one meal first.');
  // Same meals + goals = same advice; only pay again when something changed.
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify([data.day, data.goals, data.meals.map((m) => [m.id, m.servings])])).digest('hex');
  const cached = db.prepare('SELECT insight FROM insight_cache WHERE cache_key = ?').get(cacheKey);
  if (cached) return res.json({ insight: cached.insight, cached: true, usage: usageSummary() });
  const insight = grok ? await grok.dailyInsight(data) : dailyAdvice(data);
  db.prepare('INSERT OR REPLACE INTO insight_cache (cache_key, insight) VALUES (?, ?)').run(cacheKey, insight);
  res.json({ insight, cached: false, usage: usageSummary() });
}));

app.get('/api/goals', (req, res) => res.json(getGoals()));
app.put('/api/goals', (req, res) => {
  const goals = Object.fromEntries(Object.keys(DEFAULT_GOALS).map((k) => [k, Math.min(Math.max(Number(req.body[k]) || DEFAULT_GOALS[k], 0), 100000)]));
  setGoals(goals);
  res.json(goals);
});

// Bound to localhost only by default: nobody else on your Wi-Fi can use (and spend) your key.
// LAN_ACCESS=true opens it to your network, with every other device behind the PIN.
// Deployed: listen on all interfaces behind the platform's HTTPS proxy.
if (ENGINE === 'local') warmUp().catch((err) => console.error('Model failed to load:', err.message));
const server = app.listen(PORT, NEEDS_LOGIN || ON_FLY ? '0.0.0.0' : '127.0.0.1', () => {
  if (ON_FLY) {
    console.log(`NutriLens running on Fly.io app "${process.env.FLY_APP_NAME}" port ${PORT} (engine: ${ENGINE}, ${NEEDS_LOGIN ? 'login required' : 'open access'})`);
    return;
  }
  console.log(`NutriLens running at http://localhost:${PORT}  (engine: ${ENGINE === 'local' ? 'free local model' : `Grok ${grok.MODEL}`})`);
  if (LAN_ACCESS) {
    for (const url of lanUrls()) console.log(`Open on your phone: ${url}`);
    console.log('Phone access is on: other devices must enter your ACCESS_PIN.');
  }
});

// Clean shutdown (the platform stops idle machines): finish requests, close the database.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
