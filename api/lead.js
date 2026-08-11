// /api/lead.js — Vercel Serverless Function
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function getSheetsClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

function validatePayload(body) {
  const errors = [];
  if (!body.fullName || body.fullName.trim().length < 2) errors.push('fullName');
  if (!body.mobile || !/^[0-9]{10}$/.test(body.mobile.trim())) errors.push('mobile');
  if (!body.city) errors.push('city');
  if (!body.debtAmount) errors.push('debtAmount');
  return errors;
}

// ── SERVER-SIDE QUALIFICATION GATE ─────────────────────────────────────────
// This is the only place a lead is qualified. body.qualificationStatus /
// body.qualified / any client-supplied boolean is NEVER read for this
// decision — qualification is derived exclusively from body.debtAmount,
// checked against this explicit allowlist. These exact string values must
// match what index.html's <select id="debtAmount"> sends for a qualified
// (₹5L+) applicant — nothing else is ever accepted.
const QUALIFIED_DEBT_RANGES = new Set([
  '5-10L',
  '10-25L',
  'above-25L'
]);

function isQualifiedDebtRange(value) {
  return typeof value === 'string' && QUALIFIED_DEBT_RANGES.has(value.trim());
}

// ── DealClosure CRM — server-side only, never exposed to the browser ──────
// CRM is the primary sales destination for this funnel: a lead is only
// considered successfully processed once DealClosure confirms receipt.
// This URL must never appear in index.html or any client-side JavaScript.
const CRM_WEBHOOK_URL =
  'https://us-central1-dealclosure-crm.cloudfunctions.net/dealConverterCrmWebhook?webhookId=dT182wf45HxCc70VhMad';
const CRM_TIMEOUT_MS = 8000;

async function sendToCrm(row) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CRM_TIMEOUT_MS);

  try {
    const crmRes = await fetch(CRM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contact_name: row.full_name,
        mailing_city: row.city,
        mobile: row.mobile,
        type_of_debt: row.debt_type,
        total_debt_amount: row.debt_amount,
        monthly_emi: row.monthly_emi,
        financial_challenge: row.financial_challenge,
        urgency: row.urgency,
        qualification_status: row.qualification_status,
        source: row.utm_source || 'direct',
        campaign: row.utm_campaign || '',
        ad_set: row.utm_content || '',
        ad_name: row.utm_term || ''
      })
    });

    clearTimeout(timeoutId);

    if (!crmRes.ok) {
      const text = await crmRes.text().catch(() => '');
      console.error('[crm] webhook rejected:', crmRes.status, text);
      return { ok: false, reason: 'HTTP ' + crmRes.status };
    }

    const successBody = await crmRes.text().catch(() => '');
    console.log('[crm] ✅ lead delivered — status:', crmRes.status, 'body:', successBody);
    return { ok: true, responseBody: successBody };
  } catch (err) {
    clearTimeout(timeoutId);
    const reason = err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || 'unknown';
    console.error('[crm] webhook failed:', reason);
    return { ok: false, reason };
  }
}

// ── Best-effort duplicate-submission protection ─────────────────────────
// In-memory only, keyed by mobile number. Vercel serverless instances are
// not guaranteed to persist between invocations, so treat this as a
// courtesy debounce for accidental double-submits, not a hard guarantee.
const recentSubmissions = new Map();
const DUPLICATE_WINDOW_MS = 30 * 1000;

function isRecentDuplicate(mobile) {
  const last = recentSubmissions.get(mobile);
  const now = Date.now();
  if (last && (now - last) < DUPLICATE_WINDOW_MS) return true;
  recentSubmissions.set(mobile, now);
  if (recentSubmissions.size > 500) {
    const cutoff = now - DUPLICATE_WINDOW_MS;
    for (const key of recentSubmissions.keys()) {
      if (recentSubmissions.get(key) < cutoff) recentSubmissions.delete(key);
    }
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};

    // Honeypot — unchanged from original
    if (body['bot-field']) {
      return res.status(200).json({ ok: true });
    }

    // Validate — unchanged from original
    const missing = validatePayload(body);
    if (missing.length) {
      console.error('[lead] validation failed:', missing);
      return res.status(400).json({ ok: false, error: 'Missing fields: ' + missing.join(', ') });
    }

    // ── QUALIFICATION GATE — must happen before ANY Supabase or Sheets write ──
    // body.qualificationStatus (if present at all) is intentionally never
    // read here. A below-₹5L or invalid debtAmount is rejected regardless
    // of what qualification_status/qualified the client claims.
    if (!isQualifiedDebtRange(body.debtAmount)) {
      console.warn('[lead:rejected] below-threshold or invalid debtAmount', {
        debtAmountRaw: body.debtAmount,
        mobile: body.mobile ? body.mobile.slice(0, 4) + '******' : null,
        ts: new Date().toISOString()
      });
      // Generic message — no internals leaked, nothing the client can use
      // to infer or fake a passing state.
      return res.status(200).json({
        ok: false,
        qualified: false,
        error: 'Based on the information provided, this program may not be right for you at this time.'
      });
    }

    // Duplicate-submission courtesy check — after qualification (no point
    // debouncing requests we'd reject anyway), before any writes.
    const mobileTrimmed = body.mobile.trim();
    if (isRecentDuplicate(mobileTrimmed)) {
      return res.status(200).json({
        ok: false,
        error: 'We already received your details. A debt expert will call you shortly.'
      });
    }

    const row = {
      full_name: body.fullName.trim(),
      mobile: mobileTrimmed,
      email: body.email || '',
      city: body.city,
      debt_amount: body.debtAmount,
      debt_type: Array.isArray(body.debtType) ? body.debtType.join(', ') : (body.debtType || ''),
      // New qualification-context fields — only added if present in the
      // frontend payload (index.html's #qualifiedFields sends these).
      monthly_emi: body.monthlyEmi || '',
      financial_challenge: body.financialChallenge || '',
      urgency: body.urgency || '',
      // Server-derived, never trusted from the client.
      qualification_status: 'qualified',
      utm_source: body.utm_source || '',
      utm_medium: body.utm_medium || '',
      utm_campaign: body.utm_campaign || '',
      utm_term: body.utm_term || '',
      utm_content: body.utm_content || '',
      gclid: body.gclid || '',
      fbclid: body.fbclid || '',
      landing_page: body.landing_page || '',
      recaptcha_score: null,
      submitted_at: body.submitted_at || new Date().toISOString()
    };

    // NOTE: sheetsRow column layout extended from the original A:O (15 cols)
    // to A:S (19 cols) to include the 4 new fields. The destination Google
    // Sheet's header row needs matching columns added — this is a
    // spreadsheet-side change I cannot make from here. See report.
    const sheetsRow = [
      row.submitted_at, row.full_name, row.mobile, row.email, row.city,
      row.debt_amount, row.debt_type, row.utm_source, row.utm_medium,
      row.utm_campaign, row.utm_term, row.utm_content, row.gclid,
      row.fbclid, row.landing_page,
      row.monthly_emi, row.financial_challenge, row.urgency, row.qualification_status
    ];

    // Run Supabase + Sheets in parallel — neither blocks the other
    // (unchanged from original)
    const [supabaseResult, sheetsResult] = await Promise.allSettled([
      supabase.from('leads').insert([row]),
      getSheetsClient().spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Leads!A:S',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [sheetsRow] }
      })
    ]);

    // Log results — unchanged from original
    if (supabaseResult.status === 'rejected') {
      console.error('[supabase] failed:', supabaseResult.reason);
    } else if (supabaseResult.value.error) {
      console.error('[supabase] insert error:', supabaseResult.value.error.message);
    } else {
      console.log('[supabase] ✅ lead saved');
    }

    if (sheetsResult.status === 'rejected') {
      console.error('[sheets] failed:', sheetsResult.reason?.message);
    } else {
      console.log('[sheets] ✅ row appended');
    }

    // Return ok:true as long as at least one succeeded — unchanged from original
    const supabaseOk = supabaseResult.status === 'fulfilled' && !supabaseResult.value.error;
    const sheetsOk = sheetsResult.status === 'fulfilled';

    if (!supabaseOk && !sheetsOk) {
      return res.status(500).json({ ok: false, error: 'Could not save your details. Please WhatsApp us.' });
    }

    // ── CRM — the primary sales destination ──────────────────────────────
    // Runs after Supabase/Sheets (so the lead is durably stored even if CRM
    // is down), but the frontend only gets ok:true once CRM confirms
    // receipt. A CRM failure does not undo the Supabase/Sheets writes —
    // those records remain the recovery path if this happens — but the
    // user-facing response must not claim success, since CRM is where the
    // sales team actually sees the lead.
    const crmResult = await sendToCrm(row);
    console.log('[lead] CRM call completed, ok:', crmResult.ok);

    if (!crmResult.ok) {
      console.error('[lead] CRM delivery failed, blocking success response', {
        mobile: mobileTrimmed.slice(0, 4) + '******',
        reason: crmResult.reason,
        ts: new Date().toISOString()
      });
      // 502: the lead was validated and stored, but the primary sales
      // destination did not confirm receipt. Generic message only — no
      // webhook internals exposed to the client.
      return res.status(502).json({
        ok: false,
        qualified: true,
        error: "We couldn't complete your request right now. Please try again."
      });
    }

    return res.status(200).json({ ok: true, qualified: true });

  } catch (err) {
    console.error('[lead] unexpected error:', err.message, err.stack);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please WhatsApp us.' });
  }
}
