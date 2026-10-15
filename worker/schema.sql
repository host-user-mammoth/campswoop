-- CampSwoop's D1 database. Apply with: npx wrangler d1 execute campswoop --remote --file schema.sql

-- One row per watch: a person, a campground link and a stay.
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,                    -- shared with the checker; appears in state.json
  token TEXT NOT NULL,                    -- secret part of the confirm, stop and manage links
  email TEXT NOT NULL,
  link TEXT NOT NULL,                     -- booking link the person picked
  name TEXT NOT NULL,                     -- campground name for emails
  check_in TEXT NOT NULL,                 -- YYYY-MM-DD
  check_out TEXT NOT NULL,                -- YYYY-MM-DD
  camping TEXT NOT NULL DEFAULT 'any',    -- any, tent, trailer, motorhome or rv
  length INTEGER NOT NULL DEFAULT 0,      -- rig length in feet; 0 when not given
  status TEXT NOT NULL DEFAULT 'pending', -- pending (not confirmed yet), active, stopped or ended
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  ip TEXT                                 -- salted hash of the sign-up IP, for rate limits
);
CREATE INDEX IF NOT EXISTS watches_by_email ON watches (email);
CREATE INDEX IF NOT EXISTS watches_by_status ON watches (status);

-- Emails sent per day (Eastern time), to stay under Resend's free daily limit.
CREATE TABLE IF NOT EXISTS sends (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);

-- Booking sites people tried that CampSwoop can't watch yet.
CREATE TABLE IF NOT EXISTS requested_sites (
  host TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
