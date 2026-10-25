// pickFlight against a sample AeroAPI result (no network needed).
import { pickFlight, type FaFlight } from "../src/flightaware";

let failures = 0;
const check = (label: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures++; };
const f = (o: Partial<FaFlight> & { from?: string }): FaFlight => ({ origin: { code_iata: o.from ?? "SFO" }, ...o });
const dep = Date.parse("2026-10-20T18:00:00Z");

const day: FaFlight[] = [
  f({ fa_flight_id: "a", registration: "N1", aircraft_type: "B77W", scheduled_out: "2026-10-20T18:10:00Z" }),
  f({ fa_flight_id: "b", registration: "N2", aircraft_type: "B77W", scheduled_out: "2026-10-19T18:10:00Z" }),
  f({ fa_flight_id: "c", registration: "N3", aircraft_type: "B77W", scheduled_out: "2026-10-20T18:00:00Z", from: "LAX" }),
  f({ fa_flight_id: "d", registration: "N4", scheduled_out: "2026-10-20T18:00:00Z", cancelled: true }),
];
check("picks same-airport flight nearest in time", pickFlight(day, "SFO", dep).flight?.registration === "N1");
check("no match for unknown airport", pickFlight(day, "JFK", dep).flight === null);
check("outside tolerance is no match", pickFlight(day.slice(1, 2), "SFO", dep).flight === null);
check("diverted duplicate is not ambiguous", pickFlight([day[0], day[0]], "SFO", dep).flight?.registration === "N1");
check("two near-simultaneous flights are ambiguous", pickFlight([day[0], f({ fa_flight_id: "e", registration: "N9", scheduled_out: "2026-10-20T18:05:00Z" })], "SFO", dep).flight === null);
process.exit(failures ? 1 : 0);
