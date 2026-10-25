// Local dev only: serves public/ plus fake /auth and /api endpoints (~60 generated flights).
//   npm run build:ui && node ui/dev-mock.mjs        -> http://localhost:8788
//   MOCK_STATE=login|setup|authed (default authed)   PORT=8788
// Passkey ceremonies can't be faked, so login/register just succeed on a bogus "response" only if
// the browser produces one; use MOCK_STATE=authed to look at the real screens.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const pub = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const port = Number(process.env.PORT) || 8788;
let authed = (process.env.MOCK_STATE ?? "authed") === "authed";
let hasPasskeys = (process.env.MOCK_STATE ?? "authed") !== "setup";

// ---- data ----
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const AP = {
  JFK: ["John F. Kennedy International", "New York", "America/New_York", -5, 40.64, -73.78], PIT: ["Pittsburgh International", "Pittsburgh", "America/New_York", -5, 40.49, -80.23],
  SFO: ["San Francisco International", "San Francisco", "America/Los_Angeles", -8, 37.62, -122.38], NRT: ["Narita International", "Tokyo", "Asia/Tokyo", 9, 35.77, 140.39],
  LHR: ["Heathrow", "London", "Europe/London", 0, 51.47, -0.45], ORD: ["O'Hare International", "Chicago", "America/Chicago", -6, 41.98, -87.9],
  LAX: ["Los Angeles International", "Los Angeles", "America/Los_Angeles", -8, 33.94, -118.41],
  BOS: ["Logan International", "Boston", "America/New_York", -5, 42.36, -71.01], SEA: ["Seattle-Tacoma International", "Seattle", "America/Los_Angeles", -8, 47.45, -122.31],
};
const AIRLINES = [["B6", "JetBlue"], ["NH", "ANA"], ["UA", "United Airlines"], ["BA", "British Airways"], ["AA", "American Airlines"]];
const AIRCRAFT = [["Airbus A320", "Airbus A320"], ["Boeing 787-9", "Boeing 787"], ["Boeing 787-8", "Boeing 787"], ["Boeing 787-10", "Boeing 787"], [null, "Boeing 787"], ["Boeing 737-800", "Boeing 737"], ["Boeing 737 MAX 8", "Boeing 737"], ["Boeing 737-900", "Boeing 737"], [null, "Boeing 737"], ["Boeing 777-300ER", "Boeing 777"], ["Airbus A321neo", "Airbus A320"], ["Embraer E175", "Embraer E-Jet"], [null, null]];
const miles = (a, b) => {
  const r = (d) => (d * Math.PI) / 180, [, , , , la1, lo1] = AP[a], [, , , , la2, lo2] = AP[b];
  const x = Math.sin(r(la2 - la1) / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(r(lo2 - lo1) / 2) ** 2;
  return Math.round(3958.8 * 2 * Math.asin(Math.sqrt(x)));
};
// Real zone offsets (DST-aware) so local times, UTC and durations agree like the server's.
const zoneOffMs = (zone, ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(ms)).map((x) => [x.type, +x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
};
const wallToUtc = (local, zone) => { const g = Date.parse(local + ":00Z"); const o = zoneOffMs(zone, g - zoneOffMs(zone, g)); return g - o; };
const wallFromUtc = (ms, zone) => new Date(ms + zoneOffMs(zone, ms)).toISOString().slice(0, 16);
const flights = [];
const codes = Object.keys(AP);
for (let i = 1; i <= 120; i++) {
  let a = pick(codes), b = pick(codes);
  while (b === a) b = pick(codes);
  const [cc, name] = pick(AIRLINES), [type, fam] = pick(AIRCRAFT);
  const day = new Date(Date.UTC(2024, 5, 1) + Math.floor(rnd() * 1000) * 86400000);
  const dep_date = day.toISOString().slice(0, 10), hr = String(5 + Math.floor(rnd() * 16)).padStart(2, "0");
  const dist = miles(a, b), dur = Math.round(dist / 8 + 40);
  const pc = pick(["Economy", "Economy", "Economy", "Premium Economy", "Business"]);
  const fc = rnd() < 0.15 ? pick(["Business", "First"]) : pc;
  const status = rnd() < 0.06 ? "cancelled" : rnd() < 0.05 ? "pending" : "confirmed";
  const dep_local = `${dep_date}T${hr}:${pick(["00", "15", "30", "45"])}`;
  const depMs = wallToUtc(dep_local, AP[a][2]), arrMs = depMs + dur * 60000;
  const offA = zoneOffMs(AP[a][2], depMs) / 3600000, offB = zoneOffMs(AP[b][2], arrMs) / 3600000;
  const fmtOff = (o) => `${o < 0 ? "-" : "+"}${String(Math.abs(o)).padStart(2, "0")}:00`;
  flights.push({
    id: i, carrier_code: cc, flight_number: String(1 + Math.floor(rnd() * 2000)), airline: name, operating_carrier: null,
    confirmation_code: Math.random().toString(36).slice(2, 8).toUpperCase(), booked_via: null, status,
    dep_airport: a, dep_local, dep_tz: AP[a][2], dep_offset: fmtOff(offA),
    dep_utc: new Date(depMs).toISOString().replace(".000", ""), dep_date,
    arr_airport: b, arr_local: wallFromUtc(arrMs, AP[b][2]), arr_tz: AP[b][2], arr_offset: fmtOff(offB), arr_utc: new Date(arrMs).toISOString().replace(".000", ""),
    duration_min: rnd() < 0.05 ? null : dur, distance_mi: dist,
    aircraft_raw: null, aircraft_family: fam, aircraft_type: type, aircraft_registration: null, aircraft_name: null,
    seat: rnd() < 0.1 ? null : `${1 + Math.floor(rnd() * 40)}${pick(["A", "B", "C", "D", "E", "F"])}`, seat_type: pick(["window", "aisle", "aisle", "middle", null]),
    purchased_class: pc, flown_class: fc, upgrade_type: fc !== pc ? "complimentary_upgrade" : null, upgrade_points_cost: null, upgrade_cash_cost: null, upgrade_cash_currency: null,
    fare_type: i % 9 === 0 ? null : "cash", points_cost: null, points_program: null, cash_cost: i % 13 === 0 ? null : Math.round(rnd() * 50000) / 100, cash_currency: "USD", comments: null,
    review_ok: i % 11 === 0 ? ["aircraft"] : [],
    manual_fields: [...(i % 7 === 0 ? ["seat", "comments"] : []), ...(i % 5 === 0 ? ["duration_min"] : [])], created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00",
  });
}
const flightNo = (f) => f.carrier_code + f.flight_number;
const info = (c) => (AP[c] ? { name: AP[c][0], city: AP[c][1], country: "US" } : null);
// Mirror of REVIEW_GROUPS in src/review.ts
const GROUPS = [
  ["airline", (f) => f.carrier_code === ""], ["flight_number", (f) => f.flight_number === ""], ["confirmation", (f) => !f.confirmation_code], ["times", (f) => f.arr_local == null],
  ["aircraft", (f) => f.aircraft_family == null && f.aircraft_type == null], ["seat", (f) => f.seat == null],
  ["cabin", (f) => f.purchased_class == null && f.flown_class == null], ["fare", (f) => f.fare_type == null],
  ["cost", (f) => (f.fare_type === "award" && f.points_cost == null) || (f.fare_type === "cash" && f.cash_cost == null)],
];
const missingOf = (f) => GROUPS.filter(([, m]) => m(f)).map(([n]) => n);
const needsReview = (f) => counted(f) && missingOf(f).some((m) => !f.review_ok.includes(m));
const present = (f) => ({ ...f, flight: flightNo(f), missing: missingOf(f), needs_review: needsReview(f), dep_airport_info: info(f.dep_airport), arr_airport_info: info(f.arr_airport) });

// ---- validation (subset of FIELDS) ----
const ENUMS = {
  status: ["confirmed", "pending", "changed", "cancelled", "replaced"], seat_type: ["window", "middle", "aisle"], fare_type: ["cash", "award"],
  purchased_class: ["Economy", "Premium Economy", "Business", "First"], flown_class: ["Economy", "Premium Economy", "Business", "First"],
  upgrade_type: ["complimentary_upgrade", "op_up", "mileage_upgrade", "cash_upgrade", "bid_upgrade", "certificate_upgrade", "op_down", "voluntary_downgrade"],
};
const INTS = ["duration_min", "distance_mi", "upgrade_points_cost", "points_cost"], NUMS = ["upgrade_cash_cost", "cash_cost"];
const TEXT = ["airline", "operating_carrier", "confirmation_code", "booked_via", "aircraft_family", "aircraft_type", "aircraft_registration", "aircraft_name", "points_program", "comments", "dep_tz", "arr_tz", "dep_offset", "arr_offset", "upgrade_cash_currency", "cash_currency", "seat", "carrier_code", "flight_number", "dep_airport", "arr_airport", "dep_local", "arr_local"];
const REQUIRED = ["flight_number", "status", "dep_airport", "arr_airport", "dep_local"];
function applyPatch(f, body) {
  const errors = [], next = { ...f }, manual = new Set(f.manual_fields);
  for (const [k, v] of Object.entries(body)) {
    if (k === "unlock" || k === "review_ok") continue;
    if (!(k in ENUMS || INTS.includes(k) || NUMS.includes(k) || TEXT.includes(k))) { errors.push(`${k} isn't editable`); continue; }
    if (v === null || v === "") { if (REQUIRED.includes(k)) errors.push(`${k} can't be empty`); else { next[k] = null; manual.add(k); } continue; }
    if (k in ENUMS && !ENUMS[k].includes(v)) errors.push(`${k}: expected ${ENUMS[k].join(" | ")}`);
    else if (INTS.includes(k) && !(Number.isInteger(v) && v >= 0)) errors.push(`${k}: expected whole number`);
    else if (NUMS.includes(k) && !(typeof v === "number" && v >= 0)) errors.push(`${k}: expected number`);
    else if (k.endsWith("_airport") && !/^[A-Za-z]{3}$/.test(v)) errors.push(`${k}: expected 3-letter IATA code`);
    else if (k.endsWith("_local") && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) errors.push(`${k}: expected YYYY-MM-DDTHH:MM (local time)`);
    else { next[k] = k.endsWith("_airport") ? v.toUpperCase() : v; manual.add(k); }
  }
  for (const u of Array.isArray(body.unlock) ? body.unlock : []) manual.delete(String(u));
  next.manual_fields = [...manual];
  const names = GROUPS.map(([n]) => n);
  if (Array.isArray(body.review_ok) && body.review_ok.every((g) => names.includes(g))) next.review_ok = missingOf(next).filter((m) => body.review_ok.includes(m));
  else if (body.review_ok !== undefined && typeof body.review_ok !== "boolean") errors.push("review_ok: expected true, false or a list of groups");
  else if (body.review_ok !== undefined) next.review_ok = body.review_ok ? missingOf(next) : [];
  return { next, errors };
}

// ---- series (synthetic, deterministic; independent of the ~120 generated flights) ----
function series(year) {
  const r = (n) => { const x = Math.sin(n * 9301 + 49297) * 233280; return x - Math.floor(x); };
  const mk = (key, flights, n, recent) => {
    const miles = flights * (900 + Math.round(r(n + 1) * 1400)), prem = Math.round(flights * r(n + 2) * 0.4);
    const cash = recent && flights ? Math.round(flights * (150 + r(n + 4) * 350) * 100) / 100 : 0;
    const award = Math.round(cash * r(n + 6) * 0.2 * 100) / 100, upgrade = Math.round(cash * r(n + 7) * 0.15 * 100) / 100;
    return {
      key, flights, miles, minutes: Math.round(miles / 8.2 + flights * 40), airports: flights ? Math.min(2 + Math.round(flights * 0.5), 40) : 0,
      new_airports: flights ? Math.round(r(n + 3) * (flights > 20 ? 6 : 3)) : 0, premium_share: flights ? prem / flights : null,
      cash_usd: Math.round((cash + award + upgrade) * 100) / 100, fare_usd: cash, award_usd: award, upgrade_usd: upgrade, points: recent && flights ? Math.round(r(n + 5) * 60000 / 1000) * 1000 : 0,
    };
  };
  if (year) {
    const y = +year, pts = Array.from({ length: 12 }, (_, i) => mk(`${y}-${String(i + 1).padStart(2, "0")}`, [0, 2, 3, 1, 4, 6, 8, 5, 3, 0, 2, 4][i] * (y > 2018 ? 1 : 0), i + y, y >= 2019));
    return { unit: "month", points: pts, other_currency_flights: y >= 2022 ? 3 : 0 };
  }
  const zero = new Set([2004, 2005, 2009]);
  const pts = [];
  for (let y = 2001; y <= 2026; y++) pts.push(mk(String(y), zero.has(y) ? 0 : y < 2010 ? 2 + Math.round(r(y) * 8) : 8 + Math.round(r(y) * 40) + (y > 2022 ? 20 : 0), y, y >= 2019));
  return { unit: "year", points: pts, other_currency_flights: 3 };
}

// ---- stats ----
const counted = (f) => !["cancelled", "replaced"].includes(f.status);
const departed = (f) => Date.parse(f.dep_utc ?? f.dep_local + ":00Z") < Date.now();
const top = (m, n = 10) => [...m.entries()].sort((x, y) => y[1].flights - x[1].flights).slice(0, n);
function stats(year) {
  const all = flights.filter(counted), years = [...new Set(all.map((f) => +f.dep_date.slice(0, 4)))].sort((a, b) => b - a);
  const inYear = all.filter((f) => !year || f.dep_date.startsWith(year));
  const flown = inYear.filter(departed);
  const routes = new Map(), airlines = new Map(), aircraft = new Map(), ap = new Set(), apc = new Map();
  const seat_types = { window: 0, middle: 0, aisle: 0, unknown: 0 }, cabins = { Economy: 0, "Premium Economy": 0, Business: 0, First: 0, unknown: 0 };
  for (const f of flown) {
    ap.add(f.dep_airport); ap.add(f.arr_airport);
    for (const c of [f.dep_airport, f.arr_airport]) apc.set(c, (apc.get(c) ?? 0) + 1);
    const [x, y] = [f.dep_airport, f.arr_airport].sort(), rk = `${x}–${y}`;
    const r = routes.get(rk) ?? { route: rk, a: x, b: y, flights: 0, miles: 0 }; r.flights++; r.miles += f.distance_mi ?? 0; routes.set(rk, r);
    const al = airlines.get(f.carrier_code) ?? { key: f.carrier_code, name: f.airline, flights: 0, miles: 0, minutes: 0, cash_usd: 0, points: 0 }; al.flights++; al.miles += f.distance_mi ?? 0; al.minutes += f.duration_min ?? 0; al.cash_usd += (f.cash_cost_usd ?? 0) + (f.upgrade_cash_cost_usd ?? 0); al.points += f.points_cost ?? 0; airlines.set(f.carrier_code, al);
    const fam = f.aircraft_family || "Unknown";
    const ac = aircraft.get(fam) ?? { family: fam, flights: 0, variants: [], unspecified: 0 }; ac.flights++; aircraft.set(fam, ac);
    if (f.aircraft_type) { const v = ac.variants.find((x) => x.type === f.aircraft_type); if (v) v.flights++; else ac.variants.push({ type: f.aircraft_type, flights: 1 }); } else ac.unspecified++;
    seat_types[f.seat_type ?? "unknown"]++;
    cabins[f.flown_class || f.purchased_class || "unknown"]++;
  }
  return {
    year: year ? +year : null, years: [...new Set([...years, ...Array.from({ length: 26 }, (_, i) => 2026 - i)])].sort((a, b) => b - a), flights: flown.length, upcoming: inYear.length - flown.length,
    miles: flown.reduce((s, f) => s + (f.distance_mi ?? 0), 0), minutes: flown.reduce((s, f) => s + (f.duration_min ?? 0), 0), airports: ap.size,
    top_airports: [...apc].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 10).map(([code, n]) => ({ code, name: AP[code][0], city: AP[code][1], flights: n })),
    routes: top(routes).map(([, v]) => v), airlines: top(airlines).map(([, v]) => v), aircraft: top(aircraft).map(([, v]) => ({ ...v, variants: v.variants.sort((x, y) => y.flights - x.flights) })), seat_types, cabins,
    series: series(year),
  };
}

// ---- list ----
const SORT = {
  dep: (f) => f.dep_utc ?? f.dep_local, flight: flightNo, route: (f) => f.dep_airport + f.arr_airport, airline: (f) => f.airline ?? "",
  aircraft: (f) => f.aircraft_type ?? "", seat: (f) => f.seat ?? "", class: (f) => f.flown_class ?? "", distance: (f) => f.distance_mi ?? -1, duration: (f) => f.duration_min ?? -1,
};
function list(q) {
  const sort = q.get("sort") ?? "dep", dir = q.get("dir") ?? "desc";
  if (!SORT[sort] || !["asc", "desc"].includes(dir)) return null;
  let rows = flights.slice();
  const s = (q.get("q") ?? "").toLowerCase();
  if (s) rows = rows.filter((f) => [flightNo(f), f.dep_airport, f.arr_airport, f.airline, f.confirmation_code, f.aircraft_type].join(" ").toLowerCase().includes(s));
  if (q.get("year")) rows = rows.filter((f) => f.dep_date.startsWith(q.get("year")));
  const review_count = rows.filter(needsReview).length;
  const names = GROUPS.map(([n]) => n);
  const todo = (f, g) => counted(f) && missingOf(f).includes(g) && !f.review_ok.includes(g);
  const review_group_counts = Object.fromEntries(names.map((g) => [g, rows.filter((f) => todo(f, g)).length]));
  if (q.has("missing")) {
    const gs = q.get("missing").split(",").filter(Boolean);
    if (!gs.length || !gs.every((g) => names.includes(g))) return null;
    rows = rows.filter((f) => gs.some((g) => todo(f, g)));
  } else if (q.get("review") === "1") rows = rows.filter(needsReview);
  const key = SORT[sort];
  rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (dir === "asc" ? 1 : -1));
  if (!q.has("page")) return rows.map(present);
  const per = Math.min(200, Number(q.get("per_page")) || 25), page = Math.max(1, Number(q.get("page")) || 1);
  return { flights: rows.slice((page - 1) * per, page * per).map(present), total: rows.length, page, per_page: per, review_count, review_group_counts };
}

// ---- server ----
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
const send = (res, status, data, headers = {}) => {
  if (data === undefined) { res.writeHead(status, headers); return res.end(); }
  res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(data));
};
const body = (req) => new Promise((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { ok({}); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"), p = url.pathname;
  try {
    if (p === "/auth/me") return send(res, 200, { authenticated: authed, has_passkeys: hasPasskeys });
    if (p === "/auth/logout") { authed = false; return send(res, 204); }
    if (p.startsWith("/auth/")) {
      const b = await body(req);
      if (p === "/auth/register/options") return b.setup_token === "dev" || authed ? send(res, 200, { challenge: "AAAA", rp: { name: "mock", id: "localhost" }, user: { id: "AAAA", name: "me", displayName: "me" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "required" } }) : send(res, 401, { error: "unauthorized" });
      if (p === "/auth/register/verify") { authed = true; hasPasskeys = true; return send(res, 200, { ok: true }); }
      if (p === "/auth/login/options") return send(res, 200, { challenge: "AAAA", rpId: "localhost", allowCredentials: [] });
      if (p === "/auth/login/verify") { authed = true; return send(res, 200, { ok: true }); }
    }
    if (p.startsWith("/api/")) {
      if (!authed) return send(res, 404, { error: "Not found" });
      if (p === "/api/stats") return send(res, 200, { ...stats(url.searchParams.get("year")), needs_review: flights.filter(needsReview).length });
      if (p === "/api/flights/review" && req.method === "POST") {
        const { ids, ok, groups } = await body(req);
        const names = GROUPS.map(([n]) => n);
        if (groups !== undefined && !(Array.isArray(groups) && groups.every((g) => names.includes(g)))) return send(res, 400, { error: "bad groups" });
        if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every((i) => Number.isInteger(i) && i > 0) || typeof ok !== "boolean") return send(res, 400, { error: "bad ids or ok" });
        let updated = 0;
        for (const f of flights) if (ids.includes(f.id)) { f.review_ok = !groups ? (ok ? missingOf(f) : []) : ok ? [...new Set([...f.review_ok, ...missingOf(f).filter((m) => groups.includes(m))])] : f.review_ok.filter((m) => !groups.includes(m)); updated++; }
        return send(res, 200, { updated });
      }
      if (p === "/api/flights" && req.method === "GET") {
        const r = list(url.searchParams);
        return r ? send(res, 200, r) : send(res, 400, { error: "bad sort, dir or missing" });
      }
      const m = p.match(/^\/api\/flights\/(\d+)$/);
      if (m) {
        const i = flights.findIndex((f) => f.id === +m[1]);
        if (i < 0) return send(res, 404, { error: "No such flight" });
        if (req.method === "GET") return send(res, 200, present(flights[i]));
        if (req.method === "DELETE") { flights.splice(i, 1); return send(res, 200, { ok: true }); }
        if (req.method === "PATCH") {
          const { next, errors } = applyPatch(flights[i], await body(req));
          if (errors.length) return send(res, 400, { error: errors });
          next.updated_at = new Date().toISOString(); flights[i] = next;
          return send(res, 200, present(next));
        }
      }
      return send(res, 404, { error: "Not found" });
    }
    const file = normalize(join(pub, p === "/" ? "index.html" : p));
    if (!file.startsWith(pub)) return send(res, 403, { error: "no" });
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }); res.end(data);
  } catch (e) {
    send(res, e.code === "ENOENT" ? 404 : 500, { error: String(e.message) });
  }
}).listen(port, () => console.log(`mock UI server on http://localhost:${port} (authed=${authed})`));
