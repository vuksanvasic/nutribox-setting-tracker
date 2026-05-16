-- ═══════════════════════════════════════════════════════════
-- ADDITIVE migration v2 — dodaje payment_method i sale_type kolone
-- Paste ovo u Supabase SQL Editor (project: lkukoewqzxmztlvarnvw)
-- Safe za pokretanje više puta (IF NOT EXISTS)
-- ═══════════════════════════════════════════════════════════

ALTER TABLE sales_opportunities
  ADD COLUMN IF NOT EXISTS payment_method TEXT CHECK (payment_method IN ('Kartica','Firma','Pouzeće') OR payment_method IS NULL),
  ADD COLUMN IF NOT EXISTS sale_type      TEXT CHECK (sale_type IN ('Salesman','Self-service') OR sale_type IS NULL) DEFAULT 'Salesman';

CREATE INDEX IF NOT EXISTS idx_opp_payment_method ON sales_opportunities (payment_method);
CREATE INDEX IF NOT EXISTS idx_opp_sale_type      ON sales_opportunities (sale_type);

-- Mapiranje stage-ova → status (komentar; samo radi orijentacije)
-- 'Registered'       → status='open',   counted_as_call=false
-- 'Pozvati'          → status='open',   counted_as_call=false
-- 'Call Booked'      → status='open',   counted_as_call=true     ← broji se u "Pozivi"
-- 'No-Show'          → status='noshow', counted_as_call=true
-- 'Follow Up'        → status='open',   counted_as_call=true     (postao showed up)
-- 'Porudžbine'       → status='won',    counted_as_call=true     ← Vuksan-ova WIN
-- 'Uplata na čekanju'→ status='won',    counted_as_call=true     (još won, payment pending)
-- 'Uplatio'          → status='won',    counted_as_call=true     (won + paid)
-- 'Lost'             → status='lost',   counted_as_call=true
-- 'Junk'             → ignored — webhook ga preskače
