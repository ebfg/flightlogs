import {
  deriveFlight, emptyFlight, FLIGHT_COLS, manualSet, mergeRow, splitPrinted, type FlightRow,
} from "./enrich";
import { airport, distanceMiles } from "./geo";
import { isMe, pickMe } from "./normalize";
import { flightsNeedingReview, type ReviewItem } from "./review";
import type { EmailType, ExtractedEmail, ParseResult, Passenger, PdfAttachment, Reservation, Seat, Segment } from "./types";

export const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const MAX_HTML = 300_000;
const MAX_TEXT = 100_000;

type Row = Record<string, unknown>;

export async function insertFlight(db: D1Database, row: FlightRow): Promise<number> {
  const sql = `INSERT INTO flights (${FLIGHT_COLS.join(", ")}) VALUES (${FLIGHT_COLS.map((_, i) => `?${i + 1}`).join(", ")}) RETURNING id`;
  const res = await db.prepare(sql).bind(...FLIGHT_COLS.map((c) => row[c] ?? null)).first<{ id: number }>();
  return res!.id;
}

export async function updateFlight(db: D1Database, id: number, row: FlightRow): Promise<void> {
  const sets = FLIGHT_COLS.map((c, i) => `${c} = ?${i + 1}`).join(", ");
  await db
    .prepare(`UPDATE flights SET ${sets}, updated_at = ${NOW} WHERE id = ?${FLIGHT_COLS.length + 1}`)
    .bind(...FLIGHT_COLS.map((c) => row[c] ?? null), id)
    .run();
}

// ---------------------------------------------------------------- emails

export async function recordEmail(
  db: D1Database, e: ExtractedEmail, envelopeFrom: string, status: string, keepBodies: boolean,
): Promise<number> {
  // A rejected sender must never clobber a stored message (it could reuse a real Message-ID).
  const row = await db
    .prepare(
      `INSERT INTO emails (message_id, envelope_from, header_from, subject, sent_at, status, text_body, html_body)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(message_id) DO UPDATE SET
         status = excluded.status, received_at = ${NOW}, error = NULL,
         text_body = excluded.text_body, html_body = excluded.html_body
       WHERE excluded.status != 'rejected' OR emails.status = 'rejected'
       RETURNING id`,
    )
    .bind(
      e.messageId, envelopeFrom, e.from, e.subject, e.originalDate ?? e.date, status,
      keepBodies ? e.text.slice(0, MAX_TEXT) : e.text.slice(0, 5_000),
      keepBodies && e.html.length <= MAX_HTML ? e.html : null,
    )
    .first<{ id: number }>();
  if (row) return row.id;
  // Conflict was skipped by the WHERE above: keep the existing row and return its id.
  const kept = await db.prepare(`SELECT id FROM emails WHERE message_id = ?1`).bind(e.messageId).first<{ id: number }>();
  return kept!.id;
}

// D1 caps a row at 2 MB; larger PDFs are still parsed on arrival, just not kept for /reparse.
const MAX_STORED_PDF = 1_900_000;

/** Keep an email's PDFs so /reparse can send them to Claude again. Replaces any already stored. */
export async function saveAttachments(db: D1Database, emailId: number, pdfs: PdfAttachment[]): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM email_attachments WHERE email_id = ?1`).bind(emailId),
    ...pdfs
      .filter((p) => p.data.byteLength <= MAX_STORED_PDF)
      .map((p) =>
        db.prepare(`INSERT INTO email_attachments (email_id, filename, content_type, data) VALUES (?1, ?2, 'application/pdf', ?3)`)
          .bind(emailId, p.filename, p.data),
      ),
  ]);
}

export async function loadAttachments(db: D1Database, emailId: number): Promise<PdfAttachment[]> {
  const { results } = await db
    .prepare(`SELECT filename, data FROM email_attachments WHERE email_id = ?1 ORDER BY id`)
    .bind(emailId)
    .all<{ filename: string | null; data: ArrayBuffer | number[] }>();
  return results.map((r) => ({ filename: r.filename, data: new Uint8Array(r.data) }));
}

export async function setEmailStatus(
  db: D1Database, id: number,
  f: { status: string; email_type?: string | null; parse_method?: string | null; error?: string | null },
): Promise<void> {
  await db
    .prepare(`UPDATE emails SET status = ?2, email_type = ?3, parse_method = ?4, error = ?5 WHERE id = ?1`)
    .bind(id, f.status, f.email_type ?? null, f.parse_method ?? null, f.error ?? null)
    .run();
}

// ---------------------------------------------------------------- picking out "my" part of a booking

/** Your seat/class on a flight, from a list that may cover several passengers. */
export function mySeat(seats: Seat[] | undefined, passengers: Passenger[], myName?: string): Seat | null {
  if (!seats?.length) return null;
  if (myName && passengers.length && !passengers.some((p) => isMe(p.name, myName, true))) return null;
  const mine = pickMe(seats, (s) => s.passenger, myName);
  if (mine) return mine;
  if (passengers.length <= 1) return seats.find((s) => !s.passenger || passengers.length === 1) ?? null;
  return null;
}

/** Your share of a booking's cost, split across its flights by distance (evenly if unknown). */
export function costShares(r: Reservation): Array<{ points: number | null; cash: number | null }> {
  const n = r.segments.length;
  const pax = r.cost_is_per_passenger ? 1 : Math.max(1, r.passengers.length);
  const miles = r.segments.map((s) => {
    const a = airport(s.dep_airport), b = airport(s.arr_airport);
    return a && b ? distanceMiles(a, b) : 0;
  });
  const total = miles.reduce((x, y) => x + y, 0);
  const weights = miles.every((m) => m > 0) ? miles.map((m) => m / total) : miles.map(() => 1 / n);

  const split = (amount: number | null | undefined, decimals: number): Array<number | null> => {
    if (amount == null) return weights.map(() => null);
    const f = 10 ** decimals;
    const mine = amount / pax;
    const parts = weights.map((w) => Math.floor(mine * w * f) / f);
    parts[n - 1] = Math.round((mine - parts.slice(0, -1).reduce((x, y) => x + y, 0)) * f) / f;
    return parts;
  };
  const pts = split(r.points_cost, 0);
  const cash = split(r.cash_cost, 2);
  return weights.map((_, i) => ({ points: pts[i], cash: cash[i] }));
}

interface IngestContext {
  emailId: number | null;
  /** When the confirmation was sent; an email older than the last one applied only fills gaps. */
  sentAt?: string | null;
  emailType: EmailType;
  myName?: string;
}

/** splitPrinted, after normalising variants the extractor lets through: "+09", "11:00 +09:00", "…+09:00[Asia/Tokyo]". */
export function splitTime(raw: string | null | undefined): { local: string | null; offset: string | null } {
  const t = raw?.trim()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/\s+(?=Z$|[+-]\d{2})/, "")
    .replace(/([+-]\d{2})$/, "$1:00");
  return splitPrinted(t);
}

/** Returns null (skipped) when the departure time can't be understood. */
async function upsertFlightFromEmail(
  db: D1Database, r: Reservation, s: Segment, share: { points: number | null; cash: number | null }, ctx: IngestContext,
): Promise<number | null> {
  const dep = splitTime(s.dep_time);
  const arr = splitTime(s.arr_time);
  if (!dep.local) return null;
  const depLocal = dep.local;
  const carrier = s.carrier_code ?? "";
  const existing = await db
    .prepare(`SELECT * FROM flights WHERE carrier_code = ?1 AND flight_number = ?2 AND dep_date = ?3 AND dep_airport = ?4`)
    .bind(carrier, s.flight_number, depLocal.slice(0, 10), s.dep_airport)
    .first<FlightRow & { id: number }>();
  const manual = manualSet(existing?.manual_fields);

  // Re-forwarding an old email shouldn't roll back newer info (e.g. a seat change).
  let stale = false;
  if (existing?.last_email_id && ctx.sentAt) {
    const last = await db.prepare(`SELECT sent_at FROM emails WHERE id = ?1`).bind(existing.last_email_id).first<{ sent_at: string | null }>();
    const a = Date.parse(ctx.sentAt), b = Date.parse(last?.sent_at ?? "");
    stale = Number.isFinite(a) && Number.isFinite(b) && a < b;
  }

  // Classes: the first class we see is what was bought; a later, different one is what was flown.
  const seat = mySeat(s.seats, r.passengers, ctx.myName);
  const cabin = seat?.travel_class ?? s.cabin ?? null;
  let flownEvidence = s.upgraded_to ?? (s.upgrade_type ? cabin : null);
  const purchasedCandidate = flownEvidence && cabin === flownEvidence ? null : cabin;
  const setPurchased = !existing?.purchased_class || ctx.emailType === "change";
  if (!setPurchased && purchasedCandidate && purchasedCandidate !== existing!.purchased_class) {
    flownEvidence ??= purchasedCandidate;
  }

  // A newer booking-type email revives a flight that was replaced or cancelled.
  const reactivates = existing?.status === "replaced" ||
    (existing?.status === "cancelled" && ["booking", "change", "checkin", "upgrade"].includes(ctx.emailType));

  const hasCost = share.points != null || share.cash != null;
  const incoming: Partial<FlightRow> = {
    carrier_code: carrier, flight_number: s.flight_number, airline: s.carrier_name ?? r.airline_name ?? null,
    operating_carrier: s.operating_carrier ?? null, confirmation_code: r.confirmation_code, booked_via: r.booked_via ?? null,
    status: s.status ?? (reactivates ? "confirmed" : undefined),
    dep_airport: s.dep_airport, dep_local: depLocal, arr_airport: s.arr_airport, arr_local: arr.local,
    aircraft_raw: s.aircraft ?? null,
    seat: seat?.seat ?? null,
    purchased_class: setPurchased ? purchasedCandidate : null,
    flown_class: flownEvidence,
    upgrade_type: s.upgrade_type ?? null,
    upgrade_points_cost: s.upgrade_points_cost ?? null,
    upgrade_cash_cost: s.upgrade_cash_cost ?? null,
    upgrade_cash_currency: s.upgrade_cash_currency ?? null,
    fare_type: hasCost ? (r.fare_type ?? null) : null,
    points_cost: share.points,
    points_program: hasCost ? (r.points_program ?? null) : null,
    cash_cost: share.cash,
    cash_currency: share.cash != null ? (r.cash_currency ?? null) : null,
    last_email_id: ctx.emailId,
  };
  const base = existing ?? emptyFlight({ carrier_code: carrier, flight_number: s.flight_number, dep_airport: s.dep_airport, dep_local: depLocal, arr_airport: s.arr_airport });
  if (stale) {
    // Only fill what's still empty; keep the newer email as the source of record. Cost is the
    // exception: it only ever comes from booking/receipt emails, so re-forwarding one should apply it.
    const COST = new Set(["fare_type", "points_cost", "points_program", "cash_cost", "cash_currency"]);
    for (const k of Object.keys(incoming) as (keyof FlightRow)[]) {
      if (!COST.has(k) && base[k] != null && base[k] !== "") delete incoming[k];
    }
    delete incoming.last_email_id;
  }
  const merged = mergeRow(base, incoming, manual);
  const row = deriveFlight(merged, manual, { depOffset: dep.offset, arrOffset: arr.offset, previous: existing });
  row.manual_fields = JSON.stringify([...manual]);

  const id = existing ? (await updateFlight(db, existing.id, row), existing.id) : await insertFlight(db, row);
  if (ctx.emailId) {
    await db.prepare(`INSERT OR IGNORE INTO email_flights (email_id, flight_id) VALUES (?1, ?2)`).bind(ctx.emailId, id).run();
  }
  return id;
}

/** Write a parse result. Returns a summary per booking plus any warnings for the reply. */
export async function saveResult(
  db: D1Database, emailId: number | null, result: ParseResult, opts: { myName?: string; sentAt?: string | null } = {},
): Promise<{ lines: string[]; warnings: string[]; needsReview: ReviewItem[] }> {
  const lines: string[] = [];
  const touched: number[] = [];
  const warnings: string[] = [];
  const ctx: IngestContext = { emailId, emailType: result.email_type, myName: opts.myName, sentAt: opts.sentAt };

  for (const r of result.reservations) {
    if (opts.myName && r.passengers.length && !r.passengers.some((p) => isMe(p.name, opts.myName, true))) {
      warnings.push(`${r.confirmation_code}: none of the passengers (${r.passengers.map((p) => p.name).join(", ")}) matched MY_NAME, so seat and class were left empty.`);
    }
    if (!opts.myName && r.passengers.length > 1) {
      warnings.push(`${r.confirmation_code}: several passengers and MY_NAME isn't set, so seat and class were left empty.`);
    }

    if (r.status === "cancelled" && r.segments.length === 0) {
      // Airlines reuse codes: only touch flights that haven't departed as of the email (a day's slack for time zones).
      const asOf = Number.isFinite(Date.parse(ctx.sentAt ?? "")) ? new Date(ctx.sentAt!).toISOString() : new Date().toISOString();
      await db
        .prepare(
          `UPDATE flights SET status = 'cancelled', updated_at = ${NOW}
           WHERE confirmation_code = ?1 AND dep_date >= date(?2, '-1 day') AND manual_fields NOT LIKE '%"status"%'`,
        )
        .bind(r.confirmation_code, asOf)
        .run();
      lines.push(`${r.confirmation_code}: cancelled`);
      continue;
    }

    const shares = costShares(r);
    const ids: number[] = [];
    for (let i = 0; i < r.segments.length; i++) {
      const id = await upsertFlightFromEmail(db, r, r.segments[i], shares[i], ctx);
      if (id != null) ids.push(id);
      else warnings.push(`${r.confirmation_code}: skipped ${r.segments[i].carrier_code ?? ""}${r.segments[i].flight_number}, unreadable departure time "${r.segments[i].dep_time}".`);
    }

    touched.push(...ids);
    if (r.is_full_itinerary && ids.length) {
      await db
        .prepare(
          `UPDATE flights SET status = 'replaced', updated_at = ${NOW}
           WHERE confirmation_code = ?1 AND status NOT IN ('cancelled', 'replaced')
             AND manual_fields NOT LIKE '%"status"%' AND id NOT IN (SELECT value FROM json_each(?2))
             AND carrier_code IN (SELECT carrier_code FROM flights WHERE id IN (SELECT value FROM json_each(?2)))
             AND dep_date BETWEEN (SELECT date(min(dep_date), '-30 day') FROM flights WHERE id IN (SELECT value FROM json_each(?2)))
                              AND (SELECT date(max(dep_date), '+30 day') FROM flights WHERE id IN (SELECT value FROM json_each(?2)))`,
        )
        .bind(r.confirmation_code, JSON.stringify(ids))
        .run();
    }
    const { results } = await db
      .prepare(`SELECT * FROM flights WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY dep_utc, dep_local`)
      .bind(JSON.stringify(ids))
      .all<FlightRow>();
    lines.push(`${r.confirmation_code}${r.airline_name ? ` · ${r.airline_name}` : ""}\n${results.map(describeFlight).join("\n")}`);
  }
  return { lines, warnings, needsReview: await flightsNeedingReview(db, touched) };
}

// ---------------------------------------------------------------- formatting

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtLocal(local: string, withYear = true): string {
  const [y, m, d] = local.slice(0, 10).split("-").map(Number);
  const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dow} ${d} ${MON[m - 1]}${withYear ? ` ${y}` : ""} ${local.slice(11, 16)}`;
}

export const fmtDuration = (min: number | null) => (min == null ? null : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m`);

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });

const usdNote = (cur: string | null, usd: number | null | undefined) =>
  cur !== "USD" && usd != null ? ` (≈ $${Math.round(usd).toLocaleString("en-US")} USD)` : "";

export function fmtCost(f: Pick<FlightRow, "fare_type" | "points_cost" | "points_program" | "cash_cost" | "cash_currency" | "cash_cost_usd">): string | null {
  const parts: string[] = [];
  if (f.points_cost) parts.push(`${f.points_cost.toLocaleString("en-US")} pts${f.points_program ? ` (${f.points_program})` : ""}`);
  if (f.cash_cost != null) parts.push(`${money(f.cash_cost)} ${f.cash_currency ?? ""}`.trim() + usdNote(f.cash_currency, f.cash_cost_usd));
  return parts.length ? `${f.fare_type ?? "paid"} ${parts.join(" + ")}` : null;
}

export function describeFlight(f: FlightRow): string {
  const when = `${fmtLocal(f.dep_local)}${f.dep_offset ? ` (${f.dep_offset})` : ""}` +
    (f.arr_local ? ` → ${fmtLocal(f.arr_local, false)}${f.arr_offset ? ` (${f.arr_offset})` : ""}` : "");
  const cls = f.flown_class && f.purchased_class && f.flown_class !== f.purchased_class
    ? `${f.purchased_class} → ${f.flown_class}${f.upgrade_type ? ` (${f.upgrade_type.replace(/_/g, " ")})` : " (reason not set)"}`
    : f.flown_class ?? f.purchased_class;
  const facts = [
    fmtDuration(f.duration_min), f.distance_mi != null ? `${f.distance_mi.toLocaleString("en-US")} mi` : null,
    f.aircraft_type ?? f.aircraft_family,
    f.seat ? `seat ${f.seat}${f.seat_type ? ` (${f.seat_type})` : ""}` : null, cls, fmtCost(f),
  ].filter(Boolean).join(" · ");
  const status = f.status !== "confirmed" ? `  [${f.status}]` : "";
  return `  ${f.carrier_code ? f.carrier_code + " " : ""}${f.flight_number}  ${f.dep_airport}→${f.arr_airport}  ${when}${status}` +
    (facts ? `\n     ${facts}` : "");
}

export type { Row };
