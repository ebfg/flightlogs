// Unit tests for parsing a seat-prompt reply (run by test/e2e.sh).
import { parseAnswer } from "../src/seat-answer";

let failures = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got ${JSON.stringify(got)}`}`);
  if (!ok) failures++;
};

eq("seat", parseAnswer("14c"), { kind: "seat", seat: "14C" });
eq("seat with punctuation + signature", parseAnswer("\n 3A.\n\nSent from my iPhone"), { kind: "seat", seat: "3A" });
eq("ok", parseAnswer("Ok thanks"), { kind: "ok" });
eq("yes", parseAnswer("yes"), { kind: "ok" });
eq("confirmed", parseAnswer("Confirmed!"), { kind: "ok" });
eq("quoted text skipped", parseAnswer("> 12A\n> Reply with your seat\n22F\n\nOn Tue, Oct 20, 2026 at 5:00 PM Flight Memory <flights@example.com> wrote:\n> Seat on file: 12A"), { kind: "seat", seat: "22F" });
eq("only quoted", parseAnswer("On Tue, Oct 20, 2026 at 5:00 PM X <a@b.c> wrote:\n> ok"), { kind: "unknown" });
eq("garbage", parseAnswer("what?"), { kind: "unknown" });
eq("bad row", parseAnswer("123A"), { kind: "unknown" });
eq("empty", parseAnswer(""), { kind: "unknown" });
process.exit(failures ? 1 : 0);
