// Regenerates src/data/airports.json from OurAirports (public domain, updated nightly),
// adding each airport's IANA time zone from its coordinates.
//   npm run build:airports
import { writeFileSync } from "node:fs";
import tzlookup from "@photostructure/tz-lookup";

const SRC = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv";
const RANK = { large_airport: 5, medium_airport: 4, small_airport: 3, seaplane_base: 2, heliport: 1 };

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const csv = await (await fetch(SRC)).text();
const [header, ...rows] = parseCsv(csv);
const col = Object.fromEntries(header.map((h, i) => [h, i]));

const best = new Map();
for (const r of rows) {
  const iata = r[col.iata_code]?.trim().toUpperCase();
  const type = r[col.type];
  if (!iata || !/^[A-Z]{3}$/.test(iata) || !(type in RANK)) continue;
  const score = RANK[type] * 2 + (r[col.scheduled_service] === "yes" ? 1 : 0);
  const prev = best.get(iata);
  if (!prev || score > prev.score) best.set(iata, { score, r });
}

const out = {};
for (const [iata, { r }] of [...best].sort(([a], [b]) => a.localeCompare(b))) {
  const lat = Number(r[col.latitude_deg]);
  const lon = Number(r[col.longitude_deg]);
  let tz = null;
  try { tz = tzlookup(lat, lon); } catch { /* ocean / invalid coords */ }
  out[iata] = [r[col.name], r[col.municipality] || null, r[col.iso_country], +lat.toFixed(4), +lon.toFixed(4), tz];
}

writeFileSync(new URL("../src/data/airports.json", import.meta.url), JSON.stringify(out));
console.log(`wrote ${Object.keys(out).length} airports`);
