// Short Stack website and booking server (Cloudflare Worker).
//
// The website's files in ../public are served by Cloudflare before this code runs;
// requests for anything else come here.
//
//   GET  /site-config.json    rates and settings, for the website
//   GET  /api/booked          booked date ranges from every source, for the website
//   POST /api/checkout        { weekStart, adults, kids, returnUrl } -> { url } of a Stripe Checkout page
//   POST /api/release         { hold } frees a week when the guest backs out of checkout
//   POST /api/stripe-webhook  payment results from Stripe
//   GET  /calendar.ics        direct + hand-entered bookings, for Vrbo and Houfy to import
//
// Card details never reach this server: guests pay on Stripe's own checkout page,
// and only dates, guest contact details, and Stripe reference IDs are stored here.

import config from "../../site-config.json";

const HOLD_MINUTES = 32;           // Stripe Checkout pages last at least 30 minutes; ours close a minute before the hold ends
const DAY_MS = 86400000;
const STRIPE_VERSION = "2026-09-30.endive";   // the webhook endpoint in the Stripe dashboard should use the same version

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const route = `${request.method} ${url.pathname}`;
      if (route === "GET /site-config.json") return json(config, cors);
      if (route === "GET /api/booked") return json({ booked: await bookedRanges(env) }, cors);
      if (route === "POST /api/checkout") return json(await createCheckout(request, env), cors);
      if (route === "POST /api/release") return json(await releaseHold(request, env), cors);
      if (route === "POST /api/stripe-webhook") return await handleWebhook(request, env);
      if (route === "GET /calendar.ics") return await calendarFeed(env);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, cors, err.status);
      console.error(err);
      return json({ error: "Something went wrong. Please try again, or send us an inquiry instead." }, cors, 500);
    }
  },
};

// ---------- Weeks and prices (from site-config.json) ----------

const iso = d => d.toISOString().slice(0, 10);
const addDays = (day, n) => iso(new Date(Date.parse(day + "T00:00:00Z") + n * DAY_MS));
const fmtDay = day => new Date(day + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const overlaps = (a, b) => a.start < b.end && a.end > b.start;

function seasonWeeks() {
  const weeks = [];
  for (let start = config.seasonStart; start < config.seasonEnd; start = addDays(start, 7)) {
    const tier = [...config.rateTiers].reverse().find(t => start >= t.from) || config.rateTiers[0];
    const end = addDays(start, 7);
    weeks.push({ start, end, rate: tier.rate, label: `${fmtDay(start)} – ${fmtDay(end)}, ${end.slice(0, 4)}` });
  }
  return weeks;
}

// ---------- Availability ----------

// includeHolds: count weeks someone is checking out right now (the website shows them as booked)
async function bookedRanges(env, { strict = false, includeHolds = true } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare(
    `SELECT week_start AS start, week_end AS end FROM bookings
     WHERE status IN ('pending', 'paid') OR (? AND status = 'hold' AND expires_at > ?)`
  ).bind(includeHolds ? 1 : 0, now).all();

  const manual = config.booked.map(start => ({ start, end: addDays(start, 7) }));
  const external = await externalBookings(env, strict);
  return mergeRanges([...results, ...manual, ...external]);
}

// Vrbo / Houfy calendars. strict: throw if a feed can't be read (used before taking payment).
async function externalBookings(env, strict) {
  const feeds = [env.VRBO_ICAL_URL, env.HOUFY_ICAL_URL].filter(Boolean);  const ranges = [];
  await Promise.all(feeds.map(async feed => {
    try {
      // Checkout always reads the feeds fresh; the website's availability view may use a 10-minute cache
      const res = await fetch(feed, strict ? {} : { cf: { cacheTtl: 600, cacheEverything: true } });
      if (!res.ok) throw new Error(`calendar feed returned ${res.status}`);
      ranges.push(...parseIcal(await res.text()));
    } catch (err) {
      console.error("Calendar feed failed:", err.message);
      if (strict) throw new HttpError(503, "We couldn't confirm availability right now. Please try again in a few minutes.");
    }
  }));
  return ranges;
}

function parseIcal(text) {
  const events = [];
  let current = null;
  for (const line of text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    if (line === "BEGIN:VEVENT") current = {};
    else if (line === "END:VEVENT" && current) {
      if (current.DTSTART) {
        const start = icalDate(current.DTSTART);
        let end = current.DTEND ? icalDate(current.DTEND) : addDays(start, 1);
        if (end <= start) end = addDays(start, 1);
        events.push({ start, end });
      }
      current = null;
    } else if (current && line.includes(":")) {
      const i = line.indexOf(":");
      current[line.slice(0, i).split(";")[0]] = line.slice(i + 1).trim();
    }
  }
  return events;
}

// All-day dates look like 20270626; timed ones like 20270626T160000Z
const icalDate = v => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;

function mergeRanges(ranges) {
  const merged = [];
  for (const r of [...ranges].sort((a, b) => a.start.localeCompare(b.start))) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = r.end > last.end ? r.end : last.end;
    else merged.push({ start: r.start, end: r.end });
  }
  return merged;
}

// ---------- Checkout ----------

async function createCheckout(request, env) {
  const body = await request.json().catch(() => ({}));
  const week = seasonWeeks().find(w => w.start === body.weekStart);
  if (!week) throw new HttpError(400, "That week isn't available to book.");
  if (week.start <= iso(new Date())) throw new HttpError(400, "That week has already started. Please send us an inquiry instead.");

  const adults = Number.parseInt(body.adults, 10);
  const kids = Number.parseInt(body.kids || 0, 10);
  if (!(adults >= 1) || !(kids >= 0)) throw new HttpError(400, "Please enter at least one adult.");
  if (config.maxGuests && adults + kids > config.maxGuests) {
    throw new HttpError(400, `The house sleeps up to ${config.maxGuests} guests.`);
  }
  const returnUrl = allowedReturnUrl(body.returnUrl, request, env);

  await env.DB.prepare(`UPDATE bookings SET status = 'expired' WHERE status = 'hold' AND expires_at <= ?`)
    .bind(Math.floor(Date.now() / 1000)).run();

  const booked = await bookedRanges(env, { strict: true, includeHolds: false });
  if (booked.some(r => overlaps(r, week))) throw new HttpError(409, "Sorry, that week was just booked. Please pick another week.");

  // Hold the week while the guest is on Stripe's page. The unique index on active
  // weeks means two guests can't both get a hold on the same week. Timed from here, after
  // the calendar checks, so slow feeds can't cut Stripe's page under its 30-minute minimum.
  const now = Math.floor(Date.now() / 1000);
  const holdId = crypto.randomUUID();
  const expiresAt = now + HOLD_MINUTES * 60;
  try {
    await env.DB.prepare(
      `INSERT INTO bookings (id, week_start, week_end, status, adults, kids, created_at, expires_at)
       VALUES (?, ?, ?, 'hold', ?, ?, ?, ?)`
    ).bind(holdId, week.start, week.end, adults, kids, now, expiresAt).run();
  } catch {
    throw new HttpError(409, "Someone else is booking that week right now. Please try again in 30 minutes or pick another week.");
  }

  const tax = Math.round(week.rate * 100 * (config.taxPercent || 0) / 100);
  const lineItems = [{ name: `Short Stack · ${week.label}`, description: "Weekly rental, Saturday to Saturday", cents: week.rate * 100 }];
  if (tax > 0) lineItems.push({ name: `Sales & occupancy tax (${config.taxPercent}%)`, cents: tax });

  const success = new URL(returnUrl); success.searchParams.set("booking", "success"); success.hash = "rates";
  const cancel = new URL(returnUrl); cancel.searchParams.set("booking", "cancelled"); cancel.searchParams.set("hold", holdId); cancel.hash = "rates";
  const metadata = { hold_id: holdId, week_start: week.start, adults, kids };

  let session;
  try {
    session = await stripe(env, "POST", "/v1/checkout/sessions", {
      mode: "payment",
      line_items: lineItems.map(li => ({
        quantity: 1,
        price_data: { currency: "usd", unit_amount: li.cents, product_data: { name: li.name, description: li.description } },
      })),
      custom_fields: [{ key: "guest_name", type: "text", label: { type: "custom", custom: "Full name" } }],
      phone_number_collection: { enabled: true },
      consent_collection: config.requireTerms ? { terms_of_service: "required" } : undefined,
      metadata,
      payment_intent_data: { description: `Short Stack · ${week.label}`, metadata },
      expires_at: expiresAt - 60,
      success_url: success.toString(),
      cancel_url: cancel.toString(),
      integration_identifier: "shortstack_booking_qmzrtwkp",   // labels these checkouts in the Stripe dashboard
    }, holdId);
  } catch (err) {
    await env.DB.prepare(`DELETE FROM bookings WHERE id = ?`).bind(holdId).run();
    throw err;
  }

  await env.DB.prepare(`UPDATE bookings SET stripe_session_id = ? WHERE id = ?`).bind(session.id, holdId).run();
  return { url: session.url };
}

function allowedReturnUrl(value, request, env) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, "Missing return address."); }
  if (!allowedOrigins(request, env).includes(url.origin)) throw new HttpError(400, "Bookings must start from the Short Stack website.");
  url.search = ""; url.hash = "";
  return url.toString();
}

async function releaseHold(request, env) {
  const { hold } = await request.json().catch(() => ({}));
  if (!hold) return { released: false };
  const row = await env.DB.prepare(`SELECT stripe_session_id FROM bookings WHERE id = ? AND status = 'hold'`).bind(hold).first();
  if (!row) return { released: false };
  if (row.stripe_session_id) {
    // Close the Stripe page first, so it can't be paid after the week is released. If it won't
    // close (already paid in another tab, or Stripe unreachable), keep the hold: it lapses on its
    // own, and a payment that went through is still recorded.
    const path = `/v1/checkout/sessions/${row.stripe_session_id}`;
    const session = await stripe(env, "POST", `${path}/expire`)
      .catch(() => stripe(env, "GET", path))
      .catch(() => null);
    if (session?.status !== "expired") return { released: false };
  }
  await env.DB.prepare(`UPDATE bookings SET status = 'released' WHERE id = ? AND status = 'hold'`).bind(hold).run();
  return { released: true };
}

// ---------- Stripe webhook ----------

async function handleWebhook(request, env) {
  const payload = await request.text();
  if (!(await verifyStripeSignature(payload, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET))) {
    return new Response("Bad signature", { status: 400 });
  }
  const event = JSON.parse(payload);
  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      // Bank payments can complete as "unpaid" and settle days later; keep the week blocked meanwhile
      await recordPayment(env, obj, obj.payment_status === "paid");
      break;
    case "checkout.session.expired":
      await env.DB.prepare(`UPDATE bookings SET status = 'expired' WHERE stripe_session_id = ? AND status = 'hold'`).bind(obj.id).run();
      break;
    case "checkout.session.async_payment_failed":
      await env.DB.prepare(
        `UPDATE bookings SET status = 'failed' WHERE stripe_session_id = ? AND status IN ('hold', 'expired', 'released', 'pending', 'conflict')`
      ).bind(obj.id).run();
      break;
    case "charge.refunded":
      // A full refund in the Stripe dashboard cancels the booking and reopens the week
      if (obj.refunded) {
        await env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE payment_intent = ? AND status IN ('pending', 'paid')`)
          .bind(obj.payment_intent).run();
      }
      break;
  }
  return new Response("ok");
}

// Stripe may send an event more than once, or out of order, so a booking only moves forward:
// hold (or a lapsed hold) -> pending -> paid. Paid, refunded and failed bookings stay as they are.
const UNPAID = ["hold", "expired", "released"];

async function recordPayment(env, session, paid) {
  const holdId = session.metadata?.hold_id;
  if (!holdId) return;   // not a website booking, e.g. a Stripe invoice or payment link
  const row = await env.DB.prepare(`SELECT status, week_start, week_end FROM bookings WHERE id = ?`).bind(holdId).first();
  if (!row) {
    console.error(`Payment ${session.payment_intent} is for unknown hold ${holdId}; check it in Stripe.`);
    return;
  }
  if (row.status === "conflict") {
    if (paid) await refundConflict(env, session);   // a bank payment for a double-booked week has now settled
    return;
  }
  if (!(UNPAID.includes(row.status) || (row.status === "pending" && paid))) return;

  // On the first word of a payment, check Vrbo / Houfy didn't book the week while the guest was
  // paying. Not once pending: by then the week is in calendar.ics, and Vrbo may echo it back.
  let status = paid ? "paid" : "pending";
  if (UNPAID.includes(row.status) && await bookedElsewhere(env, { start: row.week_start, end: row.week_end })) {
    status = "conflict";
  }

  const nameField = (session.custom_fields || []).find(f => f.key === "guest_name");
  const details = session.customer_details || {};
  const values = [
    status, session.payment_intent, session.amount_total,
    nameField?.text?.value || details.name || null, details.email || null, details.phone || null,
    Math.floor(Date.now() / 1000), holdId, row.status,
  ];
  const sql = `UPDATE bookings SET status = ?, payment_intent = ?, amount_total = ?, guest_name = ?, guest_email = ?,
               guest_phone = ?, paid_at = ? WHERE id = ? AND status = ?`;
  try {
    await env.DB.prepare(sql).bind(...values).run();
  } catch (err) {
    // The unique index refused it: the hold lapsed and someone else took the week
    if (!/UNIQUE/i.test(err.message)) throw err;
    status = values[0] = "conflict";
    await env.DB.prepare(sql).bind(...values).run();
  }

  if (status === "conflict") {
    console.error(`DOUBLE BOOKING: payment ${session.payment_intent} for ${row.week_start} came in after the week was taken. ` +
      (paid ? "Refunding it." : "It will be refunded when the bank payment settles."));
    if (paid) await refundConflict(env, session);
  }
}

async function bookedElsewhere(env, week) {
  const manual = config.booked.map(start => ({ start, end: addDays(start, 7) }));
  // A calendar that can't be read doesn't count against a guest who has already paid
  const external = await externalBookings(env, true).catch(() => []);
  return [...manual, ...external].some(r => overlaps(r, week));
}

// Full refund for a week that was already taken. The idempotency key means webhook retries refund only once;
// if the refund fails, the webhook errors and Stripe retries it.
async function refundConflict(env, session) {
  await stripe(env, "POST", "/v1/refunds", {
    payment_intent: session.payment_intent,
    metadata: { hold_id: session.metadata.hold_id, reason: "week already booked" },
  }, `refund-${session.metadata.hold_id}`);
}

async function verifyStripeSignature(payload, header, secret) {
  if (!header || !secret) return false;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k === "t") timestamp = v;
    if (k === "v1") signatures.push(v);
  }
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${payload}`));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
  return signatures.some(sig => sig.length === expected.length &&
    [...sig].reduce((diff, c, i) => diff | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0);
}

// ---------- Calendar feed for Vrbo / Houfy ----------

async function calendarFeed(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, week_start, week_end FROM bookings WHERE status IN ('pending', 'paid')`
  ).all();
  const events = [
    ...results.map(r => ({ uid: r.id, start: r.week_start, end: r.week_end })),
    ...config.booked.map(start => ({ uid: `manual-${start}`, start, end: addDays(start, 7) })),
  ];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const day = d => d.replace(/-/g, "");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Short Stack OBX//Direct bookings//EN", "CALSCALE:GREGORIAN",
    ...events.flatMap(e => [
      "BEGIN:VEVENT", `UID:${e.uid}@shortstackobx`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day(e.start)}`, `DTEND;VALUE=DATE:${day(e.end)}`,
      "SUMMARY:Booked (direct)", "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ];
  return new Response(lines.join("\r\n") + "\r\n", { headers: { "Content-Type": "text/calendar; charset=utf-8" } });
}

// ---------- Helpers ----------

async function stripe(env, method, path, params = {}, idempotencyKey) {
  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Stripe-Version": STRIPE_VERSION,
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const body = method === "GET" ? undefined : formEncode(params).toString();
  const res = await fetch(`https://api.stripe.com${path}`, { method, headers, body });
  const data = await res.json();
  if (!res.ok) {
    console.error("Stripe error:", data.error?.message);
    throw new HttpError(502, "Payment setup failed. Please try again, or send us an inquiry instead.");
  }
  return data;
}

// Stripe takes nested form fields: line_items[0][price_data][currency]=usd
function formEncode(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

// This server's own address (workers.dev, a custom domain or localhost), plus any others listed
function allowedOrigins(request, env) {
  return [
    new URL(request.url).origin, new URL(config.siteUrl).origin,
    ...(env.EXTRA_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean),
  ];
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" };
  if (origin && allowedOrigins(request, env).includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, headers, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
