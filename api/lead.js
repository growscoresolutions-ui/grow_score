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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};

    // Honeypot
    if (body['bot-field']) {
      return res.status(200).json({ ok: true });
    }

    // Validate
    const missing = validatePayload(body);
    if (missing.length) {
      console.error('[lead] validation failed:', missing);
      return res.status(400).json({ ok: false, error: 'Missing fields: ' + missing.join(', ') });
    }

    const row = {
      full_name: body.fullName.trim(),
      mobile: body.mobile.trim(),
      email: body.email || '',
      city: body.city,
      debt_amount: body.debtAmount,
      debt_type: Array.isArray(body.debtType) ? body.debtType.join(', ') : (body.debtType || ''),
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

    const sheetsRow = [
      row.submitted_at, row.full_name, row.mobile, row.email, row.city,
      row.debt_amount, row.debt_type, row.utm_source, row.utm_medium,
      row.utm_campaign, row.utm_term, row.utm_content, row.gclid,
      row.fbclid, row.landing_page
    ];

    // Run Supabase + Sheets in parallel — neither blocks the other
    const [supabaseResult, sheetsResult] = await Promise.allSettled([
      supabase.from('leads').insert([row]),
      getSheetsClient().spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Leads!A:O',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [sheetsRow] }
      })
    ]);

    // Log results
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

    // Return ok:true as long as at least one succeeded
    const supabaseOk = supabaseResult.status === 'fulfilled' && !supabaseResult.value.error;
    const sheetsOk = sheetsResult.status === 'fulfilled';

    if (!supabaseOk && !sheetsOk) {
      return res.status(500).json({ ok: false, error: 'Could not save your details. Please WhatsApp us.' });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[lead] unexpected error:', err.message, err.stack);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please WhatsApp us.' });
  }
}
