// Reads a reply to a seat prompt (kept free of Worker-only imports so tests can load it).

export type Answer = { kind: "ok" } | { kind: "seat"; seat: string } | { kind: "unknown" };

/** What the reply says: its first non-empty line, ignoring quoted text and the "On … wrote:" tail. */
export function parseAnswer(text: string): Answer {
  let line = "";
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (/^on .+ wrote:?$/i.test(l) || /^-+\s*original message\s*-+$/i.test(l) || /^from:\s/i.test(l)) break;
    if (!l || l.startsWith(">")) continue;
    line = l;
    break;
  }
  line = line.replace(/[.!\s]+$/, "");
  if (/^(ok|okay|yes|y|confirm(ed)?|correct)\b/i.test(line)) return { kind: "ok" };
  if (/^\d{1,2}[A-K]$/i.test(line)) return { kind: "seat", seat: line.toUpperCase() };
  return { kind: "unknown" };
}
