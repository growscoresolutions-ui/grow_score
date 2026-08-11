// /api/check-eligibility.js — Vercel Serverless Function
//
// Checks whether a verified mobile number is currently under an active
// 30-day disqualification cooldown. This is called by the frontend right
// after OTP verification succeeds, before the debt-amount question is
// revealed. The backend is the sole source of truth here — nothing about
// eligibility_status / disqualified_until is ever trusted from the client.
//
// This endpoint is read-only: it never writes to Supabase, never touches
// the CRM, and never touches the leads table.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

    const { data, error } = await supabase
      .from('eligibility_cooldowns')
      .select('eligibility_status, disqualified_until')
      .eq('mobile', mobileTrimmed)
      .maybeSingle();

    if (error) {
      // A lookup failure should not silently block a genuine user — log it
      // for investigation and fail open. The server-side re-check inside
      // api/lead.js is the actual enforcement point for the submission
      // itself, so failing open here does not create a bypass.
      console.error('[check-eligibility] supabase lookup failed:', error.message);
      return res.status(200).json({ ok: true, blocked: false });
    }

    if (!data) {
      // No record at all — new mobile number, or has never been disqualified.
      return res.status(200).json({ ok: true, blocked: false });
    }

    const now = new Date();
    const disqualifiedUntil = data.disqualified_until ? new Date(data.disqualified_until) : null;
    const isActiveCooldown =
      data.eligibility_status === 'disqualified' &&
      disqualifiedUntil &&
      disqualifiedUntil > now;

    return res.status(200).json({
      ok: true,
      blocked: !!isActiveCooldown
    });

  } catch (err) {
    console.error('[check-eligibility] unexpected error:', err.message, err.stack);
    // Fail open — see reasoning above.
    return res.status(200).json({ ok: true, blocked: false });
  }
}
