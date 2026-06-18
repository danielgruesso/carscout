// Field-level scoring for the buyer-query golden set. Only fields present in a
// case's `expected` are graded, so each case asserts exactly what it cares about.

const NUMERIC = new Set(["year_min", "year_max", "price_max", "mileage_max", "radius_miles"]);
const EXACT_LOWER = new Set(["body_type", "transmission", "fuel_type", "new_or_used"]);
const EXACT_UPPER = new Set(["state"]);
const EXACT_RAW = new Set(["zip"]);
// make/model/city tolerate substring matches (e.g. "Miata" vs "MX-5 Miata").
const FUZZY = new Set(["make", "model", "city"]);

const norm = (v) => String(v ?? "").trim().toLowerCase();

function fuzzyEqual(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return (x.length >= 3 && y.includes(x)) || (y.length >= 3 && x.includes(y));
}

function fieldMatches(field, expected, predicted) {
  if (predicted === undefined || predicted === null || predicted === "") return false;
  if (NUMERIC.has(field)) return Number(predicted) === Number(expected);
  if (EXACT_UPPER.has(field)) return String(predicted).toUpperCase() === String(expected).toUpperCase();
  if (EXACT_LOWER.has(field)) return norm(predicted) === norm(expected);
  if (EXACT_RAW.has(field)) return String(predicted) === String(expected);
  if (FUZZY.has(field)) return fuzzyEqual(expected, predicted);
  // Unknown field — fall back to normalized equality.
  return norm(predicted) === norm(expected);
}

/**
 * Score one predicted param object against a golden case's expected fields.
 * @returns {{score:number, total:number, matched:number, fields:Record<string,boolean>, misses:string[]}}
 */
export function scoreOne(expected, predicted) {
  const fields = {};
  const misses = [];
  const keys = Object.keys(expected);
  let matched = 0;
  for (const k of keys) {
    const ok = fieldMatches(k, expected[k], predicted?.[k]);
    fields[k] = ok;
    if (ok) matched++;
    else misses.push(`${k}=${JSON.stringify(predicted?.[k])}≠${JSON.stringify(expected[k])}`);
  }
  return { score: keys.length ? matched / keys.length : 1, total: keys.length, matched, fields, misses };
}
