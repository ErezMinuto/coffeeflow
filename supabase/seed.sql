-- CoffeeFlow — Dev Seed Data
-- Run this ONCE after applying all migrations to a fresh dev Supabase project.
-- Replace 'DEV_USER_ID' with your actual Clerk user ID (or leave as-is for a shared dev user).
--
-- Usage:
--   psql <dev-db-connection-string> -f supabase/seed.sql

-- ── User Role ──────────────────────────────────────────────────────────────────
INSERT INTO user_roles (user_id, role, display_name)
VALUES ('DEV_USER_ID', 'admin', 'Dev Admin')
ON CONFLICT (user_id) DO NOTHING;

-- ── Operators ──────────────────────────────────────────────────────────────────
INSERT INTO operators (name) VALUES
  ('אלון'),
  ('מיכל'),
  ('יוסי')
ON CONFLICT DO NOTHING;

-- ── Origins (coffee sources — shared, not per-user) ────────────────────────────
INSERT INTO origins (name, stock, roasted_stock, daily_average, user_id) VALUES
  ('אתיופיה ירגצ׳פה',     30.0,  8.0,  1.2, 'DEV_USER_ID'),
  ('קולומביה הואילה',     25.0,  6.5,  0.9, 'DEV_USER_ID'),
  ('גואטמלה אנטיגואה',    0.0,   4.0,  0.7, 'DEV_USER_ID'),
  ('קניה AA',             15.0,  5.0,  0.8, 'DEV_USER_ID'),
  ('ברזיל סרטאו',         40.0, 12.0,  1.5, 'DEV_USER_ID'),
  ('קוסטה ריקה טרזו',     20.0,  3.0,  0.6, 'DEV_USER_ID')
ON CONFLICT DO NOTHING;

-- ── Roast Profiles ─────────────────────────────────────────────────────────────
INSERT INTO roast_profiles (name, roasted_stock) VALUES
  ('אריסטו',       10.0),
  ('בנסה לייט',     5.0),
  ('קניה לייט',     3.5)
ON CONFLICT DO NOTHING;

-- ── Products ───────────────────────────────────────────────────────────────────
INSERT INTO products (name, size, packed_stock, min_packed_stock) VALUES
  ('אתיופיה ירגצ׳פה',  250, 10, 5),
  ('אתיופיה ירגצ׳פה',  500,  5, 3),
  ('קולומביה הואילה',  250,  8, 4),
  ('ברזיל סרטאו',      250, 15, 6),
  ('ברזיל סרטאו',      500,  6, 3),
  ('אריסטו',           250,  4, 2)
ON CONFLICT DO NOTHING;

-- ── Employees ──────────────────────────────────────────────────────────────────
INSERT INTO employees (name, telegram_username) VALUES
  ('דניאל (דב)',   'dev_daniel'),
  ('מיה (מי)',     'dev_mia'),
  ('עומר (עו)',    'dev_omer')
ON CONFLICT DO NOTHING;
