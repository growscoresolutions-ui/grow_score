// /api/record-disqualification.js — Vercel Serverless Function
//
// Called when a verified mobile number selects a below-₹5L debt amount.
// Writes/updates a 30-day disqualification cooldown record in Supabase,
// keyed by mobile number. Uses upsert so a repeat below-5L selection from
// the same number does not create duplicate rows — it simply restarts the
// 30-day window, per spec ("If they again select below ₹5 lakh: start a
// new 30-day cooldown").
//
// This endpoint never touches the leads table, never calls the CRM, and
// never writes to Google Sheets — it only manages the cooldown record.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const COOLDOWN_DAYS = 30;

function normalizeMobile(raw) {
  if (typeof raw !== 'string') return '';

  let digits = raw.replace(/[^0-9]/g, '');

  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  }

  return digits;
}

function isValidMobile(mobile) {
  return typeof mobile === 'string' && /^[0-9]{10}$/.test(mobile);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const mobile = normalizeMobile(body.mobile);

    if (!isValidMobile(mobile)) {
      return res.status(400).json({ ok: false, error: 'Invalid mobile number' });
    }

    const mobileTrimmed = mobile;
    const now = new Date();
    const disqualifiedUntil = new Date(now.getTime() + COOLDOWN_DAYS * 24 * 60 * 60 * 1000);

    const { error } = await supabase
      .from('eligibility_cooldowns')
      .upsert(
        {
          mobile: mobileTrimmed,
          eligibility_status: 'disqualified',
          disqualified_at: now.toISOString(),
          disqualified_until: disqualifiedUntil.toISOString(),
          updated_at: now.toISOString()
        },
        { onConflict: 'mobile' }
      );

    if (error) {
      console.error('[record-disqualification] supabase upsert failed:', error.message);
      return res.status(500).json({ ok: false, error: 'Could not record eligibility status' });
    }

    console.log('[record-disqualification] cooldown recorded for', mobileTrimmed.slice(0, 4) + '******', 'until', disqualifiedUntil.toISOString());

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[record-disqualification] unexpected error:', err.message, err.stack);
    return res.status(500).json({ ok: false, error: 'Something went wrong' });
  }
}
