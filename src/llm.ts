// Claude fallback for confirmations with no embedded structured data (most inline
// forwards, since mail clients strip <script> tags when forwarding).
import { bodyForModel } from "./extract";
import { UPGRADE_TYPES, type EmailType, type ExtractedEmail, type ParseResult, type Reservation } from "./types";

const nullableString = { type: ["string", "null"] };

const TOOL = {
  name: "record_flights",
  description: "Record the flight reservations found in an airline or travel-agency email.",
  input_schema: {
    type: "object",
    required: ["email_type", "reservations"],
    properties: {
      email_type: {
        type: "string",
        enum: ["booking", "change", "cancellation", "checkin", "upgrade", "receipt", "other"],
        description:
          "booking = new reservation/itinerary; change = schedule change or rebooking; cancellation; checkin = check-in reminder or boarding pass; upgrade = upgrade/downgrade offer result or confirmation; receipt = payment/e-ticket receipt; other = not about a specific flight booking.",
      },
      notes: { ...nullableString, description: "Anything ambiguous worth a human double-checking." },
      reservations: {
        type: "array",
        items: {
          type: "object",
          required: ["confirmation_code", "passengers", "segments"],
          properties: {
            confirmation_code: {
              type: "string",
              description: "Airline record locator / PNR (usually 6 characters). Prefer the airline's code over an agency itinerary number.",
            },
            airline_name: nullableString,
            booked_via: { ...nullableString, description: "Travel agency or OTA if booked through one." },
            status: { type: ["string", "null"], enum: ["confirmed", "pending", "changed", "cancelled", null] },
            fare_type: {
              type: ["string", "null"],
              enum: ["cash", "award", null],
              description: "award if paid with miles/points (even if taxes were paid in cash), cash if paid with money. null if the email doesn't show payment.",
            },
            points_cost: { type: ["number", "null"], description: "Total miles/points charged for the whole booking." },
            points_program: { ...nullableString, description: "Loyalty program the points came from, e.g. \"United MileagePlus\"." },
            cash_cost: { type: ["number", "null"], description: "Total money charged for the whole booking (fare + taxes/fees; for awards, just the taxes/fees). Plain number, no symbols." },
            cash_currency: { ...nullableString, description: "ISO 4217 code of cash_cost, e.g. USD, JPY." },
            cost_is_per_passenger: {
              type: "boolean",
              description: "True if points_cost/cash_cost are the traveller's own share (the receipt itemises per passenger); false if they are the whole booking's total.",
            },
            is_full_itinerary: {
              type: "boolean",
              description: "True only if this email lists every flight currently on the booking (so any flight it omits is no longer on it).",
            },
            passengers: {
              type: "array",
              items: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" }, ticket_number: nullableString, frequent_flyer: nullableString },
              },
            },
            segments: {
              type: "array",
              items: {
                type: "object",
                required: ["carrier_code", "flight_number", "dep_airport", "dep_time", "arr_airport"],
                properties: {
                  carrier_code: { ...nullableString, description: "2-character IATA code of the marketing carrier, e.g. UA, NH, B6." },
                  carrier_name: nullableString,
                  flight_number: { type: "string", description: "Number only, e.g. \"9\" for NH9." },
                  operating_carrier: nullableString,
                  dep_airport: { type: "string", description: "3-letter IATA code." },
                  dep_airport_name: nullableString,
                  dep_time: { type: "string", description: "Local departure time as printed, ISO 8601 without offset: YYYY-MM-DDTHH:MM." },
                  arr_airport: { type: "string", description: "3-letter IATA code." },
                  arr_airport_name: nullableString,
                  arr_time: { ...nullableString, description: "Local arrival time, YYYY-MM-DDTHH:MM (date may differ from departure)." },
                  aircraft: { ...nullableString, description: "Aircraft exactly as printed, e.g. \"Boeing 787-9\", \"77W\", \"Airbus A321neo\"." },
                  cabin: { ...nullableString, description: "Cabin/class as printed, e.g. Economy, Premium Economy, Business, First, Main Cabin." },
                  seats: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["passenger"],
                      properties: {
                        passenger: nullableString,
                        seat: { ...nullableString, description: "e.g. 23A" },
                        travel_class: { ...nullableString, description: "This passenger's cabin if it differs or is listed per passenger." },
                      },
                    },
                  },
                  status: { type: ["string", "null"], enum: ["confirmed", "pending", "changed", "cancelled", null] },
                  upgraded_to: { ...nullableString, description: "New cabin if the email reports the traveller was upgraded or downgraded on this flight." },
                  upgrade_type: {
                    type: ["string", "null"],
                    enum: [...UPGRADE_TYPES, null],
                    description: "Why the cabin changed, only if the email says: complimentary_upgrade (elite/status), op_up (operational), mileage_upgrade (miles/points), cash_upgrade (bought), bid_upgrade (auction), certificate_upgrade (PlusPoints, GPU, voucher), op_down (involuntary downgrade), voluntary_downgrade.",
                  },
                  upgrade_points_cost: { type: ["number", "null"], description: "Miles/points charged for the upgrade on this flight." },
                  upgrade_cash_cost: { type: ["number", "null"], description: "Money charged for the upgrade (or co-pay) on this flight." },
                  upgrade_cash_currency: nullableString,
                },
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM = `You extract flight reservations from emails for a personal travel log.
Rules:
- Only record flights. Ignore hotels, cars, ads, and "you might also like" content.
- Use 3-letter IATA airport codes. If only a city/airport name is given, use the airport's IATA code if you are confident; otherwise skip that segment.
- Times are local to each airport, exactly as printed, formatted YYYY-MM-DDTHH:MM. Do not convert time zones. If the year is missing, infer it from the email's sent date (the next occurrence on or after it). Arrivals marked "+1", "next day" or similar fall on the following date.
- One segment per flight number. A connection is two segments.
- For schedule changes, record the NEW schedule. Set is_full_itinerary true only if the email shows the whole current itinerary.
- For cancellations, set status "cancelled" on the reservation (and on specific segments if only some were cancelled).
- If the email was forwarded, the original airline message is inside it; use that.
- Attached PDFs (e-tickets, receipts, itineraries) are part of the email; read them as well as the body.
- Record the aircraft, seats and cabin only where the email states them.
- Costs: if the receipt itemises per passenger, give the traveller's own amount and set cost_is_per_passenger true; otherwise give the booking total and set it false. Never split costs per flight. Upgrade charges go in the segment's upgrade_* fields, not in the booking cost.
- Seats: list every passenger's seat you can see; the traveller is identified separately.
- Never invent values. Use null when something is not stated.
- If the email is not about a flight booking, use email_type "other" with an empty reservations list.`;

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function parseWithClaude(e: ExtractedEmail, apiKey: string, model: string, myName?: string): Promise<ParseResult> {
  const pdfs = e.pdfs ?? [];
  const prompt = [
    ...(myName ? [`The traveller whose log this is: ${myName}`, ""] : []),
    `Subject: ${e.subject}`,
    `From: ${e.from ?? "unknown"}`,
    `Sent: ${e.originalDate ?? e.date ?? "unknown"}`,
    ...(pdfs.length ? [`Attached PDFs: ${pdfs.map((p) => p.filename ?? "unnamed").join(", ")}`] : []),
    "",
    bodyForModel(e),
  ].join("\n");
  const content = [
    ...pdfs.map((p) => ({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64(p.data) },
      ...(p.filename ? { title: p.filename } : {}),
    })),
    { type: "text", text: prompt },
  ];

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [{ role: "user", content }],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Claude API ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  const data = (await resp.json()) as { stop_reason?: string; content: Array<{ type: string; name?: string; input?: any }> };
  if (data.stop_reason === "max_tokens") {
    throw new Error("Claude API response was truncated (hit max_tokens); not saving partial results");
  }
  const call = data.content.find((c) => c.type === "tool_use" && c.name === TOOL.name);
  if (!call?.input) throw new Error("Claude API returned no structured result");

  const input = call.input as { email_type: EmailType; reservations: Reservation[]; notes?: string | null };
  return {
    email_type: input.email_type ?? "other",
    reservations: Array.isArray(input.reservations) ? input.reservations : [],
    method: "llm",
    notes: input.notes ?? undefined,
  };
}
