// Parse .eml files locally without Cloudflare:  npm run parse -- path/to/email.eml [...]
// Shows the parsed booking plus derived time zones, duration, distance and aircraft per flight.
// Set ANTHROPIC_API_KEY (and MY_NAME) in your shell to exercise the Claude fallback too.
import { readFileSync } from "node:fs";
import { fmtDuration } from "../src/db";
import { deriveFlight, emptyFlight, splitPrinted } from "../src/enrich";
import { extractEmail } from "../src/extract";
import { parseEmail } from "../src/parse";

for (const path of process.argv.slice(2)) {
  const e = await extractEmail(new Uint8Array(readFileSync(path)));
  const result = await parseEmail(e, { apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.CLAUDE_MODEL, myName: process.env.MY_NAME });
  console.log(`\n=== ${path}`);
  console.log(`subject: ${e.subject} | from: ${e.from} | forwarded as attachment: ${e.forwardedAsAttachment}`);
  console.log(`type: ${result.email_type} | method: ${result.method}${result.notes ? ` | notes: ${result.notes}` : ""}`);
  for (const r of result.reservations) {
    const cost = [r.fare_type, r.points_cost && `${r.points_cost} pts`, r.cash_cost != null && `${r.cash_cost} ${r.cash_currency ?? ""}`,
      r.cash_cost != null || r.points_cost ? (r.cost_is_per_passenger ? "(per person)" : "(booking total)") : ""].filter(Boolean).join(" ");
    console.log([r.confirmation_code, r.airline_name, cost, r.status].filter(Boolean).join(" · "));
    console.log(`  passengers: ${r.passengers.map((p) => p.name).join(", ") || "—"}`);
    for (const s of r.segments) {
      const dep = splitPrinted(s.dep_time), arr = splitPrinted(s.arr_time);
      const row = deriveFlight(
        { ...emptyFlight({ carrier_code: s.carrier_code ?? "", flight_number: s.flight_number, dep_airport: s.dep_airport, dep_local: dep.local!, arr_airport: s.arr_airport }),
          arr_local: arr.local, aircraft_raw: s.aircraft ?? null, purchased_class: s.cabin ?? null, flown_class: s.upgraded_to ?? null },
        new Set(), { depOffset: dep.offset, arrOffset: arr.offset },
      );
      console.log(`  ${row.carrier_code} ${row.flight_number}  ${row.dep_airport} ${row.dep_local} ${row.dep_offset ?? "?"} (${row.dep_tz}) → ` +
        `${row.arr_airport} ${row.arr_local ?? "?"} ${row.arr_offset ?? ""} (${row.arr_tz})`);
      console.log(`     ${fmtDuration(row.duration_min) ?? "duration ?"} · ${row.distance_mi ?? "?"} mi · ${row.aircraft_type ?? row.aircraft_family ?? "aircraft ?"}` +
        ` · class ${row.purchased_class ?? "?"}${row.flown_class !== row.purchased_class ? ` → ${row.flown_class} (${s.upgrade_type ?? "reason ?"})` : ""}` +
        (s.seats?.length ? ` · seats ${s.seats.map((x) => `${x.passenger ?? "?"} ${x.seat ?? ""}`.trim()).join(", ")}` : ""));
    }
  }
  if (process.env.VERBOSE) console.log(JSON.stringify(result, null, 2));
}
