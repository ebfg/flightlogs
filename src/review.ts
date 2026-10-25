// "Needs review": which field groups of a flight are empty. Defined once here, as both a TS
// predicate (for API output) and SQL (for filtering, counting and bulk dismissal), so they can't drift.
// Cancelled / replaced flights never need review. Groups the user marked OK (review_ok) are ignored.

type Row = Record<string, unknown>;
const empty = (v: unknown) => v === null || v === undefined;
// Seats are often only assigned at check-in, so a future flight without one isn't missing anything yet.
const departed = (f: Row) => String(f.dep_utc ?? f.dep_date ?? "") <= new Date().toISOString();
const DEPARTED_SQL = "COALESCE(dep_utc, dep_date) <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

interface Group { name: string; missing: (f: Row) => boolean; sql: string }

export const REVIEW_GROUPS: readonly Group[] = [
  { name: "airline", missing: (f) => f.carrier_code === "", sql: "carrier_code = ''" },
  { name: "flight_number", missing: (f) => f.flight_number === "", sql: "flight_number = ''" },
  { name: "confirmation", missing: (f) => empty(f.confirmation_code) || f.confirmation_code === "", sql: "(confirmation_code IS NULL OR confirmation_code = '')" },
  { name: "times", missing: (f) => empty(f.arr_local), sql: "arr_local IS NULL" },
  { name: "aircraft", missing: (f) => empty(f.aircraft_family) && empty(f.aircraft_type), sql: "(aircraft_family IS NULL AND aircraft_type IS NULL)" },
  { name: "seat", missing: (f) => empty(f.seat) && departed(f), sql: `(seat IS NULL AND ${DEPARTED_SQL})` },
  { name: "cabin", missing: (f) => empty(f.purchased_class) && empty(f.flown_class), sql: "(purchased_class IS NULL AND flown_class IS NULL)" },
  { name: "fare", missing: (f) => empty(f.fare_type), sql: "fare_type IS NULL" },
  {
    name: "cost",
    missing: (f) => (f.fare_type === "award" && empty(f.points_cost)) || (f.fare_type === "cash" && empty(f.cash_cost)),
    sql: "((fare_type = 'award' AND points_cost IS NULL) OR (fare_type = 'cash' AND cash_cost IS NULL))",
  },
];

export const REVIEW_LABELS: Record<string, string> = {
  airline: "Airline", flight_number: "Flight #", confirmation: "Conf #", times: "Times", aircraft: "Aircraft", seat: "Seat", cabin: "Cabin", fare: "Fare", cost: "Cost",
};

export interface ReviewItem { id: number; flight: string; date: string; route: string; missing: string[] }

export const isLive = (status: unknown) => status !== "cancelled" && status !== "replaced";
export const LIVE_SQL = "status NOT IN ('cancelled', 'replaced')";

export const missingGroups = (f: object): string[] => REVIEW_GROUPS.filter((g) => g.missing(f as Row)).map((g) => g.name);

export function parseReviewOk(json: unknown): string[] {
  try {
    const v = JSON.parse(String(json ?? "[]"));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function reviewInfo(f: object) {
  const missing = missingGroups(f);
  const review_ok = parseReviewOk((f as Row).review_ok);
  return { missing, review_ok, needs_review: isLive((f as Row).status) && missing.some((m) => !review_ok.includes(m)) };
}

/** SQL boolean: live flight with some missing group the user hasn't marked OK. */
export const NEEDS_REVIEW_SQL = `(${LIVE_SQL} AND (${REVIEW_GROUPS.map(
  (g) => `(${g.sql} AND '${g.name}' NOT IN (SELECT value FROM json_each(review_ok)))`,
).join(" OR ")}))`;

/** Validates a list of group names. Returns the names, or null if it isn't an array of known groups. */
export function parseGroups(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && REVIEW_GROUPS.some((g) => g.name === x))) return null;
  return [...new Set(v as string[])];
}

/** SQL boolean: live flight missing at least one of these groups (and not dismissed). Names must be validated first. */
export const needsReviewForGroupsSql = (groups: string[]) =>
  `(${LIVE_SQL} AND (${REVIEW_GROUPS.filter((g) => groups.includes(g.name)).map(
    (g) => `(${g.sql} AND '${g.name}' NOT IN (SELECT value FROM json_each(review_ok)))`,
  ).join(" OR ") || "0"}))`;

/** SQL select list: one count column per group (live, missing, not dismissed). */
export const GROUP_COUNTS_SQL = REVIEW_GROUPS.map(
  (g) => `COALESCE(SUM(${LIVE_SQL} AND ${g.sql} AND '${g.name}' NOT IN (SELECT value FROM json_each(review_ok))), 0) AS ${g.name}`,
).join(", ");

/** SQL expression: JSON array of the flight's currently missing group names. */
export const MISSING_JSON_SQL = `(SELECT json_group_array(value) FROM json_each(json_array(${REVIEW_GROUPS.map(
  (g) => `CASE WHEN ${g.sql} THEN '${g.name}' END`,
).join(", ")})) WHERE value IS NOT NULL)`;

/** Of these flights, the live ones that still need review, with the (un-dismissed) missing groups as labels. */
export async function flightsNeedingReview(db: D1Database, ids: number[]): Promise<ReviewItem[]> {
  if (!ids.length) return [];
  const { results } = await db
    .prepare(`SELECT * FROM flights WHERE id IN (SELECT value FROM json_each(?1)) AND ${NEEDS_REVIEW_SQL} ORDER BY COALESCE(dep_utc, dep_local), id`)
    .bind(JSON.stringify(ids))
    .all<Row>();
  return results.map((f) => {
    const { missing, review_ok } = reviewInfo(f);
    return {
      id: f.id as number, flight: `${f.carrier_code}${f.flight_number}`, date: String(f.dep_date), route: `${f.dep_airport}→${f.arr_airport}`,
      missing: missing.filter((m) => !review_ok.includes(m)).map((m) => REVIEW_LABELS[m] ?? m),
    };
  });
}
