// NutriLens frontend. Talks only to our own server; the API key never reaches the browser.
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: d });
const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;
const HEADER_OFFSET = () => (isDesktop() ? 24 : headerHeight() + 12); // room for the sticky mobile header
function headerHeight() {
  const h = document.querySelector('.mobile-header');
  return h && getComputedStyle(h).position === 'sticky' && h.offsetParent ? h.offsetHeight : 0;
}
// Browsers restore an old scroll position on reload; an app should open at the top.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

// Scroll that always arrives: smooth when the browser animates it, otherwise (reduced
// motion, background tab, some embedded browsers) it jumps straight to the target.
function scrollToY(y) {
  const target = Math.max(0, Math.round(y));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: target, behavior: reduce ? 'instant' : 'smooth' });
  clearTimeout(scrollToY.timer);
  scrollToY.timer = setTimeout(() => {
    if (Math.abs(window.scrollY - target) > 4) window.scrollTo({ top: target, behavior: 'instant' });
  }, 600);
}
const scrollToEl = (el) => scrollToY(el.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET());

const MAX_SIDE = 1024;   // px: plenty for food recognition, keeps image tokens low
const JPEG_QUALITY = 0.82;

const GOAL_LABELS = {
  calories: ['Calories', 'kcal'], protein_g: ['Protein', 'g'], carbs_g: ['Carbs', 'g'], fat_g: ['Fat', 'g'],
  fiber_g: ['Fiber', 'g'], sugar_g: ['Sugar', 'g'], sodium_mg: ['Sodium (salt)', 'mg'],
};
const GOAL_HINTS = {
  calories: 'Total energy for the day. Most adults need 1,600–2,600.',
  protein_g: 'Builds muscle and keeps you full. About 0.8–1.2 g per kg of body weight.',
  carbs_g: 'Your main energy source. Often about half of your calories.',
  fat_g: 'Needed in small amounts. About 25–35% of your calories.',
  fiber_g: 'Good for digestion. Aim for at least 25–30 g.',
  sugar_g: 'An upper limit. Less is better.',
  sodium_mg: 'An upper limit for salt. 2,300 mg is about one teaspoon of salt.',
};
const DEFAULT_GOALS = { calories: 2000, protein_g: 75, carbs_g: 250, fat_g: 65, fiber_g: 28, sugar_g: 50, sodium_mg: 2300 };
const TODAY_HINTS = {
  fiber_g: 'Aim to reach it', sugar_g: 'Try to stay under', sodium_mg: 'Try to stay under',
};
const MACRO_COLORS = { protein_g: 'var(--protein)', carbs_g: 'var(--carbs)', fat_g: 'var(--fat)', fiber_g: 'var(--fiber)' };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  // Phone-access mode: another device must unlock with the PIN first, then we retry.
  if (res.status === 401) {
    await unlock();
    return api(path, opts);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  if (data.usage) renderUsage(data.usage);
  return data;
}

// One PIN prompt shared by every request that hit a 401 at the same time.
let unlocking = null;
function unlock() {
  unlocking ??= new Promise((resolve) => {
    const screen = $('#pin-screen'), input = $('#pin-input'), error = $('#pin-error'), btn = $('#pin-form button');
    screen.hidden = false;
    document.body.classList.add('locked');
    input.focus();
    $('#pin-form').onsubmit = async (e) => {
      e.preventDefault();
      btn.disabled = true;
      error.hidden = true;
      try {
        const res = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: input.value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Login failed (${res.status})`);
        screen.hidden = true;
        document.body.classList.remove('locked');
        input.value = '';
        unlocking = null;
        resolve();
      } catch (err) {
        error.textContent = err instanceof TypeError ? 'Can’t reach NutriLens. Is the computer on and on the same Wi-Fi?' : err.message;
        error.hidden = false;
        input.select();
      } finally {
        btn.disabled = false;
      }
    };
  });
  return unlocking;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- Usage (sidebar on desktop, chip on mobile) ----------
function renderUsage(u) {
  const monthPct = Math.min((u.month_cost_usd / u.monthly_budget_usd) * 100, 100);
  const todayPct = Math.min((u.today_calls / u.daily_limit) * 100, 100);
  $('#usage-chip').textContent = `AI $${u.month_cost_usd.toFixed(2)} / $${u.monthly_budget_usd.toFixed(0)}`;
  $('#usage-chip').title = `AI this month: $${u.month_cost_usd.toFixed(3)} of $${u.monthly_budget_usd.toFixed(2)} · scans today: ${u.today_calls} of ${u.daily_limit}`;
  $('#u-month').textContent = `$${u.month_cost_usd.toFixed(3)} / $${u.monthly_budget_usd.toFixed(2)}`;
  $('#u-today').textContent = `${u.today_calls} / ${u.daily_limit}`;
  for (const [id, pct] of [['#u-month-bar', monthPct], ['#u-today-bar', todayPct]]) {
    const bar = $(id);
    bar.style.width = `${pct}%`;
    bar.className = pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '';
  }
}
const refreshUsage = () => api('/api/usage').then(renderUsage).catch(() => {});

// ---------- Navigation ----------
$$('.tab, [data-goto]').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab ?? btn.dataset.goto)));
const scrollMemory = {};
let activeTab = 'scan';
function showTab(name) {
  if (name !== activeTab) scrollMemory[activeTab] = window.scrollY;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  // Same tab tapped again = back to top; otherwise return to where you left it.
  window.scrollTo({ top: name === activeTab ? 0 : scrollMemory[name] ?? 0, behavior: 'instant' });
  activeTab = name;
  if (name === 'today') loadToday();
  if (name === 'history') loadHistory();
  if (name === 'goals') loadGoals();
}

// ---------- Image capture & compression ----------
let imageDataUrl = null;
let goals = null; // user's daily goals, used to explain every number
let current = null; // { analysis, image_hash, servings }

async function compress(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

// The scan page has three states. With a food result, the quick review card
// replaces the photo panel and sits beside the full report.
function setPane(which) {
  $('#loading').hidden = which !== 'loading';
  $('#result').hidden = which !== 'result';
  $('#how').hidden = which !== 'how';
  const state = which === 'result' && current?.analysis?.is_food ? 'result' : which === 'loading' ? 'loading' : 'idle';
  $('#scan-layout').dataset.state = state;
  $('#new-scan').hidden = state !== 'result';
}

async function setFile(file) {
  if (!file || !file.type.startsWith('image/')) return showScanError('Please choose an image file.');
  hideScanError();
  setPane('how');
  try {
    imageDataUrl = await compress(file);
  } catch {
    return showScanError('Could not read that image. Try a JPEG or PNG.');
  }
  $('#preview').src = imageDataUrl;
  $('#preview').hidden = false;
  $('#change-photo').hidden = false;
  $('#drop-hint').hidden = true;
  $('#dropzone').classList.add('has-image');
  $('#analyze').disabled = false;
}

function resetScanner() {
  imageDataUrl = null; current = null;
  scrollMemory.scan = 0;
  $('#preview').hidden = true; $('#change-photo').hidden = true; $('#drop-hint').hidden = false;
  $('#dropzone').classList.remove('has-image');
  $('#file-camera').value = ''; $('#file-upload').value = ''; $('#note').value = '';
  $('#analyze').disabled = true;
  setPane('how');
}

['#file-camera', '#file-upload'].forEach((id) => $(id).addEventListener('change', (e) => setFile(e.target.files[0])));
const dz = $('#dropzone');
dz.addEventListener('click', () => { if (!imageDataUrl) $('#file-upload').click(); });
$('#change-photo').addEventListener('click', (e) => { e.stopPropagation(); $('#file-upload').click(); });
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (item) { showTab('scan'); setFile(item.getAsFile()); }
});

const showScanError = (msg) => { $('#scan-error').textContent = msg; $('#scan-error').hidden = false; };
const hideScanError = () => { $('#scan-error').hidden = true; };

// ---------- Analyze ----------
function startSteps() {
  const steps = $$('#steps li');
  let i = 0;
  steps.forEach((li) => li.classList.remove('active', 'done'));
  steps[0].classList.add('active');
  const timer = setInterval(() => {
    if (i >= steps.length - 1) return;
    steps[i].classList.replace('active', 'done');
    steps[++i].classList.add('active');
  }, 1400);
  return () => clearInterval(timer);
}

async function analyze() {
  if (!imageDataUrl) return;
  hideScanError();
  $('#analyze').disabled = true;
  $('#loading-img').src = imageDataUrl;
  setPane('loading');
  if (!isDesktop()) scrollToEl($('#loading'));
  const stopSteps = startSteps();
  try {
    goals ??= await api('/api/goals');
    const data = await api('/api/analyze', { method: 'POST', body: { image: imageDataUrl, note: $('#note').value } });
    current = { analysis: data.analysis, image_hash: data.image_hash, servings: 1, cached: data.cached };
    renderResult();
    setPane('result');
    if (isDesktop()) scrollToY(0);
    else scrollToEl(current.analysis.is_food ? $('#review') : $('#result'));
  } catch (err) {
    setPane('how');
    showScanError(err.message);
  } finally {
    stopSteps();
    $('#analyze').disabled = false;
  }
}
$('#analyze').addEventListener('click', analyze);
$('#new-scan').addEventListener('click', () => { resetScanner(); scrollToY(0); });

function scaled(totals, s) {
  return Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v * s]));
}

// ---------- Plain-language helpers (shared by Scan and Today) ----------

// What each score band means, in words a beginner understands.
function scoreBand(score) {
  if (score <= 3) return { label: 'Less healthy', cls: 'bad', note: 'Fine as an occasional treat, but not a good everyday choice.' };
  if (score <= 5) return { label: 'Okay sometimes', cls: 'meh', note: 'Not bad, but it could be more balanced.' };
  if (score <= 7) return { label: 'Good choice', cls: 'ok', note: 'A fairly balanced, nutritious meal.' };
  return { label: 'Excellent', cls: 'great', note: 'A very nutritious, well-balanced meal.' };
}

const MACRO_INFO = {
  protein_g: { name: 'Protein', why: 'Builds and repairs muscles, and keeps you full for longer.' },
  carbs_g: { name: 'Carbohydrates (carbs)', why: 'Your body’s main fuel, from rice, bread, fruit, sugar and more.' },
  fat_g: { name: 'Fat', why: 'Stored energy that helps your body absorb vitamins. Needed, but in small amounts.' },
};

// "Get more" vs "limit" nutrients, read with the simple 5% / 20% rule used on food labels.
const DETAIL_INFO = [
  { key: 'fiber_g', name: 'Fiber', unit: 'g', kind: 'more', why: 'Helps digestion and keeps you full. Found in vegetables, fruit, whole grains, dal.' },
  { key: 'saturated_fat_g', name: 'Saturated fat', unit: 'g', kind: 'limit', why: 'The “unhealthy” fat in butter, ghee, cheese, red meat and fried food. Too much is bad for your heart.' },
  { key: 'sugar_g', name: 'Sugar', unit: 'g', kind: 'limit', why: 'Quick energy, but too much leads to weight gain and energy crashes.' },
  { key: 'sodium_mg', name: 'Sodium (salt)', unit: 'mg', kind: 'limit', why: 'Too much salt can raise your blood pressure.' },
  { key: 'cholesterol_mg', name: 'Cholesterol', unit: 'mg', kind: 'limit', why: 'Found in eggs, meat and dairy. Most people should keep it moderate.' },
];

function dailyRefs(goals) {
  return { ...goals, saturated_fat_g: 20, cholesterol_mg: 300 };
}

function levelOf(pct, kind) {
  const level = pct <= 5 ? 'Low' : pct >= 20 ? 'High' : 'Medium';
  const map = kind === 'more'
    ? { Low: ['meh', 'Low'], Medium: ['ok', 'Some'], High: ['great', 'High · great'] }
    : { Low: ['great', 'Low · good'], Medium: ['meh', 'Medium'], High: ['bad', 'High · limit this'] };
  const [cls, text] = map[level];
  return { cls, text };
}

const CONFIDENCE_INFO = {
  high: 'The AI clearly recognised the food and the portion size.',
  medium: 'The dish is clear, but the portion size or recipe is a best guess.',
  low: 'The AI isn’t sure what this food is. Add a note to help it.',
};

function scoreScale(score) {
  const band = scoreBand(score);
  return `
    <div class="scale" role="img" aria-label="Health score ${score} out of 10, ${band.label}">
      <div class="scale-track">${Array.from({ length: 10 }, (_, i) =>
        `<span class="seg ${scoreBand(i + 1).cls} ${i + 1 === score ? 'on' : ''}">${i + 1}</span>`).join('')}</div>
      <div class="scale-legend">
        <span style="flex:3">Less healthy</span><span style="flex:2">Okay</span><span style="flex:2">Good</span><span style="flex:3">Excellent</span>
      </div>
    </div>`;
}

function renderResult() {
  const a = current.analysis;
  const el = $('#result');
  el.hidden = false;

  if (!a.is_food) {
    el.innerHTML = `<div class="empty"><div class="drop-icon">🤔</div><b>No food detected</b><p>${esc(a.message || 'Try a clearer photo of your meal.')}</p></div>`;
    return;
  }

  const g = goals ?? {};
  const refs = dailyRefs(g);
  const s = current.servings;
  const t = scaled(a.totals, s);
  const band = scoreBand(a.health_score);
  const pctOf = (k) => (refs[k] ? (t[k] / refs[k]) * 100 : 0);
  const range = (a.calorie_range ?? [a.totals.calories, a.totals.calories]).map((n) => n * s);
  const mealLow = Math.round((g.calories * 0.25) / 50) * 50;
  const mealHigh = Math.round((g.calories * 0.35) / 50) * 50;
  const kcalFrom = { protein_g: t.protein_g * 4, carbs_g: t.carbs_g * 4, fat_g: t.fat_g * 9 };
  const kcalSum = kcalFrom.protein_g + kcalFrom.carbs_g + kcalFrom.fat_g || 1;
  const share = (k) => Math.round((kcalFrom[k] / kcalSum) * 100);
  const list = (items) => items.map((x) => `<li>${esc(x)}</li>`).join('');

  el.innerHTML = `
    <div class="result-head">
      <div><div class="eyebrow">Full nutrition report</div><h2>${esc(a.meal_name)}</h2></div>
    </div>
    <p class="result-intro">${esc(a.description)}</p>
    <div>
      <div class="chips">
        ${a.cuisine ? `<span class="chip">🌍 ${esc(a.cuisine)}</span>` : ''}
        ${current.cached ? '<span class="chip good">⚡ Saved result · no AI cost</span>' : ''}
        ${a.diet_tags.map((d) => `<span class="chip good">${esc(d)}</span>`).join('')}
      </div>
    </div>

    <section id="sec-score" class="block verdict ${band.cls}">
      <div class="verdict-head">
        <div class="score-badge"><b>${a.health_score}</b><small>out of 10</small></div>
        <div>
          <div class="eyebrow">Health score</div>
          <div class="verdict-label">${band.label}</div>
          <p class="hint">How nutritious this meal is, from 1 (least healthy) to 10 (most healthy). ${esc(band.note)}</p>
        </div>
      </div>
      ${scoreScale(a.health_score)}
      ${a.simple_summary ? `<div class="simple"><b>In simple words:</b> ${esc(a.simple_summary)}</div>` : ''}
      <div class="why">
        ${a.score_good_points?.length ? `<div><h4>👍 What’s good</h4><ul>${list(a.score_good_points)}</ul></div>` : ''}
        ${a.score_watch_outs?.length ? `<div><h4>⚠️ Watch out</h4><ul>${list(a.score_watch_outs)}</ul></div>` : ''}
      </div>
    </section>

    <section id="sec-energy" class="block">
      <h3>⚡ Energy (calories)</h3>
      <div class="kcal"><b>${fmt(t.calories)}</b><span>kcal${s !== 1 ? ` · ${s}× serving` : ''}</span></div>
      <p class="hint">Likely between <b>${fmt(range[0])}–${fmt(range[1])} kcal</b>. Photo estimates are never exact.</p>
      ${g.calories ? `
        <div class="goal-line"><span>${fmt(pctOf('calories'))}% of your daily goal (${fmt(g.calories)} kcal)</span></div>
        <div class="progress-track"><div class="progress-fill" style="width:${Math.min(pctOf('calories'), 100)}%"></div></div>
        <p class="hint">Calories are the energy your body gets from food. On a ${fmt(g.calories)} kcal day, a main meal is usually about ${fmt(mealLow)}–${fmt(mealHigh)} kcal.</p>` : ''}
    </section>

    <section id="sec-nutrients" class="block">
      <h3>🍽️ The 3 main nutrients</h3>
      <div class="macro-list">
        ${Object.entries(MACRO_INFO).map(([k, info]) => `
          <div class="nutrient" style="--c:${MACRO_COLORS[k]}">
            <div class="nutrient-top">
              <span class="dot"></span><b>${info.name}</b>
              <span class="amount">${fmt(t[k], 1)} g</span>
            </div>
            <p class="hint">${info.why}</p>
            ${refs[k] ? `<div class="progress-track"><div class="progress-fill" style="width:${Math.min(pctOf(k), 100)}%"></div></div>
            <div class="sub">${fmt(pctOf(k))}% of your daily ${fmt(refs[k])} g</div>` : ''}
          </div>`).join('')}
      </div>
      <div class="split">
        <div class="sub">Where the energy comes from</div>
        <div class="macro-bar">${['protein_g', 'carbs_g', 'fat_g'].map((k) => `<div style="--c:${MACRO_COLORS[k]};width:${share(k)}%"></div>`).join('')}</div>
        <div class="split-legend">${['protein_g', 'carbs_g', 'fat_g'].map((k) =>
          `<span style="--c:${MACRO_COLORS[k]}"><i class="dot"></i>${MACRO_INFO[k].name.split(' ')[0]} ${share(k)}%</span>`).join('')}</div>
      </div>
    </section>

    <section id="sec-limits" class="block">
      <h3>🔍 Good to get more / Good to limit</h3>
      <p class="hint rule">How to read: <b>Low</b> = 5% or less of your daily need, <b>High</b> = 20% or more.
        High is great for fiber, but for fat, sugar and salt it means “eat less of this”.</p>
      ${DETAIL_INFO.map((d) => {
        const pct = pctOf(d.key);
        const lv = levelOf(pct, d.kind);
        return `<div class="nutrient detail">
          <div class="nutrient-top">
            <b>${d.name}</b>
            <span class="level ${lv.cls}">${lv.text}</span>
            <span class="amount">${fmt(t[d.key], d.unit === 'g' ? 1 : 0)} ${d.unit}</span>
          </div>
          <p class="hint">${d.why} <span class="sub">(${fmt(pct)}% of daily ${fmt(refs[d.key])} ${d.unit})</span></p>
        </div>`;
      }).join('')}
    </section>

    <section id="sec-plate" class="block">
      <h3>🥄 What’s on your plate</h3>
      <div class="plate">${a.items.map((it) => `
        <div class="plate-item">
          <div><b>${esc(it.name)}</b><div class="sub">${esc(it.portion)}${it.estimated_grams ? ` · about ${fmt(it.estimated_grams * s)} g` : ''}</div></div>
          <span class="amount">${fmt(it.calories * s)} kcal</span>
        </div>`).join('')}</div>
      <details class="expert">
        <summary>📊 Full numbers for each item (for experts)</summary>
        <div class="table-wrap"><table>
          <thead><tr><th>Item</th><th>g</th><th>kcal</th><th>Protein</th><th>Carbs</th><th>Fat</th><th>Sat. fat</th><th>Fiber</th><th>Sugar</th><th>Sodium</th><th>Chol.</th></tr></thead>
          <tbody>${a.items.map((it) => `<tr>
            <td>${esc(it.name)}</td><td>${fmt(it.estimated_grams * s)}</td><td>${fmt(it.calories * s)}</td>
            <td>${fmt(it.protein_g * s, 1)}</td><td>${fmt(it.carbs_g * s, 1)}</td><td>${fmt(it.fat_g * s, 1)}</td>
            <td>${fmt(it.saturated_fat_g * s, 1)}</td><td>${fmt(it.fiber_g * s, 1)}</td><td>${fmt(it.sugar_g * s, 1)}</td>
            <td>${fmt(it.sodium_mg * s)}</td><td>${fmt(it.cholesterol_mg * s)}</td></tr>`).join('')}
            <tr class="total"><td>Total</td><td>${fmt(a.items.reduce((n, it) => n + it.estimated_grams, 0) * s)}</td><td>${fmt(t.calories)}</td>
            <td>${fmt(t.protein_g, 1)}</td><td>${fmt(t.carbs_g, 1)}</td><td>${fmt(t.fat_g, 1)}</td><td>${fmt(t.saturated_fat_g, 1)}</td>
            <td>${fmt(t.fiber_g, 1)}</td><td>${fmt(t.sugar_g, 1)}</td><td>${fmt(t.sodium_mg)}</td><td>${fmt(t.cholesterol_mg)}</td></tr>
          </tbody>
        </table></div>
        <p class="sub">Grams (g) except sodium and cholesterol in milligrams (mg). 1 g fat = 9 kcal, 1 g protein or carbs = 4 kcal.</p>
      </details>
    </section>

    ${a.micronutrients.length ? `<section id="sec-vitamins" class="block">
      <h3>💊 Vitamins & minerals</h3>
      <p class="hint">Small nutrients your body needs every day. “% daily” shows how much of a day’s need this meal covers.</p>
      ${a.micronutrients.map((m) => `<div class="plate-item">
        <div><b>${esc(m.name)}</b>${m.benefit ? `<div class="sub">${esc(m.benefit)}</div>` : ''}</div>
        <span class="amount">${esc(m.amount)}${m.daily_value_percent ? `<br><small>${fmt(m.daily_value_percent * s)}% daily</small>` : ''}</span>
      </div>`).join('')}
    </section>` : ''}

    ${a.allergens.length ? `<section id="sec-allergens" class="block">
      <h3>⚠️ May contain these allergens</h3>
      <div class="chips">${a.allergens.map((x) => `<span class="chip warn">${esc(x)}</span>`).join('')}</div>
      <p class="hint">Guessed from the photo. Always check the real ingredients if you have an allergy.</p>
    </section>` : ''}

    ${a.tips.length ? `<section id="sec-tips" class="block">
      <h3>💡 How to make it healthier</h3>
      <ul class="tips">${list(a.tips)}</ul>
    </section>` : ''}

    <section id="sec-accuracy" class="block accuracy">
      <h3>🎯 How accurate is this?</h3>
      <div class="nutrient-top"><b>AI confidence</b><span class="level ${{ high: 'great', medium: 'meh', low: 'bad' }[a.confidence]}">${esc(a.confidence)}</span></div>
      <p class="hint">${CONFIDENCE_INFO[a.confidence]}</p>
      ${a.visual_observations ? `<h4>What the AI saw</h4><p>${esc(a.visual_observations)}</p>` : ''}
      ${a.assumptions?.length ? `<h4>What the AI assumed</h4><ul>${list(a.assumptions)}</ul>` : ''}
      ${a.calories_corrected ? '<p class="hint">✔ We double-checked the calorie math against protein, carbs and fat, and corrected it.</p>' : ''}
      <h4>Something wrong?</h4>
      <div class="fix-form">
        <input id="fix-note" type="text" maxlength="200" placeholder="e.g. “this is brown rice”, “no butter”, “large bowl”">
        <button type="button" id="fix-btn" class="btn">Re-analyze</button>
      </div>
      <p class="sub">Tell the AI what to fix. Re-analyzing uses one AI scan.</p>
    </section>

    <div class="log-bar">
      <div class="stepper" aria-label="Servings">
        <button type="button" data-step="-0.25" aria-label="Fewer servings">−</button>
        <span>${s}×</span>
        <button type="button" data-step="0.25" aria-label="More servings">+</button>
      </div>
      <select id="meal-type" aria-label="Meal type">${['breakfast', 'lunch', 'dinner', 'snack'].map((m) =>
        `<option value="${m}" ${m === (current.mealType ?? guessMealType()) ? 'selected' : ''}>${m[0].toUpperCase() + m.slice(1)}</option>`).join('')}</select>
      <button id="log-btn" class="btn primary"><svg><use href="#i-plus"/></svg><span class="lbl-long">Add to log</span><span class="lbl-short">Log</span></button>
    </div>
    <p class="sub center log-note">Ate more or less? Use − / + to change the portion. All numbers update instantly.</p>`;

  // Changing servings rescales locally: no new AI call needed.
  el.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    current.mealType = $('#meal-type').value;
    current.servings = Math.min(Math.max(current.servings + Number(b.dataset.step), 0.25), 10);
    renderResult();
  }));
  const fix = () => {
    const note = $('#fix-note').value.trim();
    if (!note) return $('#fix-note').focus();
    $('#note').value = note;
    analyze();
  };
  $('#fix-btn').addEventListener('click', fix);
  $('#fix-note').addEventListener('keydown', (e) => { if (e.key === 'Enter') fix(); });
  $('#log-btn').addEventListener('click', logMeal);
  buildReportNav();
  renderReview();
}

// ---------- Report section bar (jump between sections; sticky on phones) ----------
const SECTION_LABELS = {
  'sec-score': 'Score', 'sec-energy': 'Energy', 'sec-nutrients': 'Nutrients', 'sec-limits': 'Limits',
  'sec-plate': 'Plate', 'sec-vitamins': 'Vitamins', 'sec-allergens': 'Allergens', 'sec-tips': 'Tips', 'sec-accuracy': 'Accuracy',
};
let sectionObserver;
function buildReportNav() {
  const result = $('#result');
  const sections = [...result.querySelectorAll('section[id]')];
  if (!sections.length) return;
  const nav = document.createElement('nav');
  nav.className = 'report-nav';
  nav.setAttribute('aria-label', 'Report sections');
  nav.innerHTML = sections.map((sec) => `<button type="button" data-sec="${sec.id}">${SECTION_LABELS[sec.id]}</button>`).join('');
  sections[0].before(nav);
  const offset = () => (isDesktop() ? 0 : headerHeight()) + nav.offsetHeight + 8;
  nav.addEventListener('click', (e) => {
    const id = e.target.closest('[data-sec]')?.dataset.sec;
    if (id) scrollToY($(`#${id}`).getBoundingClientRect().top + window.scrollY - offset());
  });
  const setActive = (id) => {
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.sec === id));
    const btn = nav.querySelector(`[data-sec="${id}"]`);
    // Keep the active chip visible by scrolling the bar sideways only (never the page).
    if (btn) nav.scrollTo({ left: btn.offsetLeft - nav.clientWidth / 2 + btn.offsetWidth / 2, behavior: 'smooth' });
  };
  setActive(sections[0].id);
  // Track every section in the reading band; the first one (in page order) is "current".
  const inView = new Set();
  sectionObserver?.disconnect();
  sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach((en) => (en.isIntersecting ? inView.add(en.target.id) : inView.delete(en.target.id)));
    const first = sections.find((sec) => inView.has(sec.id));
    if (first) setActive(first.id);
  }, { rootMargin: `-${offset() + 2}px 0px -55% 0px` });
  sections.forEach((sec) => sectionObserver.observe(sec));
}

// ---------- Quick review card ("at a glance") ----------
const FREQ = {
  everyday: { level: 4, label: 'Everyday' },
  few_times_week: { level: 3, label: 'A few times a week' },
  occasionally: { level: 2, label: 'Once in a while' },
  rarely: { level: 1, label: 'Rarely, as a treat' },
};

function renderReview() {
  const a = current?.analysis;
  const box = $('#review');
  if (!a?.is_food) { box.innerHTML = ''; return; }
  const s = current.servings;
  const t = scaled(a.totals, s);
  const band = scoreBand(a.health_score);
  const freq = FREQ[a.eat_frequency] ?? FREQ.occasionally;
  const pros = (a.score_good_points ?? []).slice(0, 2);
  const cons = (a.score_watch_outs ?? []).slice(0, 2);
  box.innerHTML = `<div class="card review-card ${band.cls}">
    <div class="review-photo">
      ${imageDataUrl ? `<img src="${imageDataUrl}" alt="Your meal">` : ''}
      <span class="eyebrow-pill">At a glance</span>
      <div class="photo-title"><b>${esc(a.meal_name)}</b><span>${esc(a.cuisine)}${s !== 1 ? ` · ${s}× serving` : ''}</span></div>
      <div class="review-score" title="Health score"><b>${a.health_score}</b><small>out of 10</small></div>
    </div>
    <div class="review-body">
      <div class="verdict-word">${band.label}</div>
      <div class="headline">${esc(a.headline || a.simple_summary)}</div>
      <div class="freq">
        <div class="freq-top"><span>How often to eat it</span><b>${freq.label}</b></div>
        <div class="freq-track">${[1, 2, 3, 4].map((n) => `<i class="${n <= freq.level ? 'on' : ''}"></i>`).join('')}</div>
        <div class="freq-labels"><span>Rarely</span><span>Sometimes</span><span>Often</span><span>Daily</span></div>
      </div>
      <div class="quick-stats">
        <div class="kcal-tile"><b>${fmt(t.calories)}</b><span>kcal</span></div>
        <div><b>${fmt(t.protein_g)}g</b><span>protein</span></div>
        <div><b>${fmt(t.carbs_g)}g</b><span>carbs</span></div>
        <div><b>${fmt(t.fat_g)}g</b><span>fat</span></div>
      </div>
      ${pros.length || cons.length ? `<ul class="flags">
        ${pros.map((x) => `<li class="pro"><svg><use href="#i-check"/></svg><span>${esc(x)}</span></li>`).join('')}
        ${cons.map((x) => `<li class="con"><svg><use href="#i-alert"/></svg><span>${esc(x)}</span></li>`).join('')}
      </ul>` : ''}
      ${a.best_for ? `<div class="best-for">⭐ Best for: ${esc(a.best_for)}</div>` : ''}
      ${a.overall_review ? `<div class="overall"><h4>Overall review</h4><p class="clamp">${esc(a.overall_review)}</p>
        <button type="button" class="read-more" aria-expanded="false">Read more</button></div>` : ''}
    </div>
  </div>`;
  // On laptops the review text is trimmed to 3 lines so the card fits on screen.
  const more = box.querySelector('.read-more');
  more?.addEventListener('click', () => {
    const open = box.querySelector('.overall p').classList.toggle('clamp') === false;
    more.textContent = open ? 'Show less' : 'Read more';
    more.setAttribute('aria-expanded', String(open));
  });
  requestAnimationFrame(() => {
    const p = box.querySelector('.overall p');
    if (more && p && p.scrollHeight <= p.clientHeight + 2) more.hidden = true;
  });
}

// Sticky panels only stick when they fit on screen. A panel taller than the window
// scrolls with the page instead, so nothing is ever cut off.
const STICKY_PANELS = ['.scan-left', '#review', '.summary-card'];
function updateSticky() {
  for (const sel of STICKY_PANELS) {
    const el = $(sel);
    if (el) el.classList.toggle('no-stick', el.offsetHeight > window.innerHeight - 56);
  }
}
const stickyObserver = new ResizeObserver(updateSticky);
STICKY_PANELS.forEach((sel) => { const el = $(sel); if (el) stickyObserver.observe(el); });
window.addEventListener('resize', updateSticky);

function guessMealType() {
  const h = new Date().getHours();
  return h < 11 ? 'breakfast' : h < 16 ? 'lunch' : h < 21 ? 'dinner' : 'snack';
}

async function logMeal() {
  const btn = $('#log-btn');
  btn.disabled = true;
  try {
    const mealType = $('#meal-type').value;
    await api('/api/meals', { method: 'POST', body: { ...current, meal_type: mealType } });
    navigator.vibrate?.(15);
    toast(`✓ Added to ${mealType}`);
    resetScanner();
    showTab('today');
  } catch (err) {
    btn.disabled = false;
    showScanError(err.message);
  }
}

// ---------- Today ----------
const dayKeyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function ring(value, goal) {
  const r = 52, c = 2 * Math.PI * r;
  const pct = goal ? Math.min(value / goal, 1) : 0;
  return `<div class="ring">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <circle class="track" cx="60" cy="60" r="${r}"/>
      <circle class="fill ${value > goal * 1.05 ? 'over' : ''}" cx="60" cy="60" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"/>
    </svg>
    <div class="ring-center"><b>${fmt(value)}</b><span>of ${fmt(goal)} kcal</span></div>
  </div>`;
}

function progress(key, value, goal) {
  const [label, unit] = GOAL_LABELS[key];
  const pct = goal ? (value / goal) * 100 : 0;
  const over = key === 'sugar_g' || key === 'sodium_mg' ? pct > 100 : pct > 115;
  return `<div class="progress">
    <div class="progress-label"><span>${label}${TODAY_HINTS[key] ? ` <small>· ${TODAY_HINTS[key]}</small>` : ''}</span>
      <span class="val">${fmt(value, unit === 'g' ? 1 : 0)} / ${fmt(goal)} ${unit}</span></div>
    <div class="progress-track"><div class="progress-fill ${over ? 'over' : ''}" style="--c:${MACRO_COLORS[key] ?? 'var(--accent)'};width:${Math.min(pct, 100)}%"></div></div>
  </div>`;
}

async function loadToday() {
  const today = new Date();
  $('#today-date').textContent = today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const d = await api(`/api/day/${dayKeyOf(today)}`);
  goals = d.goals;
  const t = d.totals, g = d.goals;
  const left = g.calories - t.calories;
  const avgScore = d.meals.length ? d.meals.reduce((n, m) => n + m.analysis.health_score, 0) / d.meals.length : null;

  $('#today-summary').innerHTML = `
    <div class="ring-wrap">
      ${ring(t.calories, g.calories)}
      <div class="ring-facts">
        <div class="ring-fact"><b>${left >= 0 ? fmt(left) : fmt(-left)}</b><span>${left >= 0 ? 'kcal left today' : 'kcal over your goal'}</span></div>
        <div class="ring-fact"><b>${d.meals.length}</b><span>meal${d.meals.length === 1 ? '' : 's'} logged</span></div>
        ${avgScore ? `<div class="ring-fact"><b class="${scoreBand(Math.round(avgScore)).cls}" style="color:var(--tone)">${fmt(avgScore, 1)}/10</b><span>average health score</span></div>` : ''}
      </div>
    </div>
    <div class="macro-cards">
      ${['protein_g', 'carbs_g', 'fat_g'].map((k) => `<div class="macro-card" style="--c:${MACRO_COLORS[k]}">
        <div class="label"><i class="dot"></i>${GOAL_LABELS[k][0]}</div>
        <b>${fmt(t[k])}<small> / ${fmt(g[k])} g</small></b>
        <div class="progress-track"><div class="progress-fill" style="width:${Math.min((t[k] / g[k]) * 100, 100)}%"></div></div>
      </div>`).join('')}
    </div>
    ${['fiber_g', 'sugar_g', 'sodium_mg'].map((k) => progress(k, t[k], g[k])).join('')}`;

  $('#today-meals').innerHTML = d.meals.length ? d.meals.map((m) => {
    const band = scoreBand(m.analysis.health_score);
    return `<div class="meal">
      ${m.image_url ? `<img src="${esc(m.image_url)}" alt="">` : '<div class="ph">🍽️</div>'}
      <div class="meal-info">
        <b>${esc(m.analysis.meal_name)}</b>
        <div class="meal-meta">
          <span>${esc(m.meal_type[0].toUpperCase() + m.meal_type.slice(1))} · ${new Date(m.logged_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${m.servings !== 1 ? ` · ${m.servings}×` : ''}</span>
          <span class="level ${band.cls}">${m.analysis.health_score}/10 ${band.label}</span>
        </div>
      </div>
      <span class="meal-kcal">${fmt(m.analysis.totals.calories * m.servings)} kcal</span>
      <button class="btn ghost icon" data-del="${m.id}" aria-label="Remove ${esc(m.analysis.meal_name)}"><svg><use href="#i-x"/></svg></button>
    </div>`;
  }).join('') : `<div class="empty"><div class="drop-icon"><svg><use href="#i-camera"/></svg></div>
      <b>No meals yet today</b><p>Scan your first meal to start tracking.</p>
      <button class="btn primary" data-goto="scan">Scan a meal</button></div>`;

  $$('#today-meals [data-goto]').forEach((b) => b.addEventListener('click', () => showTab('scan')));
  $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this meal from your log?')) return;
    await api(`/api/meals/${b.dataset.del}`, { method: 'DELETE' });
    toast('Meal removed');
    loadToday();
  }));
}

$('#insight-btn').addEventListener('click', async () => {
  const btn = $('#insight-btn');
  btn.disabled = true;
  $('#insight').textContent = 'Thinking…';
  try {
    const { insight } = await api('/api/insight', { method: 'POST' });
    $('#insight').classList.remove('muted');
    $('#insight').textContent = insight;
  } catch (err) {
    $('#insight').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- History ----------
const barClass = (kcal, goal) => (!kcal ? '' : kcal > goal * 1.1 ? 'over' : kcal < goal * 0.8 ? 'under' : 'on');

async function loadHistory() {
  const { days, goals: g } = await api('/api/history');
  const byDay = Object.fromEntries(days.map((d) => [d.day, d]));

  // Last 14 calendar days, including days with nothing logged.
  const span = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return { date: d, key: dayKeyOf(d), data: byDay[dayKeyOf(d)] };
  });
  const max = Math.max(g.calories * 1.3, ...span.map((s) => s.data?.totals.calories ?? 0));
  $('#history-chart').innerHTML = `
    <div class="goal-mark" style="bottom:calc(22px + (100% - 32px) * ${g.calories / max})"><span>Goal ${fmt(g.calories)}</span></div>
    ${span.map((s, i) => {
      const kcal = s.data?.totals.calories ?? 0;
      return `<div class="bar-col ${i === 13 ? 'today' : ''}" title="${s.date.toLocaleDateString()}: ${fmt(kcal)} kcal">
        <div class="bar ${barClass(kcal, g.calories)}" style="height:calc((100% - 22px) * ${kcal / max})"></div>
        <span class="bar-label">${i === 13 ? 'Today' : s.date.toLocaleDateString(undefined, { weekday: 'narrow' }) + s.date.getDate()}</span>
      </div>`;
    }).join('')}`;

  const logged = span.filter((s) => s.data);
  const avg = logged.length ? logged.reduce((n, s) => n + s.data.totals.calories, 0) / logged.length : 0;
  const onTarget = logged.filter((s) => barClass(s.data.totals.calories, g.calories) === 'on').length;
  $('#history-stats').innerHTML = `
    <div class="stat"><b>${logged.length}</b><span>days logged (14)</span></div>
    <div class="stat"><b>${logged.length ? fmt(avg) : '–'}</b><span>avg kcal / day</span></div>
    <div class="stat"><b>${onTarget}</b><span>days near goal</span></div>`;

  $('#history-list').innerHTML = days.length ? days.map((d) => {
    const pct = (d.totals.calories / g.calories) * 100;
    const date = new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return `<div class="hist-row">
      <span>${date}<br><small class="muted">${d.meal_count} meal${d.meal_count === 1 ? '' : 's'}</small></span>
      <div class="progress-track"><div class="progress-fill ${pct > 110 ? 'over' : ''}" style="width:${Math.min(pct, 100)}%"></div></div>
      <span>${fmt(d.totals.calories)} kcal</span>
    </div>`;
  }).join('') : '<div class="empty">No history yet. Logged meals will appear here.</div>';
}

// ---------- Goals ----------
function renderGoalFields(values) {
  $('#goals-fields').innerHTML = Object.entries(GOAL_LABELS).map(([k, [label, unit]]) => `
    <label class="goal-field">
      <b>${label}</b>
      <small>${GOAL_HINTS[k]}</small>
      <span class="input-unit"><input type="number" name="${k}" min="0" step="1" inputmode="numeric" value="${values[k]}" aria-label="${label} in ${unit}"><em>${unit}</em></span>
    </label>`).join('');
}
async function loadGoals() {
  renderGoalFields(await api('/api/goals'));
}
$('#goals-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, Number(v)]));
  goals = await api('/api/goals', { method: 'PUT', body });
  toast('✓ Goals saved');
});
$('#goals-reset').addEventListener('click', () => renderGoalFields(DEFAULT_GOALS));

// ---------- Theme (auto / light / dark) ----------
const THEMES = ['auto', 'light', 'dark'];
function currentTheme() {
  try { return localStorage.getItem('nl-theme') || 'auto'; } catch { return 'auto'; }
}
function setTheme(t) {
  try { localStorage.setItem('nl-theme', t); } catch { /* storage blocked: still apply for this visit */ }
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeSet === t)));
  $('#theme-cycle use').setAttribute('href', `#i-${t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'auto'}`);
  $('#theme-cycle').title = `Theme: ${t}`;
}
$$('[data-theme-set]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeSet)));
$('#theme-cycle').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  setTheme(next);
  toast(`Theme: ${next === 'auto' ? 'match system' : next}`);
});
setTheme(currentTheme());

const hour = new Date().getHours();
$('#greeting').textContent = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

// ---------- Phone niceties ----------
// Big camera button in the bottom bar: one tap from anywhere opens the camera.
$('#fab-camera').addEventListener('click', () => {
  if (current) resetScanner();
  showTab('scan');
  $('#file-camera').click();
});
// Hide the floating tab bar while the on-screen keyboard is up, so it never covers the input.
document.addEventListener('focusin', (e) => {
  if (e.target.matches('input, select, textarea')) document.body.classList.add('typing');
});
document.addEventListener('focusout', () => setTimeout(() => {
  if (!document.activeElement?.matches('input, select, textarea')) document.body.classList.remove('typing');
}, 50));
// Sticky elements under the mobile header need to know how tall it is.
const syncHeaderVar = () => document.documentElement.style.setProperty('--header-h', `${headerHeight()}px`);
window.addEventListener('resize', syncHeaderVar);
syncHeaderVar();

refreshUsage();
api('/api/goals').then((g) => { goals = g; }).catch(() => {});
