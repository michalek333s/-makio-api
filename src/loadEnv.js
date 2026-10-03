import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');

// .env v projektu má přednost před systémovými SUPABASE_* (jinak starý
// Windows env SUPABASE_URL přepíše platný projekt → ENOTFOUND / „Nelze ověřit session“).
const beforeUrl = process.env.SUPABASE_URL;
const result = dotenv.config({ path: envPath, override: true });
if (result.error && result.error.code !== 'ENOENT') {
  console.warn('[loadEnv]', result.error.message);
}

const afterUrl = process.env.SUPABASE_URL;
if (
  beforeUrl &&
  afterUrl &&
  beforeUrl.replace(/\/$/, '') !== afterUrl.replace(/\/$/, '')
) {
  console.warn(
    '[loadEnv] SUPABASE_URL ze systému byl přepsán hodnotou z nemio-backend/.env',
  );
}

if (!process.env.ANTHROPIC_API_KEY && process.env.CLAUDE_API_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.CLAUDE_API_KEY;
}
