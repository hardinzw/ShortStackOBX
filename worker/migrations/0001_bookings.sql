-- One row per booking attempt. Card details are never stored: Stripe keeps those.
CREATE TABLE bookings (
  id                TEXT PRIMARY KEY,      -- hold ID, also sent to Stripe as metadata
  week_start        TEXT NOT NULL,         -- check-in Saturday, YYYY-MM-DD
  week_end          TEXT NOT NULL,         -- check-out Saturday
  -- hold: guest is on the Stripe page | pending: bank payment settling | paid
  -- expired / released / failed: never paid | cancelled: fully refunded
  -- conflict: paid for a week that was already taken; refunded automatically
  status            TEXT NOT NULL,
  adults            INTEGER,
  kids              INTEGER,
  guest_name        TEXT,
  guest_email       TEXT,
  guest_phone       TEXT,
  amount_total      INTEGER,               -- cents, including tax
  stripe_session_id TEXT,
  payment_intent    TEXT,
  created_at        INTEGER NOT NULL,      -- unix seconds
  expires_at        INTEGER,               -- when a hold lapses
  paid_at           INTEGER
);

-- A week can only have one hold or booking at a time
CREATE UNIQUE INDEX bookings_active_week ON bookings (week_start) WHERE status IN ('hold', 'pending', 'paid');
CREATE INDEX bookings_session ON bookings (stripe_session_id);
CREATE INDEX bookings_payment_intent ON bookings (payment_intent);
