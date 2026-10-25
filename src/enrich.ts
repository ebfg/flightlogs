// Derived fields. Anything listed in a row's manual_fields is left exactly as typed.
import { familyForType, inferSeatType, normalizeAircraft } from "./aircraft";
import { airport, distanceMiles, resolveTime } from "./geo";

export interface FlightRow {
  id?: number;
  carrier_code: string;
  flight_number: string;
  airline: string | null;
  operating_carrier: string | null;
  confirmation_code: string | null;
  booked_via: string | null;
  status: string;
  dep_airport: string;
  dep_local: string;
  dep_tz: string | null;
  dep_offset: string | null;
  dep_utc: string | null;
  dep_date: string;
  arr_airport: string;
  arr_local: string | null;
  arr_tz: string | null;
  arr_offset: string | null;
  arr_utc: string | null;
  duration_min: number | null;
  distance_mi: number | null;
  aircraft_raw: string | null;
  aircraft_family: string | null;
  aircraft_type: string | null;
  aircraft_registration: string | null;
  aircraft_name: string | null;
  seat: string | null;
  seat_type: string | null;
  purchased_class: string | null;
  flown_class: string | null;
  upgrade_type: string | null;
  upgrade_points_cost: number | null;
  upgrade_cash_cost: number | null;
  upgrade_cash_currency: string | null;
  upgrade_cash_cost_usd: number | null;
  fare_type: string | null;
  points_cost: number | null;
  points_program: string | null;
  cash_cost: number | null;
  cash_currency: string | null;
  cash_cost_usd: number | null;
  comments: string | null;
  manual_fields: string;
  last_email_id: number | null;
}

export const FLIGHT_COLS = [
  "carrier_code", "flight_number", "airline", "operating_carrier", "confirmation_code", "booked_via", "status",
  "dep_airport", "dep_local", "dep_tz", "dep_offset", "dep_utc", "dep_date",
  "arr_airport", "arr_local", "arr_tz", "arr_offset", "arr_utc", "duration_min", "distance_mi",
  "aircraft_raw", "aircraft_family", "aircraft_type", "aircraft_registration", "aircraft_name",
  "seat", "seat_type", "purchased_class", "flown_class", "upgrade_type",
  "upgrade_points_cost", "upgrade_cash_cost", "upgrade_cash_currency", "upgrade_cash_cost_usd",
  "fare_type", "points_cost", "points_program", "cash_cost", "cash_currency", "cash_cost_usd",
  "comments", "manual_fields", "last_email_id",
] as const satisfies readonly (keyof FlightRow)[];

export function emptyFlight(init: Pick<FlightRow, "carrier_code" | "flight_number" | "dep_airport" | "dep_local" | "arr_airport">): FlightRow {
  const row = Object.fromEntries(FLIGHT_COLS.map((c) => [c, null])) as unknown as FlightRow;
  return { ...row, ...init, dep_date: init.dep_local.slice(0, 10), status: "confirmed", manual_fields: "[]" };
}

export const manualSet = (json: string | null | undefined): Set<string> => {
  try {
    return new Set(JSON.parse(json ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

/** Copy non-empty incoming values onto base, skipping fields set by hand. */
export function mergeRow<T extends object>(base: T, incoming: Partial<T>, manual: Set<string>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== undefined && v !== null && v !== "" && !manual.has(k)) out[k] = v;
  }
  return out as T;
}

function addDays(local: string, days: number): string {
  const d = new Date(`${local}:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 16);
}

export interface DeriveHints {
  depOffset?: string | null;
  arrOffset?: string | null;
  /** The row as it was before this change, so flown_class can keep following purchased_class. */
  previous?: FlightRow | null;
}

/** Fill time zones, UTC times, duration, distance, aircraft type/family, seat type and flown class. */
export function deriveFlight(row: FlightRow, manual: Set<string>, hints: DeriveHints = {}): FlightRow {
  const r = { ...row };
  const depAp = airport(r.dep_airport);
  const arrAp = airport(r.arr_airport);
  if (!manual.has("dep_tz")) r.dep_tz = depAp?.tz ?? r.dep_tz;
  if (!manual.has("arr_tz")) r.arr_tz = arrAp?.tz ?? r.arr_tz;

  // A hand-typed offset wins; then the airport's zone; then an offset printed in the email.
  const resolve = (local: string, tz: string | null, field: "dep_offset" | "arr_offset", hint?: string | null) => {
    const forced = manual.has(field) ? r[field] : tz ? null : (hint ?? null);
    return forced ? resolveTime(local + forced, null) : resolveTime(local, tz);
  };

  const dep = resolve(r.dep_local, r.dep_tz, "dep_offset", hints.depOffset);
  r.dep_date = r.dep_local.slice(0, 10);
  if (!manual.has("dep_offset")) r.dep_offset = dep?.offset ?? null;
  r.dep_utc = dep?.utc ?? null;

  let arr = r.arr_local ? resolve(r.arr_local, r.arr_tz, "arr_offset", hints.arrOffset) : null;
  // "Arrives 06:10" printed without a next-day marker: roll forward until after departure.
  if (arr?.utcMs != null && dep?.utcMs != null && arr.utcMs <= dep.utcMs && !manual.has("arr_local")) {
    for (let i = 1; i <= 2 && arr && arr.utcMs! <= dep.utcMs; i++) {
      r.arr_local = addDays(r.arr_local!, 1);
      arr = resolve(r.arr_local, r.arr_tz, "arr_offset", null);
    }
  }
  if (!manual.has("arr_offset")) r.arr_offset = arr?.offset ?? null;
  r.arr_utc = arr?.utc ?? null;

  if (!manual.has("duration_min")) {
    const mins = arr?.utcMs != null && dep?.utcMs != null ? Math.round((arr.utcMs - dep.utcMs) / 60000) : null;
    r.duration_min = mins !== null && mins > 0 && mins < 24 * 60 ? mins : null;
  }
  if (!manual.has("distance_mi")) r.distance_mi = depAp && arrAp ? distanceMiles(depAp, arrAp) : r.distance_mi;

  if (r.aircraft_raw) {
    const n = normalizeAircraft(r.aircraft_raw);
    if (!manual.has("aircraft_type") && n.type) r.aircraft_type = n.type;
    if (!manual.has("aircraft_family") && n.family) r.aircraft_family = n.family;
  }
  if (!manual.has("aircraft_family") && r.aircraft_type) {
    r.aircraft_family = familyForType(r.aircraft_type) ?? r.aircraft_family;
  }

  // Flown class follows purchased class until something says otherwise.
  const prev = hints.previous;
  if (!manual.has("flown_class")) {
    const wasFollowing = !prev || !prev.flown_class || prev.flown_class === prev.purchased_class;
    if (!r.flown_class || (wasFollowing && r.flown_class === prev?.flown_class)) r.flown_class = r.purchased_class;
  }
  // An upgrade reason that was filled in automatically doesn't survive the classes matching again.
  if (!manual.has("upgrade_type") && r.flown_class && r.flown_class === r.purchased_class) r.upgrade_type = null;

  // USD equivalent: copied when the cost is in USD, dropped when a non-USD cost or currency changed under it.
  for (const [cost, cur, usd] of [["cash_cost", "cash_currency", "cash_cost_usd"], ["upgrade_cash_cost", "upgrade_cash_currency", "upgrade_cash_cost_usd"]] as const) {
    if (manual.has(usd)) continue;
    if (r[cur] === "USD") r[usd] = r[cost];
    else if (prev && (r[cost] !== prev[cost] || r[cur] !== prev[cur])) r[usd] = null;
  }

  if (!manual.has("seat_type")) r.seat_type = inferSeatType(r.seat, r.aircraft_family, r.flown_class) ?? (r.seat ? null : r.seat_type);
  return r;
}

/** Split an email's time ("2027-04-23T11:00:00-04:00") into local wall time and printed offset. */
export function splitPrinted(raw: string | null | undefined): { local: string | null; offset: string | null } {
  if (!raw) return { local: null, offset: null };
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(raw.trim());
  if (!m) return { local: null, offset: null };
  const off = m[2] ? (m[2] === "Z" ? "+00:00" : m[2].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")) : null;
  return { local: m[1], offset: off };
}
