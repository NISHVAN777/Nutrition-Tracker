# 🥗 NutriLens: AI Nutrition Tracker

Snap a photo of your food. Grok Vision identifies the dish, estimates portions, and gives the full nutrition breakdown. Log meals, track daily goals, and get AI coaching.

## Run it

```
npm install
npm start
```

Then open http://localhost:8787. On Windows you can also double-click `start.bat`.

## Use it on your phone

1. In `.env`, set `LAN_ACCESS=true` and choose an `ACCESS_PIN` (at least 6 characters).
2. Restart the server. It prints the address to use, e.g. `Open on your phone: http://192.168.1.20:8787`.
3. On your phone (same Wi-Fi), open that address and enter the PIN. It is remembered on that device for 30 days.
4. Optional: use **Add to Home Screen** (Safari share menu, or the Chrome ⋮ menu) to get an app icon.

Notes:
- The first time, Windows Firewall may ask whether Node.js can talk on networks: allow it on **private** networks only.
- The camera button works over plain `http://` because it uses the phone's photo picker, not live camera access.
- This computer never needs the PIN. Every other device must log in before it can use the API or see photos, and wrong PINs are blocked after 5 tries for 15 minutes.
- Turn it off again with `LAN_ACCESS=false`; the server then listens on this computer only.

## Features

| Feature | AI? | Cost |
|---|---|---|
| Photo → dish name, description, cuisine, per-item portions | ✅ Grok Vision | ~$0.005 / scan |
| Calories, protein, carbs, fat, sat. fat, fiber, sugar, sodium, cholesterol | ✅ | (same call) |
| Vitamins & minerals with % daily value, allergens, diet tags | ✅ | (same call) |
| Health score (1–10), health summary, 3 improvement tips | ✅ | (same call) |
| **At a glance** review: one-line verdict, how often to eat it, best for, overall review | ✅ | (same call) |
| Light / dark / auto theme, phone + tablet + desktop layouts | ❌ local | free |
| Phone app feel: camera button in the tab bar, report section bar, installable to home screen | ❌ local | free |
| Optional note (“cooked in ghee”, “half portion”) to refine estimates | ✅ | (same call) |
| Adjust servings (0.25×–10×) | ❌ local math | free |
| Daily log, goals and progress bars, 30-day history | ❌ local | free |
| AI Coach: feedback on your day + next-meal suggestion | ✅ text only | ~$0.0005 |

## Where data lives

Everything is stored locally in `D:\Nutrition Tracker\data\` (git-ignored):
- `data/nutrition.db`: SQLite database with meals, goals, AI cache and usage log
- `data/images/`: compressed meal photos (~100 KB each)

## API key security plan

1. **The key lives only in `.env`** on the server. It is git-ignored, never sent to the browser, never logged, and provider error messages are not forwarded to the browser.
2. **The browser talks only to our server** (`/api/*`). It never calls xAI directly.
3. **The server listens on `127.0.0.1` only**, so other devices on your Wi-Fi can't use it (or spend your credits). Optional phone access (`LAN_ACCESS=true`) puts every other device behind a PIN: an HttpOnly, SameSite=Strict session cookie, constant-time PIN check, and 5 wrong tries per 15 minutes.
4. **Strict security headers**: the CSP blocks third-party scripts, and all AI text is HTML-escaped before display.
5. **Image validation**: JPEG/PNG/WebP only, file-signature check, 2 MB cap.
6. **Prompt-injection guard**: the model is told to ignore any instructions written inside a photo, and its output is schema-validated and sanitized.

## Cost-control plan

| Guard | Setting (`.env`) | Default |
|---|---|---|
| Cheapest vision model (no billed reasoning tokens) | `XAI_MODEL` | `grok-4.20-0309-non-reasoning` ($1.25 / $2.50 per 1M tokens) |
| Photo compressed in the browser to 1024 px JPEG | `public/app.js` | ~1,400 input tokens per scan |
| **Cache**: same photo + note is never paid for twice | automatic | |
| Output cap per call | `max_tokens` | 1,200 (scan), 350 (coach) |
| Totals computed locally, not by AI | automatic | fewer output tokens |
| Hard daily cap on AI calls | `DAILY_AI_LIMIT` | 40 |
| Hard monthly budget (stops all AI calls) | `MONTHLY_BUDGET_USD` | $3.00 |
| Per-minute rate limit | `PER_MINUTE_LIMIT` | 6 |
| No automatic retries (a failure costs at most one call) | | |
| Live spend shown in the app header | | |

Measured: **one scan ≈ $0.005**, so $3/month covers about 600 scans.

> 🔒 **Also do this:** set a spending limit in the xAI console (console.x.ai → Billing). That is the provider-side safety net, even if this app's limits were bypassed.

## Project layout

```
server/index.js   Express API, validation, rate limiting, caching
server/ai.js      All Grok calls, prompts, JSON schema, budget guard
server/db.js      SQLite (built into Node 22+), goals, date helpers
public/           Frontend (vanilla HTML/CSS/JS, no build step)
```

## Roadmap ideas

- Barcode scanning for packaged food (free Open Food Facts lookup, no AI cost)
- Edit individual items after a scan (rename, change grams)
- Weekly AI report with trends
- Water intake, weight tracking
- Install as a phone app (PWA) and deploy with login (needs auth before going public)
