import { familyForType } from "./aircraft";
import { airport } from "./geo";

// Aggregates for GET /api/stats. "Flown" = not cancelled/replaced and already departed (or, with
// includeFuture, booked too).
const LIVE = "status NOT IN ('cancelled', 'replaced')";
const DEP = "COALESCE(dep_utc, dep_local)";
const CABINS = ["Economy", "Premium Economy", "Business", "First"];

export interface SeriesPoint {
  key: string; flights: number; miles: number; minutes: number; airports: number; new_airports: number;
  premium_share: number | null; cash_usd: number; fare_usd: number; award_usd: number; upgrade_usd: number; points: number;
}

export async function computeStats(db: D1Database, year: number | null, includeFuture = false) {
  const now = new Date().toISOString();
  const cutoff = includeFuture ? "9999" : now;
  const yearSql = year === null ? "" : " AND substr(dep_date, 1, 4) = ?2";
  const yb = (...extra: unknown[]) => (year === null ? extra : [...extra, String(year)]);
  // ?1 is always the cutoff
  const flown = `${LIVE} AND ${DEP} < ?1${yearSql}`;
  const q = (sql: string) => db.prepare(sql).bind(...yb(cutoff));

  // Series buckets: years overall, months within a selected year.
  const plen = year === null ? 4 : 7;
  const P = `substr(dep_date, 1, ${plen})`;
  const flownAll = `${LIVE} AND ${DEP} < ?1`;
  const cls = "COALESCE(NULLIF(flown_class, ''), NULLIF(purchased_class, ''))";

  const [totals, upcoming, years, airports, topAirports, routes, airlines, aircraft, seats, cabins, serMain, serAirports, serFirst, serOther] = await db.batch([
    q(`SELECT COUNT(*) AS flights, COALESCE(SUM(COALESCE(distance_mi, 0)), 0) AS miles, COALESCE(SUM(COALESCE(duration_min, 0)), 0) AS minutes
       FROM flights WHERE ${flown}`),
    db.prepare(`SELECT COUNT(*) AS n FROM flights WHERE ${LIVE} AND ${DEP} >= ?1${yearSql}`).bind(...yb(now)),
    db.prepare(`SELECT DISTINCT CAST(substr(dep_date, 1, 4) AS INTEGER) AS y FROM flights WHERE ${LIVE} ORDER BY y DESC`),
    q(`SELECT COUNT(*) AS n FROM (SELECT dep_airport AS a FROM flights WHERE ${flown} UNION SELECT arr_airport FROM flights WHERE ${flown})`),
    q(`SELECT code, COUNT(*) AS flights FROM (SELECT dep_airport AS code FROM flights WHERE ${flown} UNION ALL SELECT arr_airport FROM flights WHERE ${flown})
       WHERE code != '' GROUP BY code ORDER BY flights DESC, code LIMIT 10`),
    q(`SELECT MIN(dep_airport, arr_airport) AS a, MAX(dep_airport, arr_airport) AS b, COUNT(*) AS flights, SUM(COALESCE(distance_mi, 0)) AS miles
       FROM flights WHERE ${flown} GROUP BY a, b ORDER BY flights DESC, miles DESC, a, b LIMIT 10`),
    q(`SELECT f.carrier_code AS key, COUNT(*) AS flights, SUM(COALESCE(f.distance_mi, 0)) AS miles,
         SUM(COALESCE(f.duration_min, 0)) AS minutes, SUM(COALESCE(f.cash_cost_usd, 0)) + SUM(COALESCE(f.upgrade_cash_cost_usd, 0)) AS cash_usd,
         SUM(COALESCE(f.points_cost, 0)) AS points,
         (SELECT airline FROM flights g WHERE g.carrier_code = f.carrier_code AND g.airline IS NOT NULL AND g.airline != ''
          GROUP BY airline ORDER BY COUNT(*) DESC, airline LIMIT 1) AS name
       FROM flights f WHERE ${flown.replace(/\b(status|dep_utc|dep_local|dep_date)\b/g, "f.$1")} AND f.carrier_code != ''
       GROUP BY f.carrier_code ORDER BY flights DESC, miles DESC, key`),
    q(`SELECT NULLIF(aircraft_family, '') AS family, NULLIF(aircraft_type, '') AS type, COUNT(*) AS flights
       FROM flights WHERE ${flown} GROUP BY family, type`),
    q(`SELECT COALESCE(seat_type, 'unknown') AS k, COUNT(*) AS n FROM flights WHERE ${flown} GROUP BY k`),
    q(`SELECT COALESCE(NULLIF(flown_class, ''), NULLIF(purchased_class, ''), 'unknown') AS k, COUNT(*) AS n FROM flights WHERE ${flown} GROUP BY k`),
    q(`SELECT ${P} AS k, COUNT(*) AS flights, SUM(COALESCE(distance_mi, 0)) AS miles, SUM(COALESCE(duration_min, 0)) AS minutes,
         SUM(CASE WHEN ${cls} IN ('Premium Economy', 'Business', 'First') THEN 1 ELSE 0 END) AS premium,
         SUM(CASE WHEN fare_type IS NOT 'award' THEN COALESCE(cash_cost_usd, 0) ELSE 0 END) AS fare_usd,
         SUM(CASE WHEN fare_type = 'award' THEN COALESCE(cash_cost_usd, 0) ELSE 0 END) AS award_usd,
         SUM(COALESCE(upgrade_cash_cost_usd, 0)) AS upgrade_usd, SUM(COALESCE(points_cost, 0)) AS points
       FROM flights WHERE ${flown} GROUP BY k`),
    q(`SELECT k, COUNT(DISTINCT code) AS n FROM (SELECT ${P} AS k, dep_airport AS code FROM flights WHERE ${flown}
         UNION ALL SELECT ${P}, arr_airport FROM flights WHERE ${flown}) WHERE code != '' GROUP BY k`),
    // First-ever flown visit per airport over all history (not just the selected year).
    db.prepare(`SELECT code, MIN(d) AS first FROM (SELECT dep_airport AS code, dep_date AS d FROM flights WHERE ${flownAll}
         UNION ALL SELECT arr_airport, dep_date FROM flights WHERE ${flownAll}) WHERE code != '' GROUP BY code`).bind(cutoff),
    q(`SELECT COUNT(*) AS n FROM flights WHERE ${flown} AND ((cash_cost IS NOT NULL AND cash_cost_usd IS NULL) OR (upgrade_cash_cost IS NOT NULL AND upgrade_cash_cost_usd IS NULL))`),
  ]);

  const rows = <T>(r: D1Result) => r.results as T[];
  const t = rows<{ flights: number; miles: number; minutes: number }>(totals)[0];
  const seat_types: Record<string, number> = { window: 0, middle: 0, aisle: 0, unknown: 0 };
  for (const r of rows<{ k: string; n: number }>(seats)) seat_types[r.k in seat_types ? r.k : "unknown"] += r.n;
  const cabinCounts: Record<string, number> = Object.fromEntries([...CABINS, "unknown"].map((c) => [c, 0]));
  for (const r of rows<{ k: string; n: number }>(cabins)) cabinCounts[r.k in cabinCounts ? r.k : "unknown"] += r.n;

  // Roll (family, type) rows up into families; a missing family falls back to the type's family.
  const fams = new Map<string, { family: string; flights: number; variants: { type: string; flights: number }[]; unspecified: number }>();
  for (const r of rows<{ family: string | null; type: string | null; flights: number }>(aircraft)) {
    const family = r.family ?? familyForType(r.type) ?? "Unknown";
    const f = fams.get(family) ?? { family, flights: 0, variants: [], unspecified: 0 };
    f.flights += r.flights;
    if (r.type) {
      const v = f.variants.find((x) => x.type === r.type);
      if (v) v.flights += r.flights;
      else f.variants.push({ type: r.type, flights: r.flights });
    } else f.unspecified += r.flights;
    fams.set(family, f);
  }
  const topAircraft = [...fams.values()]
    .map((f) => ({ ...f, variants: f.variants.sort((a, b) => b.flights - a.flights || a.type.localeCompare(b.type)) }))
    // "Unknown" isn't an aircraft: always rank it last.
    .sort((a, b) => Number(a.family === "Unknown") - Number(b.family === "Unknown") || b.flights - a.flights || a.family.localeCompare(b.family))
    .slice(0, 10);

  // Series: fill missing periods so gaps show as zeros.
  const byKey = new Map(rows<{ k: string; flights: number; miles: number; minutes: number; premium: number; fare_usd: number; award_usd: number; upgrade_usd: number; points: number }>(serMain).map((r) => [r.k, r]));
  const apByKey = new Map(rows<{ k: string; n: number }>(serAirports).map((r) => [r.k, r.n]));
  const newByKey = new Map<string, number>();
  for (const r of rows<{ first: string }>(serFirst)) {
    const k = r.first.slice(0, plen);
    newByKey.set(k, (newByKey.get(k) ?? 0) + 1);
  }
  let keys: string[] = [];
  if (year !== null) keys = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  else if (byKey.size) {
    const ys = [...byKey.keys()].map(Number);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    for (let y = lo; y <= hi; y++) keys.push(String(y));
  }
  const points: SeriesPoint[] = keys.map((key) => {
    const r = byKey.get(key);
    const c = (v: number | undefined) => Math.round((v ?? 0) * 100) / 100;
    const fare = c(r?.fare_usd), award = c(r?.award_usd), upgrade = c(r?.upgrade_usd);
    return {
      key, flights: r?.flights ?? 0, miles: r?.miles ?? 0, minutes: r?.minutes ?? 0,
      airports: apByKey.get(key) ?? 0, new_airports: newByKey.get(key) ?? 0,
      premium_share: r && r.flights ? r.premium / r.flights : null,
      cash_usd: c(fare + award + upgrade), fare_usd: fare, award_usd: award, upgrade_usd: upgrade, points: r?.points ?? 0,
    };
  });

  return {
    year,
    include_future: includeFuture,
    years: rows<{ y: number }>(years).map((r) => r.y),
    flights: t.flights,
    upcoming: rows<{ n: number }>(upcoming)[0].n,
    miles: t.miles,
    minutes: t.minutes,
    airports: rows<{ n: number }>(airports)[0].n,
    top_airports: rows<{ code: string; flights: number }>(topAirports).map((r) => {
      const a = airport(r.code);
      return { code: r.code, name: a?.name ?? null, city: a?.city ?? null, flights: r.flights };
    }),
    routes: rows<{ a: string; b: string; flights: number; miles: number }>(routes).map((r) => ({ route: `${r.a}–${r.b}`, ...r })),
    airlines: rows<{ key: string; name: string | null; flights: number; miles: number; minutes: number; cash_usd: number; points: number }>(airlines)
      .map((r) => ({ ...r, name: r.name ?? r.key, cash_usd: Math.round(r.cash_usd * 100) / 100 })),
    aircraft: topAircraft,
    seat_types,
    cabins: cabinCounts,
    series: { unit: (year === null ? "year" : "month") as "year" | "month", points, other_currency_flights: rows<{ n: number }>(serOther)[0].n },
  };
}
