import { EmailMessage } from "cloudflare:email";
import { handleApi } from "./api";
import { authenticate, handleAuth } from "./auth";
import { recordEmail, saveAttachments, setEmailStatus } from "./db";
import { extractEmail } from "./extract";
import { enrichAircraft } from "./flightaware";
import { processStored } from "./pipeline";
import { buildReply } from "./reply";
import type { ReviewItem } from "./review";
import { answerPrompt, findPrompt, sendSeatPrompts } from "./seat-prompt";
import type { Env, ParseResult } from "./types";

/** Gmail auto-forwards use envelope senders like you+caf_=flights=domain.com@gmail.com. */
function baseAddress(addr: string | null | undefined): string {
  if (!addr) return "";
  const [local, domain] = addr.toLowerCase().trim().split("@");
  return `${local.split("+")[0]}@${domain}`;
}

/** Only the SMTP envelope sender is trusted; header From is attacker-controlled. */
function isAllowed(env: Env, envelopeFrom: string | null | undefined): boolean {
  const allowed = new Set((env.ALLOWED_SENDERS ?? "").split(",").map((s) => baseAddress(s)).filter(Boolean));
  const from = baseAddress(envelopeFrom);
  return !!from && allowed.has(from);
}

async function sendReply(message: ForwardableEmailMessage, env: Env, subject: string, body: string) {
  if (env.REPLY_ENABLED === "false") return;
  try {
    const raw = buildReply({
      from: message.to, to: message.from, subject, inReplyTo: message.headers.get("Message-ID"),
      references: message.headers.get("References"), body,
    });
    await message.reply(new EmailMessage(message.to, message.from, raw));
  } catch (err) {
    console.warn("reply failed", err);
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1] ?? ""} ${Number(d.slice(8, 10))}`;

function replyBody(result: ParseResult, lines: string[], warnings: string[] = [], needsReview: ReviewItem[] = [], origin?: string): string {
  if (!lines.length) {
    return result.method === "none"
      ? "Saved this email, but it has no embedded flight data and the Claude fallback isn't configured (ANTHROPIC_API_KEY)."
      : `No flights found in this email (looked like: ${result.email_type}). It's stored, so it can be re-parsed later.`;
  }
  const how = result.method === "structured" ? "embedded airline data" : "Claude";
  return [
    `Saved (${result.email_type}, read via ${how}):`, "", lines.join("\n\n"),
    ...(result.notes ? ["", `Note: ${result.notes}`] : []),
    ...warnings.map((w) => `\nHeads up: ${w}`),
    ...(needsReview.length ? [
      "", "Needs review (missing data):",
      ...needsReview.map((f) => `${f.flight} ${shortDate(f.date)} ${f.route}: ${f.missing.map((m) => m.toLowerCase()).join(", ")}`),
      ...(origin ? [`${origin.replace(/\/+$/, "")}/#/flights?review=1`] : []),
    ] : []),
  ].join("\n");
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext) {
    const raw = await new Response(message.raw).arrayBuffer();
    const e = await extractEmail(raw);

    if (!isAllowed(env, message.from)) {
      // Keep a short record (this is how you'd read Gmail's forwarding-verification code) but don't parse.
      await recordEmail(env.DB, e, message.from, "rejected", false);
      return;
    }

    // A reply to one of our seat prompts is an answer, not a booking.
    const prompt = await findPrompt(env.DB, message.headers.get("In-Reply-To"), message.headers.get("References"));
    const emailId = await recordEmail(env.DB, e, message.from, prompt ? "seat_answer" : "received", true);
    if (prompt) {
      try {
        await sendReply(message, env, e.subject, await answerPrompt(env.DB, prompt, e.text));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("seat answer failed", msg);
        await setEmailStatus(env.DB, emailId, { status: "failed", error: msg.slice(0, 1000) });
        await sendReply(message, env, e.subject, `Couldn't record that seat:\n${msg}`);
      }
      return;
    }
    if (e.pdfs?.length) {
      await saveAttachments(env.DB, emailId, e.pdfs).catch((err) => console.warn("storing PDFs failed", err));
    }
    try {
      const { result, lines, warnings, needsReview } = await processStored(env, emailId, e);
      await sendReply(message, env, e.subject, replyBody(result, lines, warnings, needsReview, env.ORIGIN));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("parse failed", msg);
      await setEmailStatus(env.DB, emailId, { status: "failed", error: msg.slice(0, 1000) });
      await sendReply(message, env, e.subject, `Couldn't parse this one (it's stored for retry):\n${msg}`);
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === "*/30 * * * *") {
      ctx.waitUntil(sendSeatPrompts(env).catch((err) => console.error("seat prompts failed", err)));
    } else {
      ctx.waitUntil(enrichAircraft(env).catch((err) => console.error("aircraft enrichment failed", err)));
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/auth" || path.startsWith("/auth/")) return handleAuth(req, env);
    if (path === "/api" || path.startsWith("/api/")) {
      // Unauthenticated requests get a plain 404 so the API isn't discoverable.
      const a = await authenticate(req, env);
      if (!a.kind) return new Response("Not found", { status: 404 });
      if (!a.csrfOk) return Response.json({ error: "Bad origin" }, { status: 403 });
      return handleApi(req, env);
    }
    return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
