# Nutribox Dashboard — Sales Department Setup

Vodič za završne korake (oko 1h posla, najveći deo je tvoj klik-i-paste).

---

## ✅ Već je urađeno (lokalno)

- `index.html` refactor: PIN-first welcome → department picker → Setting **ILI** Sales view
- Sales screen sa svim sekcijama (KPI, paketi, lost reasons, tabela, date range picker)
- `supabase-sales-migration.sql` — schema za sales tabele
- `api/ghl-webhook.js` — Vercel serverless funkcija
- `api/package.json` — Supabase client dependency
- USERS u kodu ažurirani:
  - Andrija (PIN 2222) — samo `setting`
  - Tatjana (PIN 1111) — samo `setting`
  - Vuksan (PIN **1806**) — `setting + sales`, admin

---

## 🔧 Šta je preostalo (po redu)

### KORAK 1 — Supabase migration (5 min)

1. Otvori [Supabase Studio](https://supabase.com/dashboard/project/lkukoewqzxmztlvarnvw/sql/new)
2. Otvori fajl `supabase-sales-migration.sql` u editoru
3. Copy ceo sadržaj → paste u SQL Editor
4. Klikni **Run**
5. U Table Editor proveri da postoje 3 nove tabele:
   - `sales_opportunities`
   - `sales_lost_reason_clusters`
   - `ghl_webhook_log`

### KORAK 2 — Supabase Service Role key (1 min)

1. Supabase Studio → Project Settings → API
2. Kopiraj **service_role** key (NE anon!)
3. Drži ga negde — koristićeš ga u Koraku 4

### KORAK 3 — GHL pipeline + custom fields (15-20 min)

U Nutribox sub-account-u u GoHighLevel-u:

1. **Pipeline:** Settings → Pipelines → New Pipeline → "Sales Calls"
   - Stages: `Scheduled`, `Showed Up`, `Won`, `Lost`, `No-Show`

2. **Custom fields** na Opportunity-u (Settings → Custom Fields → Opportunity):
   - `package` — Single Options (dropdown)
     - Vrednosti: `Custom`, `28-dnevni`, `20-dnevni`, `7-dnevni`, `5-dnevni`
   - `lost_reason` — Multi Line (textarea, free-text)
   - `package_price` — Number

3. **Workflow** (Automations → New Workflow):
   - Trigger: Opportunity custom field `package` changes
   - Action: Update Opportunity → set `package_price` based on package value:
     - 28-dnevni → 78400
     - 20-dnevni → 60000
     - 7-dnevni → 21000
     - 5-dnevni → 15000
     - Custom → ostaje prazno (Vuksan ručno)

4. **API Key & Location ID:**
   - Settings → API → kopiraj **Private Integration Token**
   - Settings → Company → vidiš **Location ID** u URL-u ili u API tab-u

### KORAK 4 — Vercel env variables (5 min)

1. Otvori Vercel projekat `nutribox-setting-tracker`
2. Settings → Environment Variables → Add:
   ```
   SUPABASE_URL              = https://lkukoewqzxmztlvarnvw.supabase.co
   SUPABASE_SERVICE_KEY      = <key iz Koraka 2>
   GHL_WEBHOOK_SECRET        = <generiši random, npr. `openssl rand -hex 32`>
   ```

### KORAK 5 — Deploy (5 min)

```bash
cd /Users/dusan/nauci-dizajn-tracker

# Push lokalne izmene (5 stari commits + nove izmene)
git add -A
git commit -m "feat: add Sales department + dept picker + webhook endpoint"
git push origin main
```

Vercel auto-deploy-uje. Sačekaj ~30s, otvori `nutribox-setting-tracker.vercel.app` — videćeš novi flow.

> Rename u `nutribox-dashboard` se radi u Vercel UI: Settings → General → Project Name.

### KORAK 6 — GHL webhook konfiguracija (5 min)

1. GHL Settings → Webhooks → Add Webhook
2. URL: `https://nutribox-dashboard.vercel.app/api/ghl-webhook?secret=<GHL_WEBHOOK_SECRET>`
3. Events: ☑ Opportunity Create · ☑ Opportunity Status Update · ☑ Opportunity Stage Update · ☑ Appointment Create
4. Save

### KORAK 7 — End-to-end test (10 min)

1. U GHL kreiraj test opportunity u "Sales Calls" pipeline-u
2. Postavi `package` = "5-dnevni", move stage to "Won"
3. Otvori Supabase Studio → `sales_opportunities` → trebalo bi da vidiš red
4. Otvori `nutribox-dashboard.vercel.app` → uloguj se kao Vuksan (PIN 1806) → Sales → vidiš test podatak (mada još uvek je dashboard hard-coded mock, sledeći commit ga povezuje)

### KORAK 8 (sledeća sesija) — Wire up dashboard sa real data

Trenutni Sales screen prikazuje mock podatke. Treba još:
- Zameniti hardcoded HTML brojeve sa `supabase.from('sales_opportunities').select(...).gte('won_at', from).lte('won_at', to)` queries
- Implementirati render funkcije
- Implementirati LLM klastering job za lost_reason

Ovo radimo nakon što vidimo prve realne podatke iz GHL webhook-a (da znamo tačan payload shape).

---

## 🧪 Quick test (lokalno, bez deploy-a)

Otvori `index.html` u browseru:
- PIN `2222` → Andrija → Setting (setter view, kao do sad)
- PIN `1111` → Tatjana → Setting
- PIN `1806` → Vuksan → Department picker → Setting ili Sales

---

## 🔐 Security flag

GitHub PAT je ostavljen u `git remote -v` od `/Users/dusan/Tracking/setter-tracker/` (Nauči Dizajn projekat, NE ovaj). Rotiraj ga čim možeš — token je u plain text u .git/config.

Ovaj projekat (`nauci-dizajn-tracker/`) NE sadrži embedovan PAT — koristi standardni git auth.
