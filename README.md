# CarScout

A chat-style webapp for finding used and new car listings across the US. Talk to it like an assistant — "1999 vw jetta in Seattle", "manual miata under 20k", "show me only EVs" — and it parses your message with **Google Gemini** (default `gemini-3.1-flash-lite`), then aggregates listings from AutoTrader, CarMax, Carvana, Cars.com, and CarGurus.

- **Nationwide** search. If you don't name a city, it defaults to **Atlanta, GA**.
- **No key needed for visitors.** The Gemini key lives in a Vercel Edge function on the server side. You bring one key, everyone uses the app.
- **No database, no build step.** One static HTML file + one Edge function.

```
carscout/
├── index.html       # chat UI (React via esm.sh, Tailwind via CDN)
├── api/
│   └── parse.js     # Vercel Edge function — proxies to Gemini, keeps key server-side
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

### 5. Add the Gemini key as an environment variable

```bash
vercel env add GEMINI_API_KEY
```

- Paste your `AIza…` key when prompted.
- For environment, select **all three** (Production, Preview, Development) with the spacebar, then Enter.

(Optional) override the model name:

```bash
vercel env add GEMINI_MODEL
# enter: gemini-3.1-flash-lite
```

If the default model isn't available on your account yet, try `gemini-2.5-flash-lite` or whatever Flash-Lite tier you have access to.

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

## Demo mode vs. Live mode

The header has a **Demo / Live** toggle. **Demo is the default.**

### Demo mode

Returns 16–24 deterministic, plausible mock listings spread across the five sources. Same query → same results. Prices follow a real depreciation curve (a 1999 Jetta comes back at $1,500–$3,000, not $25k), mileage is age-appropriate. For popular metros (Atlanta, Seattle, LA, NYC, Chicago, Boston, Austin, Dallas, Houston, Denver, Portland, Phoenix, Philadelphia, Miami, SF), real neighbor cities are used. For any other city, generic suffixes ("Downtown", "North", etc.) are used.

Card links go to each source's real search page, pre-filled with the query and ZIP.

### Live mode

Attempts to fetch and parse real search-result pages via a user-provided CORS proxy (configured in ⚙ settings). Sites employ bot protection and JS rendering, so most requests get blocked — you'll see per-source dots (`AutoTrader: blocked`, etc.). Partial results render, no crashes.

For reliable real data, deploy a tiny Cloudflare Worker:

```js
export default {
  async fetch(req) {
    const url = new URL(req.url);
    const target = url.searchParams.get("url");
    if (!target) return new Response("missing ?url=", { status: 400 });
    const upstream = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0" } });
    const body = await upstream.text();
    return new Response(body, {
      headers: {
        "content-type": upstream.headers.get("content-type") || "text/html",
        "access-control-allow-origin": "*",
      },
    });
  },
};
```

Or use a paid listing API (MarketCheck, Auto.dev) — wire it up in place of `fetchLiveListings` in `index.html`.

---

## Free tier notes

Gemini's free tier has per-minute and per-day quotas (varies by model). If you go over, `/api/parse` returns a 429 and the app falls back to regex parsing with a "rate-limited" note — no crash, no broken state. If your app gets popular enough to outgrow free, switch to paid in Google AI Studio.

Vercel hobby tier covers Edge function usage generously (500k invocations/mo).

---

## Limitations & ethics

- For **personal use**. Respect each listing site's terms of service and `robots.txt`.
- Live mode makes at most one request per source per search.
- CarScout doesn't persist anything server-side. Chat state lives in your tab; refresh resets it.
