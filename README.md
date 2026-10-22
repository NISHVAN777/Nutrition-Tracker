<div align="center">

# 🥗 NutriLens

**Snap a photo of your meal. AI tells you what it is, what's inside, and whether it's good for you, in words anyone can understand.**

![Node.js 22.13+](https://img.shields.io/badge/Node.js-22.13%2B-1e6b4b?logo=nodedotjs&logoColor=white) ![Grok Vision](https://img.shields.io/badge/AI-Grok%20Vision-111?logo=x&logoColor=white) ![SQLite](https://img.shields.io/badge/Storage-SQLite%20(local)-e2792f?logo=sqlite&logoColor=white) ![No build step](https://img.shields.io/badge/Frontend-vanilla%20JS-f6f3ec?labelColor=555)

<img src="docs/screenshots/desktop-result.png" alt="NutriLens analysing a South Indian thali: health score 7 out of 10, quick review card and full nutrition report" width="100%">

</div>

---

## What it does

1. **Take a photo** of your food, using your phone camera or a file on your computer.
2. **AI identifies every item** on the plate and estimates the portion sizes.
3. **You get a clear report:**
   - a **health score** from 1 to 10, with the reasons behind it
   - a one-line verdict and **how often** you could eat the meal
   - calories, protein, carbs and fat, plus fiber, sugar, salt and vitamins, each explained in plain language
4. **Log it** and track your day against your goals, with tips from an AI coach.

It's built for beginners as well as people who track their food closely: every number comes with a short explanation, and the full breakdown is one tap away.

## Screenshots

### Desktop

| Full report: every nutrient explained | Today: progress and AI coach |
|---|---|
| <img src="docs/screenshots/desktop-report.png" alt="Nutrients section with plain-language explanations and Low/High labels"> | <img src="docs/screenshots/desktop-today.png" alt="Today page with calorie ring, macro cards, AI coach advice and logged meals"> |
| **History: 14 days against your goal** | **Dark mode** |
| <img src="docs/screenshots/desktop-history.png" alt="History page with a 14-day calorie bar chart and goal line"> | <img src="docs/screenshots/desktop-dark.png" alt="Butter chicken analysis in dark mode, health score 4 out of 10"> |

### Phone

Works like an app: a camera button in the tab bar, a section bar for the long report, and it can be installed to your home screen.

| Home | At a glance | Report sections | Today |
|---|---|---|---|
| <img src="docs/screenshots/mobile-home.png" alt="Phone home screen with photo area and camera button" width="200"> | <img src="docs/screenshots/mobile-review.png" alt="Phone quick review of a double cheeseburger: 3 out of 10, rarely as a treat" width="200"> | <img src="docs/screenshots/mobile-report.png" alt="Phone report scrolled to the Limits section with sticky section chips" width="200"> | <img src="docs/screenshots/mobile-today.png" alt="Phone Today page with calorie ring and macros" width="200"> |

## Features

**Food analysis (one AI call per photo)**
- Recognises the dish, cuisine and each separate item (rice, curry, bread, drink…) with estimated grams
- Calories, protein, carbs, fat, saturated fat, fiber, sugar, sodium and cholesterol, per item and in total
- Vitamins and minerals, with what each one does and the % of your daily need it covers
- **Health score (1–10)** from a fixed rubric, with "What's good" and "Watch out" reasons
- **At a glance** card: a one-line verdict, how often to eat it (Rarely → Daily), what it's best for, and an overall review
- Possible allergens, diet tags (vegetarian, high-protein, …) and 3 tips to make the meal healthier
- **Honest accuracy:** a likely calorie range, the AI's confidence, what it saw, and what it assumed. You can correct it ("this is brown rice", "no butter") and re-analyze
- Calorie math is double-checked against protein, carbs and fat (4/4/9 rule) and corrected when the numbers don't add up

**Tracking (free, no AI)**
- Change the portion (0.25× to 10×) and every number updates instantly
- Daily log with breakfast, lunch, dinner and snacks, a calorie ring, and macro and limit progress bars
- 14-day history chart and a 30-day list
- Personal daily goals, each with a plain-language hint
- **AI Coach:** short feedback on your day plus a suggestion for your next meal (text only, very cheap)

**Experience**
- Responsive: sidebar layout on desktop, app-style tab bar on phone, wide strip on tablet
- Light, dark and auto themes
- Installable web app with its own home-screen icon
- Optional phone access over your Wi-Fi, protected by a PIN

## Getting started

**You need:** [Node.js](https://nodejs.org) 22.13 or newer, and an [xAI API key](https://console.x.ai).

```bash
git clone https://github.com/NISHVAN777/Nutrition-Tracker.git
cd Nutrition-Tracker
npm install
```

Copy `.env.example` to `.env` and paste your key:

```bash
cp .env.example .env
```

```ini
XAI_API_KEY=xai-your-key-here
```

Start it:

```bash
npm start
```

Open **http://localhost:8787**. On Windows you can also double-click `start.bat`.

## Use it on your phone

1. In `.env`, set `LAN_ACCESS=true` and choose an `ACCESS_PIN` (at least 6 characters).
2. Restart the server. It prints the address to use, e.g. `Open on your phone: http://192.168.1.20:8787`.
3. On your phone (same Wi-Fi), open that address and enter the PIN. The phone stays logged in for 30 days.
4. Optional: tap **Add to Home Screen** (Safari's Share menu, or Chrome's ⋮ menu) to install it like an app.

- The first time, Windows Firewall may ask whether Node.js can use the network: allow it on **private** networks only.
- The camera button works over plain `http://` because it uses the phone's photo picker, not a live camera stream.
- This computer never needs the PIN. Other devices must log in before they can use the API or see photos, and wrong PINs are blocked after 5 tries for 15 minutes.

## Configuration

All settings live in `.env` (git-ignored). See [`.env.example`](.env.example).

| Setting | Default | What it does |
|---|---|---|
| `XAI_API_KEY` | (required) | Your xAI key. Stays on the server and is never sent to the browser. |
| `XAI_MODEL` | `grok-4.20-0309-non-reasoning` | Vision model. The default is the cheapest one that reads images. |
| `PRICE_INPUT_PER_M` / `PRICE_OUTPUT_PER_M` | `1.25` / `2.50` | USD per 1M tokens, used for the live cost tracker |
| `DAILY_AI_LIMIT` | `40` | Hard cap on AI calls per day |
| `MONTHLY_BUDGET_USD` | `3.00` | All AI calls stop once this month's spend reaches it |
| `PER_MINUTE_LIMIT` | `6` | Rate limit on AI requests |
| `PORT` | `8787` | Server port |
| `LAN_ACCESS` / `ACCESS_PIN` | `false` / (empty) | Optional phone access over Wi-Fi, behind a PIN |
| `DATA_DIR` | `./data` | Where the database and photos are stored |

## Keeping costs low

A typical scan costs **about $0.005**, so the default $3/month budget covers roughly 600 scans.

| Guard | How |
|---|---|
| Cheap model | Non-reasoning Grok vision model, so no hidden "thinking" tokens are billed |
| Small images | Photos are resized to 1024 px JPEG in the browser before upload |
| Cache | The same photo with the same note is never paid for twice |
| Output caps | `max_tokens` of 1,800 per scan and 350 per coach message |
| Local math | Totals, servings and the daily summary are computed locally, not by the AI |
| Hard limits | Daily call cap, monthly budget and per-minute rate limit, all enforced on the server |
| No auto-retries | A failure costs at most one call |
| Visible spend | Month-to-date cost is shown in the app |

> 🔒 Also set a spending limit in the xAI console (console.x.ai → Billing). That cap works at the provider, independent of this app.

## Security

- The API key is only read on the server from `.env`. It is never sent to the browser, never logged, and provider error details aren't passed through.
- By default the server listens on `127.0.0.1` only. Phone access is opt-in and protected by a PIN, with HttpOnly SameSite=Strict cookies, a constant-time PIN check and lockout after repeated wrong PINs.
- A strict Content-Security-Policy allows no third-party scripts, and all AI text is HTML-escaped before it's displayed.
- Uploads are checked for type and file signature and capped at 2 MB.
- The AI is told to ignore any instructions written inside a photo, and its answer is validated against a JSON schema and sanitized.

## How it works

```
Photo ──► browser resizes to 1024 px JPEG ──► POST /api/analyze
                                                  │
                                    cache hit? ───┤──► return saved result (free)
                                                  │
                          budget / rate-limit check ──► Grok Vision (structured JSON)
                                                  │
                    validate · sanitize · 4/4/9 calorie check · compute totals
                                                  │
                         save to SQLite cache ──► report in the browser
```

## Project structure

```
server/
  index.js     Express API, validation, rate limiting, caching, optional PIN login
  ai.js        Grok calls, prompt and scoring rubric, JSON schema, budget guard
  db.js        SQLite via Node's built-in node:sqlite (no native modules)
public/
  index.html   App shell (no build step)
  app.js       UI logic: scanning, report, log, history, goals, theme
  styles.css   Design system, responsive layouts, light/dark themes
  manifest.webmanifest, icons/   Installable web app
docs/screenshots/   Images used in this README
```

## Accuracy note

Nutrition values are **estimates from a photo** and can be off by 20% or more, especially for hidden oil, sauces and portion depth. Adding a note ("cooked in ghee", "half portion") helps. NutriLens is a guide for everyday awareness, not medical or dietary advice.

## Roadmap

- Barcode scanning for packaged food (free Open Food Facts lookup)
- Edit individual items after a scan
- Weekly AI report with trends
- Water and weight tracking
