import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

// ---------- shared constants (mirror src/types.ts and FIELDS in src/api.ts) ----------
const UPGRADE_TYPES = [
  "complimentary_upgrade", "op_up", "mileage_upgrade", "cash_upgrade", "bid_upgrade",
  "certificate_upgrade", "op_down", "voluntary_downgrade",
] as const;
const STATUSES = ["confirmed", "pending", "changed", "cancelled", "replaced"];
const CLASSES = ["Economy", "Premium Economy", "Business", "First"];
const SEAT_TYPES = ["window", "middle", "aisle"];
const FARE_TYPES = ["cash", "award"];

type Json = Record<string, any>;
type Flight = Json & { id: number; manual_fields: string[] };

// ---------- tiny DOM helper ----------
type Child = Node | string | number | null | undefined | false | Child[];
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Json | null = null, ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k in el && k !== "list") (el as any)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, kids);
  return el;
}
function append(el: Node, kids: Child[]) {
  for (const k of kids) {
    if (Array.isArray(k)) { append(el, k); continue; }
    if (k == null || k === false) continue;
    el.appendChild(typeof k === "object" ? k : document.createTextNode(String(k)));
  }
}
const app = document.getElementById("app")!;
const svgPlane = `<svg viewBox="0 0 24 24"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>`;

// ---------- API ----------
class ApiError extends Error {
  constructor(public messages: string[], public status: number) { super(messages.join("; ")); }
}
class AuthRequired extends Error {}

async function raw(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  let body = init.body;
  if (init.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(init.json); }
  return fetch(path, { ...init, body, headers, credentials: "same-origin" });
}
async function parse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}
function errMessages(data: any, res: Response): string[] {
  const e = data && typeof data === "object" ? data.error : null;
  if (Array.isArray(e)) return e.map(String);
  if (typeof e === "string") return [e];
  return [`Request failed (${res.status})`];
}

/** Call /api. 401/404 means signed out (the API hides itself from unauthenticated callers). */
async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}, soft404 = false): Promise<T> {
  const res = await raw(path, init);
  const data = await parse(res);
  if (res.ok) return data as T;
  if (res.status === 401 || res.status === 404) {
    const me = await getMe().catch(() => null);
    if (me && !me.authenticated) { await showLogin(me); throw new AuthRequired(); }
    if (res.status === 404 && soft404) throw new ApiError(["Not found"], 404);
  }
  throw new ApiError(errMessages(data, res), res.status);
}

interface Me { authenticated: boolean; has_passkeys: boolean }
const getMe = async (): Promise<Me> => (await parse(await raw("/auth/me"))) as Me;

// ---------- state & routing ----------
interface ListState { page: number; per: number; sort: string; dir: "asc" | "desc"; q: string; year: string; review: boolean; missing: string[] }
const defaultList = (): ListState => ({ page: 1, per: 25, sort: "dep", dir: "desc", q: "", year: "", review: false, missing: [] });
// Short labels for the "missing data" groups (mirror REVIEW_GROUPS in src/review.ts).
const MISSING_LABELS: Record<string, string> = {
  airline: "Airline", flight_number: "Flight #", confirmation: "Conf #", times: "Times", aircraft: "Aircraft", seat: "Seat", cabin: "Cabin", fare: "Fare", cost: "Cost",
};
const MISSING_ORDER = Object.keys(MISSING_LABELS);
const missingLabel = (m: string) => MISSING_LABELS[m] ?? m;
let lastListHash = "#/flights";
let navToken = 0;

function parseHash(): { path: string[]; query: URLSearchParams } {
  const hash = location.hash.replace(/^#/, "") || "/flights";
  const [p, qs] = hash.split("?");
  return { path: p.split("/").filter(Boolean), query: new URLSearchParams(qs ?? "") };
}
function listFromQuery(q: URLSearchParams): ListState {
  const d = defaultList();
  const per = Number(q.get("per"));
  return {
    page: Math.max(1, Number(q.get("page")) || 1),
    per: [25, 50, 100].includes(per) ? per : d.per,
    sort: q.get("sort") || d.sort,
    dir: q.get("dir") === "asc" ? "asc" : q.get("dir") === "desc" ? "desc" : d.dir,
    q: q.get("q") ?? "",
    year: q.get("year") ?? "",
    review: q.get("review") === "1" || !!q.get("missing"),
    missing: MISSING_ORDER.filter((g) => (q.get("missing") ?? "").split(",").includes(g)),
  };
}
function listToHash(s: ListState): string {
  const d = defaultList();
  const q = new URLSearchParams();
  if (s.page !== 1) q.set("page", String(s.page));
  if (s.per !== d.per) q.set("per", String(s.per));
  if (s.sort !== d.sort) q.set("sort", s.sort);
  if (s.dir !== d.dir) q.set("dir", s.dir);
  if (s.q) q.set("q", s.q);
  if (s.year) q.set("year", s.year);
  if (s.review && !s.missing.length) q.set("review", "1");
  if (s.review && s.missing.length) q.set("missing", s.missing.join(","));
  const qs = q.toString();
  return "#/flights" + (qs ? "?" + qs : "");
}

async function route() {
  const token = ++navToken;
  const { path, query } = parseHash();
  let me: Me;
  try { me = await getMe(); } catch { app.replaceChildren(h("div", { class: "loading" }, "Can't reach the server.")); return; }
  if (token !== navToken) return;
  if (!me.authenticated) { await showLogin(me); return; }
  const area = path[0] ?? "flights";
  const content = h("div");
  app.replaceChildren(h("div", { class: "shell" }, topbar(area), content));
  if (area !== "flights" || path[1]) refreshReviewBadge();
  try {
    if (area === "stats") await statsView(content, path[1] ?? "", query.get("upcoming") === "1", token);
    else if (area === "flights" && path[1]) await detailView(content, Number(path[1]));
    else if (area === "flights") await listView(content, listFromQuery(query), token);
    else location.replace("#/flights");
  } catch (e) {
    if (e instanceof AuthRequired) return;
    content.replaceChildren(h("div", { class: "card empty" }, (e as Error).message));
  }
}
window.addEventListener("hashchange", route);

// ---------- chrome ----------
let reviewCount = 0;
function setReviewBadge(n: number) {
  reviewCount = n;
  const b = document.getElementById("nav-review");
  if (!b) return;
  b.textContent = String(n);
  b.hidden = n <= 0;
}
async function refreshReviewBadge() {
  try { setReviewBadge((await api<Json>("/api/stats")).needs_review ?? 0); } catch { /* the badge is optional */ }
}

function topbar(active: string): HTMLElement {
  const wrap = h("div", { class: "menu-wrap" });
  const btn = h("button", { class: "btn small", "aria-haspopup": "true" }, "Account");
  let menu: HTMLElement | null = null;
  const close = () => { menu?.remove(); menu = null; document.removeEventListener("click", outside); };
  const outside = (e: Event) => { if (!wrap.contains(e.target as Node)) close(); };
  btn.onclick = (e) => {
    e.stopPropagation();
    if (menu) return close();
    const note = h("div", { class: "note" });
    menu = h("div", { class: "menu", role: "menu" },
      h("button", { onclick: async () => {
        const name = prompt("Name for this passkey (e.g. “iPhone”)", defaultPasskeyName());
        if (name === null) return;
        close();
        try { await registerPasskey({ name: name.trim() || undefined }); alert("Passkey added."); }
        catch (err) { alert(passkeyError(err)); }
      } }, "Add another passkey"),
      h("button", { onclick: async () => { close(); await raw("/auth/logout", { method: "POST" }); location.hash = "#/flights"; route(); } }, "Sign out"),
      note);
    wrap.appendChild(menu);
    setTimeout(() => document.addEventListener("click", outside));
  };
  wrap.appendChild(btn);
  const link = (href: string, label: string, key: string, onclick?: () => void) =>
    h("a", { href, class: active === key ? "active" : "", onclick }, label);
  const brand = h("a", { class: "brand", href: "#/flights" });
  brand.innerHTML = svgPlane;
  brand.append("Flight Logs");
  return h("header", { class: "topbar" }, brand,
    h("nav", { class: "nav" },
      h("a", { href: lastListHash, class: active === "flights" ? "active" : "" }, "Flights",
        h("span", { id: "nav-review", class: "count-badge", hidden: reviewCount <= 0, title: "Flights needing review" }, String(reviewCount))),
      link("#/stats", "Stats", "stats")),
    h("div", { class: "spacer" }), wrap);
}

// ---------- auth views ----------
function defaultPasskeyName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : "Device";
  return os;
}
function passkeyError(e: unknown): string {
  if (e instanceof ApiError) return e.messages.join(", ");
  const err = e as Error;
  if (err?.name === "NotAllowedError") return "Passkey prompt was cancelled or timed out.";
  return err?.message || "Something went wrong.";
}

async function registerPasskey(opts: { setupToken?: string; name?: string }) {
  const tokenBody = opts.setupToken ? { setup_token: opts.setupToken } : {};
  const optionsJSON = await postAuth("/auth/register/options", tokenBody);
  const response = await startRegistration({ optionsJSON });
  await postAuth("/auth/register/verify", { response, name: opts.name, ...tokenBody });
}
async function postAuth(path: string, json: unknown): Promise<any> {
  const res = await raw(path, { method: "POST", json });
  const data = await parse(res);
  if (!res.ok) throw new ApiError(res.status === 401 ? ["Not authorised (check the setup token)"] : errMessages(data, res), res.status);
  return data;
}

async function showLogin(me: Me) {
  const err = h("div", { class: "error", role: "alert" });
  const done = () => { err.textContent = ""; route(); };
  let body: HTMLElement;
  if (me.has_passkeys) {
    const btn = h("button", { class: "btn primary", onclick: async () => {
      btn.disabled = true; err.textContent = "";
      try {
        const optionsJSON = await postAuth("/auth/login/options", {});
        const response = await startAuthentication({ optionsJSON });
        await postAuth("/auth/login/verify", { response });
        done();
      } catch (e) { err.textContent = passkeyError(e); btn.disabled = false; }
    } }, "Sign in with passkey");
    body = h("div", null, h("p", null, "Use your passkey to continue."), btn, err);
  } else {
    const token = h("input", { type: "password", required: true, autocomplete: "off", placeholder: "API_TOKEN" });
    const name = h("input", { type: "text", value: defaultPasskeyName() });
    const submit = h("button", { class: "btn primary", type: "submit" }, "Create passkey");
    const form = h("form", { onsubmit: async (e: Event) => {
      e.preventDefault(); submit.disabled = true; err.textContent = "";
      try { await registerPasskey({ setupToken: token.value, name: name.value.trim() || undefined }); done(); }
      catch (e2) { err.textContent = passkeyError(e2); submit.disabled = false; }
    } },
      h("label", null, "Setup token", token), h("label", null, "Passkey name", name), submit, err);
    body = h("div", null, h("p", null, "First-time setup: enter your setup token to create your first passkey."), form);
  }
  const brand = h("div", { class: "brand", style: "justify-content:center;margin-bottom:14px" });
  brand.innerHTML = svgPlane;
  brand.append("Flight Logs");
  app.replaceChildren(h("div", { class: "card login" }, brand, h("h1", null, me.has_passkeys ? "Welcome back" : "Set up"), body));
}

// Manufacturer prefixes stripped from variant names under a family ("Boeing 737-800" → "737-800").
const MAKERS = ["De Havilland Canada ", "McDonnell Douglas ", "Fairchild ", "Bombardier ", "Embraer ", "Airbus ", "Boeing ", "BAe ", "ATR "];

// ---------- formatting ----------
const fmtNum = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
function fmtDur(min: number | null | undefined): string {
  if (min == null) return "—";
  const hh = Math.floor(min / 60), mm = min % 60;
  return hh ? `${hh}h ${String(mm).padStart(2, "0")}m` : `${mm}m`;
}
function fmtDate(f: Flight): string {
  const d = new Date((f.dep_date || String(f.dep_local).slice(0, 10)) + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
const classRank = (c: string | null) => CLASSES.indexOf(c ?? "");

// ---------- flights list ----------
async function listView(root: HTMLElement, state: ListState, token: number) {
  const s = state;
  let years: number[] = [];
  try {
    const st = await api<Json>("/api/stats");
    years = st.years ?? [];
    setReviewBadge(st.needs_review ?? 0);
  } catch (e) { if (e instanceof AuthRequired) throw e; }
  if (token !== navToken) return;

  const search = h("input", { type: "search", placeholder: "Search flight, airport, airline, code…", value: s.q, "aria-label": "Search" });
  const yearSel = h("select", { "aria-label": "Year" }, h("option", { value: "" }, "All years"),
    years.map((y) => h("option", { value: String(y), selected: String(y) === s.year }, String(y))));
  const chip = h("button", { class: "chip", type: "button", "aria-pressed": String(s.review) }, `Needs review (${reviewCount})`);
  const markBtn = h("button", { class: "btn small", type: "button", disabled: true }, "Mark selected OK (0)");
  markBtn.hidden = !s.review;
  const toolbar = h("div", { class: "toolbar" }, search, yearSel, chip, markBtn);
  const groupBar = h("div", { class: "groupbar", role: "group", "aria-label": "Filter by missing data" });
  groupBar.hidden = !s.review;
  let groupCounts: Record<string, number> = {}, filteredReviewCount = reviewCount;
  const selected = new Set<number>();
  const tableHost = h("div", { class: "card" });
  root.append(toolbar, groupBar, tableHost);

  let timer: number | undefined;
  let seq = 0;
  const sync = () => { lastListHash = listToHash(s); history.replaceState(null, "", lastListHash); };
  const reload = (resetPage = true) => { if (resetPage) s.page = 1; sync(); load(); };
  search.addEventListener("input", () => { clearTimeout(timer); timer = window.setTimeout(() => { s.q = search.value.trim(); reload(); }, 300); });
  yearSel.addEventListener("change", () => { s.year = yearSel.value; reload(); });
  const syncMode = () => {
    chip.setAttribute("aria-pressed", String(s.review)); markBtn.hidden = !s.review; groupBar.hidden = !s.review; renderGroups(); syncMark();
  };
  chip.addEventListener("click", () => { s.review = !s.review; s.missing = []; syncMode(); reload(); });
  const setMissing = (groups: string[]) => { s.review = true; s.missing = MISSING_ORDER.filter((g) => groups.includes(g)); syncMode(); reload(); };
  function renderGroups() {
    const pill = (label: string, on: boolean, onclick: () => void) =>
      h("button", { class: "chip small", type: "button", "aria-pressed": String(on), onclick }, label);
    groupBar.replaceChildren(
      pill(`All (${filteredReviewCount})`, !s.missing.length, () => setMissing([])),
      ...MISSING_ORDER.filter((g) => groupCounts[g] || s.missing.includes(g)).map((g) =>
        pill(`${missingLabel(g)} (${groupCounts[g] ?? 0})`, s.missing.includes(g),
          () => setMissing(s.missing.includes(g) ? s.missing.filter((x) => x !== g) : [...s.missing, g]))));
  }
  function syncMark() {
    const labels = s.missing.map(missingLabel).join(", ");
    markBtn.textContent = s.missing.length ? `Mark ${labels} OK for selected (${selected.size})` : `Mark selected OK (${selected.size})`;
    markBtn.disabled = !selected.size;
  }
  markBtn.addEventListener("click", async () => {
    markBtn.disabled = true;
    try { await api("/api/flights/review", { method: "POST", json: { ids: [...selected], ok: true, ...(s.missing.length ? { groups: s.missing } : {}) } }); }
    catch (e) { if (e instanceof AuthRequired) return; alert((e as Error).message); }
    reload(false);
    refreshReviewBadge();
  });
  sync();

  type Col = { label: string; sort?: string; num?: boolean; firstDir?: "asc" | "desc" };
  const cols: Col[] = [
    { label: "Date", sort: "dep", firstDir: "desc" }, { label: "Flight", sort: "flight" }, { label: "Route", sort: "route" },
    { label: "Airline", sort: "airline" }, { label: "Aircraft", sort: "aircraft" }, { label: "Seat", sort: "seat" },
    { label: "Cabin", sort: "class" }, { label: "Distance", sort: "distance", num: true, firstDir: "desc" },
    { label: "Duration", sort: "duration", num: true, firstDir: "desc" }, { label: "" },
  ];

  async function load() {
    const my = ++seq;
    const qs = new URLSearchParams({ page: String(s.page), per_page: String(s.per), sort: s.sort, dir: s.dir });
    if (s.q) qs.set("q", s.q);
    if (s.year) qs.set("year", s.year);
    if (s.review) qs.set("review", "1");
    if (s.review && s.missing.length) qs.set("missing", s.missing.join(","));
    let data: { flights: Flight[]; total: number; review_count: number; review_group_counts: Record<string, number> };
    try { data = await api(`/api/flights?${qs}`); }
    catch (e) {
      if (e instanceof AuthRequired) return;
      tableHost.replaceChildren(h("div", { class: "empty error" }, (e as Error).message)); return;
    }
    if (my !== seq || token !== navToken) return;
    chip.textContent = `Needs review (${data.review_count})`;
    filteredReviewCount = data.review_count; groupCounts = data.review_group_counts ?? {};
    selected.clear(); renderGroups(); syncMark();
    const pages = Math.max(1, Math.ceil(data.total / s.per));
    if (s.page > pages) { s.page = pages; sync(); return load(); }

    const selAll = h("input", { type: "checkbox", "aria-label": "Select all on this page", disabled: !data.flights.length });
    selAll.addEventListener("change", () => {
      selected.clear();
      if (selAll.checked) for (const f of data.flights) selected.add(f.id);
      table.querySelectorAll<HTMLInputElement>("tbody input[type=checkbox]").forEach((c) => { c.checked = selAll.checked; });
      syncMark();
    });
    const head = h("tr", null, s.review && h("th", { class: "check" }, selAll), cols.map((c) => {
      const active = c.sort === s.sort;
      return h("th", {
        class: (c.sort ? "sortable " : "") + (c.num ? "num" : ""),
        "aria-sort": active ? (s.dir === "asc" ? "ascending" : "descending") : undefined,
        onclick: c.sort ? () => {
          if (active) s.dir = s.dir === "asc" ? "desc" : "asc"; else { s.sort = c.sort!; s.dir = c.firstDir ?? "asc"; }
          reload();
        } : undefined,
      }, c.label, c.sort && h("span", { class: "arrow" }, active ? (s.dir === "asc" ? " ▲" : " ▼") : ""));
    }));
    const rows = data.flights.map((f) => flightRow(f, s.review ? (on) => {
      if (on) selected.add(f.id); else selected.delete(f.id);
      selAll.checked = selected.size === data.flights.length;
      syncMark();
    } : undefined, (g) => setMissing([g])));
    const table = h("table", null, h("thead", null, head), h("tbody", null, rows));
    const from = data.total ? (s.page - 1) * s.per + 1 : 0, to = Math.min(s.page * s.per, data.total);
    const perSel = h("select", { "aria-label": "Rows per page" },
      [25, 50, 100].map((n) => h("option", { value: n, selected: n === s.per }, `${n} / page`)));
    perSel.onchange = () => { s.per = Number(perSel.value); reload(); };
    const go = (p: number) => () => { s.page = p; reload(false); };
    const pager = h("div", { class: "pager" },
      h("span", null, `${fmtNum(from)}–${fmtNum(to)} of ${fmtNum(data.total)}`),
      h("div", { class: "grp" }, perSel,
        h("button", { class: "btn small", disabled: s.page <= 1, onclick: go(s.page - 1) }, "← Prev"),
        h("span", null, `${s.page} / ${pages}`),
        h("button", { class: "btn small", disabled: s.page >= pages, onclick: go(s.page + 1) }, "Next →")));
    tableHost.replaceChildren(
      data.flights.length ? h("div", { class: "table-wrap" }, table) : h("div", { class: "empty" }, "No flights match."),
      pager);
  }
  await load();
}

/** Small muted chips for the data groups this flight is missing (only ones not marked OK). */
function missingChips(f: Flight, onGroup?: (g: string) => void): HTMLElement | null {
  if (!f.needs_review) return null;
  const todo = (f.missing as string[]).filter((m) => !(f.review_ok as string[]).includes(m));
  return h("span", { class: "sub miss", title: "Missing data" }, todo.map((m) => onGroup
    ? h("button", { class: "mchip", type: "button", title: `Show flights missing ${missingLabel(m).toLowerCase()}`,
      onclick: (e: Event) => { e.stopPropagation(); onGroup(m); } }, missingLabel(m))
    : h("span", { class: "mchip" }, missingLabel(m))));
}

function flightRow(f: Flight, onSelect?: (on: boolean) => void, onGroup?: (g: string) => void): HTMLElement {
  const bought = f.purchased_class as string | null, flown = (f.flown_class || f.purchased_class) as string | null;
  let cabin: Child = flown ?? "—";
  if (bought && flown && bought !== flown) {
    const up = classRank(flown) > classRank(bought);
    cabin = h("span", null, h("span", { class: up ? "up" : "down", title: `Purchased ${bought}` }, up ? "↑ " : "↓ "), flown);
  }
  const dim = f.status === "cancelled" || f.status === "replaced";
  return h("tr", { class: dim ? "dim" : "", onclick: () => { location.hash = `#/flights/${f.id}`; } },
    onSelect && h("td", { class: "check", onclick: (e: Event) => e.stopPropagation() },
      h("input", { type: "checkbox", "aria-label": `Select ${f.flight}`, onchange: (e: Event) => onSelect((e.target as HTMLInputElement).checked) })),
    h("td", null, fmtDate(f), h("span", { class: "sub" }, String(f.dep_local ?? "").slice(11, 16))),
    h("td", null, h("a", { class: "flightno", href: `#/flights/${f.id}`, onclick: (e: Event) => e.stopPropagation() }, f.flight)),
    h("td", null, f.dep_airport, h("span", { class: "arrow-sep" }, "→"), f.arr_airport, missingChips(f, onGroup)),
    h("td", null, f.airline ?? "—"),
    h("td", null, f.aircraft_type || f.aircraft_family || "—"),
    h("td", null, f.seat ? [f.seat, f.seat_type && h("span", { class: "sub" }, f.seat_type)] : "—"),
    h("td", null, cabin),
    h("td", { class: "num" }, f.distance_mi == null ? "—" : fmtNum(f.distance_mi) + " mi"),
    h("td", { class: "num" }, fmtDur(f.duration_min)),
    h("td", null, f.status !== "confirmed" ? h("span", { class: `badge ${f.status}` }, f.status) : null));
}

// ---------- flight detail / edit ----------
type FType = "text" | "int" | "num" | "select" | "local" | "area";
interface FieldDef { name: string; label: string; type: FType; options?: readonly string[]; wide?: boolean; ph?: string }
const GROUPS: { title: string; fields: FieldDef[] }[] = [
  { title: "Flight", fields: [
    { name: "carrier_code", label: "Airline code", type: "text", ph: "NH" },
    { name: "flight_number", label: "Flight number", type: "text", ph: "9" },
    { name: "airline", label: "Airline", type: "text" },
    { name: "operating_carrier", label: "Operated by", type: "text" },
    { name: "confirmation_code", label: "Confirmation code", type: "text" },
    { name: "booked_via", label: "Booked via", type: "text" },
    { name: "status", label: "Status", type: "select", options: STATUSES },
  ] },
  { title: "Schedule", fields: [
    { name: "dep_airport", label: "From (IATA)", type: "text", ph: "JFK" },
    { name: "arr_airport", label: "To (IATA)", type: "text", ph: "NRT" },
    { name: "dep_local", label: "Departs (local)", type: "local", ph: "YYYY-MM-DDTHH:MM" },
    { name: "arr_local", label: "Arrives (local)", type: "local", ph: "YYYY-MM-DDTHH:MM" },
    { name: "dep_tz", label: "Departure time zone", type: "text", ph: "America/New_York" },
    { name: "arr_tz", label: "Arrival time zone", type: "text", ph: "Asia/Tokyo" },
    { name: "dep_offset", label: "Departure UTC offset", type: "text", ph: "-04:00" },
    { name: "arr_offset", label: "Arrival UTC offset", type: "text", ph: "+09:00" },
    { name: "duration_min", label: "Duration (min)", type: "int" },
    { name: "distance_mi", label: "Distance (mi)", type: "int" },
  ] },
  { title: "Aircraft", fields: [
    { name: "aircraft_family", label: "Family", type: "text", ph: "Boeing 777" },
    { name: "aircraft_type", label: "Type", type: "text", ph: "Boeing 777-300ER" },
    { name: "aircraft_registration", label: "Registration", type: "text", ph: "JA791A" },
    { name: "aircraft_name", label: "Name", type: "text" },
  ] },
  { title: "Seat & cabin", fields: [
    { name: "seat", label: "Seat", type: "text", ph: "23A" },
    { name: "seat_type", label: "Seat type", type: "select", options: SEAT_TYPES },
    { name: "purchased_class", label: "Purchased cabin", type: "select", options: CLASSES },
    { name: "flown_class", label: "Flown cabin", type: "select", options: CLASSES },
    { name: "upgrade_type", label: "Upgrade type", type: "select", options: UPGRADE_TYPES },
    { name: "upgrade_points_cost", label: "Upgrade points", type: "int" },
    { name: "upgrade_cash_cost", label: "Upgrade cash cost", type: "num" },
    { name: "upgrade_cash_currency", label: "Upgrade currency", type: "text", ph: "USD" },
    { name: "upgrade_cash_cost_usd", label: "Upgrade cash (USD)", type: "num" },
  ] },
  { title: "Cost", fields: [
    { name: "fare_type", label: "Fare type", type: "select", options: FARE_TYPES },
    { name: "points_cost", label: "Points", type: "int" },
    { name: "points_program", label: "Points program", type: "text" },
    { name: "cash_cost", label: "Cash cost", type: "num" },
    { name: "cash_currency", label: "Currency", type: "text", ph: "USD" },
    { name: "cash_cost_usd", label: "Cash cost (USD)", type: "num" },
  ] },
  { title: "Notes", fields: [{ name: "comments", label: "Comments", type: "area", wide: true }] },
];

// ---- local date/time + time-zone helpers ----
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
function tzOffsetMs(zone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const p: Record<string, number> = {};
  for (const x of dtf.formatToParts(new Date(utcMs))) if (x.type !== "literal") p[x.type] = Number(x.value);
  const asUtc = new Date(0);
  asUtc.setUTCFullYear(p.year, p.month - 1, p.day); asUtc.setUTCHours(p.hour, p.minute, p.second, 0);
  return asUtc.getTime() - Math.floor(utcMs / 1000) * 1000;
}
/** Wall-clock "YYYY-MM-DDTHH:MM" in an IANA zone -> UTC ms; null if the zone or time is invalid. */
function localToUtcMs(local: string, zone: string): number | null {
  const m = LOCAL_RE.exec(local);
  if (!m || !zone) return null;
  try {
    const g = new Date(0);
    g.setUTCFullYear(+m[1], +m[2] - 1, +m[3]); g.setUTCHours(+m[4], +m[5], 0, 0);
    const guess = g.getTime();
    const o1 = tzOffsetMs(zone, guess);
    let utc = guess - o1;
    const o2 = tzOffsetMs(zone, utc);
    if (o2 !== o1) utc = guess - o2; // crossed a DST change
    return Number.isFinite(utc) ? utc : null;
  } catch { return null; }
}
function shiftDate(date: string, days: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  const t = new Date(0); t.setUTCFullYear(y, mo - 1, d + days);
  return `${String(t.getUTCFullYear()).padStart(4, "0")}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}
const dayDiff = (a: string, b: string) => {
  const t = (s: string) => { const [y, m, d] = s.split("-").map(Number); const x = new Date(0); x.setUTCFullYear(y, m - 1, d); return x.getTime(); };
  return Math.round((t(b) - t(a)) / 86400000);
};

const toInput = (v: unknown) => (v == null ? "" : String(v));
function fromInput(def: FieldDef, s: string): unknown {
  const t = s.trim();
  if (def.type === "int" || def.type === "num") return t === "" ? null : Number(t);
  return def.type === "area" ? s : t === "" ? null : t;
}

async function detailView(root: HTMLElement, id: number) {
  if (!Number.isInteger(id)) { root.append(h("div", { class: "card empty" }, "Bad flight id.")); return; }
  let flight: Flight = await api(`/api/flights/${id}`, {}, true);
  const controls = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
  const timeCtl = new Map<string, HTMLInputElement>(); // time half of a "local" field; controls holds the date half
  const host = h("div");
  const banner = h("div");
  root.append(h("div", { class: "crumbs" }, h("a", { href: lastListHash }, "← All flights")), banner, host);

  function renderBanner() {
    const missing: string[] = flight.missing ?? [], ok: string[] = flight.review_ok ?? [];
    if (!missing.length) { banner.replaceChildren(); return; }
    const review = async (value: boolean | string[], btn: HTMLButtonElement) => {
      btn.disabled = true;
      try {
        const r = await api<Flight>(`/api/flights/${id}`, { method: "PATCH", json: { review_ok: value } });
        // Keep unsaved edits in the form: only the review fields change here.
        flight = { ...flight, missing: r.missing, review_ok: r.review_ok, needs_review: r.needs_review };
        renderBanner(); refreshReviewBadge();
      } catch (e) { btn.disabled = false; if (!(e instanceof AuthRequired)) alert((e as Error).message); }
    };
    const reopen = async (g: string, btn: HTMLButtonElement) => {
      btn.disabled = true;
      try {
        await api("/api/flights/review", { method: "POST", json: { ids: [id], ok: false, groups: [g] } });
        const r = await api<Flight>(`/api/flights/${id}`);
        flight = { ...flight, missing: r.missing, review_ok: r.review_ok, needs_review: r.needs_review };
        renderBanner(); refreshReviewBadge();
      } catch (e) { btn.disabled = false; if (!(e instanceof AuthRequired)) alert((e as Error).message); }
    };
    const dismissed = ok.filter((m) => missing.includes(m));
    const todo = missing.filter((m) => !dismissed.includes(m));
    const parts: Child[] = [];
    if (todo.length) {
      parts.push(h("span", null, "Missing:"));
      for (const g of todo) {
        const btn = h("button", { class: "btn small", type: "button", title: `Mark ${missingLabel(g)} OK`, onclick: () => review([...dismissed, g], btn) }, "OK");
        parts.push(h("span", { class: "bgroup" }, missingLabel(g), btn));
      }
      const all = h("button", { class: "btn small", type: "button", onclick: () => review(true, all) }, "Mark all OK");
      parts.push(all);
    }
    if (dismissed.length) {
      parts.push(h("span", null, todo.length ? "Marked OK:" : "Marked OK ·"));
      for (const g of dismissed) {
        const btn = h("button", { class: "btn small", type: "button", title: `Reopen ${missingLabel(g)}`, onclick: () => reopen(g, btn) }, "Reopen");
        parts.push(h("span", { class: "bgroup" }, missingLabel(g), btn));
      }
      if (dismissed.length > 1) { const all = h("button", { class: "btn small", type: "button", onclick: () => review(false, all) }, "Reopen all"); parts.push(all); }
    }
    banner.replaceChildren(h("div", { class: todo.length ? "banner attn" : "banner", role: "status" }, parts));
  }

  function render() {
    controls.clear(); timeCtl.clear();
    const f = flight;
    const wraps = new Map<string, HTMLElement>();
    let durTyped = false; // user typed in the duration field (vs. derived from times)
    const durHint = h("div", { class: "fhint" });
    const raw = (name: string): string => {
      const c = controls.get(name)!, t = timeCtl.get(name);
      return t ? (c.value && t.value ? `${c.value}T${t.value}` : "") : c.value;
    };
    const partial = (name: string) => { const t = timeCtl.get(name); return !!t && !controls.get(name)!.value !== !t.value; };
    const refreshAll = () => {
      const fields = changedFields();
      for (const [n, w] of wraps) w.classList.toggle("changed", fields.some(([x]) => x.name === n));
      save.disabled = !fields.length;
    };
    const showDur = (text: string, warn = false) => { durHint.textContent = text; durHint.classList.toggle("warn", warn); };
    // UTC offsets follow the zone and local time too (shown only; the server derives them unless set by hand).
    const offTyped = new Set<string>();
    const fmtOffset = (ms: number) => {
      const m = Math.round(ms / 60000), a = Math.abs(m);
      return `${m < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
    };
    function recompute() {
      for (const [loc, tz, off] of [["dep_local", "dep_tz", "dep_offset"], ["arr_local", "arr_tz", "arr_offset"]] as const) {
        if (locked.has(off) || offTyped.has(off)) continue;
        const l = raw(loc), z = controls.get(tz)!.value.trim();
        const u = l && z ? localToUtcMs(l, z) : null;
        if (u != null) controls.get(off)!.value = fmtOffset(tzOffsetMs(z, u));
      }
      const dep = raw("dep_local"), arr = raw("arr_local");
      const dc = controls.get("duration_min")!;
      showDur("");
      if (!dep || !arr) return;
      const a = localToUtcMs(dep, controls.get("dep_tz")!.value.trim()), b = localToUtcMs(arr, controls.get("arr_tz")!.value.trim());
      if (a == null || b == null) return;
      const min = Math.round((b - a) / 60000);
      if (min <= 0 || min > 1800) { showDur("Arrival is before departure — check the arrival date", true); return; }
      dc.value = String(min); durTyped = false;
      showDur(`${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m (from times)`);
    }
    const errBox = h("div");
    const msg = h("span", { class: "msg muted" });
    const save = h("button", { class: "btn primary", type: "submit", disabled: true }, "Save changes");
    const locked = new Set(f.manual_fields);

    const groups = GROUPS.map((g) => h("fieldset", null, h("legend", null, g.title), h("div", { class: "fields" }, g.fields.map((d) => {
      const wrap = h("div", { class: "field" + (d.wide ? " wide" : "") });
      let c: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      const val = toInput(f[d.name]);
      let tInput: HTMLInputElement | undefined;
      if (d.type === "local") {
        const m = LOCAL_RE.exec(val);
        c = h("input", { id: "f_" + d.name, type: "date", value: m ? val.slice(0, 10) : "", "aria-label": d.label + " date" });
        tInput = h("input", { id: "f_" + d.name + "_time", type: "time", step: "60", value: m ? val.slice(11, 16) : "", "aria-label": d.label + " time" });
        timeCtl.set(d.name, tInput);
      } else if (d.type === "select") {
        c = h("select", { id: "f_" + d.name }, h("option", { value: "" }, "—"),
          d.options!.map((o) => h("option", { value: o, selected: o === val }, o.replaceAll("_", " "))));
        // Keep legacy/unknown values visible instead of silently dropping them.
        if (val && !d.options!.includes(val)) c.append(h("option", { value: val, selected: true }, val));
      } else if (d.type === "area") {
        c = h("textarea", { id: "f_" + d.name, value: val });
      } else {
        c = h("input", { id: "f_" + d.name, type: d.type === "int" || d.type === "num" ? "number" : "text",
          value: val, placeholder: d.ph, step: d.type === "num" ? "any" : d.type === "int" ? "1" : undefined,
          min: d.type === "int" || d.type === "num" ? "0" : undefined, autocomplete: "off" });
      }
      controls.set(d.name, c); wraps.set(d.name, wrap);
      const onchange = () => {
        wrap.classList.remove("invalid"); wrap.querySelector(".ferr")?.remove();
        if (d.name === "duration_min") { durTyped = true; showDur(""); }
        if (d.name === "dep_offset" || d.name === "arr_offset") offTyped.add(d.name);
        if (["dep_local", "arr_local", "dep_tz", "arr_tz"].includes(d.name)) recompute();
        refreshAll();
      };
      c.addEventListener("input", onchange); c.addEventListener("change", onchange);
      tInput?.addEventListener("input", onchange); tInput?.addEventListener("change", onchange);
      if (d.name === "dep_local") {
        // Moving the departure date moves a set arrival date by the same number of days.
        let prev = (c as HTMLInputElement).value;
        c.addEventListener("change", () => {
          const now = (c as HTMLInputElement).value, ad = controls.get("arr_local")!;
          if (now && prev && ad.value && now !== prev) { ad.value = shiftDate(ad.value, dayDiff(prev, now)); recompute(); refreshAll(); }
          if (now) prev = now;
        });
      }
      const lock = locked.has(d.name) && h("span", { class: "lock", title: "Set by hand, so email updates won't overwrite it" },
        "locked (set by hand)",
        h("button", { type: "button", onclick: () => unlock(d.name) }, "Unlock"));
      append(wrap, [h("label", { for: "f_" + d.name }, d.label, lock),
        tInput ? h("div", { class: "dt-pair" }, c, tInput) : c, d.name === "duration_min" ? durHint : null]);
      if (tInput) wrap.classList.add("dt");
      return wrap;
    }))));

    function changedFields(): [FieldDef, unknown][] {
      const out: [FieldDef, unknown][] = [];
      for (const g of GROUPS) for (const d of g.fields) {
        if (d.name === "duration_min" && !locked.has(d.name) && !durTyped) continue; // derived by the server
        if ((d.name === "dep_offset" || d.name === "arr_offset") && !locked.has(d.name) && !offTyped.has(d.name)) continue; // likewise
        const now = fromInput(d, raw(d.name)), was = f[d.name] ?? null;
        if (!(now === was || (now === null && was === "") || (now === "" && was === null))) out.push([d, now]);
      }
      return out;
    }

    const deleteArea = h("span");
    const showDelete = () => {
      deleteArea.replaceChildren(h("span", { class: "error" }, "Delete this flight? "),
        h("button", { class: "btn small danger", type: "button", onclick: async () => {
          try { await api(`/api/flights/${id}`, { method: "DELETE" }); location.hash = lastListHash; }
          catch (e) { if (!(e instanceof AuthRequired)) msg.textContent = (e as Error).message; }
        } }, "Yes, delete"),
        " ", h("button", { class: "btn small", type: "button", onclick: resetDelete }, "Cancel"));
    };
    const resetDelete = () => deleteArea.replaceChildren(h("button", { class: "btn danger", type: "button", onclick: showDelete }, "Delete"));
    resetDelete();

    const form = h("form", { class: "card", novalidate: true, onsubmit: async (e: Event) => {
      e.preventDefault();
      const ch = changedFields();
      if (!ch.length) return;
      const bad = ["dep_local", "arr_local"].filter(partial);
      if (bad.length) {
        for (const n of bad) {
          const w = wraps.get(n)!; w.querySelector(".ferr")?.remove(); w.classList.add("invalid");
          w.appendChild(h("div", { class: "ferr" }, "Enter both a date and a time" + (n === "arr_local" ? ", or clear both" : "")));
        }
        form.querySelector(".invalid")?.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
      save.disabled = true; msg.className = "msg muted"; msg.textContent = "Saving…"; errBox.replaceChildren();
      const body: Json = {};
      for (const [d, v] of ch) body[d.name] = v;
      try {
        flight = await api(`/api/flights/${id}`, { method: "PATCH", json: body });
        refreshReviewBadge();
        // Back to the list as it was (page, sort, filters).
        location.hash = lastListHash;
      } catch (err) {
        if (err instanceof AuthRequired) return;
        const msgs = err instanceof ApiError ? err.messages : [(err as Error).message];
        showErrors(msgs); save.disabled = false; msg.textContent = "";
      }
    } }, groups, errBox, h("div", { class: "actions" }, save, h("button", { class: "btn", type: "button", onclick: render }, "Reset"), msg, deleteArea));

    function showErrors(msgs: string[]) {
      const unmatched: string[] = [];
      for (const m of msgs) {
        const name = m.match(/^([a-z_]+)(?::| can't| isn't)/)?.[1];
        const c = name && controls.get(name);
        if (c) {
          const wrap = c.closest(".field")!;
          wrap.classList.add("invalid");
          wrap.appendChild(h("div", { class: "ferr" }, m.replace(/^[a-z_]+: ?/, "")));
        } else unmatched.push(m);
      }
      if (unmatched.length) errBox.replaceChildren(h("div", { class: "err-list", role: "alert" }, unmatched.length > 1 ? h("ul", null, unmatched.map((m) => h("li", null, m))) : unmatched[0]));
      form.querySelector(".invalid")?.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    async function unlock(field: string) {
      try { flight = await api(`/api/flights/${id}`, { method: "PATCH", json: { unlock: [field] } }); render(); renderBanner(); }
      catch (e) { if (!(e instanceof AuthRequired)) alert((e as Error).message); }
    }

    const title = h("div", { class: "detail-head" },
      h("h1", null, f.flight), h("span", { class: "route" }, `${f.dep_airport} → ${f.arr_airport}`),
      f.status !== "confirmed" && h("span", { class: `badge ${f.status}` }, f.status));
    host.replaceChildren(title, h("div", { class: "grid" }, form, infoPanel(f)));
  }
  render();
  renderBanner();
}

function infoPanel(f: Flight): HTMLElement {
  const dl = (rows: [string, Child][]) => h("dl", null, rows.map(([k, v]) => [h("dt", null, k), h("dd", null, v ?? "—")]));
  const ap = (i: Json | null | undefined, code: string) => (i ? `${i.name}${i.city ? ` (${i.city})` : ""}` : code);
  return h("aside", { class: "card info" },
    h("section", null, h("h3", null, "Airports"), dl([
      ["Departure", ap(f.dep_airport_info, f.dep_airport)], ["Arrival", ap(f.arr_airport_info, f.arr_airport)]])),
    h("section", null, h("h3", null, "Derived"), dl([
      ["Departs (UTC)", f.dep_utc], ["Arrives (UTC)", f.arr_utc],
      ["Departure zone", f.dep_tz && `${f.dep_tz}${f.dep_offset ? " (" + f.dep_offset + ")" : ""}`],
      ["Arrival zone", f.arr_tz && `${f.arr_tz}${f.arr_offset ? " (" + f.arr_offset + ")" : ""}`],
      ["Duration", fmtDur(f.duration_min)],
      ["Distance", f.distance_mi == null ? null : fmtNum(f.distance_mi) + " mi"],
    ])),
    h("section", null, h("h3", null, "Record"), dl([["ID", f.id], ["Created", f.created_at], ["Updated", f.updated_at]])));
}

// ---------- stats ----------
interface Stats {
  year: number | null; include_future: boolean; years: number[]; flights: number; upcoming: number; miles: number; minutes: number; airports: number; top_airports: { code: string; name: string | null; city: string | null; flights: number }[];
  routes: { route: string; flights: number; miles: number }[];
  airlines: { key: string; name: string; flights: number; miles: number; minutes: number; cash_usd: number; points: number }[];
  aircraft: { family: string; flights: number; variants: { type: string; flights: number }[]; unspecified: number }[];
  seat_types: Record<string, number>; cabins: Record<string, number>;
  series: { unit: "year" | "month"; points: SeriesPoint[]; other_currency_flights: number };
}
interface SeriesPoint {
  key: string; flights: number; miles: number; minutes: number; airports: number; new_airports: number;
  premium_share: number | null; cash_usd: number; fare_usd: number; award_usd: number; upgrade_usd: number; points: number;
}

async function statsView(root: HTMLElement, yearArg: string, upcoming: boolean, token: number) {
  const year = /^\d{4}$/.test(yearArg) ? yearArg : "";
  const qs = new URLSearchParams({ ...(year && { year }), ...(upcoming && { future: "1" }) }).toString();
  const s = await api<Stats>("/api/stats" + (qs ? `?${qs}` : ""));
  if (token !== navToken) return;
  const go = (y: string, up: boolean) => { location.hash = "#/stats" + (y ? "/" + y : "") + (up ? "?upcoming=1" : ""); };
  const sel = h("select", { "aria-label": "Year" }, h("option", { value: "" }, "All time"),
    s.years.map((y) => h("option", { value: String(y), selected: String(y) === year }, String(y))));
  sel.onchange = () => go(sel.value, upcoming);
  const toggle = h("label", { class: "stats-toggle" },
    h("input", { type: "checkbox", checked: upcoming, onchange: (e: Event) => go(year, (e.target as HTMLInputElement).checked) }),
    " Include upcoming");
  const hours = Math.round(s.minutes / 60);
  const tile = (label: string, value: Child, hint?: string) =>
    h("div", { class: "card tile" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), hint && h("div", { class: "hint" }, hint));
  type RankItem = { name: Child; label?: string; value: number; display?: string; tip: string; muted?: boolean; onClick?: () => void };
  const rankRows = (items: RankItem[]) => {
    const max = Math.max(1, ...items.map((i) => i.value));
    return items.length ? h("ol", { class: "rank" }, items.map((i) => {
      const cells = [
        h("span", { class: "name" }, i.name, i.onClick && h("span", { class: "chev", "aria-hidden": "true" }, " ›")),
        h("span", { class: "track" }, h("div", { class: "bar", style: `width:${(i.value / max) * 100}%` })),
        h("span", { class: "val" }, i.display ?? fmtNum(i.value))];
      const row = i.onClick
        ? h("button", { type: "button", class: "row", "aria-label": `${i.label ?? i.name}, ${fmtNum(i.value)} flights. Show types`, onclick: i.onClick }, cells)
        : h("div", { class: "row" }, cells);
      return h("li", { title: i.tip, class: i.muted ? "unk" : "" }, row);
    })) : h("div", { class: "nodata" }, "No data");
  };
  const rank = (title: string, items: RankItem[], unit: string) =>
    h("section", { class: "card chart" }, h("h2", null, title), rankRows(items),
      h("div", { class: "hint muted", style: "font-size:12px;margin-top:10px" }, unit));
  /** Top aircraft: family list that drills into a family's types. State is local to the card. */
  const aircraftCard = () => {
    const card = h("section", { class: "card chart" });
    const show = (fam: Stats["aircraft"][number] | null) => {
      if (!fam) {
        const items = s.aircraft.map((r): RankItem => ({
          name: r.family, value: r.flights, tip: `${r.family}: ${r.flights} flights`,
          onClick: r.variants.length || (r.unspecified && r.family !== "Unknown") ? () => show(r) : undefined }));
        card.replaceChildren(h("h2", null, "Top aircraft"), rankRows(items),
          h("div", { class: "hint muted", style: "font-size:12px;margin-top:10px" }, "Flights per aircraft family"));
        return;
      }
      const maker = MAKERS.find((m) => fam.family.startsWith(m)) ?? "";
      const items: RankItem[] = fam.variants.map((v) => {
        const short = v.type.startsWith(maker) ? v.type.slice(maker.length) : v.type;
        return { name: short, value: v.flights, tip: `${v.type}: ${v.flights} flights` };
      });
      if (fam.unspecified) items.push({ name: "Unspecified", value: fam.unspecified, tip: `Unspecified: ${fam.unspecified} flights`, muted: true });
      const back = h("button", { type: "button", class: "back", onclick: () => show(null) }, "← All aircraft");
      card.replaceChildren(h("div", { class: "chart-head" }, h("h2", null, fam.family), back), rankRows(items),
        h("div", { class: "hint muted", style: "font-size:12px;margin-top:10px" }, `Flights per ${fam.family} type`));
      back.focus();
    };
    show(null);
    return card;
  };
  /** Top airlines: ranked by a switchable metric. State is local to the card. */
  const airlinesCard = () => {
    const metrics: { id: string; label: string; value: (r: Stats["airlines"][number]) => number; display?: (n: number) => string; unit: string }[] = [
      { id: "flights", label: "Flights", value: (r) => r.flights, unit: "Flights per airline" },
      { id: "miles", label: "Miles", value: (r) => r.miles, unit: "Miles per airline" },
      { id: "hours", label: "Hours", value: (r) => Math.round(r.minutes / 60), unit: "Hours per airline" },
      { id: "cash", label: "Cash (USD)", value: (r) => r.cash_usd, display: (n) => "$" + fmtNum(Math.round(n)), unit: "Cash spent per airline (USD; fares, award taxes and upgrades)" },
      { id: "points", label: "Points", value: (r) => r.points, unit: "Points per airline" }];
    let m = metrics[0];
    try { m = metrics.find((x) => x.id === localStorage.getItem(AIRLINE_METRIC_KEY)) ?? m; } catch { /* storage unavailable */ }
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Airline metric" });
    const body = h("div");
    const hint = h("div", { class: "hint muted", style: "font-size:12px;margin-top:10px" });
    const card = h("section", { class: "card chart airlines" }, h("h2", null, "Top airlines"), seg, body, hint);
    const render = () => {
      seg.replaceChildren(...metrics.map((x) => h("button", {
        type: "button", class: "seg-btn", "aria-pressed": String(x === m),
        onclick: () => { m = x; try { localStorage.setItem(AIRLINE_METRIC_KEY, x.id); } catch { /* ignore */ } render(); },
      }, x.label)));
      const items = s.airlines.filter((r) => m.value(r) > 0)
        .sort((a, b) => m.value(b) - m.value(a) || b.flights - a.flights || (a.name || a.key).localeCompare(b.name || b.key)).slice(0, 10)
        .map((r): RankItem => {
          const n = r.name || r.key, v = m.value(r);
          return { name: n, value: v, display: m.display?.(v), tip: `${n}: ${r.flights} flights, ${fmtNum(r.miles)} mi, ${fmtNum(Math.round(r.minutes / 60))} hrs`
            + (r.cash_usd ? `, $${fmtNum(Math.round(r.cash_usd))}` : "") + (r.points ? `, ${fmtNum(r.points)} pts` : "") };
        });
      body.replaceChildren(rankRows(items));
      hint.textContent = m.unit;
    };
    render();
    return card;
  };
  root.append(
    year ? h("div", { class: "crumbs" }, h("a", { href: "#/stats" + (upcoming ? "?upcoming=1" : "") }, "← All time")) : "",
    h("div", { class: "stats-head" }, h("h1", null, year || "All time"), h("div", { class: "stats-controls" }, toggle, sel)),
    h("div", { class: "tiles" },
      tile("Flights", fmtNum(s.flights), upcoming && s.upcoming ? `incl. ${fmtNum(s.upcoming)} upcoming` : undefined),
      tile("Miles", fmtNum(s.miles)),
      tile("In the air", [fmtNum(hours), h("small", null, " hrs")], `${fmtNum(s.minutes)} minutes`),
      tile("Airports", fmtNum(s.airports)),
      !upcoming && tile("Upcoming", fmtNum(s.upcoming))),
    seriesCard(s),
    h("div", { class: "charts" },
      rank("Top routes", s.routes.map((r) => ({ name: r.route, value: r.flights, tip: `${r.route}: ${r.flights} flights, ${fmtNum(r.miles)} mi` })), "Flights per route"),
      rank("Top airports", s.top_airports.map((r) => ({
        name: [h("b", { class: "code" }, r.code), r.city && h("span", { class: "muted" }, ` · ${r.city}`)], label: r.code,
        value: r.flights, tip: `${r.code}${r.name ? ` (${r.name})` : ""}: ${r.flights} flights` })), "Flights per airport (departures + arrivals)"),
      airlinesCard(),
      aircraftCard(),
      breakdown("Seat type", s.seat_types, ["window", "middle", "aisle"]),
      breakdown("Cabin", s.cabins, CLASSES)));
}

// ---------- "By year" / "By month" bar chart ----------
interface Metric { id: string; label: string; get: (p: SeriesPoint) => number | null; fmt: (n: number) => string; full: (n: number) => string; unit: string }
/** 12000 -> "12k", 1200000 -> "1.2M" */
function compact(n: number): string {
  const f = (v: number, suf: string) => `${Number(v.toFixed(v < 10 ? 1 : 0))}${suf}`;
  return n >= 1e6 ? f(n / 1e6, "M") : n >= 1e3 ? f(n / 1e3, "k") : String(Math.round(n));
}
const METRICS: Metric[] = [
  { id: "flights", label: "Flights", get: (p) => p.flights, fmt: compact, full: fmtNum, unit: "flights" },
  { id: "miles", label: "Miles", get: (p) => p.miles, fmt: compact, full: fmtNum, unit: "miles" },
  { id: "hours", label: "Hours", get: (p) => Math.round(p.minutes / 60), fmt: compact, full: fmtNum, unit: "hours" },
  { id: "airports", label: "Airports", get: (p) => p.airports, fmt: compact, full: fmtNum, unit: "airports" },
  { id: "new_airports", label: "New airports", get: (p) => p.new_airports, fmt: compact, full: fmtNum, unit: "new airports" },
  { id: "premium", label: "Premium %", get: (p) => (p.premium_share == null ? null : Math.round(p.premium_share * 100)), fmt: (n) => `${n}%`, full: (n) => `${n}%`, unit: "premium cabin" },
  { id: "cash", label: "Cash (USD)", get: (p) => p.cash_usd, fmt: (n) => "$" + compact(n), full: (n) => "$" + fmtNum(n), unit: "cash" },
  { id: "points", label: "Points", get: (p) => p.points, fmt: compact, full: fmtNum, unit: "points" },
];
const METRIC_KEY = "fm.stats.metric";
const AIRLINE_METRIC_KEY = "fm.stats.airlineMetric";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Round-number axis: returns the step and the top of the axis (3-4 gridlines above zero). */
function niceAxis(max: number): { step: number; top: number } {
  if (max <= 0) return { step: 1, top: 1 };
  const want = max / 4, mag = 10 ** Math.floor(Math.log10(want));
  for (const m of [1, 2, 2.5, 5, 10, 20]) {
    const step = m * mag;
    if (step >= want && step >= 1 && Number.isInteger(step)) return { step, top: Math.ceil(max / step) * step };
  }
  return { step: Math.ceil(want), top: Math.ceil(max / Math.ceil(want)) * Math.ceil(want) };
}

function svgEl(tag: string, attrs: Record<string, string | number> = {}, ...kids: (Node | string)[]): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const k of kids) el.append(k);
  return el as SVGElement;
}

const CASH_PARTS = [
  { get: (p: SeriesPoint) => p.fare_usd, cls: "fare", label: "Fares", short: "fares" },
  { get: (p: SeriesPoint) => p.award_usd, cls: "award", label: "Award taxes & fees", short: "award taxes" },
  { get: (p: SeriesPoint) => p.upgrade_usd, cls: "upgrade", label: "Upgrades", short: "upgrades" },
];

function seriesCard(s: Stats): HTMLElement {
  const { unit, points, other_currency_flights } = s.series;
  const isYear = unit === "year";
  let metric = METRICS[0];
  try { metric = METRICS.find((m) => m.id === localStorage.getItem(METRIC_KEY)) ?? metric; } catch { /* storage unavailable */ }

  const title = isYear ? "By year" : `By month — ${s.year}`;
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Metric" });
  const legend = h("div", { class: "series-legend" }, ...CASH_PARTS.map((c) => h("span", null, h("i", { class: `sw sw-${c.cls}` }), c.label)));
  const body = h("div", { class: "series-body" });
  const note = h("div", { class: "hint muted series-note" });
  const card = h("section", { class: "card chart series" }, h("h2", null, title), seg, legend, body, note);
  const tip = h("div", { class: "ctip", role: "presentation", hidden: true });

  const label = (key: string) => (isYear ? key : MONTHS[Number(key.slice(5)) - 1]);
  const longLabel = (key: string) => (isYear ? key : `${label(key)} ${key.slice(0, 4)}`);

  let drawnWidth = 0;
  const draw = () => {
    const wrap = body.querySelector<HTMLElement>(".plot");
    if (!wrap) return;
    const width = Math.floor(wrap.clientWidth);
    if (width < 80) return;
    drawnWidth = width;
    const vals = points.map((p) => metric.get(p));
    const { step, top } = niceAxis(Math.max(0, ...vals.map((v) => v ?? 0)));
    const ticks: number[] = [];
    for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
    const cash = metric.id === "cash";
    const height = 230, mt = 10, mb = 26;
    const ml = Math.max(...ticks.map((t) => metric.fmt(t).length)) * 6.6 + 12, mr = 14;
    const pw = width - ml - mr, ph = height - mt - mb;
    const slot = pw / points.length, bw = Math.max(2, Math.min(40, slot - 2));
    const y = (v: number) => mt + ph - (v / top) * ph;

    const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": `${title}: ${metric.label}` });
    for (const t of ticks) {
      svg.append(svgEl("line", { class: t === 0 ? "axis" : "grid", x1: ml, x2: width - mr, y1: y(t), y2: y(t) }),
        svgEl("text", { class: "tick", x: ml - 6, y: y(t) + 4, "text-anchor": "end" }, metric.fmt(t)));
    }
    // x labels: thin to every 1st/2nd/5th/10th, anchored on the last; first always shown.
    const n = points.length, need = isYear ? 34 : 26;
    const gap = [1, 2, 5, 10].find((g) => g * slot >= need) ?? 10;
    const show = new Set<number>();
    for (let i = n - 1; i >= 0; i -= gap) show.add(i);
    if (!show.has(0)) { for (const i of [...show]) if (i < gap * 0.7) show.delete(i); show.add(0); }
    for (const i of show) svg.append(svgEl("text", { class: "tick", x: ml + slot * (i + 0.5), y: height - 7, "text-anchor": "middle" }, label(points[i].key)));

    const cols: SVGElement[] = [];
    const parts = (p: SeriesPoint) => CASH_PARTS.filter((c) => c.get(p) > 0);
    const partsText = (p: SeriesPoint) => ` — ${parts(p).map((c) => `${c.short} ${metric.full(c.get(p))}`).join(", ")}`;
    const showTip = (i: number) => {
      const p = points[i], v = vals[i];
      tip.replaceChildren(h("b", null, v == null ? "No flights" : `${metric.full(v)} ${metric.unit}`), h("span", null, longLabel(p.key)),
        ...(cash ? CASH_PARTS.filter((c) => c.get(p) > 0).map((c) => h("span", { class: "tip-part" }, h("i", { class: `sw sw-${c.cls}` }), `${c.label} ${metric.full(c.get(p))}`)) : []));
      tip.hidden = false;
      const tw = tip.offsetWidth, cx = ml + slot * (i + 0.5);
      const ty = v == null ? y(0) : y(v);
      tip.style.left = `${Math.max(0, Math.min(width - tw, cx - tw / 2))}px`;
      tip.style.top = `${Math.max(0, ty - tip.offsetHeight - 8)}px`;
    };
    const go = (i: number) => { if (isYear) location.hash = `#/stats/${points[i].key}${s.include_future ? "?upcoming=1" : ""}`; };
    points.forEach((p, i) => {
      const v = vals[i], x = ml + slot * i;
      const col = svgEl("g", {
        class: "col" + (isYear ? " link" : ""), tabindex: i === n - 1 ? 0 : -1, role: isYear ? "link" : "img",
        "aria-label": `${longLabel(p.key)}: ${v == null ? "no flights" : `${metric.full(v)} ${metric.unit}`}${cash && v ? partsText(p) : ""}`,
      });
      col.append(svgEl("rect", { class: "hit", x, y: mt, width: slot, height: ph + mb - 4 }));
      if (v && cash) {
        const bx = x + (slot - bw) / 2, ps = parts(p), gap = 2;
        let base = mt + ph;
        ps.forEach((c, j) => {
          const topSeg = j === ps.length - 1;
          const sh = Math.max(topSeg ? 2 : 2 + gap, (c.get(p) / top) * ph), bh = topSeg ? sh : sh - gap, by = base - bh;
          const r = Math.min(4, bw / 2, bh);
          base -= sh;
          col.append(svgEl("path", { class: `bar seg-${c.cls}`, d: topSeg
            ? `M${bx},${by + bh}V${by + r}Q${bx},${by} ${bx + r},${by}H${bx + bw - r}Q${bx + bw},${by} ${bx + bw},${by + r}V${by + bh}Z`
            : `M${bx},${by}H${bx + bw}V${by + bh}H${bx}Z` }));
        });
      } else if (v) {
        const bx = x + (slot - bw) / 2, bh = Math.max(2, ph - (y(v) - mt)), by = mt + ph - bh, r = Math.min(4, bw / 2, bh);
        col.append(svgEl("path", { class: "bar", d: `M${bx},${by + bh}V${by + r}Q${bx},${by} ${bx + r},${by}H${bx + bw - r}Q${bx + bw},${by} ${bx + bw},${by + r}V${by + bh}Z` }));
      }
      col.append(svgEl("title", {}, `${longLabel(p.key)}: ${v == null ? "no flights" : `${metric.full(v)} ${metric.unit}`}${cash && v ? partsText(p) : ""}`));
      col.addEventListener("pointerenter", () => showTip(i));
      col.addEventListener("pointerleave", () => { if (document.activeElement !== col) tip.hidden = true; });
      col.addEventListener("focus", () => showTip(i));
      col.addEventListener("blur", () => { tip.hidden = true; });
      col.addEventListener("click", () => go(i));
      col.addEventListener("keydown", (e) => {
        const ev = e as KeyboardEvent;
        const to = ev.key === "ArrowLeft" ? i - 1 : ev.key === "ArrowRight" ? i + 1 : ev.key === "Home" ? 0 : ev.key === "End" ? n - 1 : -1;
        if (to >= 0) {
          ev.preventDefault();
          const next = cols[Math.max(0, Math.min(n - 1, to))];
          cols.forEach((c) => c.setAttribute("tabindex", c === next ? "0" : "-1"));
          next.focus();
        } else if ((ev.key === "Enter" || ev.key === " ") && isYear) { ev.preventDefault(); go(i); }
      });
      cols.push(col);
      svg.append(col);
    });
    wrap.replaceChildren(svg, tip);
    tip.hidden = true;
  };

  const render = () => {
    const vals = points.map((p) => metric.get(p));
    const costless = (metric.id === "cash" || metric.id === "points") && vals.every((v) => !v);
    seg.replaceChildren(...METRICS.map((m) => h("button", {
      type: "button", class: "seg-btn", "aria-pressed": String(m === metric),
      onclick: () => { metric = m; try { localStorage.setItem(METRIC_KEY, m.id); } catch { /* ignore */ } render(); },
    }, m.label)));
    if (!points.length || points.every((p) => !p.flights)) body.replaceChildren(h("div", { class: "nodata series-empty" }, "No flights yet"));
    else if (costless) body.replaceChildren(h("div", { class: "nodata series-empty" }, "No cost data yet — costs come from emailed receipts or edits"));
    else {
      body.replaceChildren(h("div", { class: "plot" }));
      draw();
    }
    legend.hidden = metric.id !== "cash" || costless;
    note.textContent = metric.id === "cash" && other_currency_flights > 0
      ? `${other_currency_flights} flight${other_currency_flights === 1 ? "" : "s"} ${other_currency_flights === 1 ? "has no USD value and isn't" : "have no USD value and aren't"} included.` : "";
    note.hidden = !note.textContent;
  };
  render();
  // Redraw at the real pixel width (keeps text legible on phones) once laid out and on resize.
  const ro = new ResizeObserver(() => {
    if (!card.isConnected && drawnWidth) { ro.disconnect(); return; }
    const w = body.querySelector<HTMLElement>(".plot")?.clientWidth ?? 0;
    if (w && Math.abs(w - drawnWidth) > 1) draw();
  });
  ro.observe(body);
  return card;
}

/** Stacked bar + legend (the legend doubles as the data table). Unknown is muted and always last. */
function breakdown(title: string, data: Record<string, number>, order: string[]): HTMLElement {
  const keys = [...order, ...Object.keys(data).filter((k) => k !== "unknown" && !order.includes(k)), "unknown"];
  const entries = keys.map((k, i) => ({ k, n: data[k] ?? 0, color: k === "unknown" ? "var(--unknown)" : `var(--s${(i % 4) + 1})` }));
  const total = entries.reduce((a, e) => a + e.n, 0);
  const label = (k: string) => (k === "unknown" ? "Unknown" : k[0].toUpperCase() + k.slice(1));
  return h("section", { class: "card chart" }, h("h2", null, title),
    total ? [
      h("div", { class: "stack", role: "img", "aria-label": `${title} breakdown` },
        entries.filter((e) => e.n).map((e) => h("span", { style: `flex:${e.n};background:${e.color}`, title: `${label(e.k)}: ${e.n} (${Math.round((e.n / total) * 100)}%)` }))),
      h("ul", { class: "legend" }, entries.filter((e) => e.n || e.k !== "unknown").map((e) =>
        h("li", { class: e.k === "unknown" ? "unk" : "" },
          h("span", { class: "sw", style: `background:${e.color}` }), h("span", { class: "lbl" }, label(e.k)),
          h("span", { class: "n" }, fmtNum(e.n)), h("span", { class: "pct" }, `${Math.round((e.n / total) * 100)}%`)))),
    ] : h("div", { class: "nodata" }, "No data"));
}

route();
