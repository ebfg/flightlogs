// Exercises the API against a running local Worker (called from test/e2e.sh, after the
// sample emails have been posted with MY_NAME="John Smith").
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const API = `http://${process.env.API}`;
const H = { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" };
let failures = 0;

const call = async (method, path, body) => {
  const r = await fetch(API + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
};
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const sendEmail = async (file) => {
  const q = new URLSearchParams({ from: process.env.FROM, to: process.env.TO });
  await fetch(`${API}/cdn-cgi/handler/email?${q}`, { method: "POST", body: readFileSync(file), headers: { "content-type": "message/rfc822" } });
};
const byFlight = async (code) => (await call("GET", "/api/flights")).data.find((f) => f.flight === code);

check("API without token is hidden", (await fetch(API + "/api/flights")).status === 404);

let nh9 = await byFlight("NH9");
let nh10 = await byFlight("NH10");
check("Time zones + UTC", nh9.dep_tz === "America/New_York" && nh9.arr_tz === "Asia/Tokyo" && nh9.dep_utc === "2027-04-23T15:00:00Z");
check("Duration 14h25m / 6,730 mi", nh9.duration_min === 865 && nh9.distance_mi === 6730, `${nh9.duration_min} min, ${nh9.distance_mi} mi`);
check("Aircraft type + family", nh9.aircraft_type === "Boeing 777-300ER" && nh9.aircraft_family === "Boeing 777");
check("Only my seat kept (JOHN SMITH)", nh10.seat === "31C", nh10.seat);
check("Cost: booking total ÷ 2 passengers, split by distance", nh9.cash_cost === 621.6 && nh10.cash_cost === 621.6 && nh9.cash_currency === "USD", `${nh9.cash_cost} / ${nh10.cash_cost}`);
check("Upgrade seen on boarding pass: bought Economy, flew Business", nh9.purchased_class === "Economy" && nh9.flown_class === "Business" && nh9.seat === "7K", `${nh9.purchased_class} → ${nh9.flown_class}, seat ${nh9.seat}`);
check("NH10 not upgraded", nh10.purchased_class === "Economy" && nh10.flown_class === "Economy");

// Fill in the upgrade reason and the manual fields
let r = await call("PATCH", `/api/flights/${nh9.id}`, {
  upgrade_type: "mileage_upgrade", upgrade_points_cost: 25000, upgrade_cash_cost: 0, upgrade_cash_currency: "USD",
  aircraft_registration: "JA791A", aircraft_name: "Star Wars Jet", comments: "Great crew", seat_type: "window",
});
check("PATCH upgrade reason + manual fields", r.status === 200 && r.data.upgrade_type === "mileage_upgrade" && r.data.aircraft_registration === "JA791A");
r = await call("PATCH", `/api/flights/${nh9.id}`, { upgrade_type: "lucky" });
check("Upgrade type is validated", r.status === 400, JSON.stringify(r.data.error));
r = await call("PATCH", `/api/flights/${nh9.id}`, { flown_class: "biz" });
check("Class is validated", r.status === 400, JSON.stringify(r.data.error));
r = await call("PATCH", `/api/flights/${nh9.id}`, { dep_local: "tomorrow" });
check("Times are validated", r.status === 400);

// Re-forward the original booking: must not undo the upgrade, the seat or manual fields
await sendEmail("test/samples/01-booking-direct.eml");
nh9 = await byFlight("NH9");
check("Re-sent booking keeps flown class + reason", nh9.flown_class === "Business" && nh9.upgrade_type === "mileage_upgrade" && nh9.purchased_class === "Economy");
check("Re-sent (older) booking doesn't roll back the newer seat", nh9.seat === "7K", nh9.seat);
check("Re-sent booking keeps registration/comments", nh9.aircraft_registration === "JA791A" && nh9.comments === "Great crew");

// Op-down by hand on NH10
r = await call("PATCH", `/api/flights/${nh10.id}`, { purchased_class: "Business", flown_class: "Premium Economy", upgrade_type: "op_down" });
check("Op-down by hand", r.data.purchased_class === "Business" && r.data.flown_class === "Premium Economy" && r.data.upgrade_type === "op_down");
// Award cost by hand, then unlock
r = await call("PATCH", `/api/flights/${nh10.id}`, { fare_type: "award", points_cost: 55000, points_program: "ANA Mileage Club", cash_cost: 306.2 });
check("Manual award cost", r.data.points_cost === 55000 && r.data.cash_cost === 306.2);
await sendEmail("test/samples/01-booking-direct.eml");
check("Email doesn't overwrite manual cost", (await byFlight("NH10")).cash_cost === 306.2);
await call("PATCH", `/api/flights/${nh10.id}`, { unlock: ["cash_cost", "fare_type", "points_cost", "points_program"] });
await sendEmail("test/samples/01-booking-direct.eml");
const after = await byFlight("NH10");
check("Unlocked cost refilled from email", after.cash_cost === 621.6, `${after.cash_cost} ${after.fare_type}`);

// USD equivalents
check("USD cost auto-copied to cash_cost_usd", after.cash_currency === "USD" && after.cash_cost_usd === 621.6, `${after.cash_cost_usd}`);
r = await call("PATCH", `/api/flights/${nh10.id}`, { cash_cost: 700 });
check("USD cost edit follows into cash_cost_usd", r.data.cash_cost_usd === 700, `${r.data.cash_cost_usd}`);
r = await call("PATCH", `/api/flights/${nh10.id}`, { cash_currency: "EUR" });
check("Switching to a non-USD currency clears the stale USD value", r.data.cash_currency === "EUR" && r.data.cash_cost_usd === null, `${r.data.cash_cost_usd}`);
r = await call("PATCH", `/api/flights/${nh10.id}`, { cash_cost_usd: 760 });
check("Manual USD value on a non-USD cost", r.data.cash_cost_usd === 760 && r.data.manual_fields.includes("cash_cost_usd"));
r = await call("PATCH", `/api/flights/${nh10.id}`, { cash_cost: 650 });
check("Manual USD value kept when the cost changes", r.data.cash_cost === 650 && r.data.cash_cost_usd === 760, `${r.data.cash_cost_usd}`);
r = await call("PATCH", `/api/flights/${nh10.id}`, { unlock: ["cash_cost_usd"], cash_cost: 640 });
check("Unlocked USD value is cleared by the next cost change", r.data.cash_cost_usd === null, `${r.data.cash_cost_usd}`);
r = await call("PATCH", `/api/flights/${nh10.id}`, { upgrade_cash_cost: 80, upgrade_cash_currency: "USD" });
check("Upgrade USD cost auto-copied", r.data.upgrade_cash_cost_usd === 80, `${r.data.upgrade_cash_cost_usd}`);
r = await call("PATCH", `/api/flights/${nh10.id}`, { upgrade_cash_cost: 90, upgrade_cash_currency: "GBP" });
check("Upgrade cost in another currency clears USD", r.data.upgrade_cash_cost_usd === null, `${r.data.upgrade_cash_cost_usd}`);
{
  const mkc = (n, extra) => call("POST", "/api/flights", { carrier_code: "B6", flight_number: n, dep_airport: "JFK", dep_local: "2010-03-01T07:00", arr_airport: "PIT", airline: "JetBlue", fare_type: "cash", ...extra });
  const c1 = (await mkc("9001", { cash_cost: 100, cash_currency: "EUR", cash_cost_usd: 120 })).data;
  const c2 = (await mkc("9002", { cash_cost: 50, cash_currency: "USD" })).data;
  const c3 = (await mkc("9003", { cash_cost: 40, cash_currency: "JPY" })).data;
  const c4 = (await mkc("9004", { fare_type: "award", points_cost: 20000, cash_cost: 30, cash_currency: "USD" })).data;
  const c5 = (await mkc("9005", { cash_cost: 200, cash_currency: "USD", upgrade_cash_cost: 25, upgrade_cash_currency: "USD" })).data;
  const c6 = (await mkc("9006", { cash_cost: 10, cash_currency: "USD", upgrade_cash_cost: 500, upgrade_cash_currency: "JPY" })).data;
  const ser = (await call("GET", "/api/stats?year=2010")).data.series;
  const pt = ser.points.find((x) => x.key === "2010-03");
  check("Stats cash sums cash_cost_usd across currencies, incl. upgrades", ser.points.reduce((n, x) => n + x.cash_usd, 0) === 435, JSON.stringify(ser.points.map((x) => x.cash_usd)));
  check("Stats splits fares / award taxes / upgrades", pt.fare_usd === 380 && pt.award_usd === 30 && pt.upgrade_usd === 25 && pt.cash_usd === 435, JSON.stringify(pt));
  check("Stats excluded count = cost or upgrade without a USD value (once per flight)", ser.other_currency_flights === 2, `${ser.other_currency_flights}`);
  for (const c of [c1, c2, c3, c4, c5, c6]) await call("DELETE", `/api/flights/${c.id}`);
}

// Back-fill a past flight by hand
r = await call("POST", "/api/flights", {
  carrier_code: "B6", flight_number: "1001", dep_airport: "JFK", dep_local: "2025-08-01T07:05", arr_airport: "PIT", arr_local: "2025-08-01T08:52",
  airline: "JetBlue", aircraft_type: "Airbus A320", aircraft_registration: "N779JB", seat: "12B", purchased_class: "economy",
  fare_type: "cash", cash_cost: 189, cash_currency: "USD", comments: "Visiting Mom",
});
const hist = r.data;
check("POST manual flight with derived fields", r.status === 201 && hist.dep_offset === "-04:00" && hist.duration_min === 107 && hist.distance_mi === 339, `${r.status} ${hist?.dep_offset} ${hist?.duration_min} ${hist?.distance_mi}`);
check("Manual flight: family, class, seat type", hist.aircraft_family === "Airbus A320" && hist.flown_class === "Economy" && hist.seat_type === "middle", `${hist.aircraft_family} ${hist.flown_class} ${hist.seat_type}`);
r = await call("PATCH", `/api/flights/${hist.id}`, { seat: "12F" });
check("Seat change re-infers type (12F window)", r.data.seat_type === "window");
r = await call("PATCH", `/api/flights/${hist.id}`, { purchased_class: "Business" });
check("Flown class follows purchased class when not upgraded", r.data.flown_class === "Business");
r = await call("POST", "/api/flights", { carrier_code: "B6", flight_number: "1001", dep_airport: "JFK", dep_local: "2025-08-01T09:00", arr_airport: "PIT" });
check("Duplicate flight/date rejected", r.status === 409);

r = await call("GET", "/api/flights?past=1");
check("Filter past", r.data.length === 1 && r.data[0].flight === "B61001");
r = await call("GET", "/api/flights?upgraded=1");
check("Filter upgraded/downgraded", r.data.map((f) => f.flight).sort().join() === "NH10,NH9", r.data.map((f) => f.flight).join());

r = await call("DELETE", `/api/flights/${hist.id}`);
check("DELETE flight", r.status === 204 && (await call("GET", `/api/flights/${hist.id}`)).status === 404);

// ---- Pagination, sorting, search, year ----
// Add a second past flight pair for stats (JFK→PIT already exists on 2025-08-01 as B61001; delete first so the counts are exact).
const mk = (n, from, to, date, extra = {}) =>
  call("POST", "/api/flights", { carrier_code: "B6", flight_number: n, dep_airport: from, dep_local: `${date}T07:00`, arr_airport: to, airline: "JetBlue", ...extra });
r = await mk("2001", "JFK", "PIT", "2025-08-01", { aircraft_type: "Airbus A320", seat: "12F", purchased_class: "Economy" });
check("Create JFK→PIT", r.status === 201);
r = await mk("2002", "PIT", "JFK", "2025-08-05", { aircraft_type: "Airbus A320", seat: "14C" });
check("Create PIT→JFK", r.status === 201);
r = await call("GET", "/api/flights?page=1&per_page=2");
check("Paged shape", !Array.isArray(r.data) && r.data.flights.length === 2 && r.data.total === 5 && r.data.page === 1 && r.data.per_page === 2, JSON.stringify({ t: r.data.total, p: r.data.page, pp: r.data.per_page }));
check("Default sort is dep desc", r.data.flights[0].dep_date >= r.data.flights[1].dep_date && r.data.flights[0].dep_date.startsWith("2027"));
r = await call("GET", "/api/flights?page=2&per_page=2&sort=dep&dir=asc");
check("Page 2 asc", r.data.flights.length === 2 && r.data.flights[0].dep_date <= r.data.flights[1].dep_date && r.data.page === 2);
r = await call("GET", "/api/flights?page=1&sort=dep&dir=asc");
const dates = r.data.flights.map((f) => f.dep_date);
check("Sort dep asc ordered", dates.join() === [...dates].sort().join(), dates.join());
r = await call("GET", "/api/flights?page=1&sort=flight&dir=desc");
const fl = r.data.flights.map((f) => f.flight);
check("Sort flight desc ordered", fl.join() === [...fl].sort().reverse().join(), fl.join());
r = await call("GET", "/api/flights?page=1&sort=distance&dir=desc");
const di = r.data.flights.map((f) => f.distance_mi);
check("Sort distance desc", di.every((d, i) => i === 0 || d <= di[i - 1]), di.join());
check("Unknown sort -> 400", (await call("GET", "/api/flights?sort=id;drop")).status === 400);
check("Bad dir -> 400", (await call("GET", "/api/flights?sort=dep&dir=up")).status === 400);
check("Bad page -> 400", (await call("GET", "/api/flights?page=0")).status === 400);
r = await call("GET", "/api/flights?page=1&per_page=9999");
check("per_page capped at 200", r.data.per_page === 200);
r = await call("GET", "/api/flights?page=1");
check("per_page defaults to 25", r.data.per_page === 25);
r = await call("GET", "/api/flights?page=1&q=nh9");
check("q matches flight number case-insensitively", r.data.total === 1 && r.data.flights[0].flight === "NH9");
r = await call("GET", "/api/flights?page=1&q=pit");
check("q matches airport", r.data.total === 2, String(r.data.total));
r = await call("GET", "/api/flights?page=1&q=jetblue");
check("q matches airline", r.data.total === 2, String(r.data.total));
r = await call("GET", "/api/flights?page=1&q=%25");
check("q treats % literally", r.data.total === 0);
r = await call("GET", "/api/flights?page=1&year=2025");
check("year filter", r.data.total === 2 && r.data.flights.every((f) => f.dep_date.startsWith("2025")));
check("Bad year -> 400", (await call("GET", "/api/flights?year=abc")).status === 400);

// ---- Stats ----
r = await call("GET", "/api/stats");
const st = r.data;
check("Stats: flown counts only departed flights", r.status === 200 && st.flights === 2 && st.upcoming === 2 && st.year === null, `${st.flights} flown, ${st.upcoming} upcoming`);
check("Stats: years newest first", st.years[0] === 2027 && st.years.includes(2025), st.years.join());
check("Stats: miles (2 x 339)", st.miles === 339 * 2, String(st.miles));
const jp = st.routes.filter((x) => x.a === "JFK" && x.b === "PIT");
check("Stats: JFK→PIT and PIT→JFK merge into one route", st.routes.length === 1 && jp.length === 1 && jp[0].flights === 2 && jp[0].route === "JFK–PIT", JSON.stringify(st.routes));
check("Stats: airports", st.airports === 2);
check("Stats: top airports count departures + arrivals", st.top_airports.length === 2 && st.top_airports.every((a) => a.flights === 2) && st.top_airports[0].code === "JFK" && st.top_airports[1].code === "PIT"
  && st.top_airports[0].city === "New York" && !!st.top_airports[0].name, JSON.stringify(st.top_airports));
{ const all = (await call("GET", "/api/flights?page=1&per_page=100")).data.flights, now = new Date().toISOString();
  const jfk = all.filter((f) => !["cancelled", "replaced"].includes(f.status) && (f.dep_utc ?? f.dep_local) < now && (f.dep_airport === "JFK" || f.arr_airport === "JFK")).length;
  check("Stats: JFK airport count matches flown flights touching JFK", st.top_airports.find((a) => a.code === "JFK")?.flights === jfk, String(jfk)); }
check("Stats: airline name from most common text", st.airlines[0].key === "B6" && st.airlines[0].name === "JetBlue" && st.airlines[0].flights === 2, JSON.stringify(st.airlines));
check("Stats: airlines carry minutes, cash_usd, points", st.airlines.every((a) => ["minutes", "cash_usd", "points"].every((k) => typeof a[k] === "number")), JSON.stringify(st.airlines));
check("Stats: aircraft ranked by family", st.aircraft[0].family === "Airbus A320" && st.aircraft[0].flights === 2, JSON.stringify(st.aircraft));
check("Stats: family flights = variants + unspecified", st.aircraft.every((a) => a.flights === a.variants.reduce((n, v) => n + v.flights, 0) + a.unspecified)
  && st.aircraft[0].variants[0].type === "Airbus A320" && st.aircraft[0].variants[0].flights === 2 && st.aircraft[0].unspecified === 0, JSON.stringify(st.aircraft));
check("Stats: seat types sum to flights", Object.values(st.seat_types).reduce((a, b) => a + b, 0) === 2 && st.seat_types.window === 1 && st.seat_types.aisle === 1, JSON.stringify(st.seat_types));
check("Stats: cabins sum to flights", Object.values(st.cabins).reduce((a, b) => a + b, 0) === 2 && st.cabins.Economy === 1 && st.cabins.unknown === 1, JSON.stringify(st.cabins));
r = await call("GET", "/api/stats?year=2025");
check("Stats by year", r.data.year === 2025 && r.data.flights === 2 && r.data.upcoming === 0);
r = await call("GET", "/api/stats?year=2027");
check("Stats by year: upcoming only", r.data.flights === 0 && r.data.upcoming === 2 && r.data.routes.length === 0);
r = await call("GET", "/api/stats?year=2027&future=1");
check("Stats with future flights count them", r.data.include_future === true && r.data.flights === 2 && r.data.upcoming === 2 && r.data.routes.length > 0);
r = await call("GET", "/api/stats?future=1");
check("Stats with future flights, all time", r.data.flights === 4 && r.data.upcoming === 2, `${r.data.flights} flights`);
{
  const ser = st.series;
  const p25 = ser?.points.find((x) => x.key === "2025");
  check("Series: year unit, covers flown years only", ser?.unit === "year" && ser.points.length >= 1 && ser.points[0].key === "2025" && ser.points.at(-1).key <= String(new Date().getFullYear()), JSON.stringify(ser?.points.map((x) => x.key)));
  check("Series: 2025 flights/miles", p25?.flights === 2 && p25.miles === 339 * 2 && p25.airports === 2, JSON.stringify(p25));
  check("Series: totals match", ser.points.reduce((n, x) => n + x.flights, 0) === st.flights && ser.points.reduce((n, x) => n + x.miles, 0) === st.miles);
  check("Series: new_airports sums to all-time distinct airports", ser.points.reduce((n, x) => n + x.new_airports, 0) === st.airports, JSON.stringify(ser.points.map((x) => x.new_airports)));
  check("Series: premium_share null when empty, else 0-1", ser.points.every((x) => (x.flights ? x.premium_share >= 0 && x.premium_share <= 1 : x.premium_share === null)));
  check("Series: other_currency_flights is a number", typeof ser.other_currency_flights === "number");
  const m = (await call("GET", "/api/stats?year=2025")).data.series;
  check("Month series has 12 points", m.unit === "month" && m.points.length === 12 && m.points[0].key === "2025-01" && m.points[11].key === "2025-12", m.points.length + "");
  check("Month series sums to year", m.points.reduce((n, x) => n + x.flights, 0) === 2 && m.points.find((x) => x.key === "2025-08")?.flights === 2);
  check("Month new_airports sums to year's new airports", m.points.reduce((n, x) => n + x.new_airports, 0) === 2);
  const m27 = (await call("GET", "/api/stats?year=2027")).data.series;
  check("Month series for upcoming-only year is 12 zero points", m27.points.length === 12 && m27.points.every((x) => x.flights === 0 && x.premium_share === null));
}
check("Stats bad year -> 400", (await call("GET", "/api/stats?year=x")).status === 400);

// ---- Needs review ----
{
  const full = { carrier_code: "B6", confirmation_code: "ABC123", dep_airport: "JFK", arr_airport: "PIT", airline: "JetBlue", arr_local: "2026-02-01T08:50", aircraft_type: "Airbus A320", seat: "12F", purchased_class: "Economy", fare_type: "cash", cash_cost: 99, cash_currency: "USD" };
  const sparse = (await call("POST", "/api/flights", { carrier_code: "B6", flight_number: "3001", dep_airport: "JFK", dep_local: "2026-02-01T07:00", arr_airport: "PIT" })).data;
  const done = (await call("POST", "/api/flights", { ...full, flight_number: "3002", dep_local: "2026-02-02T07:00" })).data;
  const noNum = (await call("POST", "/api/flights", { ...full, flight_number: "", dep_local: "2026-02-03T07:00" })).data;
  const noCarrier = (await call("POST", "/api/flights", { ...full, carrier_code: "", flight_number: "3004", dep_local: "2026-02-04T07:00" })).data;
  const awardNoPts = (await call("POST", "/api/flights", { ...full, flight_number: "3005", dep_local: "2026-02-05T07:00", fare_type: "award", cash_cost: null })).data;
  const cancelled = (await call("POST", "/api/flights", { flight_number: "3006", dep_airport: "JFK", dep_local: "2026-02-06T07:00", arr_airport: "PIT", status: "cancelled" })).data;
  check("Review: sparse flight lists its missing groups", sparse.missing.join() === "confirmation,times,aircraft,seat,cabin,fare" && sparse.needs_review === true && sparse.review_ok.length === 0, sparse.missing?.join());
  check("Review: complete flight has nothing missing", done.missing.length === 0 && done.needs_review === false);
  check("Review: empty flight number / airline code / award without points", noNum.missing.join() === "flight_number" && noCarrier.missing.join() === "airline" && awardNoPts.missing.join() === "cost", [noNum.missing, noCarrier.missing, awardNoPts.missing].join(" | "));
  check("Review: cancelled flight reports missing but never needs review", cancelled.missing.length > 0 && cancelled.needs_review === false);
  check("review_ok is not a manual field", !sparse.manual_fields.includes("review_ok"));

  const all = (await call("GET", "/api/flights")).data;
  const expectIds = all.filter((f) => f.needs_review).map((f) => f.id).sort((a, b) => a - b);
  r = await call("GET", "/api/flights?review=1&page=1&per_page=200");
  check("review=1 SQL filter agrees with TS needs_review for every flight", r.data.flights.map((f) => f.id).sort((a, b) => a - b).join() === expectIds.join() && r.data.total === expectIds.length, `${r.data.total} vs ${expectIds.length}`);
  check("review=1 excludes complete and cancelled flights", !r.data.flights.some((f) => [done.id, cancelled.id].includes(f.id)) && r.data.flights.some((f) => f.id === sparse.id));
  check("review_count = flights needing review", r.data.review_count === expectIds.length);
  const pg = (await call("GET", "/api/flights?review=1&page=2&per_page=2&sort=dep&dir=asc")).data;
  check("review=1 pages and sorts", pg.total === expectIds.length && pg.flights.length === Math.min(2, Math.max(0, expectIds.length - 2)) && pg.page === 2);
  r = await call("GET", "/api/flights?page=1&review=1&q=3001");
  check("review=1 combines with q", r.data.total === 1 && r.data.flights[0].id === sparse.id);
  r = await call("GET", "/api/flights?page=1&q=3001");
  check("review_count ignores the review filter but not q", r.data.total === 1 && r.data.review_count === 1);
  r = await call("GET", "/api/flights?page=1&q=3002&review=1");
  check("review_count 0 when the matching flight is fine", r.data.total === 0 && r.data.review_count === 0);
  r = await call("GET", "/api/flights?page=1&year=2025&review=1");
  check("review=1 combines with year", r.data.flights.every((f) => f.dep_date.startsWith("2025")) && r.data.review_count === r.data.total);
  check("Stats: needs_review counts all live flights needing review", (await call("GET", "/api/stats?year=2025")).data.needs_review === expectIds.length);

  // Dismiss / reopen
  r = await call("PATCH", `/api/flights/${sparse.id}`, { review_ok: true });
  check("PATCH review_ok:true records the missing list", r.status === 200 && r.data.review_ok.join() === sparse.missing.join() && r.data.needs_review === false && r.data.missing.join() === sparse.missing.join(), JSON.stringify(r.data.review_ok));
  check("...and drops it from review=1", !(await call("GET", "/api/flights?review=1&page=1&per_page=200")).data.flights.some((f) => f.id === sparse.id));
  check("...and from the stats count", (await call("GET", "/api/stats")).data.needs_review === expectIds.length - 1);
  // A newly-missing group re-flags it
  r = await call("PATCH", `/api/flights/${sparse.id}`, { aircraft_type: "Airbus A320" });
  check("Filling a dismissed group keeps it dismissed", r.data.needs_review === false && !r.data.missing.includes("aircraft"));
  r = await call("PATCH", `/api/flights/${sparse.id}`, { aircraft_family: null, aircraft_type: null });
  check("Clearing aircraft again is still covered by the earlier dismissal", r.data.needs_review === false);
  r = await call("PATCH", `/api/flights/${done.id}`, { seat: "1A", review_ok: true });
  check("review_ok:true on a complete flight is an empty list", r.data.review_ok.length === 0 && r.data.needs_review === false);
  r = await call("PATCH", `/api/flights/${done.id}`, { seat: null, aircraft_family: null, aircraft_type: null });
  check("A group that goes missing after dismissal re-flags (aircraft+seat)", r.data.needs_review === true && r.data.missing.join() === "aircraft,seat", r.data.missing.join());
  r = await call("PATCH", `/api/flights/${done.id}`, { review_ok: true, seat: "2A" });
  check("review_ok with other edits: edits first, then missing computed", r.data.seat === "2A" && r.data.review_ok.join() === "aircraft" && r.data.needs_review === false, JSON.stringify(r.data.review_ok));
  r = await call("PATCH", `/api/flights/${done.id}`, { seat: null });
  check("Seat missing again after dismissing only aircraft -> flagged", r.data.needs_review === true && r.data.missing.join() === "aircraft,seat");
  r = await call("PATCH", `/api/flights/${done.id}`, { review_ok: false });
  check("PATCH review_ok:false reopens", r.data.review_ok.length === 0 && r.data.needs_review === true);
  check("review_ok must be boolean", (await call("PATCH", `/api/flights/${done.id}`, { review_ok: "yes" })).status === 400);
  r = await call("PATCH", `/api/flights/${cancelled.id}`, { review_ok: true });
  check("Cancelled flight stays out of review either way", r.status === 200 && r.data.needs_review === false);

  // Bulk
  const ids = [sparse.id, done.id, noNum.id];
  r = await call("POST", "/api/flights/review", { ids, ok: true });
  check("Bulk mark OK", r.status === 200 && r.data.updated === 3, JSON.stringify(r.data));
  const after3 = await Promise.all(ids.map(async (i) => (await call("GET", `/api/flights/${i}`)).data));
  check("Bulk OK: none need review, review_ok = missing", after3.every((f) => !f.needs_review && f.review_ok.join() === f.missing.join()));
  check("Bulk OK leaves other flights alone", (await call("GET", `/api/flights/${noCarrier.id}`)).data.needs_review === true);
  r = await call("POST", "/api/flights/review", { ids: [...ids, 999999], ok: false });
  check("Bulk reopen (unknown ids ignored)", r.data.updated === 3 && (await call("GET", `/api/flights/${noNum.id}`)).data.needs_review === true);
  check("Bulk validation", (await call("POST", "/api/flights/review", { ids: [], ok: true })).status === 400
    && (await call("POST", "/api/flights/review", { ids: [1], ok: "yes" })).status === 400
    && (await call("POST", "/api/flights/review", { ids: ["a"], ok: true })).status === 400
    && (await call("POST", "/api/flights/review", { ids: Array.from({ length: 501 }, (_, i) => i + 1), ok: true })).status === 400
    && (await call("POST", "/api/flights/review", { ok: true })).status === 400);
  r = await call("POST", "/api/flights/review", { ids: Array.from({ length: 500 }, (_, i) => i + 1), ok: false });
  check("Bulk accepts 500 ids", r.status === 200, JSON.stringify(r.data));
  r = await call("POST", "/api/flights/review", { ids: [sparse.id], ok: true });
  check("Bulk requires auth", (await fetch(API + "/api/flights/review", { method: "POST", body: "{}" })).status === 404 && r.status === 200);
  // Bulk SQL missing list agrees with the TS one for every flight
  const allIds = (await call("GET", "/api/flights")).data.map((f) => f.id);
  await call("POST", "/api/flights/review", { ids: allIds, ok: true });
  const every = (await call("GET", "/api/flights")).data;
  check("SQL missing list == TS missing list for every flight; none need review after bulk OK", every.every((f) => f.review_ok.join() === f.missing.join() && !f.needs_review), every.filter((f) => f.review_ok.join() !== f.missing.join()).map((f) => f.flight).join());
  check("review=1 is empty after OK-ing everything", (await call("GET", "/api/flights?review=1&page=1")).data.total === 0);

  // Per-group filter, counts and dismissal
  {
    const GROUPS = ["airline", "flight_number", "confirmation", "times", "aircraft", "seat", "cabin", "fare", "cost"];
    await call("POST", "/api/flights/review", { ids: allIds, ok: false });
    const flightsNow = (await call("GET", "/api/flights")).data;
    const todo = (f, g) => f.status !== "cancelled" && f.status !== "replaced" && f.missing.includes(g) && !f.review_ok.includes(g);
    const idsOf = (rows) => rows.map((f) => f.id).sort((a, b) => a - b).join();
    const page = async (qs) => (await call("GET", `/api/flights?page=1&per_page=200&${qs}`)).data;
    for (const g of GROUPS) {
      const d = await page(`missing=${g}`);
      check(`missing=${g} matches TS definition for every flight`, idsOf(d.flights) === idsOf(flightsNow.filter((f) => todo(f, g))) && d.total === d.flights.length, `${d.total}`);
    }
    const seatRows = (await page("missing=seat")).flights, fareRows = (await page("missing=fare")).flights;
    check("missing=seat only returns flights missing seat", seatRows.length > 0 && seatRows.every((f) => f.missing.includes("seat")));
    const both = await page("missing=seat,fare");
    check("missing=a,b is OR", idsOf(both.flights) === idsOf(flightsNow.filter((f) => todo(f, "seat") || todo(f, "fare"))) && both.total >= Math.max(seatRows.length, fareRows.length));
    check("missing= unknown group -> 400", (await call("GET", "/api/flights?page=1&missing=seat,bogus")).status === 400 && (await call("GET", "/api/flights?page=1&missing=")).status === 400);
    const counts = (await page("review=1")).review_group_counts;
    check("review_group_counts match a direct per-group count", GROUPS.every((g) => counts[g] === flightsNow.filter((f) => todo(f, g)).length), JSON.stringify(counts));
    check("review_group_counts ignore review/missing filters", JSON.stringify((await page("missing=seat")).review_group_counts) === JSON.stringify(counts));
    const q3001 = await page("q=3001");
    check("review_group_counts respect q", GROUPS.every((g) => q3001.review_group_counts[g] === (todo(sparse, g) ? 1 : 0)), JSON.stringify(q3001.review_group_counts));
    const pgd = await call("GET", "/api/flights?page=2&per_page=2&sort=dep&dir=asc&missing=seat");
    check("missing= pages and sorts", pgd.data.total === seatRows.length && pgd.data.flights.length === Math.min(2, Math.max(0, seatRows.length - 2)));

    // Dismiss one group on a flight missing seat and something else
    const target = seatRows.find((f) => f.missing.some((m) => m !== "seat"));
    r = await call("POST", "/api/flights/review", { ids: [target.id], ok: true, groups: ["seat", "airline"] });
    let t = (await call("GET", `/api/flights/${target.id}`)).data;
    check("Bulk groups: only those currently missing are dismissed", r.status === 200 && t.review_ok.join() === (target.missing.includes("airline") ? "seat,airline" : "seat") || t.review_ok.slice().sort().join() === ["airline", "seat"].filter((g) => target.missing.includes(g)).sort().join(), JSON.stringify(t.review_ok));
    check("...flight still needs review for another group and leaves the seat filter", t.needs_review === true && !(await page("missing=seat")).flights.some((f) => f.id === target.id));
    const other = target.missing.find((m) => m !== "seat" && m !== "airline");
    check("...but stays in the other group's filter", !other || (await page(`missing=${other}`)).flights.some((f) => f.id === target.id));
    check("...and counts drop by one", (await page("review=1")).review_group_counts.seat === counts.seat - 1);
    r = await call("POST", "/api/flights/review", { ids: [target.id], ok: false, groups: ["seat"] });
    t = (await call("GET", `/api/flights/${target.id}`)).data;
    check("Bulk ok=false with groups reopens just those", !t.review_ok.includes("seat") && t.review_ok.every((g) => g !== "seat") && (await page("missing=seat")).flights.some((f) => f.id === target.id));
    check("Bulk groups validated", (await call("POST", "/api/flights/review", { ids: [target.id], ok: true, groups: ["bogus"] })).status === 400
      && (await call("POST", "/api/flights/review", { ids: [target.id], ok: true, groups: "seat" })).status === 400);
    await call("POST", "/api/flights/review", { ids: [target.id], ok: false });
    r = await call("PATCH", `/api/flights/${target.id}`, { review_ok: ["seat", "cabin", "bogus"] });
    check("PATCH review_ok with unknown group -> 400", r.status === 400);
    r = await call("PATCH", `/api/flights/${target.id}`, { review_ok: ["seat", "cabin"] });
    check("PATCH review_ok array dismisses exactly those that are missing", r.status === 200 && r.data.review_ok.slice().sort().join() === ["seat", "cabin"].filter((g) => target.missing.includes(g)).sort().join(), JSON.stringify(r.data.review_ok));
    r = await call("PATCH", `/api/flights/${target.id}`, { review_ok: [] });
    check("PATCH review_ok [] clears", r.data.review_ok.length === 0);
    await call("POST", "/api/flights/review", { ids: allIds, ok: true });
  }

  // Replies to forwarded emails list the flights that still need review
  {
    const dir = ".wrangler/tmp/email";
    const replies = () => { try { return readdirSync(dir).flatMap((d) => { try { return readdirSync(`${dir}/${d}/reply`).map((f) => `${dir}/${d}/reply/${f}`); } catch { return []; } }); } catch { return []; } };
    await call("POST", "/api/flights/review", { ids: allIds, ok: false });
    const before = new Set(replies());
    await call("PATCH", `/api/flights/${(await byFlight("NH10")).id}`, { seat: null });
    await sendEmail("test/samples/00-booking-qq1234.eml");
    await new Promise((ok) => setTimeout(ok, 1500));
    const fresh = replies().filter((f) => !before.has(f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const eml = fresh.length ? readFileSync(fresh[0], "utf8") : "";
    const text = /base64/i.test(eml) ? Buffer.from(eml.split(/\r?\n\r?\n/).slice(1).join("").replace(/\s/g, ""), "base64").toString("utf8") : eml;
    const m = /Needs review \(missing data\):\r?\n((?:.+\r?\n)+)/.exec(text);
    check("Reply lists flights needing review with their missing fields", !!m && /[A-Z0-9]{3,7} [A-Z][a-z]{2} \d{1,2} .*: [a-z, #]+/.test(m[1]), m ? m[1].trim() : `no match: ${JSON.stringify(text.slice(-500))}`);
    check("Reply links to the review filter", /#\/flights\?review=1/.test(text));
    const em = (await call("GET", "/api/emails")).data.find((e) => e.status === "parsed" && e.email_type === "booking" && /QQ1234/.test(e.subject));
    r = await call("POST", `/api/emails/${em.id}/reparse`);
    check("Reparse response includes needs_review list", r.status === 200 && Array.isArray(r.data.needs_review) && r.data.needs_review.length > 0 && r.data.needs_review.every((x) => x.flight && x.date && Array.isArray(x.missing) && x.missing.length), JSON.stringify(r.data));
  }
  for (const f of [sparse, done, noNum, noCarrier, awardNoPts, cancelled]) await call("DELETE", `/api/flights/${f.id}`);
}

// ---- Auth endpoints ----
const raw = async (method, path, body, headers = {}) => {
  const res = await fetch(API + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, data, res };
};
r = await raw("GET", "/auth/me");
check("/auth/me unauthenticated", r.status === 200 && r.data.authenticated === false && r.data.has_passkeys === false, JSON.stringify(r.data));
check("register/options without token -> 401", (await raw("POST", "/auth/register/options", {})).status === 401);
check("register/options with bad token -> 401", (await raw("POST", "/auth/register/options", { setup_token: "nope" })).status === 401);
r = await raw("POST", "/auth/register/options", { setup_token: process.env.TOKEN });
check("register/options with setup_token", r.status === 200 && typeof r.data.challenge === "string" && r.data.rp.id === process.env.RP_ID && r.data.authenticatorSelection.residentKey === "required", JSON.stringify(r.data).slice(0, 120));
check("register/verify without token -> 401", (await raw("POST", "/auth/register/verify", { response: {} })).status === 401);
const forged = { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge: r.data.challenge, origin: "https://evil.example", type: "webauthn.create" })).toString("base64url"), attestationObject: "AA" }, clientExtensionResults: {} };
check("register/verify rejects a bogus attestation", (await raw("POST", "/auth/register/verify", { setup_token: process.env.TOKEN, response: forged })).status === 400);
check("...and the challenge is single use", (await raw("POST", "/auth/register/verify", { setup_token: process.env.TOKEN, response: forged })).data.error === "Invalid or expired challenge");
r = await raw("POST", "/auth/login/options", {});
check("login/options", r.status === 200 && typeof r.data.challenge === "string" && (r.data.allowCredentials ?? []).length === 0 && r.data.rpId === process.env.RP_ID);
const loginChal = r.data.challenge;
const bogusLogin = { id: "nosuchcred", rawId: "x", type: "public-key", response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge: loginChal, origin: process.env.ORIGIN, type: "webauthn.get" })).toString("base64url"), authenticatorData: "AA", signature: "AA" }, clientExtensionResults: {} };
check("login/verify unknown credential -> 401", (await raw("POST", "/auth/login/verify", { response: bogusLogin })).status === 401);
check("login/verify garbage -> 401", (await raw("POST", "/auth/login/verify", { response: {} })).status === 401);
check("cookie-less /api is 404", (await raw("GET", "/api/flights")).status === 404 && (await raw("GET", "/api/stats")).status === 404);
check("old root paths are gone", (await call("GET", "/flights")).status !== 200);

// ---- Seat prompt replies (a prompt row is planted in D1, as the 30-minute cron would) ----
const sqlq = (q) => execFileSync("npx", ["wrangler", "d1", "execute", "flight-memory", "--local", "--config", "wrangler.e2e.toml", "--command", q], { stdio: "pipe" });
sqlq(`INSERT INTO seat_prompts (flight_id, message_id) VALUES (${nh10.id}, '<seat-test@example.com>')`);
const sendReplyMail = async (id, body) => {
  const q = new URLSearchParams({ from: process.env.FROM, to: process.env.TO });
  const mime = `From: ${process.env.FROM}\r\nTo: ${process.env.TO}\r\nSubject: Re: Seat on NH10?\r\nMessage-ID: <${id}@example.com>\r\nIn-Reply-To: <seat-test@example.com>\r\nReferences: <seat-test@example.com>\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;
  await fetch(`${API}/cdn-cgi/handler/email?${q}`, { method: "POST", body: mime, headers: { "content-type": "message/rfc822" } });
};
await sendReplyMail("seat-reply-1", "22F\r\n\r\n> Seat on file: 31C");
let seatFlight = await byFlight("NH10");
check("Seat prompt reply sets the seat", seatFlight.seat === "22F", seatFlight.seat);
await sendReplyMail("seat-reply-2", "ok");
seatFlight = await byFlight("NH10");
check("'ok' keeps the seat", seatFlight.seat === "22F");
await sendReplyMail("seat-reply-3", "what?");
seatFlight = await byFlight("NH10");
check("Unintelligible reply changes nothing", seatFlight.seat === "22F");
await sendEmail("test/samples/03-checkin-one-seat.eml");
seatFlight = await byFlight("NH10");
check("Seat from a prompt reply survives later emails", seatFlight.seat === "22F", seatFlight.seat);

// ---- Sessions (a session row is planted in D1, as a successful passkey login would) ----
const sid = randomBytes(32).toString("hex");
const sql = (q) => execFileSync("npx", ["wrangler", "d1", "execute", "flight-memory", "--local", "--config", "wrangler.e2e.toml", "--command", q], { stdio: "pipe" });
sql(`INSERT INTO sessions (id_hash, created_at, expires_at) VALUES ('${createHash("sha256").update(sid).digest("hex")}', '2026-01-01T00:00:00Z', '2999-01-01T00:00:00Z')`);
const ck = { cookie: `fm_session=${sid}` };
check("Session cookie opens /api", (await raw("GET", "/api/flights", undefined, ck)).status === 200);
check("Raw session id is not stored", JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "flight-memory", "--local", "--config", "wrangler.e2e.toml", "--json", "--command", `SELECT COUNT(*) AS n FROM sessions WHERE id_hash = '${sid}'`], { stdio: "pipe" }).toString())[0].results[0].n === 0);
r = await raw("GET", "/auth/me", undefined, ck);
check("/auth/me with session", r.data.authenticated === true);
check("Forged session id -> 404", (await raw("GET", "/api/flights", undefined, { cookie: `fm_session=${"0".repeat(64)}` })).status === 404);
r = await raw("POST", "/api/flights", { flight_number: "7", dep_airport: "JFK", dep_local: "2031-01-01T10:00", arr_airport: "PIT" }, ck);
check("CSRF: cookie POST without Origin -> 403", r.status === 403, JSON.stringify(r.data));
r = await raw("POST", "/api/flights", { flight_number: "7", dep_airport: "JFK", dep_local: "2031-01-01T10:00", arr_airport: "PIT" }, { ...ck, origin: "https://evil.example" });
check("CSRF: cookie POST with foreign Origin -> 403", r.status === 403);
r = await raw("POST", "/api/flights", { flight_number: "7", dep_airport: "JFK", dep_local: "2031-01-01T10:00", arr_airport: "PIT" }, { ...ck, origin: process.env.ORIGIN });
check("Cookie POST with right Origin ok", r.status === 201, r.status + JSON.stringify(r.data));
if (r.data?.id) await raw("DELETE", `/api/flights/${r.data.id}`, undefined, { ...ck, origin: process.env.ORIGIN });
check("Bearer mutations need no Origin", (await call("POST", "/api/flights", { flight_number: "7", dep_airport: "JFK", dep_local: "2031-01-01T10:00", arr_airport: "PIT" })).status === 201);
r = await raw("POST", "/auth/register/options", {}, { ...ck, origin: process.env.ORIGIN });
check("Session can start adding a passkey", r.status === 200, r.status + JSON.stringify(r.data));
r = await raw("POST", "/auth/register/options", {}, ck);
check("...but not cross-origin", r.status === 401);
r = await raw("POST", "/auth/logout", undefined, { ...ck, origin: process.env.ORIGIN });
const sc = r.res.headers.get("set-cookie") ?? "";
check("Logout clears the cookie", r.status === 204 && /fm_session=;/.test(sc) && /Max-Age=0/.test(sc) && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && !/Secure/.test(sc), r.status + sc);
check("Session is dead after logout", (await raw("GET", "/api/flights", undefined, ck)).status === 404);

console.log(failures ? `\n${failures} check(s) failed` : "\nall API checks passed");
process.exit(failures ? 1 : 0);
