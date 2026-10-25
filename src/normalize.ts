import { normalizeClass } from "./aircraft";
import { UPGRADE_TYPES, type Passenger, type Reservation, type Seat, type Segment, type Status, type UpgradeType } from "./types";

const TITLES = /\b(MR|MRS|MS|MISS|MSTR|MASTER|DR|PROF|MX|CHD|INF)\.?$/;

/** "SMITH/JOHN MR" or "John  Smith" → "JOHN SMITH" so the same traveller matches across emails. */
export function normalizeName(raw: string): string {
  let s = raw.toUpperCase().replace(/\s+/g, " ").trim();
  if (s.includes("/")) {
    const [last, first = ""] = s.split("/", 2);
    s = `${stripTitles(first)} ${last.trim()}`.trim();
  }
  return stripTitles(s).replace(/^(MR|MRS|MS|MISS|DR)\.? /, "");
}

function stripTitles(s: string): string {
  let prev = "";
  s = s.trim();
  while (prev !== s) {
    prev = s;
    s = s.replace(TITLES, "").trim();
  }
  return s;
}

/** Split "NH9", "NH 0009", "9" (+ carrier "NH") into carrier + number. */
export function splitFlightNumber(
  flight: string | number | null | undefined,
  carrierHint?: string | null,
): { carrier: string; number: string } | null {
  if (flight == null) return null;
  const s = String(flight).toUpperCase().replace(/[\s-]+/g, "");
  const hint = carrierHint?.toUpperCase().trim() || "";
  if (hint && s.startsWith(hint) && /^\d/.test(s.slice(hint.length))) {
    return { carrier: hint, number: stripZeros(s.slice(hint.length)) };
  }
  const m = /^([A-Z]{2}|[A-Z]\d|\d[A-Z])(\d{1,4}[A-Z]?)$/.exec(s);
  if (m && !/^\d+$/.test(s)) return { carrier: hint || m[1], number: stripZeros(m[2]) };
  if (/^\d{1,4}[A-Z]?$/.test(s)) return { carrier: hint, number: stripZeros(s) };
  return null;
}

function stripZeros(n: string): string {
  return n.replace(/^0+(?=\d)/, "");
}

export function normalizeStatus(s: unknown): Status | null {
  if (typeof s !== "string") return null;
  const v = s.toLowerCase();
  if (v.includes("cancel")) return "cancelled";
  if (v.includes("pending") || v.includes("hold")) return "pending";
  if (v.includes("change") || v.includes("modif")) return "changed";
  if (v.includes("confirm")) return "confirmed";
  return null;
}

const IATA = /^[A-Z]{3}$/;
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Tidy a segment; returns null if it lacks what we need to store it. */
export function cleanSegment(seg: Segment): Segment | null {
  const split = splitFlightNumber(seg.flight_number, seg.carrier_code);
  const dep = seg.dep_airport?.toUpperCase().trim();
  const arr = seg.arr_airport?.toUpperCase().trim();
  if (!split || !dep || !arr || !IATA.test(dep) || !IATA.test(arr)) return null;
  if (!seg.dep_time || !ISO_LOCAL.test(seg.dep_time)) return null;
  const seats: Seat[] = (seg.seats ?? [])
    .filter((x) => x && (x.seat || x.travel_class))
    .map((x) => ({
      passenger: x.passenger ? normalizeName(x.passenger) : null,
      seat: x.seat ? x.seat.toUpperCase().replace(/\s+/g, "").replace(/^0+(?=\d)/, "") : null,
      travel_class: normalizeClass(x.travel_class),
    }));
  return {
    ...seg,
    carrier_code: split.carrier || null,
    flight_number: split.number,
    dep_airport: dep,
    arr_airport: arr,
    arr_time: seg.arr_time && ISO_LOCAL.test(seg.arr_time) ? seg.arr_time : null,
    aircraft: seg.aircraft?.trim() || null,
    cabin: normalizeClass(seg.cabin),
    upgraded_to: normalizeClass(seg.upgraded_to),
    upgrade_type: UPGRADE_TYPES.includes(seg.upgrade_type as UpgradeType) ? seg.upgrade_type : null,
    upgrade_points_cost: toNumber(seg.upgrade_points_cost),
    upgrade_cash_cost: toNumber(seg.upgrade_cash_cost),
    upgrade_cash_currency: /^[A-Z]{3}$/i.test(seg.upgrade_cash_currency ?? "") ? seg.upgrade_cash_currency!.toUpperCase() : null,
    seats,
    status: seg.status ? normalizeStatus(seg.status) : null,
  };
}

export function cleanReservation(r: Reservation): Reservation | null {
  const code = r.confirmation_code?.toUpperCase().replace(/\s+/g, "");
  if (!code) return null;
  const passengers = new Map<string, Passenger>();
  for (const p of r.passengers ?? []) {
    if (!p?.name) continue;
    const name = normalizeName(p.name);
    const prev = passengers.get(name);
    passengers.set(name, {
      name,
      ticket_number: p.ticket_number ?? prev?.ticket_number ?? null,
      frequent_flyer: p.frequent_flyer ?? prev?.frequent_flyer ?? null,
    });
  }
  const segments = (r.segments ?? []).map(cleanSegment).filter((s): s is Segment => s !== null);
  // Anyone named against a seat is a passenger too.
  for (const s of segments) for (const seat of s.seats ?? []) {
    if (seat.passenger && !passengers.has(seat.passenger)) passengers.set(seat.passenger, { name: seat.passenger });
  }
  const points = toNumber(r.points_cost);
  const cash = toNumber(r.cash_cost);
  const currency = r.cash_currency?.trim().toUpperCase();
  return {
    ...r,
    confirmation_code: code,
    status: r.status ? normalizeStatus(r.status) : null,
    points_cost: points !== null ? Math.round(points) : null,
    points_program: r.points_program?.trim() || null,
    cash_cost: cash,
    cash_currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    fare_type: r.fare_type === "award" || r.fare_type === "cash" ? r.fare_type : points ? "award" : cash !== null ? "cash" : null,
    passengers: [...passengers.values()],
    segments,
  };
}

export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/[^\d.\-]/g, ""));
  return v.trim() && Number.isFinite(n) ? n : null;
}

/**
 * Does a ticket name match one of your configured names? Exact (normalized) match, ignoring middle names.
 * `loose` also accepts JON vs JONATHAN — fine for "am I on this booking", not for picking one passenger (use pickMe).
 */
export function isMe(name: string | null | undefined, myNames: string | null | undefined, loose = false): boolean {
  return matchLevel(name, myNames, loose) > 0;
}

/** 2 = same full name, 1 = same first+last (middle names ignored), 0 = no match. */
function matchLevel(name: string | null | undefined, myNames: string | null | undefined, loose = false): number {
  if (!name || !myNames) return 0;
  const a = normalizeName(name).split(" ");
  let best = 0;
  for (const mine of myNames.split(",").map((n) => n.trim()).filter(Boolean)) {
    const b = normalizeName(mine).split(" ");
    if (a.join(" ") === b.join(" ")) return 2;
    if (a.length < 2 || b.length < 2 || a[a.length - 1] !== b[b.length - 1]) continue;
    if (a[0] === b[0]) best = Math.max(best, 1);
    else if (loose && (a[0].startsWith(b[0]) || b[0].startsWith(a[0]))) best = Math.max(best, 0.5);
  }
  return best;
}

/**
 * Pick the item that is you: prefer exact matches, and only fall back to nickname-style
 * matching (JON vs JONATHAN) when nothing matches exactly. Ambiguous matches return null.
 */
export function pickMe<T>(items: T[], nameOf: (t: T) => string | null | undefined, myNames: string | null | undefined): T | null {
  const scored = items.map((t) => ({ t, l: matchLevel(nameOf(t), myNames, true) }));
  for (const level of [2, 1, 0.5]) {
    const hits = scored.filter((x) => x.l === level);
    if (hits.length === 1) return hits[0].t;
    if (hits.length > 1) return null;
  }
  return null;
}
