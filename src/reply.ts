// Builds a minimal plain-text MIME reply, no dependencies.

function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64utf8(s)}?=`);

export function buildReply(opts: {
  from: string;
  to: string;
  subject: string;
  inReplyTo: string | null;
  /** The original's References header; a reply's References must be that plus the original's Message-ID. */
  references?: string | null;
  body: string;
  /** A fresh message rather than a reply: use this Message-ID and leave the subject alone. */
  messageId?: string;
}): string {
  const domain = opts.from.split("@")[1] ?? "flight-memory.local";
  const subject = opts.messageId || /^re:/i.test(opts.subject) ? opts.subject : `Re: ${opts.subject}`;
  const headers = [
    `From: Flight Memory <${opts.from}>`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${opts.messageId ?? `<${crypto.randomUUID()}@${domain}>`}`,
    ...(opts.inReplyTo
      ? [`In-Reply-To: ${opts.inReplyTo}`, `References: ${[opts.references?.replace(/\s+/g, " ").trim(), opts.inReplyTo].filter(Boolean).join(" ")}`]
      : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = b64utf8(opts.body).replace(/.{76}/g, "$&\r\n");
  return headers.join("\r\n") + "\r\n\r\n" + body + "\r\n";
}
