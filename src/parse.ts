import { extractJsonLd } from "./extract";
import { parseWithClaude } from "./llm";
import { cleanReservation } from "./normalize";
import { parseStructured } from "./structured";
import type { ExtractedEmail, ParseResult, Reservation } from "./types";

export interface ParseOptions {
  apiKey?: string;
  model?: string;
  myName?: string;
}

/** Structured data first; Claude only when there is none (or it yields nothing usable). */
export async function parseEmail(e: ExtractedEmail, opts: ParseOptions): Promise<ParseResult> {
  const structured = e.html ? parseStructured(extractJsonLd(e.html)) : null;
  const cleanedStructured = structured && clean(structured);
  if (cleanedStructured && cleanedStructured.reservations.length) return cleanedStructured;

  if (!opts.apiKey) {
    return {
      email_type: "other",
      reservations: [],
      method: "none",
      notes: "No embedded flight data and no ANTHROPIC_API_KEY set for the fallback parser.",
    };
  }
  return clean(await parseWithClaude(e, opts.apiKey, opts.model || "claude-haiku-5-5", opts.myName));
}

function clean(r: ParseResult): ParseResult {
  const reservations = r.reservations
    .map(cleanReservation)
    .map((x) => {
      // "Your booking ABC123 is cancelled" with no flight list → whole reservation.
      if (x && r.email_type === "cancellation" && !x.status && x.segments.length === 0) x.status = "cancelled";
      return x;
    })
    .filter((x): x is Reservation => x !== null && (x.segments.length > 0 || x.status === "cancelled"));
  return { ...r, reservations };
}
