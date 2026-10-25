// Daily FlightAware AeroAPI lookup: fills the tail number and aircraft type of flights that have departed.
// Actual departure/arrival times are deliberately not recorded.
import { updateFlight } from "./db";
import { deriveFlight, manualSet, mergeRow, type FlightRow } from "./enrich";
import { normalizeAircraft } from "./aircraft";
import type { Env } from "./types";

const API = "https://aeroapi.flightaware.com/aeroapi";
const MAX_PER_RUN = 20;
const MAX_ATTEMPTS = 3;
/** scheduled_out may differ from our (email-printed) departure by this much. */
const TOLERANCE_MS = 3 * 3600_000;
/** Two matches this close in time are indistinguishable. */
const AMBIGUOUS_MS = 20 * 60_000;

/** The parts of an AeroAPI GET /flights/{ident} result we use (spec: get_flight, 200 `flights[]`). */
export interface FaFlight {
  fa_flight_id?: string | null;
  registration?: string | null;
  aircraft_type?: string | null;
  cancelled?: boolean;
  origin?: { code_iata?: string | null } | null;
  scheduled_out?: string | null;
}

export type FaPick = { flight: FaFlight } | { flight: null; reason: string };

/** The result departing from `depAirport` closest to `depUtcMs`; none when absent or ambiguous. */
export function pickFlight(flights: FaFlight[], depAirport: string, depUtcMs: number): FaPick {
  const seen = new Set<string>();
  const cands = flights
    .filter((f) => !f.cancelled && f.origin?.code_iata?.toUpperCase() === depAirport.toUpperCase() && f.scheduled_out)
    // A diverted flight comes back twice with the same fa_flight_id.
    .filter((f) => !f.fa_flight_id || (!seen.has(f.fa_flight_id) && seen.add(f.fa_flight_id)))
    .map((f) => ({ f, diff: Math.abs(Date.parse(f.scheduled_out!) - depUtcMs) }))
    .filter((c) => c.diff <= TOLERANCE_MS)
    .sort((a, b) => a.diff - b.diff);
  if (!cands.length) return { flight: null, reason: "no flight from that airport near the departure time" };
  if (cands[1] && cands[1].diff - cands[0].diff < AMBIGUOUS_MS && cands[1].f.registration !== cands[0].f.registration) {
    return { flight: null, reason: "ambiguous: several flights depart at about the same time" };
  }
  return { flight: cands[0].f };
}

interface Candidate extends FlightRow { id: number }

/** Departed 1 hour to 9 days ago (dep_date noon-UTC if dep_utc is unknown), not yet tailed, not tried too often. */
export const CANDIDATES_SQL = `
  SELECT * FROM flights f
  WHERE f.status NOT IN ('cancelled', 'replaced')
    AND COALESCE(f.aircraft_registration, '') = ''
    AND f.carrier_code != '' AND f.flight_number != ''
    AND COALESCE(f.dep_utc, f.dep_date || 'T12:00:00Z') <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hour')
    AND COALESCE(f.dep_utc, f.dep_date || 'T12:00:00Z') >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-9 days')
    AND NOT EXISTS (SELECT 1 FROM aircraft_lookups l WHERE l.flight_id = f.id AND l.status = 'matched' AND l.applied = 1 AND l.registration IS NOT NULL)
    AND (SELECT COUNT(*) FROM aircraft_lookups l WHERE l.flight_id = f.id AND l.status != 'error') < ?1
  ORDER BY COALESCE(f.dep_utc, f.dep_date) DESC
  LIMIT ?2`;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

async function record(
  db: D1Database, flightId: number, status: "matched" | "no_match" | "error",
  f: { registration?: string | null; aircraft_type?: string | null; fa_flight_id?: string | null } | null,
  applied: boolean, error?: string,
) {
  await db
    .prepare(`INSERT INTO aircraft_lookups (flight_id, status, registration, aircraft_type, fa_flight_id, applied, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
    .bind(flightId, status, f?.registration ?? null, f?.aircraft_type ?? null, f?.fa_flight_id ?? null, applied ? 1 : 0, error ?? null)
    .run();
}

/** Fill empty, non-manual registration and aircraft type; never replaces an existing type or family. */
async function applyLookup(db: D1Database, row: Candidate, f: FaFlight): Promise<boolean> {
  const manual = manualSet(row.manual_fields);
  const reg = f.registration?.trim().toUpperCase() || null;
  const incoming: Partial<FlightRow> = {
    aircraft_registration: row.aircraft_registration ? null : reg,
    aircraft_raw: row.aircraft_raw || !normalizeAircraft(f.aircraft_type).type ? null : f.aircraft_type,
  };
  const merged = mergeRow(row, incoming, manual);
  if (merged.aircraft_registration === row.aircraft_registration && merged.aircraft_raw === row.aircraft_raw) return false;
  const out = deriveFlight(merged, manual, { previous: row });
  if (row.aircraft_type) out.aircraft_type = row.aircraft_type;
  if (row.aircraft_family) out.aircraft_family = row.aircraft_family;
  await updateFlight(db, row.id, out);
  return true;
}

export async function enrichAircraft(env: Env): Promise<void> {
  if (!env.FLIGHTAWARE_API_KEY) {
    console.warn("FLIGHTAWARE_API_KEY not set; skipping aircraft lookup");
    return;
  }
  const dry = env.FLIGHTAWARE_DRY_RUN === "true";
  const { results } = await env.DB.prepare(CANDIDATES_SQL).bind(MAX_ATTEMPTS, MAX_PER_RUN).all<Candidate>();
  const headers = { "x-apikey": env.FLIGHTAWARE_API_KEY };

  // Flight lookups only find ICAO idents (JAL1, not JL1), so ask FlightAware for each carrier's ICAO code.
  const icao = new Map<string, Promise<string>>();
  const icaoFor = (iata: string) => {
    if (!icao.has(iata)) {
      icao.set(iata, fetch(`${API}/operators/${encodeURIComponent(iata)}`, { headers })
        .then(async (res) => (res.ok ? ((await res.json()) as { icao?: string | null }).icao : null) || iata)
        .catch(() => iata));
    }
    return icao.get(iata)!;
  };

  for (const row of results) {
    const depMs = Date.parse(row.dep_utc ?? `${row.dep_date}T12:00:00Z`);
    const ident = `${await icaoFor(row.carrier_code)}${row.flight_number}`;
    // start/end compare against scheduled_out; the API only reaches 10 days back.
    const qs = new URLSearchParams({ ident_type: "designator", start: iso(depMs - 6 * 3600_000), end: iso(depMs + 12 * 3600_000) });
    try {
      const res = await fetch(`${API}/flights/${encodeURIComponent(ident)}?${qs}`, { headers });
      if (!res.ok) {
        await record(env.DB, row.id, "error", null, false, `HTTP ${res.status}`);
        // Rate-limited or key rejected: the rest would fail the same way.
        if (res.status === 429 || res.status === 401 || res.status === 403) break;
        continue;
      }
      const { flights } = (await res.json()) as { flights?: FaFlight[] };
      const pick = pickFlight(flights ?? [], row.dep_airport, depMs);
      if (!pick.flight) {
        await record(env.DB, row.id, "no_match", null, false, pick.reason);
      } else {
        const applied = !dry && (await applyLookup(env.DB, row, pick.flight));
        await record(env.DB, row.id, "matched", pick.flight, applied);
      }
    } catch (err) {
      await record(env.DB, row.id, "error", null, false, (err instanceof Error ? err.message : String(err)).slice(0, 500)).catch(() => {});
      console.warn("aircraft lookup failed", ident, err);
    }
  }
}
