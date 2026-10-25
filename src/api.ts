// Small JSON API over your flights. Every field you set by hand is "locked": later emails
// and auto-derivation leave it alone until you send {"unlock": ["field", ...]}.
import { describeFlight, insertFlight, loadAttachments, setEmailStatus, updateFlight } from "./db";
import { normalizeClass } from "./aircraft";
import { deriveFlight, emptyFlight, manualSet, type FlightRow } from "./enrich";
import { airport } from "./geo";
import { GROUP_COUNTS_SQL, MISSING_JSON_SQL, NEEDS_REVIEW_SQL, needsReviewForGroupsSql, parseGroups, REVIEW_GROUPS, reviewInfo } from "./review";
import { processStored } from "./pipeline";
import { computeStats } from "./stats";
import { UPGRADE_TYPES, type Env, type ExtractedEmail } from "./types";

type Row = Record<string, any>;
type Kind =
  | "text" | "iata" | "local" | "tz" | "offset" | "int" | "num" | "carrier" | "flightno" | "currency" | "seat" | "class"
  | { oneOf: readonly string[] };
interface Spec { kind: Kind; required?: boolean }

const CLASSES = ["Economy", "Premium Economy", "Business", "First"];

const FIELDS: Record<string, Spec> = {
  carrier_code: { kind: "carrier" }, flight_number: { kind: "flightno" },
  airline: { kind: "text" }, operating_carrier: { kind: "text" }, confirmation_code: { kind: "text" }, booked_via: { kind: "text" },
  status: { kind: { oneOf: ["confirmed", "pending", "changed", "cancelled", "replaced"] }, required: true },
  dep_airport: { kind: "iata", required: true }, arr_airport: { kind: "iata", required: true },
  dep_local: { kind: "local", required: true }, arr_local: { kind: "local" },
  dep_tz: { kind: "tz" }, arr_tz: { kind: "tz" }, dep_offset: { kind: "offset" }, arr_offset: { kind: "offset" },
  duration_min: { kind: "int" }, distance_mi: { kind: "int" },
  aircraft_family: { kind: "text" }, aircraft_type: { kind: "text" }, aircraft_registration: { kind: "text" }, aircraft_name: { kind: "text" },
  seat: { kind: "seat" }, seat_type: { kind: { oneOf: ["window", "middle", "aisle"] } },
  purchased_class: { kind: "class" }, flown_class: { kind: "class" },
  upgrade_type: { kind: { oneOf: UPGRADE_TYPES } },
  upgrade_points_cost: { kind: "int" }, upgrade_cash_cost: { kind: "num" }, upgrade_cash_currency: { kind: "currency" },
  upgrade_cash_cost_usd: { kind: "num" },
  fare_type: { kind: { oneOf: ["cash", "award"] } }, points_cost: { kind: "int" }, points_program: { kind: "text" },
  cash_cost: { kind: "num" }, cash_currency: { kind: "currency" }, cash_cost_usd: { kind: "num" },
  comments: { kind: "text" },
};

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function check(field: string, spec: Spec, v: unknown): { value: unknown } | { error: string } {
  if (v === null || v === "") {
    // Codes are NOT NULL columns: empty means unknown (old flights often have no flight number).
    return spec.required ? { error: `${field} can't be empty` } : { value: field === "carrier_code" || field === "flight_number" ? "" : null };
  }
  const k = spec.kind;
  const s = typeof v === "string" ? v.trim() : v;
  const bad = (what: string) => ({ error: `${field}: expected ${what}` });
  if (typeof k === "object") return typeof s === "string" && k.oneOf.includes(s) ? { value: s } : bad(k.oneOf.join(" | "));
  switch (k) {
    case "text": return typeof s === "string" && s.length <= 4000 ? { value: s } : bad("text");
    case "iata": return typeof s === "string" && /^[A-Za-z]{3}$/.test(s) ? { value: s.toUpperCase() } : bad("3-letter IATA code");
    case "local": return typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? { value: s } : bad("YYYY-MM-DDTHH:MM (local time)");
    case "tz": return typeof s === "string" && validTz(s) ? { value: s } : bad("IANA time zone, e.g. Asia/Tokyo");
    case "offset": return typeof s === "string" && /^[+-]\d{2}:\d{2}$/.test(s) ? { value: s } : bad("offset like +09:00");
    case "int": return Number.isInteger(s) && (s as number) >= 0 ? { value: s } : bad("whole number");
    case "num": return typeof s === "number" && s >= 0 ? { value: s } : bad("number");
    case "carrier": return typeof s === "string" && /^[A-Za-z0-9]{2}$/.test(s) ? { value: s.toUpperCase() } : bad("2-character airline code");
    case "flightno": {
      const t = String(s).trim().toUpperCase().replace(/^0+(?=\d)/, "");
      return /^\d{1,4}[A-Z]?$/.test(t) ? { value: t } : bad("flight number digits, e.g. 9");
    }
    case "currency": return typeof s === "string" && /^[A-Za-z]{3}$/.test(s) ? { value: s.toUpperCase() } : bad("ISO currency, e.g. USD");
    case "seat": {
      const t = typeof s === "string" ? s.replace(/\s/g, "").toUpperCase().replace(/^0+(?=\d)/, "") : "";
      return /^\d{1,3}[A-Z]$/.test(t) ? { value: t } : bad("seat like 23A");
    }
    case "class": {
      const c = typeof s === "string" ? normalizeClass(s) : null;
      return c && CLASSES.includes(c) ? { value: c } : bad(CLASSES.join(" | "));
    }
  }
}

/** Apply a body to a row; set fields become manual, "unlock" releases them. */
function applyEdits(row: FlightRow, body: Row): { row: FlightRow; manual: Set<string>; errors: string[] } {
  const out = { ...row } as Row;
  const manual = manualSet(row.manual_fields);
  const errors: string[] = [];
  for (const [field, v] of Object.entries(body)) {
    if (field === "unlock") continue;
    const spec = FIELDS[field];
    if (!spec) { errors.push(`${field} isn't editable`); continue; }
    const r = check(field, spec, v);
    if ("error" in r) errors.push(r.error);
    else { out[field] = r.value; manual.add(field); }
  }
  for (const f of Array.isArray(body.unlock) ? body.unlock : []) manual.delete(String(f));
  out.manual_fields = JSON.stringify([...manual]);
  return { row: out as FlightRow, manual, errors };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (msg: string | string[], status = 400) => json({ error: msg }, status);
const isUniqueError = (e: unknown) => /UNIQUE constraint/i.test(String((e as Error)?.message ?? e));

async function readBody(req: Request): Promise<Row | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Row) : null;
  } catch {
    return null;
  }
}

const airportInfo = (iata: string) => {
  const a = airport(iata);
  return a ? { name: a.name, city: a.city, country: a.country } : null;
};

type DbFlight = FlightRow & { id: number; review_ok?: string };

function present(f: DbFlight): Row {
  return {
    ...f,
    ...reviewInfo(f),
    flight: `${f.carrier_code}${f.flight_number}`,
    manual_fields: JSON.parse(f.manual_fields),
    dep_airport_info: airportInfo(f.dep_airport),
    arr_airport_info: airportInfo(f.arr_airport),
  };
}

async function getFlight(env: Env, id: number) {
  return env.DB.prepare(`SELECT * FROM flights WHERE id = ?1`).bind(id).first<DbFlight>();
}

async function patchFlight(env: Env, id: number, body: Row): Promise<Response> {
  const before = await getFlight(env, id);
  if (!before) return fail("No such flight", 404);
  const { review_ok: reviewOk, ...edits } = body;
  const okGroups = Array.isArray(reviewOk) ? parseGroups(reviewOk) : null;
  if (reviewOk !== undefined && typeof reviewOk !== "boolean" && !okGroups) return fail(`review_ok: expected true, false or a list of groups (${REVIEW_GROUPS.map((g) => g.name).join(", ")})`);
  if (Object.keys(edits).length) {
    const { row, manual, errors } = applyEdits(before, edits);
    if (errors.length) return fail(errors);
    const derived = deriveFlight(row, manual, { previous: before });
    derived.manual_fields = JSON.stringify([...manual]);
    try {
      await updateFlight(env.DB, id, derived);
    } catch (e) {
      if (isUniqueError(e)) return fail("You already have that flight number on that date", 409);
      throw e;
    }
  }
  // After the other edits, so "OK" covers whatever is still missing now.
  if (reviewOk !== undefined) await setReviewOk(env, [id], okGroups ? true : (reviewOk as boolean), okGroups ?? undefined, !!okGroups);
  return json(present((await getFlight(env, id))!));
}

/**
 * review_ok = the current missing list (ok) or [] (reopen). Returns how many flights exist among ids.
 * With groups: ok adds those that are currently missing (replace=false) or sets exactly missing-and-in-groups
 * (replace=true); !ok removes just those groups.
 */
async function setReviewOk(env: Env, ids: number[], ok: boolean, groups?: string[], replace = false): Promise<number> {
  const idsJson = JSON.stringify(ids);
  if (!groups) {
    const r = await env.DB.prepare(
      `UPDATE flights SET review_ok = ${ok ? MISSING_JSON_SQL : "'[]'"} WHERE id IN (SELECT value FROM json_each(?1))`,
    ).bind(idsJson).run();
    return r.meta.changes;
  }
  const inGroups = "value IN (SELECT value FROM json_each(?2))";
  const expr = !ok
    ? `(SELECT json_group_array(value) FROM json_each(review_ok) WHERE NOT ${inGroups})`
    : replace
      ? `(SELECT json_group_array(value) FROM json_each(${MISSING_JSON_SQL}) WHERE ${inGroups})`
      : `(SELECT json_group_array(value) FROM (SELECT value FROM json_each(review_ok) UNION SELECT value FROM json_each(${MISSING_JSON_SQL}) WHERE ${inGroups}))`;
  const r = await env.DB.prepare(`UPDATE flights SET review_ok = ${expr} WHERE id IN (SELECT value FROM json_each(?1))`)
    .bind(idsJson, JSON.stringify(groups)).run();
  return r.meta.changes;
}

async function reviewBulk(env: Env, body: Row): Promise<Response> {
  const { ids, ok } = body;
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every((i) => Number.isInteger(i) && i > 0)) {
    return fail("ids: expected 1-500 flight ids");
  }
  if (typeof ok !== "boolean") return fail("ok: expected true or false");
  let groups: string[] | undefined;
  if (body.groups !== undefined) {
    const g = parseGroups(body.groups);
    if (!g) return fail(`groups: expected a list of ${REVIEW_GROUPS.map((x) => x.name).join(" | ")}`);
    groups = g;
  }
  return json({ updated: await setReviewOk(env, ids, ok, groups) });
}

async function createFlight(env: Env, body: Row): Promise<Response> {
  const missing = ["dep_airport", "dep_local", "arr_airport"].filter((k) => body[k] == null);
  if (missing.length) return fail(`Required: ${missing.join(", ")}`);
  const seed = emptyFlight({ carrier_code: "", flight_number: "", dep_airport: "XXX", dep_local: "2000-01-01T00:00", arr_airport: "XXX" });
  const { row, manual, errors } = applyEdits(seed, body);
  if (errors.length) return fail(errors);
  // Facts you typed are locked; the identifying fields don't need to be.
  for (const k of ["carrier_code", "flight_number", "dep_airport", "arr_airport", "dep_local"]) manual.delete(k);
  const derived = deriveFlight(row, manual);
  derived.manual_fields = JSON.stringify([...manual]);
  try {
    const id = await insertFlight(env.DB, derived);
    return json(present((await getFlight(env, id))!), 201);
  } catch (e) {
    if (isUniqueError(e)) return fail("You already have that flight number on that date", 409);
    throw e;
  }
}

async function reparseEmail(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare(`SELECT * FROM emails WHERE id = ?1`).bind(id).first<Row>();
  if (!row) return fail("No such email", 404);
  if (row.status === "rejected") return fail("Rejected emails aren't parsed");
  const e: ExtractedEmail = {
    messageId: row.message_id, outerFrom: row.envelope_from, from: row.header_from, subject: row.subject ?? "",
    date: row.sent_at, html: row.html_body ?? "", text: row.text_body ?? "", forwardedAsAttachment: false,
    pdfs: await loadAttachments(env.DB, row.id),
  };
  try {
    const { result, lines, warnings, needsReview } = await processStored(env, row.id, e);
    return json({ email_type: result.email_type, method: result.method, saved: lines, warnings, needs_review: needsReview });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setEmailStatus(env.DB, row.id, { status: "failed", error: msg.slice(0, 1000) });
    return fail(msg, 500);
  }
}

const DEP = "COALESCE(dep_utc, dep_local)";
/** ORDER BY expressions, whitelisted: user input only ever selects a key, never reaches the SQL text. */
const SORTS: Record<string, string> = {
  dep: DEP,
  flight: "carrier_code || flight_number",
  route: "dep_airport || arr_airport",
  airline: "airline COLLATE NOCASE",
  aircraft: "COALESCE(aircraft_type, aircraft_family) COLLATE NOCASE",
  seat: "seat",
  class: "flown_class",
  distance: "distance_mi",
  duration: "duration_min",
};

async function listFlights(env: Env, url: URL): Promise<Response> {
  const q = url.searchParams;
  const conds = ["status != 'replaced'"];
  const binds: unknown[] = [];
  const add = (sql: string, v: unknown) => { binds.push(v); conds.push(sql.replaceAll("?", `?${binds.length}`)); };
  if (q.get("upcoming") === "1") add("dep_date >= ?", new Date(Date.now() - 864e5).toISOString().slice(0, 10));
  if (q.get("past") === "1") add("dep_date < ?", new Date().toISOString().slice(0, 10));
  if (q.get("from")) add("dep_date >= ?", q.get("from"));
  if (q.get("to")) add("dep_date <= ?", q.get("to"));
  if (q.get("confirmation")) add("confirmation_code = ?", q.get("confirmation")!.toUpperCase());
  if (q.get("upgraded") === "1") conds.push("flown_class IS NOT purchased_class AND flown_class IS NOT NULL AND purchased_class IS NOT NULL");
  const year = q.get("year");
  if (year) {
    if (!/^\d{4}$/.test(year)) return fail("year: expected YYYY");
    add("substr(dep_date, 1, 4) = ?", year);
  }
  let missingGroups: string[] | null = null;
  if (q.has("missing")) {
    missingGroups = parseGroups(q.get("missing")!.split(",").filter(Boolean));
    if (!missingGroups?.length) return fail(`missing: expected a comma-separated list of ${REVIEW_GROUPS.map((g) => g.name).join(" | ")}`);
  }
  const review = q.get("review") === "1";
  const text = q.get("q")?.trim().toLowerCase();
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
    binds.push(like);
    const n = `?${binds.length}`;
    conds.push("(" + [
      "carrier_code || flight_number", "carrier_code || ' ' || flight_number", "dep_airport", "arr_airport", "airline",
      "confirmation_code", "aircraft_type", "aircraft_family",
    ].map((c) => `lower(COALESCE(${c}, '')) LIKE ${n} ESCAPE '\\'`).join(" OR ") + ")");
  }

  const paged = q.has("page");
  const sort = q.get("sort");
  if (sort !== null && !(sort in SORTS)) return fail(`sort: expected ${Object.keys(SORTS).join(" | ")}`);
  const dirParam = q.get("dir");
  if (dirParam !== null && dirParam !== "asc" && dirParam !== "desc") return fail("dir: expected asc | desc");
  const key = sort ?? "dep";
  // Default: newest first for dep (and for the paged view), otherwise ascending. The legacy unpaged list stays ascending.
  const dir = dirParam ?? (key === "dep" && (paged || sort !== null) ? "desc" : "asc");
  const expr = SORTS[key];
  const order = `ORDER BY (${expr}) IS NULL, ${expr} ${dir === "desc" ? "DESC" : "ASC"}, id ${dir === "desc" ? "DESC" : "ASC"}`;
  const otherWhere = conds.join(" AND ");
  const where = missingGroups ? `${otherWhere} AND ${needsReviewForGroupsSql(missingGroups)}` : review ? `${otherWhere} AND ${NEEDS_REVIEW_SQL}` : otherWhere;

  if (!paged) {
    const { results } = await env.DB.prepare(`SELECT * FROM flights WHERE ${where} ${order}`).bind(...binds).all<DbFlight>();
    return json(results.map(present));
  }
  const page = Number(q.get("page"));
  if (!Number.isInteger(page) || page < 1) return fail("page: expected a whole number >= 1");
  const pp = q.has("per_page") ? Number(q.get("per_page")) : 25;
  if (!Number.isInteger(pp) || pp < 1) return fail("per_page: expected a whole number >= 1");
  const perPage = Math.min(pp, 200);
  const [rows, count, reviewCount, groupCounts] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM flights WHERE ${where} ${order} LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`).bind(...binds),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM flights WHERE ${where}`).bind(...binds),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM flights WHERE ${otherWhere} AND ${NEEDS_REVIEW_SQL}`).bind(...binds),
    env.DB.prepare(`SELECT ${GROUP_COUNTS_SQL} FROM flights WHERE ${otherWhere}`).bind(...binds),
  ]);
  return json({
    flights: (rows.results as DbFlight[]).map(present),
    total: (count.results[0] as { n: number }).n, page, per_page: perPage,
    review_count: (reviewCount.results[0] as { n: number }).n,
    review_group_counts: groupCounts.results[0],
  });
}

export async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const idMatch = /^\/api\/flights\/(\d+)$/.exec(path);
  const id = idMatch ? Number(idMatch[1]) : null;

  if (req.method === "GET" && path === "/api/flights") return listFlights(env, url);
  if (req.method === "GET" && path === "/api/stats") {
    const y = url.searchParams.get("year");
    if (y && !/^\d{4}$/.test(y)) return fail("year: expected YYYY");
    const [stats, nr] = await Promise.all([
      computeStats(env.DB, y ? Number(y) : null, url.searchParams.get("future") === "1"),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM flights WHERE ${NEEDS_REVIEW_SQL}`).first<{ n: number }>(),
    ]);
    return json({ ...stats, needs_review: nr?.n ?? 0 });
  }
  if (req.method === "GET" && id) {
    const f = await getFlight(env, id);
    return f ? json({ ...present(f), summary: describeFlight(f) }) : fail("No such flight", 404);
  }
  if (req.method === "GET" && path === "/api/emails") {
    const { results } = await env.DB.prepare(
      `SELECT id, received_at, envelope_from, header_from, subject, status, email_type, parse_method, error
       FROM emails ORDER BY id DESC LIMIT 100`,
    ).all();
    return json(results);
  }
  const reparse = /^\/api\/emails\/(\d+)\/reparse$/.exec(path);
  if (req.method === "POST" && reparse) return reparseEmail(env, Number(reparse[1]));

  if (req.method === "PATCH" && id) {
    const body = await readBody(req);
    return body ? patchFlight(env, id, body) : fail("Send a JSON object body");
  }
  if (req.method === "POST" && path === "/api/flights/review") {
    const body = await readBody(req);
    return body ? reviewBulk(env, body) : fail("Send a JSON object body");
  }
  if (req.method === "POST" && path === "/api/flights") {
    const body = await readBody(req);
    return body ? createFlight(env, body) : fail("Send a JSON object body");
  }
  if (req.method === "DELETE" && id) {
    const r = await env.DB.prepare(`DELETE FROM flights WHERE id = ?1`).bind(id).run();
    return r.meta.changes ? new Response(null, { status: 204 }) : fail("No such flight", 404);
  }
  return fail("Not found", 404);
}
