"""Generates the sample .eml files in test/samples (fictional bookings)."""
import json
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path

OUT = Path(__file__).parent / "samples"
ME = "you@example.com"

def flight(num, dep, dep_name, dep_t, arr, arr_name, arr_t, aircraft=None):
    return {"@type": "Flight", "flightNumber": num,
            "airline": {"@type": "Airline", "name": "All Nippon Airways", "iataCode": "NH"},
            "departureAirport": {"@type": "Airport", "name": dep_name, "iataCode": dep},
            "departureTime": dep_t,
            "arrivalAirport": {"@type": "Airport", "name": arr_name, "iataCode": arr},
            "arrivalTime": arr_t, "aircraft": aircraft}

OUT_F = flight("9", "JFK", "New York JFK", "2027-04-23T11:00:00-04:00", "NRT", "Tokyo Narita", "2027-04-24T14:25:00+09:00", "Boeing 777-300ER")
RET_F = flight("NH 0010", "NRT", "Tokyo Narita", "2027-05-02T17:00:00+09:00", "JFK", "New York JFK", "2027-05-02T16:40:00-04:00", "77W")

def res(flt, name, seat=None, status="Confirmed", code="XQ7K2M", price=None):
    r = {"@context": "http://schema.org", "@type": "FlightReservation", "reservationNumber": code,
         "reservationStatus": f"http://schema.org/Reservation{status}",
         "underName": {"@type": "Person", "name": name}, "reservationFor": flt,
         "airplaneSeatClass": {"@type": "AirplaneSeatClass", "name": "Economy"}}
    if seat: r["airplaneSeat"] = seat
    if price: r["totalPrice"], r["priceCurrency"] = price
    return r

def html_with(ld, visible):
    return (f'<html><head><script type="application/ld+json">{json.dumps(ld)}</script></head>'
            f'<body><table><tr><td>{visible}</td></tr></table></body></html>')

def airline_msg(subject, ld, visible, sent=1789000000):
    m = EmailMessage()
    m["From"] = "ANA <noreply@ana.example>"
    m["To"] = ME
    m["Subject"] = subject
    m["Date"] = formatdate(sent)
    m["Message-ID"] = make_msgid(domain="ana.example")
    m.set_content(visible)
    m.add_alternative(html_with(ld, visible), subtype="html")
    return m

def wrap_forward(inner, subject):
    m = EmailMessage()
    m["From"] = f"Me <{ME}>"
    m["To"] = "flights@example.com"
    m["Subject"] = subject
    m["Date"] = formatdate()
    m["Message-ID"] = make_msgid(domain="example.com")
    m.set_content("fyi")
    m.add_attachment(inner, filename="confirmation.eml")
    return m

booking = airline_msg("Your ANA booking XQ7K2M is confirmed",
    [res(OUT_F, "Smith/John Mr", "23A", price=("2486.40", "USD")), res(OUT_F, "SMITH/JANE MS", "23B", price=("2486.40", "USD")),
     res(RET_F, "Smith/John Mr"), res(RET_F, "SMITH/JANE MS")],
    "Booking XQ7K2M: NH9 JFK-NRT 23 Apr, NH10 NRT-JFK 2 May")
(OUT / "01-booking-direct.eml").write_bytes(bytes(booking))

# Same booking, forwarded as an attachment from the allowed address
(OUT / "02-booking-forwarded-as-attachment.eml").write_bytes(
    bytes(wrap_forward(booking, "Fwd: Your ANA booking XQ7K2M is confirmed")))

# Check-in: only John's return seat -> should merge, not wipe
checkin = airline_msg("Check in for NH10", [res(RET_F, "John Smith", "31C")], "Check in now for NH10", sent=1809100000)
(OUT / "03-checkin-one-seat.eml").write_bytes(bytes(wrap_forward(checkin, "Fwd: Check in for NH10")))

# Inline forward with no structured data (needs the Claude fallback)
inline = EmailMessage()
inline["From"] = f"Me <{ME}>"
inline["To"] = "flights@example.com"
inline["Subject"] = "Fwd: Your trip confirmation - Booking ref B6QW9Z"
inline["Date"] = formatdate()
inline["Message-ID"] = make_msgid(domain="example.com")
inline.set_content("""---------- Forwarded message ---------
From: JetBlue <reservations@jetblue.example>
Date: Sat, Oct 17, 2026 at 9:12 AM
Subject: Your trip confirmation - Booking ref B6QW9Z

Confirmation code: B6QW9Z
Flight 1001  New York (JFK) -> Pittsburgh (PIT)
Fri, Nov 20   Departs 7:05am   Arrives 8:52am
Travelers: John Smith, Jane Smith
""")
(OUT / "04-inline-forward-no-markup.eml").write_bytes(bytes(inline))

# Cancellation markup without flight details
cancel = airline_msg("Your booking QQ1234 has been cancelled",
    [{"@context": "http://schema.org", "@type": "FlightReservation", "reservationNumber": "QQ1234",
      "reservationStatus": "http://schema.org/ReservationCancelled",
      "underName": {"@type": "Person", "name": "John Smith"}}],
    "Booking QQ1234 cancelled")
(OUT / "05-cancellation.eml").write_bytes(bytes(wrap_forward(cancel, "Fwd: cancelled")))

# Booking QQ1234 first (to be cancelled by 05 when replayed in order) -> name 00-
qq = airline_msg("Booking QQ1234", [res(flight("2177", "HND", "Tokyo Haneda", "2027-04-27T08:00:00+09:00",
    "ITM", "Osaka Itami", "2027-04-27T09:10:00+09:00"), "John Smith", code="QQ1234")], "QQ1234 HND-ITM")
(OUT / "00-booking-qq1234.eml").write_bytes(bytes(wrap_forward(qq, "Fwd: Booking QQ1234")))

# Boarding pass after an upgrade: same flight, now Business, seat 7K (no reason given)
up = res(OUT_F, "Smith/John Mr", "7K"); up["airplaneSeatClass"] = {"@type": "AirplaneSeatClass", "name": "Business"}
upgraded = airline_msg("Your boarding pass for NH9", [up], "Boarding pass NH9 seat 7K Business", sent=1808400000)
(OUT / "07-boarding-pass-upgraded.eml").write_bytes(bytes(wrap_forward(upgraded, "Fwd: Your boarding pass for NH9")))

# Stranger -> rejected
stranger = airline_msg("Totally your flight", [res(OUT_F, "Mallory", code="EVIL01")], "spam")
del stranger["From"]; stranger["From"] = "mallory@evil.example"
(OUT / "06-unknown-sender.eml").write_bytes(bytes(stranger))
print("\n".join(sorted(p.name for p in OUT.iterdir())))
