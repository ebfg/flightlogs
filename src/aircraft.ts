// Aircraft normalisation: turns whatever an email prints ("Boeing 777-300ER", "77W",
// "B789", "Airbus A321neo (Sharklets)") into a type and family. Order matters: more
// specific variants come before the generic ones they'd otherwise match.

interface AircraftType {
  type: string;
  family: string;
  /** IATA equipment codes and ICAO type designators, matched as whole tokens. */
  codes: string[];
  /** Matched against the text uppercased with spaces, hyphens and dots removed. */
  re: RegExp;
}

const A320 = "Airbus A320", A220 = "Airbus A220", A330 = "Airbus A330", A340 = "Airbus A340";
const A350 = "Airbus A350", A380 = "Airbus A380", B737 = "Boeing 737", B747 = "Boeing 747";
const B757 = "Boeing 757", B767 = "Boeing 767", B777 = "Boeing 777", B787 = "Boeing 787";
const EJET = "Embraer E-Jet", E2 = "Embraer E-Jet E2", CRJ = "Bombardier CRJ";
const DASH8 = "De Havilland Canada Dash 8", ATR = "ATR 42/72", ERJ = "Embraer ERJ";
const B717 = "Boeing 717", DC9 = "McDonnell Douglas DC-9", MD80 = "McDonnell Douglas MD-80";
const MD90 = "McDonnell Douglas MD-90", D328 = "Dornier 328", BAE146 = "BAe 146";

const TYPES: AircraftType[] = [
  // Airbus narrowbody
  { type: "Airbus A321XLR", family: A320, codes: ["32X"], re: /A321XLR/ },
  { type: "Airbus A321neo", family: A320, codes: ["32Q", "A21N"], re: /A321NEO|A321LR/ },
  { type: "Airbus A321", family: A320, codes: ["321", "32B", "A321"], re: /A321/ },
  { type: "Airbus A320neo", family: A320, codes: ["32N", "A20N"], re: /A320NEO/ },
  { type: "Airbus A320", family: A320, codes: ["320", "32A", "A320"], re: /A320/ },
  { type: "Airbus A319neo", family: A320, codes: ["31N", "A19N"], re: /A319NEO/ },
  { type: "Airbus A319", family: A320, codes: ["319", "A319"], re: /A319/ },
  { type: "Airbus A318", family: A320, codes: ["318", "A318"], re: /A318/ },
  { type: "Airbus A220-100", family: A220, codes: ["221", "BCS1"], re: /A220100|CS100/ },
  { type: "Airbus A220-300", family: A220, codes: ["223", "BCS3"], re: /A220300|CS300/ },
  // Airbus widebody
  { type: "Airbus A330-900neo", family: A330, codes: ["339", "A339"], re: /A330900|A339/ },
  { type: "Airbus A330-800neo", family: A330, codes: ["338", "A338"], re: /A330800|A338/ },
  { type: "Airbus A330-300", family: A330, codes: ["333", "A333"], re: /A330300/ },
  { type: "Airbus A330-200", family: A330, codes: ["332", "A332"], re: /A330200/ },
  { type: "Airbus A340-600", family: A340, codes: ["346", "A346"], re: /A340600/ },
  { type: "Airbus A340-300", family: A340, codes: ["343", "A343"], re: /A340300/ },
  { type: "Airbus A350-1000", family: A350, codes: ["351", "A35K"], re: /A3501000/ },
  { type: "Airbus A350-900ULR", family: A350, codes: [], re: /A350900ULR|A359ULR|A350ULR/ },
  { type: "Airbus A350-900", family: A350, codes: ["359", "A359"], re: /A350900/ },
  { type: "Airbus A380-800", family: A380, codes: ["388", "A388"], re: /A380/ },
  // Boeing
  { type: "Boeing 737 MAX 10", family: B737, codes: ["7MJ", "B3XM"], re: /737MAX10|73710(?!\d)/ },
  { type: "Boeing 737 MAX 9", family: B737, codes: ["7M9", "B39M"], re: /737MAX9|7379(?!\d)/ },
  { type: "Boeing 737 MAX 8", family: B737, codes: ["7M8", "B38M"], re: /737MAX8|7378(?!\d)/ },
  { type: "Boeing 737-900", family: B737, codes: ["739", "73J", "B739"], re: /737900/ },
  { type: "Boeing 737-800", family: B737, codes: ["738", "73H", "B738"], re: /737800/ },
  { type: "Boeing 737-700", family: B737, codes: ["73G", "73W", "B737"], re: /737700/ },
  { type: "Boeing 737-500", family: B737, codes: ["735", "B735"], re: /737500/ },
  { type: "Boeing 737-400", family: B737, codes: ["734", "B734"], re: /737400/ },
  { type: "Boeing 737-300", family: B737, codes: ["733", "B733"], re: /737300/ },
  { type: "Boeing 717-200", family: B717, codes: ["717", "B712"], re: /(?<!\d)717200|B712|B717(?!\d)/ },
  { type: "Boeing 747-8", family: B747, codes: ["74H", "B748"], re: /7478(?!\d)|7478I/ },
  { type: "Boeing 747-400", family: B747, codes: ["744", "B744"], re: /747400/ },
  { type: "Boeing 757-300", family: B757, codes: ["753", "B753"], re: /757300/ },
  { type: "Boeing 757-200", family: B757, codes: ["752", "75W", "B752"], re: /757200/ },
  { type: "Boeing 767-400ER", family: B767, codes: ["764", "B764"], re: /767400/ },
  { type: "Boeing 767-300ER", family: B767, codes: ["76W"], re: /767300ER/ },
  { type: "Boeing 767-300", family: B767, codes: ["763", "B763"], re: /767300/ },
  { type: "Boeing 777-9", family: B777, codes: ["779", "B779"], re: /7779(?!\d)|777X/ },
  { type: "Boeing 777-300ER", family: B777, codes: ["77W", "B77W"], re: /777300ER/ },
  { type: "Boeing 777-300", family: B777, codes: ["773", "B773"], re: /777300/ },
  { type: "Boeing 777-200LR", family: B777, codes: ["77L", "B77L"], re: /777200LR/ },
  { type: "Boeing 777-200ER", family: B777, codes: ["77E"], re: /777200ER/ },
  { type: "Boeing 777-200", family: B777, codes: ["772", "B772"], re: /777200/ },
  { type: "Boeing 787-10", family: B787, codes: ["781", "B78X"], re: /78710(?!\d)/ },
  { type: "Boeing 787-9", family: B787, codes: ["789", "B789"], re: /7879(?!\d)/ },
  { type: "Boeing 787-8", family: B787, codes: ["788", "B788"], re: /7878(?!\d)/ },
  // McDonnell Douglas
  { type: "McDonnell Douglas MD-90", family: MD90, codes: ["M90", "MD90"], re: /MD90/ },
  { type: "McDonnell Douglas MD-88", family: MD80, codes: ["M88", "MD88"], re: /MD88/ },
  { type: "McDonnell Douglas DC-9-50", family: DC9, codes: ["D95", "DC95"], re: /DC95\d?/ },
  // Regional
  { type: "Fairchild Dornier 328JET", family: D328, codes: ["FRJ", "J328"], re: /328JET/ },
  { type: "Embraer E195-E2", family: E2, codes: ["295", "E295"], re: /E195E2|E2195/ },
  { type: "Embraer E190-E2", family: E2, codes: ["290", "E290"], re: /E190E2|E2190/ },
  { type: "Embraer E195", family: EJET, codes: ["E95", "E195"], re: /(E|EMB|EMBRAER|ERJ)195/ },
  { type: "Embraer E190", family: EJET, codes: ["E90", "E190"], re: /(E|EMB|EMBRAER|ERJ)190/ },
  { type: "Embraer E175", family: EJET, codes: ["E75", "E7W", "E175"], re: /(E|EMB|EMBRAER|ERJ)175/ },
  { type: "Embraer E170", family: EJET, codes: ["E70", "E170"], re: /(E|EMB|EMBRAER|ERJ)170/ },
  { type: "Embraer ERJ-145", family: ERJ, codes: ["ER4", "E145"], re: /(ERJ|EMB|EMBRAER)145/ },
  { type: "Bombardier CRJ900", family: CRJ, codes: ["CR9", "CRJ9"], re: /CRJ900|CRJ9(?!\d)/ },
  { type: "Bombardier CRJ700", family: CRJ, codes: ["CR7", "CRJ7"], re: /CRJ700|CRJ7(?!\d)/ },
  { type: "Bombardier CRJ200", family: CRJ, codes: ["CR2", "CRJ2"], re: /CRJ200|CRJ2(?!\d)/ },
  { type: "De Havilland Canada Dash 8-300", family: DASH8, codes: ["DH3", "DH8C"], re: /Q300|DASH8300|DHC8300/ },
  { type: "De Havilland Canada Dash 8-400", family: DASH8, codes: ["DH4", "DH8D"], re: /Q400|DASH8400|DHC8400/ },
  // CRJ100 contains "RJ100", hence the lookbehinds.
  { type: "Avro RJ100", family: BAE146, codes: ["AR1", "RJ1H"], re: /(?<!C)RJ100/ },
  { type: "Avro RJ85", family: BAE146, codes: ["AR8", "RJ85"], re: /(?<!C)RJ85/ },
  { type: "Avro RJ70", family: BAE146, codes: ["AR7", "RJ70"], re: /(?<!C)RJ70/ },
  { type: "BAe 146-300", family: BAE146, codes: ["143", "B463"], re: /146300/ },
  { type: "BAe 146-200", family: BAE146, codes: ["142", "B462"], re: /146200/ },
  { type: "BAe 146-100", family: BAE146, codes: ["141", "B461"], re: /146100/ },
  { type: "ATR 72", family: ATR, codes: ["AT7", "AT72", "AT75", "AT76"], re: /ATR72/ },
  { type: "ATR 42", family: ATR, codes: ["AT4", "AT45", "AT46"], re: /ATR42/ },
];

/** When only the family can be told ("Boeing 777", "Dreamliner"). */
const FAMILIES: Array<[RegExp, string]> = [
  [/A32[01]|A31[89]/, A320], [/A220|CS[13]00/, A220], [/A330/, A330], [/A340/, A340], [/A350/, A350],
  [/A380/, A380], [/737/, B737], [/747/, B747], [/757/, B757], [/767/, B767], [/777/, B777],
  [/787|DREAMLINER/, B787], [/CRJ/, CRJ], [/DASH8|Q400/, DASH8], [/ATR/, ATR],
  [/(?<!\d)717(?!\d)/, B717], [/MD8\d/, MD80], [/MD90/, MD90], [/DC9/, DC9], [/D328|DORNIER328/, D328],
  [/BAE146|AVRORJ/, BAE146],
];

const BY_CODE = new Map<string, AircraftType>();
for (const t of TYPES) for (const c of t.codes) BY_CODE.set(c, t);

const BY_TYPE = new Map(TYPES.map((t) => [t.type.toUpperCase(), t]));

export function normalizeAircraft(raw: string | null | undefined): { type: string | null; family: string | null } {
  if (!raw) return { type: null, family: null };
  const upper = raw.toUpperCase();
  for (const tok of upper.split(/[^A-Z0-9]+/)) {
    const t = BY_CODE.get(tok);
    if (t) return { type: t.type, family: t.family };
  }
  const compact = upper.replace(/[\s\-_.]/g, "");
  for (const t of TYPES) if (t.re.test(compact)) return { type: t.type, family: t.family };
  for (const [re, family] of FAMILIES) if (re.test(compact)) return { type: null, family };
  return { type: null, family: null };
}

/** Family for a type someone typed in by hand. */
export function familyForType(type: string | null | undefined): string | null {
  if (!type) return null;
  return BY_TYPE.get(type.toUpperCase())?.family ?? normalizeAircraft(type).family;
}

// Single-aisle families whose cabins use A/F window, C/D aisle, B/E middle in economy
// (2-2 premium cabins on these use A/C/D/F, which maps the same way).
const NARROWBODY_3_3 = new Set([A320, B737, B757, A220]);

export function inferSeatType(
  seat: string | null | undefined,
  family: string | null | undefined,
  travelClass: string | null | undefined,
): "window" | "middle" | "aisle" | null {
  const m = /^\d{1,3}([A-Z])$/.exec(seat?.toUpperCase().trim() ?? "");
  if (!m) return null;
  const letter = m[1];
  if (letter === "A") return "window"; // window on essentially every airliner layout
  const premium = travelClass && !/economy|coach/i.test(travelClass);
  if (!family || !NARROWBODY_3_3.has(family) || premium) return null;
  if (letter === "F") return "window";
  if (letter === "C" || letter === "D") return "aisle";
  if (letter === "B" || letter === "E") return "middle";
  return null;
}

/** Map an airline's cabin name to a standard class where it's clear; otherwise keep theirs. */
export function normalizeClass(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/premium\s*(economy|select|plus)|world traveller plus/i.test(s)) return "Premium Economy";
  if (/\bfirst\b|la premi[eè]re|\bsuites?\b/i.test(s)) return "First";
  if (/business|polaris|club world|upper class|delta one|\bmint\b|flagship business/i.test(s)) return "Business";
  if (/economy|coach|main cabin|basic|standard|comfort\+?|economy plus|even more space/i.test(s)) return "Economy";
  return s;
}
