// /api/debug.js — temporary diagnostic endpoint
// DELETE THIS FILE after debugging is done — it exposes config info
export default async function handler(req, res) {
  const checks = {};

  // Check env vars exist
  checks.SUPABASE_URL = process.env.SUPABASE_URL ? '✅ set' : '❌ MISSING';
  checks.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ set' : '❌ MISSING';
  checks.GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID ? '✅ set' : '❌ MISSING';
  checks.GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? '✅ set' : '❌ MISSING';
  checks.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ? '✅ set' : '❌ MISSING';

  // Check private key format
  if (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    const key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
    checks.PRIVATE_KEY_HAS_BEGIN = key.includes('BEGIN PRIVATE KEY') ? '✅ yes' : '❌ missing BEGIN';
    checks.PRIVATE_KEY_HAS_END = key.includes('END PRIVATE KEY') ? '✅ yes' : '❌ missing END';
    checks.PRIVATE_KEY_LENGTH = key.length + ' chars';
  }

  // Test Supabase connection
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase.from('leads').select('id').limit(1);
    checks.SUPABASE_CONNECTION = error ? '❌ ' + error.message : '✅ connected, table accessible';
  } catch(e) {
    checks.SUPABASE_CONNECTION = '❌ ' + e.message;
  }

  // Test Sheets connection
  try {
    const { google } = await import('googleapis');
    const auth = new google.auth.JWT(
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID });
    checks.SHEETS_CONNECTION = '✅ connected, sheet accessible';
  } catch(e) {
    checks.SHEETS_CONNECTION = '❌ ' + e.message;
  }

  return res.status(200).json(checks);
}
