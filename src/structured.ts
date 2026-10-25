// Parser for schema.org FlightReservation markup (JSON-LD), which many airlines and
// agencies embed in confirmation emails. No network, no cost, very reliable when present.
import { normalizeName, normalizeStatus, splitFlightNumber } from "./normalize";
import type { ParseResult, Reservation, Segment } from "./types";

type Obj = Record<string, any>;

function isType(o: Obj, t: string): boolean {
  const ty = o?.["@type"];
  return (Array.isArray(ty) ? ty : [ty]).some(
    (x) => typeof x === "string" && x.replace(/^https?:\/\/schema\.org\//, "") === t,
  );
}

function collect(node: unknown, t: string, out: Obj[]): void {
  if (Array.isArray(node)) node.forEach((n) => collect(n, t, out));
  else if (node && typeof node === "object") {
    const o = node as Obj;
    if (isType(o, t)) out.push(o);
    else for (const v of Object.values(o)) collect(v, t, out);
  }
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
const priceOf = (v: unknown): number | null => {
  const raw = typeof v === "object" && v ? (v as Obj).price ?? (v as Obj).value : v;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/[^\d.]/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
const nameOf = (v: unknown): string | null => (typeof v === "object" && v ? str((v as Obj).name) : str(v));

export function parseStructured(blocks: unknown[]): ParseResult | null {
  const items: Obj[] = [];
  collect(blocks, "FlightReservation", items);
  if (!items.length) return null;

  const byCode = new Map<string, Reservation>();
  const segIndex = new Map<string, Segment>();

  for (const it of items) {
    const flight: Obj = it.reservationFor ?? {};
    const code = str(it.reservationNumber)?.toUpperCase();
    if (!code) continue;

    const res =
      byCode.get(code) ??
      ({
        confirmation_code: code,
        airline_name: nameOf(flight.airline) ?? nameOf(it.provider),
        booked_via: nameOf(it.broker),
        status: null,
        // Markup puts the price on each passenger/flight item; it is usually the booking
        // total repeated, so take the first rather than summing.
        cash_cost: priceOf(it.totalPrice),
        cash_currency: str(it.priceCurrency) ?? str(it.totalPrice?.priceCurrency),
        is_full_itinerary: false,
        passengers: [],
        segments: [],
      } satisfies Reservation);
    byCode.set(code, res);

    const status = normalizeStatus(it.reservationStatus);

    const pax = nameOf(it.underName);
    if (pax && !res.passengers.some((p) => p.name === normalizeName(pax))) {
      res.passengers.push({
        name: pax,
        ticket_number: str(it.ticketNumber),
        frequent_flyer: str(it.programMembershipUsed?.membershipNumber ?? it.programMembership?.membershipNumber),
      });
    }

    const carrier = str(flight.airline?.iataCode);
    const split = splitFlightNumber(flight.flightNumber, carrier);
    const depTime = str(flight.departureTime);
    if (!split || !depTime) {
      if (status === "cancelled") res.status = "cancelled";
      continue;
    }

    const key = `${code}|${split.carrier}|${split.number}|${depTime.slice(0, 10)}`;
    let seg = segIndex.get(key);
    if (!seg) {
      seg = {
        carrier_code: split.carrier || null,
        carrier_name: nameOf(flight.airline),
        flight_number: split.number,
        operating_carrier: nameOf(flight.operatedBy) ?? str(flight.operatedBy?.iataCode),
        dep_airport: str(flight.departureAirport?.iataCode) ?? "",
        dep_airport_name: nameOf(flight.departureAirport),
        dep_time: depTime,
        arr_airport: str(flight.arrivalAirport?.iataCode) ?? "",
        arr_airport_name: nameOf(flight.arrivalAirport),
        arr_time: str(flight.arrivalTime),
        aircraft: nameOf(flight.aircraft) ?? str(flight.aircraft?.model),
        cabin: nameOf(it.airplaneSeatClass),
        seats: [],
        status,
      };
      segIndex.set(key, seg);
      res.segments.push(seg);
    }
    const seat = str(it.airplaneSeat);
    const cls = nameOf(it.airplaneSeatClass);
    if (seat || cls) seg.seats!.push({ passenger: pax, seat, travel_class: cls });
    if (status === "cancelled") seg.status = "cancelled";
  }

  const reservations = [...byCode.values()];
  for (const r of reservations) {
    if (r.segments.length && r.segments.every((s) => s.status === "cancelled")) r.status = "cancelled";
  }
  if (!reservations.some((r) => r.segments.length || r.status === "cancelled")) return null;

  const allCancelled = reservations.every((r) => r.status === "cancelled");
  return { email_type: allCancelled ? "cancellation" : "booking", reservations, method: "structured" };
}
