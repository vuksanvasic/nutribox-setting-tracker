// Vercel serverless function: GHL → Supabase webhook bridge
// Deploy: ovaj fajl se automatski deploy-uje kao /api/ghl-webhook
//
// Environment variables potrebne na Vercelu:
//   SUPABASE_URL              = https://lkukoewqzxmztlvarnvw.supabase.co
//   SUPABASE_SERVICE_KEY      = service_role key
//   GHL_WEBHOOK_SECRET        = random string (provera origin-a)
//   GHL_LOCATION_ID           = hbmSj98r87Ly0JZFlq2V (opciono, za filter)
//
// GHL webhook URL:
//   https://nutribox-dashboard.vercel.app/api/ghl-webhook?secret=<GHL_WEBHOOK_SECRET>

import { createClient } from '@supabase/supabase-js';

// Marketing Pipeline stage → naš status mapping
const STAGE_STATUS = {
  'Registered':         { status: 'open',   isCall: false },
  'Pozvati':            { status: 'open',   isCall: false },
  'Call Booked':        { status: 'open',   isCall: true  },
  'No-Show':            { status: 'noshow', isCall: true  },
  'Follow Up':          { status: 'open',   isCall: true  },
  'Porudžbine':         { status: 'won',    isCall: true  },
  'Uplata na čekanju':  { status: 'won',    isCall: true  },
  'Uplatio':            { status: 'won',    isCall: true  },
  'Lost':               { status: 'lost',   isCall: true  },
  'Junk':               { status: 'junk',   isCall: false }, // filtered out
};

// Fallback price by package (ako Vuksan nije manuelno uneo cenu)
const DEFAULT_PRICE = {
  '28-dnevni': 78400,
  '20-dnevni': 60000,
  '7-dnevni':  21000,
  '5-dnevni':  15000,
  'Custom':    null,
};

// GHL custom field key prefixes (mapping na tvoje GHL setup)
const FIELD_KEYS = {
  package:        'package',
  lost_note:      'lost_note',
  package_price:  'package_price',
  payment_method: 'payment_method',
  sale_type:      'sale_type',
};

// Helper: extract custom field value from various GHL payload shapes
function getCustomField(payload, key) {
  // GHL često šalje customField kao array of { id, key, field_value } ili { id, name, value }
  const cfArrays = [
    payload.customField,
    payload.customFields,
    payload?.opportunity?.customField,
    payload?.opportunity?.customFields,
  ].filter(Array.isArray);

  for (const arr of cfArrays) {
    for (const item of arr) {
      const itemKey = (item.key || item.fieldKey || item.name || '').toLowerCase();
      // matches "package", "opportunity.package", "Package", etc.
      if (
        itemKey === key.toLowerCase() ||
        itemKey === `opportunity.${key}`.toLowerCase() ||
        itemKey.endsWith(`.${key}`.toLowerCase()) ||
        itemKey.replace(/\s+/g,'_') === key.toLowerCase()
      ) {
        return item.value ?? item.field_value ?? null;
      }
    }
  }

  // Object-shape fallback
  const cfObjs = [payload.customFields, payload?.opportunity?.customFields].filter(o => o && typeof o === 'object' && !Array.isArray(o));
  for (const obj of cfObjs) {
    if (obj[key] != null) return obj[key];
    if (obj[`opportunity.${key}`] != null) return obj[`opportunity.${key}`];
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST' });
  }

  // Auth: secret query param
  if (!req.query.secret || req.query.secret !== process.env.GHL_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid secret' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  const payload = req.body || {};
  const eventType = payload.type || payload.event || 'unknown';

  // Log every webhook for debug / replay
  const { data: logRow } = await supabase
    .from('ghl_webhook_log')
    .insert({ event_type: eventType, payload, status: 'received' })
    .select('id')
    .single();

  try {
    // Extract opportunity payload (varies by event)
    const opp = payload.opportunity || payload;
    const ghlOppId = opp.id || opp.opportunity_id || opp.opportunityId;
    if (!ghlOppId) {
      return res.status(200).json({ ok: true, skipped: 'no opp id' });
    }

    // Resolve stage → status
    const stage = opp.pipelineStage || opp.pipeline_stage || opp.stage || opp.stageName;
    const stageMap = STAGE_STATUS[stage] || { status: 'open', isCall: false };

    // Skip Junk entirely
    if (stageMap.status === 'junk') {
      await supabase.from('ghl_webhook_log').update({ status: 'skipped_junk' }).eq('id', logRow?.id);
      return res.status(200).json({ ok: true, skipped: 'junk' });
    }

    // Custom fields
    const pkg            = getCustomField(payload, FIELD_KEYS.package);
    const lostNote       = getCustomField(payload, FIELD_KEYS.lost_note);
    let   price          = parseInt(getCustomField(payload, FIELD_KEYS.package_price), 10);
    const paymentMethod  = getCustomField(payload, FIELD_KEYS.payment_method);
    const saleType       = getCustomField(payload, FIELD_KEYS.sale_type) || 'Salesman';

    // Fallback price
    if (!price && pkg && DEFAULT_PRICE[pkg] != null) price = DEFAULT_PRICE[pkg];

    // Build row
    const now = new Date().toISOString();
    const row = {
      ghl_opp_id:       ghlOppId,
      ghl_contact_id:   opp.contactId || opp.contact_id,
      ghl_location_id:  opp.locationId || opp.location_id || process.env.GHL_LOCATION_ID,
      lead_name:        opp.contactName || opp.contact_name || opp.name,
      lead_phone:       opp.phone || opp.contact?.phone,
      lead_email:       opp.email || opp.contact?.email,
      salesman_name:    opp.assignedTo || opp.assigned_to || 'Vuksan',
      pipeline_stage:   stage,
      status:           stageMap.status,
      package:          pkg,
      package_price:    price || null,
      revenue:          stageMap.status === 'won' ? (price || 0) : null,
      lost_reason:      lostNote,            // mapping: GHL "lost_note" → Supabase "lost_reason" kolona
      payment_method:   paymentMethod,
      sale_type:        saleType,
      scheduled_at:     opp.appointmentStartTime || opp.scheduled_at || null,
      won_at:           stageMap.status === 'won'  ? now : null,
      lost_at:          stageMap.status === 'lost' ? now : null,
    };

    const { error } = await supabase
      .from('sales_opportunities')
      .upsert(row, { onConflict: 'ghl_opp_id' });

    if (error) throw error;

    await supabase.from('ghl_webhook_log').update({ status: 'ok' }).eq('id', logRow?.id);

    return res.status(200).json({
      ok: true,
      opp_id: ghlOppId,
      stage,
      status: stageMap.status,
      is_call: stageMap.isCall,
    });
  } catch (err) {
    if (logRow?.id) {
      await supabase.from('ghl_webhook_log')
        .update({ status: 'error', error: err.message || String(err) })
        .eq('id', logRow.id);
    }
    return res.status(500).json({ error: err.message || String(err) });
  }
}
