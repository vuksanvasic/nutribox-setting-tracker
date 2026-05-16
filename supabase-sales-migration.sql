-- ═══════════════════════════════════════════════════════════
-- NUTRIBOX DASHBOARD — Sales department migration
-- Paste ovo u Supabase SQL Editor (project: lkukoewqzxmztlvarnvw)
-- Bezbedno: koristi IF NOT EXISTS, ne dira postojeću `entries` tabelu
-- ═══════════════════════════════════════════════════════════

-- 1) Sales opportunities (1 red = 1 prilika / poziv)
CREATE TABLE IF NOT EXISTS sales_opportunities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_opp_id      TEXT UNIQUE NOT NULL,
  ghl_contact_id  TEXT,
  ghl_location_id TEXT,
  lead_name       TEXT,
  lead_phone      TEXT,
  lead_email      TEXT,
  salesman_name   TEXT NOT NULL DEFAULT 'Vuksan',
  pipeline_stage  TEXT,                       -- Scheduled / Showed Up / Won / Lost / No-Show
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','noshow')),
  package         TEXT,                       -- Custom / 28-dnevni / 20-dnevni / 7-dnevni / 5-dnevni
  package_price   INTEGER,                    -- u RSD, ceo broj
  revenue         INTEGER,                    -- ostvareni prihod (= package_price na Won)
  lost_reason     TEXT,                       -- free-text, prodavac upiše posle Lost poziva
  scheduled_at    TIMESTAMPTZ,                -- kada je poziv zakazan
  won_at          TIMESTAMPTZ,
  lost_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opp_scheduled ON sales_opportunities (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_opp_won       ON sales_opportunities (won_at);
CREATE INDEX IF NOT EXISTS idx_opp_status    ON sales_opportunities (status);
CREATE INDEX IF NOT EXISTS idx_opp_salesman  ON sales_opportunities (salesman_name);
CREATE INDEX IF NOT EXISTS idx_opp_package   ON sales_opportunities (package);

-- 2) Lost reason klasterovanje (AI job upisuje ovde)
CREATE TABLE IF NOT EXISTS sales_lost_reason_clusters (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opp_id        UUID REFERENCES sales_opportunities(id) ON DELETE CASCADE,
  raw_text      TEXT,
  category      TEXT,   -- npr. "Cena/budžet", "Razmisliće", "Pogrešno vreme", "Već ima coacha", "Ostalo"
  emoji         TEXT,
  confidence    NUMERIC(3,2),
  clustered_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cluster_category ON sales_lost_reason_clusters (category);
CREATE INDEX IF NOT EXISTS idx_cluster_opp      ON sales_lost_reason_clusters (opp_id);

-- 3) Webhook log (debug / replay)
CREATE TABLE IF NOT EXISTS ghl_webhook_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  TEXT,
  payload     JSONB,
  status      TEXT DEFAULT 'received',
  error       TEXT,
  received_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wh_received ON ghl_webhook_log (received_at DESC);

-- 4) RLS — anon može da čita (čita ih dashboard); pisanje samo service_role (webhook)
ALTER TABLE sales_opportunities         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_lost_reason_clusters  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ghl_webhook_log             ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "opp_select_anon" ON sales_opportunities;
CREATE POLICY "opp_select_anon" ON sales_opportunities
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "cluster_select_anon" ON sales_lost_reason_clusters;
CREATE POLICY "cluster_select_anon" ON sales_lost_reason_clusters
  FOR SELECT TO anon USING (true);

-- service_role bypassuje RLS po default-u; webhook koristi service_role.

-- 5) Trigger za updated_at
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_opp_touch ON sales_opportunities;
CREATE TRIGGER trg_opp_touch
  BEFORE UPDATE ON sales_opportunities
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ═══════════════════════════════════════════════════════════
-- KAKO POKRENUTI:
-- 1. Idi u Supabase Studio → SQL Editor
-- 2. Otvori projekat lkukoewqzxmztlvarnvw
-- 3. Paste-uj ovaj fajl celiji u New Query
-- 4. Klikni RUN
-- 5. Verifikuj: Table Editor → vidiš 3 nove tabele
-- ═══════════════════════════════════════════════════════════
