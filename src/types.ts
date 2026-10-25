export interface Env {
  DB: D1Database;
  ALLOWED_SENDERS: string;
  /** Your name as it appears on tickets; comma-separate variants ("Chris Smith, Christopher Smith"). */
  MY_NAME?: string;
  CLAUDE_MODEL?: string;
  REPLY_ENABLED?: string;
  ANTHROPIC_API_KEY?: string;
  API_TOKEN?: string;
  FLIGHTAWARE_API_KEY?: string;
  /** "true": the daily AeroAPI lookup records what it finds (aircraft_lookups) without changing flights. */
  FLIGHTAWARE_DRY_RUN?: string;
  /** Send binding for the post-landing seat prompts (locked to one destination in wrangler.toml). */
  SEAT_EMAIL?: SendEmail;
  PROMPT_FROM?: string;
  /** Where the seat prompts go; must match the send_email destination_address. */
  SEAT_PROMPT_TO?: string;
  /** "false" turns the seat prompts off. */
  SEAT_PROMPTS?: string;
  /** WebAuthn relying party id (the domain, e.g. example.com) and the exact origin of the UI. */
  RP_ID?: string;
  ORIGIN?: string;
  ASSETS?: Fetcher;
}

export type EmailType = "booking" | "change" | "cancellation" | "checkin" | "upgrade" | "receipt" | "other";

export const UPGRADE_TYPES = [
  "complimentary_upgrade", "op_up", "mileage_upgrade", "cash_upgrade", "bid_upgrade",
  "certificate_upgrade", "op_down", "voluntary_downgrade",
] as const;
export type UpgradeType = (typeof UPGRADE_TYPES)[number];
export type Status = "confirmed" | "pending" | "changed" | "cancelled";

export interface Passenger {
  name: string;
  ticket_number?: string | null;
  frequent_flyer?: string | null;
}

export interface Seat {
  passenger?: string | null;
  seat?: string | null;
  travel_class?: string | null;
}

export interface Segment {
  carrier_code: string | null;
  carrier_name?: string | null;
  flight_number: string;
  operating_carrier?: string | null;
  dep_airport: string;
  dep_airport_name?: string | null;
  dep_time: string;
  arr_airport: string;
  arr_airport_name?: string | null;
  arr_time?: string | null;
  /** Aircraft as printed, e.g. "Boeing 787-9" or "77W". */
  aircraft?: string | null;
  cabin?: string | null;
  /** Cabin after an upgrade/downgrade the email reports. */
  upgraded_to?: string | null;
  upgrade_type?: UpgradeType | null;
  upgrade_points_cost?: number | null;
  upgrade_cash_cost?: number | null;
  upgrade_cash_currency?: string | null;
  upgrade_cash_cost_usd?: number | null;
  seats?: Seat[];
  status?: Status | null;
}

export interface Reservation {
  confirmation_code: string;
  airline_name?: string | null;
  booked_via?: string | null;
  status?: Status | null;
  fare_type?: "cash" | "award" | null;
  points_cost?: number | null;
  points_program?: string | null;
  cash_cost?: number | null;
  cash_currency?: string | null;
  cash_cost_usd?: number | null;
  /** True when the cost fields are already for one traveller rather than the whole booking. */
  cost_is_per_passenger?: boolean;
  /** True when the email lists the whole current itinerary, so segments it omits are no longer flown. */
  is_full_itinerary?: boolean;
  passengers: Passenger[];
  segments: Segment[];
}

export interface ParseResult {
  email_type: EmailType;
  reservations: Reservation[];
  method: "structured" | "llm" | "none" | "manual";
  notes?: string;
}

export interface PdfAttachment {
  filename: string | null;
  data: Uint8Array;
}

export interface ExtractedEmail {
  messageId: string | null;
  /** From header of the outer message (the person who forwarded it). */
  outerFrom: string | null;
  /** From header of the confirmation itself (inner message if forwarded as an attachment). */
  from: string | null;
  subject: string;
  date: string | null;
  /** When the airline sent the confirmation, if the parser found it in a forwarded copy (inline "Date:" line or attached message). */
  originalDate?: string | null;
  html: string;
  text: string;
  forwardedAsAttachment: boolean;
  /** PDF attachments (e-tickets, receipts, itineraries), sent to Claude alongside the text. */
  pdfs?: PdfAttachment[];
}
