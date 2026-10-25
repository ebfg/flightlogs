import PostalMime, { type Address, type Email } from "postal-mime";
import type { ExtractedEmail, PdfAttachment } from "./types";

type Raw = string | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;

function firstAddress(a: Address | undefined): string | null {
  if (!a) return null;
  if (a.address) return a.address.toLowerCase();
  return a.group?.[0]?.address?.toLowerCase() ?? null;
}

/**
 * Parse a raw email. If the confirmation was forwarded *as an attachment* (.eml /
 * message/rfc822), the attached original is used, which keeps the airline's embedded
 * structured data intact.
 */
export async function extractEmail(raw: Raw): Promise<ExtractedEmail> {
  const outer: Email = await PostalMime.parse(raw, { forceRfc822Attachments: true });

  let src = outer;
  let forwardedAsAttachment = false;
  const attached = outer.attachments.find(
    (a) => a.mimeType === "message/rfc822" || /\.eml$/i.test(a.filename ?? ""),
  );
  if (attached && typeof attached.content !== "string") {
    try {
      src = await PostalMime.parse(attached.content, { forceRfc822Attachments: true });
      forwardedAsAttachment = true;
    } catch {
      src = outer;
    }
  }

  return {
    messageId: outer.messageId ?? null,
    outerFrom: firstAddress(outer.from),
    from: firstAddress(src.from),
    subject: src.subject ?? outer.subject ?? "",
    date: src.date ?? outer.date ?? null,
    // An attached original already supplies its own date above; inline forwards only carry it in the body.
    originalDate: forwardedAsAttachment ? null : inlineForwardDate(src.text ?? ""),
    html: src.html ?? "",
    text: src.text ?? "",
    forwardedAsAttachment,
    pdfs: collectPdfs(src === outer ? [outer] : [src, outer]),
  };
}

const MAX_PDFS = 5;
// Total across PDFs: base64 adds a third, and the API caps a request at 32 MB.
const MAX_PDF_BYTES = 15 * 1024 * 1024;

function collectPdfs(messages: Email[]): PdfAttachment[] {
  const out: PdfAttachment[] = [];
  let total = 0;
  for (const m of messages) {
    for (const a of m.attachments) {
      if (typeof a.content === "string") continue;
      if (a.mimeType !== "application/pdf" && !/\.pdf$/i.test(a.filename ?? "")) continue;
      const data = new Uint8Array(a.content);
      if (out.length >= MAX_PDFS || total + data.byteLength > MAX_PDF_BYTES) continue;
      total += data.byteLength;
      out.push({ filename: a.filename ?? null, data });
    }
  }
  return out;
}

const FORWARD_MARKER = /^[\s>]*(?:-+\s*Forwarded message\s*-+|Begin forwarded message:|-+\s*Original Message\s*-+)\s*$/gim;

/**
 * The original send date from an inline forward's header block (Gmail "Date: Mon, Apr 21, 2027 at 10:15 AM",
 * Apple Mail "Date: April 21, 2027 at 10:15:30 AM PDT", Outlook "Sent: Monday, April 21, 2027 10:15 AM").
 * Uses the last block, which is the innermost (the airline's) message when forwards are nested.
 */
export function inlineForwardDate(text: string): string | null {
  const marks = [...text.matchAll(FORWARD_MARKER)];
  if (!marks.length) return null;
  const block = text.slice(marks[marks.length - 1].index!).split("\n").slice(1, 12);
  for (const line of block) {
    const m = /^[\s>]*(?:Date|Sent):\s*(.+)$/i.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1].replace(/\bat\b/i, "").replace(/^[A-Za-z]+,\s*/, "").replace(/\s+/g, " ").trim());
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  rarr: "→", larr: "←", middot: "·", bull: "•", eacute: "é", uuml: "ü", ouml: "ö", auml: "ä",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      // Out-of-range code points and lone surrogates would throw (or be invalid text): leave them as-is.
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Rough HTML → text that keeps table structure readable for the model. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, "\n")
      .replace(/<\/t[dh]>/gi, " | ")
      .replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, " $1 ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\| *(\| *)+/g, " | ")
    .replace(/\n\s*\n+/g, "\n")
    .split("\n")
    .map((l) => l.trim().replace(/^\|\s*|\s*\|$/g, ""))
    .filter(Boolean)
    .join("\n");
}

/** Pull every JSON-LD block out of the HTML (schema.org markup airlines add for Gmail etc.). */
export function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const body = m[1].trim();
    for (const candidate of [body, decodeEntities(body)]) {
      try {
        out.push(JSON.parse(candidate));
        break;
      } catch {
        /* try the entity-decoded version, then give up on this block */
      }
    }
  }
  return out;
}

/** Best plain-text view of the email for the model. */
export function bodyForModel(e: ExtractedEmail, maxChars = 40_000): string {
  const fromHtml = e.html ? htmlToText(e.html) : "";
  const best = fromHtml.length > e.text.length * 0.8 ? fromHtml : e.text;
  return best.length > maxChars ? best.slice(0, maxChars) + "\n[…truncated]" : best;
}
