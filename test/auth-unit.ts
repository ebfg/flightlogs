// Unit-level checks of the session cookie and token-comparison helpers (no Worker needed).
import { parseCookies, safeEqual, sessionCookie } from "../src/auth";
import type { Env } from "../src/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const prod = { ORIGIN: "https://example.com" } as Env;
const local = { ORIGIN: "http://localhost:8787" } as Env;

const c = sessionCookie(prod, "abc", 2592000);
check("Cookie flags (prod)", /^fm_session=abc; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000; Secure$/.test(c), c);
check("No Secure on localhost", !/Secure/.test(sessionCookie(local, "abc", 1)));
check("Clearing cookie", /^fm_session=; .*Max-Age=0/.test(sessionCookie(prod, "", 0)));
const p = parseCookies("a=1; fm_session=deadbeef; b=x=y");
check("parseCookies", p.fm_session === "deadbeef" && p.a === "1" && p.b === "x=y");
check("parseCookies empty", Object.keys(parseCookies(null)).length === 0);
check("safeEqual equal", await safeEqual("Bearer s3cret", "Bearer s3cret"));
check("safeEqual differs", !(await safeEqual("Bearer s3cret", "Bearer s3creT")) && !(await safeEqual("a", "")));

console.log(failures ? `${failures} unit check(s) failed` : "auth unit checks passed");
process.exit(failures ? 1 : 0);
