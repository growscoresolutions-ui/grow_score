// /api/lead.js
// Vercel Serverless Function — receives the lead form POST, validates it,
// verifies reCAPTCHA v3, writes to Supabase (source of truth) and appends
// a row to Google Sheets (team's working view). Runs on Node.js runtime.

import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';

// ---------- Supabase client (server-side, uses the SERVICE ROLE key) ----------
// NEVER expose SUPABASE_SERVICE_ROLE_KEY to the browser. It only lives here,
// as a Vercel environment variable, and is read at request time.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- Google Sheets auth (service account) ----------
function getSheetsClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    // Vercel env vars can't store literal newlines well, so the private key
    // is stored with \n escaped — we un-escape it here.
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

// ---------- reCAPTCHA v3 server-side verification ----------
async function verifyRecaptcha(token) {
  if (!process.env.RECAPTCHA_SECRET_KEY) return { ok: true, score: null }; // skip if not configured yet
  if (!token) return { ok: false, score: 0 };

  const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${token}`
  });
  const data = await res.json();
  // 0.5 is Google's recommended default threshold. Tune later based on real traffic.
  return { ok: data.success && data.score >= 0.5, score: data.score };
}

// ---------- basic server-side validation (never trust the client alone) ----------
function validatePayload(body) {
  const errors = [];
  if (!body.fullName || body.fullName.trim().length < 2) errors.push('fullName');
  if (!body.mobile || !/^[0-9]{10}$/.test(body.mobile.trim())) errors.push('mobile');
  if (!body.city) errors.push('city');
  if (!body.debtAmount) errors.push('debtAmount');
  return errors;
}

export default async function handler(req, res) {
  // CORS / method guard
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};

    // 1. Honeypot — if this hidden field has anything in it, it's a bot.
    //    Respond 200/ok so the bot's script doesn't learn to retry differently,
    //    but silently drop the submission.
    if (body['bot-field']) {
      return res.status(200).json({ ok: true });
    }

    // 2. Required-field validation
    const missing = validatePayload(body);
    if (missing.length) {
      return res.status(400).json({ ok: false, error: 'Missing or invalid fields: ' + missing.join(', ') });
    }

    // 3. reCAPTCHA v3 score check
    const captcha = await verifyRecaptcha(body.recaptchaToken);
    if (!captcha.ok) {
      return res.status(400).json({ ok: false, error: 'Verification failed. Please try again or WhatsApp us.' });
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
      recaptcha_score: captcha.score,
      submitted_at: body.submitted_at || new Date().toISOString()
    };

    // 4. Write to Supabase (primary store) — this MUST succeed for the lead
    //    to count as captured. Sheets is best-effort after this.
    const { error: supabaseError } = await supabase.from('leads').insert([row]);
    if (supabaseError) {
      console.error('[supabase] insert failed:', supabaseError.message);
      return res.status(500).json({ ok: false, error: 'Could not save your details. Please WhatsApp us directly.' });
    }

    // 5. Mirror to Google Sheets — best-effort. If this fails, the lead is
    //    still safely in Supabase, so we log the error but still return ok:true.
    try {
      const sheets = getSheetsClient();
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Leads!A:O',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[
            row.submitted_at, row.full_name, row.mobile, row.email, row.city,
            row.debt_amount, row.debt_type, row.utm_source, row.utm_medium,
            row.utm_campaign, row.utm_term, row.utm_content, row.gclid,
            row.fbclid, row.landing_page
          ]]
        }
      });
    } catch (sheetsErr) {
      console.error('[sheets] append failed (lead still saved in Supabase):', sheetsErr.message);
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[api/lead] unexpected error:', err);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again or WhatsApp us.' });
  }
}
