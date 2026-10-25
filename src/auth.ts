// Passkey-only login (WebAuthn) plus cookie sessions. One user; the API_TOKEN secret
// doubles as the bootstrap "setup token" for registering the first passkey.
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Env } from "./types";

export const SESSION_COOKIE = "fm_session";
const SESSION_SECONDS = 30 * 24 * 3600;
const CHALLENGE_SECONDS = 5 * 60;
const USER_ID = new TextEncoder().encode("flight-memory-owner") as Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();
const nowIso = () => new Date().toISOString();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b as ArrayBuffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = (s: string) => crypto.subtle.digest("SHA-256", enc.encode(s));

/** Constant-time string equality (compares fixed-length digests, so length doesn't leak either). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]).then((r) => r.map((d) => new Uint8Array(d)));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function bearerOk(req: Request, env: Env): Promise<boolean> {
  const h = req.headers.get("authorization");
  return !!env.API_TOKEN && !!h && (await safeEqual(h, `Bearer ${env.API_TOKEN}`));
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const isLocal = (env: Env) => /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(env.ORIGIN ?? "");

export function sessionCookie(env: Env, value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isLocal(env) ? "" : "; Secure"}`;
}

export async function createSession(env: Env): Promise<string> {
  const id = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?1`).bind(nowIso()),
    env.DB.prepare(`INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?1, ?2, ?3)`)
      .bind(hex(await sha256(id)), new Date(now).toISOString(), new Date(now + SESSION_SECONDS * 1000).toISOString()),
  ]);
  return id;
}

/** The raw session id from the cookie, if it is a valid unexpired session. */
export async function validSession(req: Request, env: Env): Promise<string | null> {
  const id = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return null;
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM sessions WHERE id_hash = ?1 AND expires_at > ?2`)
    .bind(hex(await sha256(id)), nowIso()).first();
  return row ? id : null;
}

export type AuthKind = "bearer" | "session" | null;

/** Bearer token or session cookie. Cookie-authenticated mutations must also pass the Origin (CSRF) check. */
export async function authenticate(req: Request, env: Env): Promise<{ kind: AuthKind; csrfOk: boolean }> {
  if (await bearerOk(req, env)) return { kind: "bearer", csrfOk: true };
  if (await validSession(req, env)) {
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    return { kind: "session", csrfOk: !mutating || (!!env.ORIGIN && req.headers.get("origin") === env.ORIGIN) };
  }
  return { kind: null, csrfOk: false };
}

const json = (data: unknown, status = 200, headers?: HeadersInit) => Response.json(data, { status, headers });
const unauthorized = () => json({ error: "Unauthorized" }, 401);

async function newChallenge(env: Env, kind: "register" | "login", challenge: string) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM auth_challenges WHERE expires_at < ?1`).bind(nowIso()),
    env.DB.prepare(`INSERT INTO auth_challenges (challenge, kind, expires_at) VALUES (?1, ?2, ?3)`)
      .bind(challenge, kind, new Date(Date.now() + CHALLENGE_SECONDS * 1000).toISOString()),
  ]);
}

/** Atomically burn a challenge: true only the first time, if it is unexpired and of the right kind. */
async function consumeChallenge(env: Env, kind: "register" | "login", challenge: string): Promise<boolean> {
  const r = await env.DB.prepare(`DELETE FROM auth_challenges WHERE challenge = ?1 AND kind = ?2 AND expires_at > ?3`)
    .bind(challenge, kind, nowIso()).run();
  return r.meta.changes === 1;
}

/** The challenge the browser signed, read from clientDataJSON (verified against what we issued afterwards). */
function challengeOf(response: any): string | null {
  try {
    const b64 = String(response?.response?.clientDataJSON ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const c = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    return typeof c.challenge === "string" ? c.challenge : null;
  } catch {
    return null;
  }
}

async function readJson(req: Request): Promise<Record<string, any>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/** Registering needs a live session or the setup token. */
async function mayRegister(req: Request, env: Env, body: Record<string, any>): Promise<boolean> {
  if (typeof body.setup_token === "string" && env.API_TOKEN && (await safeEqual(body.setup_token, env.API_TOKEN))) return true;
  const a = await authenticate(req, env);
  return a.kind === "session" && a.csrfOk;
}

const toBytes = (v: unknown) => new Uint8Array(v as ArrayBuffer | number[]);
const toBlob = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

async function signedIn(env: Env): Promise<Response> {
  const id = await createSession(env);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(env, id, SESSION_SECONDS) });
}

export async function handleAuth(req: Request, env: Env): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (!env.RP_ID || !env.ORIGIN) return json({ error: "RP_ID and ORIGIN are not configured" }, 500);
  const rpID = env.RP_ID, origin = env.ORIGIN;

  if (req.method === "GET" && path === "/auth/me") {
    const [a, n] = await Promise.all([authenticate(req, env), env.DB.prepare(`SELECT COUNT(*) AS n FROM credentials`).first<{ n: number }>()]);
    return json({ authenticated: a.kind === "session", has_passkeys: (n?.n ?? 0) > 0 });
  }
  if (req.method !== "POST") return json({ error: "Not found" }, 404);

  if (path === "/auth/logout") {
    const id = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
    // Cookie-bearing requests must come from our own origin so another site can't log you out.
    if (id && req.headers.get("origin") !== origin) return json({ error: "Bad origin" }, 403);
    if (id && /^[0-9a-f]{64}$/.test(id)) await env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?1`).bind(hex(await sha256(id))).run();
    return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie(env, "", 0) } });
  }

  const body = await readJson(req);

  if (path === "/auth/register/options") {
    if (!(await mayRegister(req, env, body))) return unauthorized();
    const { results } = await env.DB.prepare(`SELECT id, transports FROM credentials`).all<{ id: string; transports: string | null }>();
    const opts = await generateRegistrationOptions({
      rpName: "Flight Memory", rpID, userName: "me", userDisplayName: "me", userID: USER_ID,
      attestationType: "none",
      excludeCredentials: results.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    await newChallenge(env, "register", opts.challenge);
    return json(opts);
  }

  if (path === "/auth/register/verify") {
    if (!(await mayRegister(req, env, body))) return unauthorized();
    const response = body.response as RegistrationResponseJSON | undefined;
    const challenge = challengeOf(response);
    if (!response || !challenge || !(await consumeChallenge(env, "register", challenge))) return json({ error: "Invalid or expired challenge" }, 400);
    let info;
    try {
      const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID });
      if (!v.verified) return json({ error: "Verification failed" }, 400);
      info = v.registrationInfo;
    } catch {
      return json({ error: "Verification failed" }, 400);
    }
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 100) : "Passkey";
    try {
      await env.DB.prepare(
        `INSERT INTO credentials (id, public_key, counter, transports, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(info.credential.id, toBlob(info.credential.publicKey as Uint8Array), info.credential.counter,
        JSON.stringify(info.credential.transports ?? response.response.transports ?? []), name, nowIso()).run();
    } catch {
      return json({ error: "That passkey is already registered" }, 409);
    }
    return signedIn(env);
  }

  if (path === "/auth/login/options") {
    const opts = await generateAuthenticationOptions({ rpID, userVerification: "required" });
    await newChallenge(env, "login", opts.challenge);
    return json(opts);
  }

  if (path === "/auth/login/verify") {
    const response = body.response as AuthenticationResponseJSON | undefined;
    const challenge = challengeOf(response);
    if (!response || typeof response.id !== "string" || !challenge || !(await consumeChallenge(env, "login", challenge))) return unauthorized();
    const cred = await env.DB.prepare(`SELECT id, public_key, counter, transports FROM credentials WHERE id = ?1`)
      .bind(response.id).first<{ id: string; public_key: unknown; counter: number; transports: string | null }>();
    if (!cred) return unauthorized();
    try {
      const v = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
        credential: {
          id: cred.id, publicKey: toBytes(cred.public_key) as any, counter: cred.counter,
          transports: cred.transports ? JSON.parse(cred.transports) : undefined,
        },
      });
      if (!v.verified) return unauthorized();
      await env.DB.prepare(`UPDATE credentials SET counter = ?2, last_used_at = ?3 WHERE id = ?1`)
        .bind(cred.id, v.authenticationInfo.newCounter, nowIso()).run();
    } catch {
      return unauthorized();
    }
    return signedIn(env);
  }

  return json({ error: "Not found" }, 404);
}
