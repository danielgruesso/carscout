# CarScout

A chat-style webapp for finding **real US car listings** with **real photos**. Talk to it like an assistant — "1999 vw jetta in Seattle", "manual miata under 20k", "show me only EVs" — and it parses your message with **Google Gemini** (default `gemini-3.1-flash-lite`), then pulls live listings via **MarketCheck**, which aggregates from AutoTrader, CarMax, Carvana, Cars.com, CarGurus, and many dealer sites.

- **Nationwide** search. If you don't name a city, it defaults to **Atlanta, GA**.
- **No key needed for visitors.** Both the Gemini key and the MarketCheck key live in Vercel Edge functions on the server side. You bring two keys, everyone uses the app.
- **Graceful degradation.** If MarketCheck isn't configured or runs out of credits, Live silently falls back to deterministic Demo data with a chat note. If Gemini is down, parsing falls back to a built-in regex. Nothing crashes.
- **No database, no build step.** One static HTML file + two Edge functions.

```
carscout/
├── index.html         # chat UI (React via esm.sh, Tailwind via CDN)
├── api/
│   ├── parse.js       # Vercel Edge function — Gemini proxy (parses query → params)
│   └── listings.js    # Vercel Edge function — MarketCheck proxy (params → real listings)
├── README.md
└── .gitignore
```

---

## Publishing to Vercel — step by step

### 0. Prerequisites

- A free **Google Gemini API key** — [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey). Click "Create API key", copy the `AIza…` string.
- A free **Vercel account** — [vercel.com/signup](https://vercel.com/signup) (GitHub login is easiest).
- Node + npm installed locally (only needed for the CLI). `node -v` should print 18+.

### 1. Install the Vercel CLI

```bash
npm install -g vercel
```

### 2. Open the project folder

```bash
cd /Users/danielgruesso/projects/carscout
```

### 3. First-time login

```bash
vercel login
```

Picks an email — opens a browser to confirm. Returns to terminal when done.

### 4. First deploy (preview)

```bash
vercel
```

You'll be prompted:

- **Set up and deploy?** → `Y`
- **Which scope?** → your personal account
- **Link to existing project?** → `N`
- **What's your project's name?** → `carscout` (or whatever you like)
- **In which directory is your code located?** → `./` (just press Enter)
- It will auto-detect "Other" framework — that's correct, accept it.

After a few seconds you'll get a preview URL like `https://carscout-xxxx.vercel.app`. The site is live, **but the chat will fall back to the regex parser** because the Gemini key isn't set yet.

### 5. Add API keys as environment variables

```bash
vercel env add GEMINI_API_KEY
```

- Paste your `AIza…` key when prompted.
- For environment, select **all three** (Production, Preview, Development) with the spacebar, then Enter.

```bash
vercel env add MARKETCHECK_API_KEY
```

- Paste your MarketCheck API key (sign up at <https://www.marketcheck.com/apis>).
- Again, select all three environments.

(Optional) override the Gemini model name:

```bash
vercel env add GEMINI_MODEL
# enter: gemini-3.1-flash-lite
```

If the default model isn't available on your account yet, try `gemini-2.5-flash-lite` or whatever Flash-Lite tier you have access to.

> The app will still load and chat without `MARKETCHECK_API_KEY` set — it just falls back to Demo data with a one-line note. Set the var whenever you're ready to flip on real listings.

### 6. Deploy to production

```bash
vercel --prod
```

You get a production URL like `https://carscout.vercel.app`. Share it with whoever you want. They don't need a key — your single key serves everyone, billed against your Gemini free tier.

### 7. (Optional) connect a custom domain

In the Vercel dashboard → your project → **Settings → Domains** → add a domain you own.

---

## Local development

Two options:

**Static only (no Gemini, falls back to regex parser):**

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

**Full stack with the Edge function:**

```bash
vercel dev
# open http://localhost:3000
```

For `vercel dev` to call Gemini locally, create `.env.local`:

```bash
echo "GEMINI_API_KEY=AIzaYourKeyHere" > .env.local
```

`.env.local` is gitignored.

---

## How the chat works

1. **Greeting** on load — CarScout introduces itself.
2. You type, e.g. `1999 vw jetta in Seattle`.
3. The browser POSTs `{ query, previous }` to `/api/parse`.
4. The Edge function calls Gemini with a strict JSON-output prompt, receives:
   ```json
   {
     "make": "Volkswagen",
     "model": "Jetta",
     "year_min": 1999,
     "year_max": 1999,
     "city": "Seattle",
     "state": "WA",
     "zip": "98101",
     "ack_message": "Got it — a 1999 VW Jetta around Seattle. Pulling listings now."
   }
   ```
5. The agent's ack appears in the chat, the listings panel populates (Demo data or Live), then a second agent message summarizes the results ("Found 18 listings, prices range from $1,500 to $4,200…").
6. Follow-up messages refine the search — previous params are passed to Gemini as context, so "show me only manuals" or "what about Portland?" merge cleanly on top.

If `/api/parse` fails (no key, rate-limited, server down), the app falls back to a built-in regex parser so it still works. The agent's reply notes the fallback.

---

## Live vs. Demo mode

The header has a **Live / Demo** toggle. **Live is the default** and is what visitors will hit.

### Live mode — real listings via MarketCheck

Live mode calls `/api/listings`, a second Vercel Edge function that proxies to **MarketCheck**. MarketCheck aggregates real US car listings from AutoTrader, CarMax, Carvana, Cars.com, CarGurus, and many dealer sites — and returns real photos, prices, mileage, and dealer locations.

**Setup (one-time):**

1. Sign up at <https://www.marketcheck.com/apis> and grab your API key. (They have a developer tier; check current pricing — there's usually some free/trial credit.)
2. Add it as a Vercel env var:
   ```bash
   vercel env add MARKETCHECK_API_KEY
   # paste the key, select Production + Preview + Development
   vercel --prod
   ```
   Or do it in the Vercel dashboard → Project → Settings → Environment Variables → add `MARKETCHECK_API_KEY`, then redeploy.

If `MARKETCHECK_API_KEY` isn't set, `/api/listings` returns 503 and the app **gracefully falls back to Demo data** with a one-line note in the chat. Same for 429 rate-limit responses. No crashes, no broken UI — it just degrades to sample data.

### Demo mode — deterministic mock data

Returns 16–24 plausible mock listings. Same query → same results. Prices follow a real depreciation curve (a 1999 Jetta comes back at $1,500–$3,000, not $25k), mileage is age-appropriate. For 15 popular metros (Atlanta, Seattle, LA, NYC, Chicago, Boston, Austin, Dallas, Houston, Denver, Portland, Phoenix, Philadelphia, Miami, SF), real neighbor cities are used; other cities get generic suffixes ("Downtown", "North", etc.). Photos are placeholders from `picsum.photos`. Card links go to each source's real search page, pre-filled with the query and ZIP.

Use Demo mode to show the app off without burning MarketCheck credits.

---

## Free tier notes

- **Gemini**: per-minute and per-day quotas (varies by model). On 429, `/api/parse` falls back to a built-in regex parser with a "rate-limited" note. No crash.
- **MarketCheck**: per-day credits depending on plan. On 429 / 401 / not-configured, `/api/listings` falls back to Demo data with a chat note. No crash.
- **Vercel hobby**: 500k Edge function invocations/mo, plenty for personal use.

---

## Limitations & ethics

- For **personal use**. Respect each listing site's terms of service and `robots.txt`.
- CarScout doesn't persist anything server-side. Chat state lives in your tab; refresh resets it.
