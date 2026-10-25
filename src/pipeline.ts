import { saveResult, setEmailStatus } from "./db";
import type { ReviewItem } from "./review";
import { parseEmail } from "./parse";
import type { Env, ExtractedEmail, ParseResult } from "./types";

/** Parse a stored email and write the result. Used by the email handler and /reparse. */
export async function processStored(
  env: Env, emailId: number, e: ExtractedEmail,
): Promise<{ result: ParseResult; lines: string[]; warnings: string[]; needsReview: ReviewItem[] }> {
  const result = await parseEmail(e, { apiKey: env.ANTHROPIC_API_KEY, model: env.CLAUDE_MODEL, myName: env.MY_NAME });
  const { lines, warnings, needsReview } = await saveResult(env.DB, emailId, result, { myName: env.MY_NAME, sentAt: e.originalDate ?? e.date });
  const status = result.reservations.length ? "parsed" : result.method === "none" ? "needs_review" : "no_flights";
  const notes = [result.notes, ...warnings].filter(Boolean).join(" ");
  await setEmailStatus(env.DB, emailId, {
    status, email_type: result.email_type, parse_method: result.method, error: notes || null,
  });
  return { result, lines, warnings, needsReview };
}
