import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, IMAGE_DIR, getGoals, setGoals, DEFAULT_GOALS, dayKey } from './db.js';
import { analyzeFoodImage, dailyInsight, usageSummary, computeTotals, BudgetError, MODEL, PROMPT_VERSION } from './ai.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8787);
const PER_MINUTE_LIMIT = Number(process.env.PER_MINUTE_LIMIT ?? 6);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const LAN_ACCESS = process.env.LAN_ACCESS === 'true';
const ACCESS_PIN = process.env.ACCESS_PIN ?? '';
const SESSION_COOKIE = 'nl_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;

if (LAN_ACCESS && ACCESS_PIN.length < 6) {
  console.error('LAN_ACCESS=true needs an ACCESS_PIN of at least 6 characters in .env (it stops others on your Wi-Fi from using your AI credits).');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' }));

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

app.use(express.static(path.join(root, 'public')));
if (LAN_ACCESS) setupPinAuth(app);
app.use('/images', express.static(IMAGE_DIR, { maxAge: '30d', immutable: true }));

// ---------- Phone access (LAN mode only) ----------
// This computer needs no PIN. Any other device must log in with ACCESS_PIN before
// it can reach /api/* or /images/*, so nobody else on the Wi-Fi can spend your credits.

function setupPinAuth(app) {
  const sessions = new Map(); // token -> expiry (ms)
  const fails = new Map();    // ip -> timestamps of failed logins
  const pinHash = crypto.createHash('sha256').update(ACCESS_PIN).digest();

  const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const tokenOf = (req) => (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('='))
    .find(([k]) => k === SESSION_COOKIE)?.[1];
  const hasSession = (req) => {
    const token = tokenOf(req);
    const expires = token && sessions.get(token);
    if (!expires) return false;
    if (expires < Date.now()) { sessions.delete(token); return false; }
    return true;
  };

  app.post('/api/login', (req, res) => {
    const now = Date.now();
    const recent = (fails.get(req.ip) ?? []).filter((t) => now - t < LOGIN_WINDOW);
    if (recent.length >= LOGIN_MAX_FAILS) {
      fails.set(req.ip, recent);
      return res.status(429).json({ error: 'Too many wrong PINs. Try again in 15 minutes.' });
    }
    // Hash both sides so the compare is constant-time regardless of PIN length.
    const given = crypto.createHash('sha256').update(String(req.body?.pin ?? '')).digest();
    if (!crypto.timingSafeEqual(given, pinHash)) {
      recent.push(now);
      fails.set(req.ip, recent);
      const left = LOGIN_MAX_FAILS - recent.length;
      return res.status(401).json({ error: left ? `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong PINs. Try again in 15 minutes.' });
    }
    fails.delete(req.ip);
    for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, now + SESSION_TTL);
    res.set('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`);
    res.json({ ok: true });
  });

  app.use(['/api', '/images'], (req, res, next) => {
    if (isLoopback(req) || hasSession(req)) return next();
    res.status(401).json({ error: 'PIN required.' });
  });
}

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${PORT}`);
}

// Simple sliding-window limiter for the paid endpoints.
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const list = (hits.get(req.ip) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= PER_MINUTE_LIMIT) {
    return res.status(429).json({ error: 'Too many AI requests. Please wait a minute.' });
  }
  list.push(now);
  hits.set(req.ip, list);
  next();
}

const asyncRoute = (fn) => (req, res) => fn(req, res).catch((err) => {
  const status = err instanceof BudgetError ? 402 : (err.status ?? 500);
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

app.get('/api/usage', (req, res) => res.json(usageSummary()));

app.post('/api/analyze', rateLimit, asyncRoute(async (req, res) => {
  const { buf, ext, hash } = parseImage(req.body.image);
  const note = String(req.body.note ?? '').trim().slice(0, 200);
  const cacheKey = crypto.createHash('sha256').update(`${hash}|${note.toLowerCase()}|${MODEL}|${PROMPT_VERSION}`).digest('hex');

  const cached = db.prepare('SELECT analysis FROM analysis_cache WHERE cache_key = ?').get(cacheKey);
  if (cached) {
    return res.json({ analysis: JSON.parse(cached.analysis), image_hash: hash, cached: true, usage: usageSummary() });
  }

  const { analysis } = await analyzeFoodImage(req.body.image, note);
  db.prepare('INSERT OR REPLACE INTO analysis_cache (cache_key, image_hash, analysis, model) VALUES (?, ?, ?, ?)')
    .run(cacheKey, hash, JSON.stringify(analysis), MODEL);
  // Client always sends JPEG; other formats are stored under .jpg only if already JPEG.
  if (ext === 'jpg') {
    const file = path.join(IMAGE_DIR, `${hash}.jpg`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  }
  res.json({ analysis, image_hash: ext === 'jpg' ? hash : null, cached: false, usage: usageSummary() });
}));

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

app.post('/api/insight', rateLimit, asyncRoute(async (req, res) => {
  const data = dayData(dayKey());
  if (!data.meals.length) throw badRequest('Log at least one meal first.');
  // Same meals + goals = same advice; only pay again when something changed.
  const cacheKey = crypto.createHash('sha256').update(JSON.stringify([data.day, data.goals, data.meals.map((m) => [m.id, m.servings])])).digest('hex');
  const cached = db.prepare('SELECT insight FROM insight_cache WHERE cache_key = ?').get(cacheKey);
  if (cached) return res.json({ insight: cached.insight, cached: true, usage: usageSummary() });
  const insight = await dailyInsight(data);
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
app.listen(PORT, LAN_ACCESS ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`NutriLens running at http://localhost:${PORT}  (model: ${MODEL})`);
  if (LAN_ACCESS) {
    for (const url of lanUrls()) console.log(`Open on your phone: ${url}`);
    console.log('Phone access is on: other devices must enter your ACCESS_PIN.');
  }
});
