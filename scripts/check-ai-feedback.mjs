import '../src/loadEnv.js';
import { storeAiFeedback } from '../src/services/aiFeedback.js';

const r = await storeAiFeedback({
  input: 'test po migraci 0031',
  aiOutput: 'ok',
  feedbackType: 'other',
  meta: { source: 'post-migration-check' },
});
console.log(JSON.stringify(r, null, 2));

const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const res = await fetch(
  `${url}/rest/v1/ai_feedback?select=id,feedback_type,created_at&order=created_at.desc&limit=3`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } },
);
console.log('select', res.status, await res.text());
