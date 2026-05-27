// Vercel Edge function — proxies to MarketCheck for real US car listings.
// Returns normalized listings with real photos from AutoTrader, CarMax,
// Carvana, Cars.com, CarGurus, and many dealer sites.
//
// Requires MARKETCHECK_API_KEY env var. Sign up at https://www.marketcheck.com/apis.

export const config = { runtime: "edge" };

const MC_BASE = "https://api.marketcheck.com/v2/search/car/active";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });

const capitalize = (s) => (!s ? s : s[0].toUpperCase() + s.slice(1).toLowerCase());

function buildMarketCheckUrl(params, apiKey) {
  const q = new URLSearchParams({ api_key: apiKey, rows: "30", start: "0" });
  if (params.make)        q.set("make",   params.make);
  if (params.model)       q.set("model",  params.model);
  if (params.year_min)    q.set("year_min", String(params.year_min));
  if (params.year_max)    q.set("year_max", String(params.year_max));
  if (params.price_max)   q.set("price_range", `0-${params.price_max}`);
  if (params.mileage_max) q.set("miles_range", `0-${params.mileage_max}`);
  if (params.zip)         q.set("zip",    params.zip);
  if (params.radius_miles) q.set("radius", String(params.radius_miles));

  if (params.new_or_used && params.new_or_used !== "any") q.set("car_type", params.new_or_used);
  if (params.transmission && params.transmission !== "any") {
    q.set("transmission", params.transmission === "manual" ? "Manual" : "Automatic");
  }
  if (params.fuel_type && params.fuel_type !== "any") {
    const map = { gas: "Gasoline", hybrid: "Hybrid", electric: "Electric", diesel: "Diesel" };
    q.set("fuel_type", map[params.fuel_type] || params.fuel_type);
  }
  if (params.body_type) {
    q.set("body_type", params.body_type.toLowerCase() === "suv" ? "SUV" : capitalize(params.body_type));
  }
  q.set("photo_links", "true");
  return `${MC_BASE}?${q.toString()}`;
}

function sourceKeyFromUrl(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    const u = String(c).toLowerCase();
    if (u.includes("autotrader.com")) return "autotrader";
    if (u.includes("carmax.com"))     return "carmax";
    if (u.includes("carvana.com"))    return "carvana";
    if (u.includes("cars.com"))       return "cars";
    if (u.includes("cargurus.com"))   return "cargurus";
  }
  return "other";
}

const SOURCE_NAMES = {
  autotrader: "AutoTrader",
  carmax: "CarMax",
  carvana: "Carvana",
  cars: "Cars.com",
  cargurus: "CarGurus",
};

function normalize(mc) {
  const build = mc.build || {};
  const dealer = mc.dealer || {};
  const media = mc.media || {};
  const photos = media.photo_links_cached || media.photo_links || [];
  const sourceKey = sourceKeyFromUrl(mc.source, mc.vdp_url, dealer.website);
  const sourceName = SOURCE_NAMES[sourceKey] || mc.source || "Dealer";

  return {
    id: mc.id || mc.vin || `${build.year}-${build.make}-${build.model}-${mc.price}`,
    vin: mc.vin || "",
    year: build.year || null,
    make: build.make || "",
    model: build.model || "",
    trim: build.trim || "",
    price: mc.price || null,
    mileage: mc.miles || null,
    city: dealer.city || "",
    state: dealer.state || "",
    distance: typeof mc.dist === "number" ? Math.round(mc.dist * 10) / 10 : null,
    source: sourceKey,
    sourceName,
    image: photos[0] || "",
    url: mc.vdp_url || "",
  };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const apiKey = process.env.MARKETCHECK_API_KEY;
  if (!apiKey) {
    return json(
      { error: "not_configured", detail: "MARKETCHECK_API_KEY env var is missing on the server" },
      503
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json_body" }, 400);
  }
  const params = body?.params || {};
  if (!params.zip) return json({ error: "missing_zip" }, 400);

  const url = buildMarketCheckUrl(params, apiKey);

  try {
    const upstream = await fetch(url, { headers: { accept: "application/json" } });
    if (!upstream.ok) {
      const text = await upstream.text();
      if (upstream.status === 429) return json({ error: "rate_limited", detail: text.slice(0, 300) }, 429);
      if (upstream.status === 401 || upstream.status === 403) {
        return json({ error: "unauthorized", detail: text.slice(0, 300) }, upstream.status);
      }
      return json({ error: "marketcheck_upstream", status: upstream.status, detail: text.slice(0, 400) }, 502);
    }
    const data = await upstream.json();
    const raw = Array.isArray(data?.listings) ? data.listings : [];
    const normalized = raw.map(normalize);

    // Dedupe by VIN, else by tuple
    const seen = new Set();
    const deduped = [];
    for (const l of normalized) {
      const key = l.vin || `${l.year}|${l.make}|${l.model}|${l.trim}|${l.price}|${l.mileage}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(l);
    }

    const sourceCounts = {};
    for (const l of deduped) sourceCounts[l.source] = (sourceCounts[l.source] || 0) + 1;

    return json({
      listings: deduped,
      num_found: data?.num_found ?? deduped.length,
      sources: sourceCounts,
    });
  } catch (e) {
    return json({ error: "fetch_failed", detail: (e && e.message) || String(e) }, 502);
  }
}
