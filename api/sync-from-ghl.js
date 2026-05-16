// Vercel serverless function: poll GHL → upsert into Supabase
// Called by GitHub Actions cron every 5 min
//
// Auth: ?secret=<CRON_SECRET>
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, GHL_TOKEN, GHL_LOCATION_ID, CRON_SECRET

import { createClient } from '@supabase/supabase-js';

const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

// Marketing Pipeline stage → naš status mapping
const STAGE_STATUS_RAW = {
  'registered':        { status: 'open',   isCall: false },
  'pozvati':           { status: 'open',   isCall: false },
  'call booked':       { status: 'open',   isCall: true  },
  'no show':           { status: 'noshow', isCall: true  },
  'no-show':           { status: 'noshow', isCall: true  },
  'follow up':         { status: 'open',   isCall: true  },
  'porudzbine':        { status: 'won',    isCall: true  },
  'uplata na cekanju': { status: 'won',    isCall: true  },
  'uplatio':           { status: 'won',    isCall: true  },
  'lost':              { status: 'lost',   isCall: true  },
  'junk':              { status: 'junk',   isCall: false },
};
function normalizeStage(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/đ/g, 'd').replace(/š/g, 's').replace(/č/g, 'c').replace(/ć/g, 'c').replace(/ž/g, 'z')
    .replace(/\s+/g, ' ').trim();
}
function stageMap(name) {
  return STAGE_STATUS_RAW[normalizeStage(name)] || { status: 'open', isCall: false };
}

const DEFAULT_PRICE = { '28-dnevni': 78400, '20-dnevni': 60000, '7-dnevni': 21000, '5-dnevni': 15000, 'Custom': null };
const FIELDS = ['package','lost_note','package_price','payment_method','sale_type'];

function cfValue(customFields, key) {
  if (!Array.isArray(customFields)) return null;
  for (const item of customFields) {
    const k = (item.key || item.fieldKey || item.name || '').toLowerCase().replace(/\s+/g,'_');
    if (k === key.toLowerCase() ||
        k === `opportunity.${key}`.toLowerCase() ||
        k.endsWith(`.${key}`.toLowerCase())) {
      return item.value ?? item.field_value ?? item.fieldValue ?? null;
    }
  }
  return null;
}

async function ghlFetch(path) {
  const res = await fetch(`${GHL_API}${path}`, {
    headers: {
      'Authorization': `Bearer ${process.env.GHL_TOKEN}`,
      'Version': GHL_VERSION,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GHL ${path} → ${res.status}: ${txt.substring(0, 200)}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  // Auth
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Invalid secret' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  const stats = { fetched: 0, upserted: 0, skipped_junk: 0, errors: 0, pages: 0 };
  const startedAt = Date.now();

  try {
    const locationId = process.env.GHL_LOCATION_ID;

    // 1) Get Marketing Pipeline + stage id→name map
    const pipelinesData = await ghlFetch(`/opportunities/pipelines?locationId=${locationId}`);
    const pipeline = pipelinesData.pipelines.find(p => /marketing/i.test(p.name));
    if (!pipeline) throw new Error('Marketing Pipeline not found');
    const stageNameById = {};
    pipeline.stages.forEach(s => { stageNameById[s.id] = s.name; });

    // 2) Get last sync timestamp (max updated_at in our DB)
    // First run mode: table is mostly empty (< 10 rows) → full backfill, no time filter.
    const { count } = await supabase
      .from('sales_opportunities')
      .select('id', { count: 'exact', head: true });
    const isFirstRun = (count ?? 0) < 10 || req.query.backfill === '1';

    const { data: lastRow } = await supabase
      .from('sales_opportunities')
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const sinceISO = lastRow?.updated_at || new Date(Date.now() - 24*60*60*1000).toISOString();

    // 3) Fetch opps (paginated)
    let startAfter = null;
    let startAfterId = null;
    let safetyPages = 20; // hard cap to avoid runaway
    const rowsToUpsert = [];

    while (safetyPages-- > 0) {
      stats.pages++;
      let url = `/opportunities/search?location_id=${locationId}&pipeline_id=${pipeline.id}&limit=100`;
      if (startAfter) url += `&startAfter=${startAfter}&startAfterId=${startAfterId}`;

      const data = await ghlFetch(url);
      const opps = data.opportunities || [];
      stats.fetched += opps.length;
      if (!opps.length) break;

      // Transform each
      for (const opp of opps) {
        try {
          // Backfill mode: process all. Otherwise filter by updatedAt.
          if (!isFirstRun && opp.updatedAt && opp.updatedAt < sinceISO) continue;

          const stageName = stageNameById[opp.pipelineStageId] || '';
          const stageInfo = stageMap(stageName);

          if (stageInfo.status === 'junk') {
            stats.skipped_junk++;
            continue;
          }

          const pkg            = cfValue(opp.customFields, 'package');
          const lostNote       = cfValue(opp.customFields, 'lost_note');
          let   price          = parseInt(cfValue(opp.customFields, 'package_price'), 10);
          const paymentMethod  = cfValue(opp.customFields, 'payment_method');
          const saleType       = cfValue(opp.customFields, 'sale_type') || 'Salesman';

          // Fallbacks: built-in monetaryValue field, default by package name
          if (!price && pkg && DEFAULT_PRICE[pkg] != null) price = DEFAULT_PRICE[pkg];
          if (!price && opp.monetaryValue) price = Math.round(parseFloat(opp.monetaryValue));

          const now = new Date().toISOString();
          rowsToUpsert.push({
            ghl_opp_id:      opp.id,
            ghl_contact_id:  opp.contactId,
            ghl_location_id: locationId,
            lead_name:       opp.name || opp.contact?.name,
            lead_phone:      opp.contact?.phone,
            lead_email:      opp.contact?.email,
            salesman_name:   opp.assignedTo || 'Vuksan',
            pipeline_stage:  stageName,
            status:          stageInfo.status,
            package:         pkg,
            package_price:   price || null,
            revenue:         stageInfo.status === 'won' ? (price || 0) : null,
            lost_reason:     lostNote,
            payment_method:  paymentMethod,
            sale_type:       saleType,
            scheduled_at:    null,
            won_at:          stageInfo.status === 'won'  ? (opp.updatedAt || now) : null,
            lost_at:         stageInfo.status === 'lost' ? (opp.updatedAt || now) : null,
          });
        } catch (e) {
          stats.errors++;
        }
      }

      // Pagination via meta
      const meta = data.meta || {};
      if (!meta.startAfter || !meta.startAfterId || meta.nextPage === false || opps.length < 100) break;
      startAfter = meta.startAfter;
      startAfterId = meta.startAfterId;
    }

    // 4) Batch upsert (chunks of 100)
    for (let i = 0; i < rowsToUpsert.length; i += 100) {
      const chunk = rowsToUpsert.slice(i, i + 100);
      const { error } = await supabase
        .from('sales_opportunities')
        .upsert(chunk, { onConflict: 'ghl_opp_id' });
      if (error) {
        stats.errors++;
        await supabase.from('ghl_webhook_log').insert({
          event_type: 'cron_sync_error',
          payload: { chunk_size: chunk.length, error: error.message },
          status: 'error',
          error: error.message,
        });
      } else {
        stats.upserted += chunk.length;
      }
    }

    // 5) Log run
    await supabase.from('ghl_webhook_log').insert({
      event_type: 'cron_sync',
      payload: { stats, sinceISO, duration_ms: Date.now() - startedAt },
      status: stats.errors ? 'partial' : 'ok',
    });

    return res.status(200).json({ ok: true, ...stats, since: sinceISO, duration_ms: Date.now() - startedAt });
  } catch (err) {
    await supabase.from('ghl_webhook_log').insert({
      event_type: 'cron_sync',
      payload: { stats, error: err.message },
      status: 'error',
      error: err.message,
    });
    return res.status(500).json({ error: err.message, stats });
  }
}
