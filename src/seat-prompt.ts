// Post-landing seat prompts: every 30 minutes, email a "what seat were you in?" note for flights that just
// landed; a reply to it (matched by In-Reply-To / References) sets the seat.
import { EmailMessage } from "cloudflare:email";
import { describeFlight, fmtLocal, updateFlight } from "./db";
import { deriveFlight, manualSet, type FlightRow } from "./enrich";
import { buildReply } from "./reply";
import { parseAnswer } from "./seat-answer";
import type { Env } from "./types";

const MAX_PER_RUN = 5;
/** Only flights that landed within this long ago are asked about. */
const WINDOW_MS = 90 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

export interface Prompt {
  id: number;
  flight_id: number;
}

/** The prompt a reply answers, if any: one of our Message-IDs appears in its In-Reply-To or References. */
export async function findPrompt(db: D1Database, inReplyTo: string | null, references: string | null): Promise<Prompt | null> {
  const ids = `${inReplyTo ?? ""} ${references ?? ""}`.match(/<[^<>\s]+>/g);
  if (!ids) return null;
  const marks = ids.map((_, i) => `?${i + 1}`).join(", ");
  return db.prepare(`SELECT id, flight_id FROM seat_prompts WHERE message_id IN (${marks}) LIMIT 1`).bind(...ids).first<Prompt>();
}

/** Applies a reply to its flight (a later answer replaces an earlier one) and returns the text to reply with. */
export async function answerPrompt(db: D1Database, prompt: Prompt, text: string): Promise<string> {
  const flight = await db.prepare(`SELECT * FROM flights WHERE id = ?1`).bind(prompt.flight_id).first<FlightRow>();
  if (!flight) return "That flight no longer exists.";
  const answer = parseAnswer(text);
  if (answer.kind === "unknown") {
    return `Didn't understand that. Reply with your seat (e.g. 14C), or "ok" to confirm the seat on file.\n\n${describeFlight(flight)}`;
  }
  let row = flight;
  let said: string;
  if (answer.kind === "seat") {
    const manual = manualSet(flight.manual_fields).add("seat");
    row = deriveFlight({ ...flight, seat: answer.seat, manual_fields: JSON.stringify([...manual]) }, manual, { previous: flight });
    await updateFlight(db, flight.id!, row);
    said = answer.seat;
  } else if (flight.seat) {
    const manual = manualSet(flight.manual_fields).add("seat");
    row = { ...flight, manual_fields: JSON.stringify([...manual]) };
    await updateFlight(db, flight.id!, row);
    said = "ok";
  } else {
    said = "ok";
  }
  await db
    .prepare(`UPDATE seat_prompts SET answered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), answer = ?2 WHERE id = ?1`)
    .bind(prompt.id, said).run();
  const head = answer.kind === "seat" ? `Got it, seat ${answer.seat}.` : flight.seat ? `Confirmed seat ${flight.seat}.` : "OK, no seat recorded.";
  return `${head}\n\n${describeFlight(row)}`;
}

function promptBody(f: FlightRow): string {
  const flt = `${f.carrier_code} ${f.flight_number}`.trim();
  return [
    `${flt}  ${f.dep_airport}→${f.arr_airport}`,
    fmtLocal(f.dep_local),
    "",
    f.seat ? `Seat on file: ${f.seat}` : "No seat on file.",
    "",
    "Reply with your seat (e.g. 14C), or 'ok' to confirm.",
  ].join("\n");
}

export async function sendSeatPrompts(env: Env): Promise<void> {
  if (env.SEAT_PROMPTS === "false") return;
  const { SEAT_EMAIL, PROMPT_FROM: from, SEAT_PROMPT_TO: to } = env;
  if (!SEAT_EMAIL || !from || !to) {
    console.warn("seat prompts skipped: SEAT_EMAIL, PROMPT_FROM and SEAT_PROMPT_TO must all be set");
    return;
  }
  const domain = from.split("@")[1];
  const now = Date.now();
  const { results } = await env.DB
    .prepare(
      `SELECT * FROM flights
       WHERE status NOT IN ('cancelled', 'replaced') AND arr_utc IS NOT NULL AND arr_utc > ?1 AND arr_utc <= ?2
         AND NOT EXISTS (SELECT 1 FROM seat_prompts p WHERE p.flight_id = flights.id)
       ORDER BY arr_utc LIMIT ?3`,
    )
    .bind(iso(now - WINDOW_MS), iso(now), MAX_PER_RUN)
    .all<FlightRow>();

  for (const f of results) {
    const messageId = `<seat-${f.id}-${crypto.randomUUID().slice(0, 8)}@${domain}>`;
    let error: string | null = null;
    try {
      const raw = buildReply({
        from, to, inReplyTo: null, messageId, body: promptBody(f),
        subject: `Seat on ${f.carrier_code}${f.flight_number} ${f.dep_airport}→${f.arr_airport}?`,
      });
      await SEAT_EMAIL.send(new EmailMessage(from, to, raw));
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      console.warn("seat prompt failed", f.id, err);
    }
    await env.DB.prepare(`INSERT INTO seat_prompts (flight_id, message_id, error) VALUES (?1, ?2, ?3)`).bind(f.id, messageId, error).run();
  }
}
