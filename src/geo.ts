// Airports, time zones, great-circle distance.
import airportsJson from "./data/airports.json";

type AirportRow = [name: string, city: string | null, country: string, lat: number, lon: number, tz: string | null];
// Closed airports that OurAirports no longer lists under their IATA code, kept so older flights still resolve.
const HISTORIC: Record<string, AirportRow> = {
  TXL: ["Berlin Tegel Airport (closed 2020)", "Berlin", "DE", 52.5597, 13.2877, "Europe/Berlin"],
  REP: ["Siem Reap International Airport (closed 2023)", "Siem Reap", "KH", 13.4107, 103.8128, "Asia/Phnom_Penh"],
};
const AIRPORTS = { ...HISTORIC, ...(airportsJson as unknown as Record<string, AirportRow>) };

export interface Airport {
  iata: string;
  name: string;
  city: string | null;
  country: string;
  lat: number;
  lon: number;
  tz: string | null;
}

export function airport(iata: string | null | undefined): Airport | null {
  if (!iata) return null;
  const code = iata.toUpperCase();
  const r = AIRPORTS[code];
  return r ? { iata: code, name: r[0], city: r[1], country: r[2], lat: r[3], lon: r[4], tz: r[5] } : null;
}

/** Great-circle distance in statute miles, rounded. */
export function distanceMiles(a: Airport, b: Airport): number {
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Minutes the zone is ahead of UTC at a given instant. */
export function offsetMinutes(utcMs: number, tz: string): number {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

export function formatOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

function parseOffset(s: string): number {
  if (s === "Z") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(s)!;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

const TIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

export interface ResolvedTime {
  local: string; // YYYY-MM-DDTHH:MM wall-clock time at the airport
  offset: string | null; // +09:00
  utc: string | null; // YYYY-MM-DDTHH:MM:SSZ
  utcMs: number | null;
}

/**
 * Resolve a time printed in an email (with or without an offset) at an airport.
 * An offset in the email wins; otherwise the airport's IANA zone (DST-aware) is used.
 */
export function resolveTime(raw: string, tz: string | null): ResolvedTime | null {
  const m = TIME_RE.exec(raw.trim());
  if (!m) return null;
  const local = `${m[1]}T${m[2]}:${m[3]}`;
  const naiveMs = Date.parse(`${local}:00Z`);
  if (Number.isNaN(naiveMs)) return null;

  let off: number | null = null;
  if (m[4]) off = parseOffset(m[4]);
  else if (tz) {
    off = offsetMinutes(naiveMs, tz);
    const second = offsetMinutes(naiveMs - off * 60000, tz); // correct across DST edges
    if (second !== off) off = second;
  }
  if (off === null) return { local, offset: null, utc: null, utcMs: null };
  const utcMs = naiveMs - off * 60000;
  return { local, offset: formatOffset(off), utc: new Date(utcMs).toISOString().replace(".000Z", "Z"), utcMs };
}
