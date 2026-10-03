/**
 * Čára B — ověření bez výpisu tajných klíčů.
 * node scripts/beta-go-live.mjs
 */
import '../src/loadEnv.js';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectProductionGuardErrors } from '../src/lib/productionGuards.js';
import { isRadarDemoFallbackEnabled } from '../src/data/radarDemoListings.js';
import { isAuthEnforced } from '../src/middleware/requireAuth.js';
import { resolveWsdpAccessMode } from '../src/lib/wsdpTestMode.js';
import { getCapabilityStatus } from '../src/services/capabilityStatus.js';
import { listContractTemplates } from '../src/services/contractTemplates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'supabase', 'migrations');

const TABLES = [
  ['landing_waitlist', '0043'],
  ['chat_sessions', '0032'],
  ['aml_checks', '0033'],
  ['aml_cases', '0027'],
  ['radar_user_scans', '0039'],
  ['calendar_integrations', '0038'],
  ['contract_generations', '0042'],
  ['ai_feedback', '0031'],
];

function heading(title) {
  console.log(`\n── ${title} ──`);
}

function ok(label, pass, detail = '') {
  console.log(`  ${pass ? 'OK' : 'CHYBÍ'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return pass;
}

async function tableExists(base, key, name) {
  const res = await fetch(`${base}/rest/v1/${name}?select=id&limit=1`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'count=exact',
    },
  });
  if (res.status === 200) return true;
  const text = await res.text();
  if (/PGRST205|does not exist|Could not find the table/i.test(text)) return false;
  if (res.status === 206 || res.status === 200) return true;
  // RLS / empty can still be 200
  return res.ok;
}

function concatBetaSql() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .filter((f) => {
      const n = Number(f.slice(0, 4));
      return n >= 32 && n <= 44;
    });
  const out = join(MIGRATIONS_DIR, '_apply_beta_0032_0044.sql');
  const body = files
    .map((f) => `-- ===== ${f} =====\n${readFileSync(join(MIGRATIONS_DIR, f), 'utf8').trim()}\n`)
    .join('\n');
  writeFileSync(
    out,
    `-- Makio čára B — vložte celý soubor do Supabase SQL Editor (jednou).\n-- Idempotentní části používají IF NOT EXISTS.\n\n${body}`,
    'utf8',
  );
  return { out, files };
}

const cap = getCapabilityStatus();
heading('Kód (capabilityStatus)');
ok('Jádro auth/crm/ai/geopas', ['auth', 'crm', 'ai', 'geopas'].every((id) => cap.items.find((i) => i.id === id)?.ok));
ok('Auth vynucený', isAuthEnforced());
ok('Radar demo vypnutý', !isRadarDemoFallbackEnabled());
ok('WSDP', cap.items.find((i) => i.id === 'wsdp')?.ok, resolveWsdpAccessMode());
const templates = listContractTemplates();
ok(
    'Smlouvy skeleton na disku',
    templates.length > 0 && templates.every((t) => t.fileExists),
    `${templates.length} šablon`,
  );

heading('Production guards (suchý běh)');
const pretendProd = collectProductionGuardErrors({
  ...process.env,
  NODE_ENV: 'production',
  FRONTEND_URL: process.env.FRONTEND_URL || 'https://app.makio.cz',
  FRONTEND_URLS:
    process.env.FRONTEND_URLS || 'https://app.makio.cz,https://makio.cz,https://www.makio.cz',
});
if (pretendProd.length) {
  console.log('  Při NODE_ENV=production by start spadl:');
  pretendProd.forEach((e) => console.log(`    • ${e}`));
} else {
  console.log('  Klíče stačí — po nastavení FRONTEND_URLS backend v production nastartuje.');
}

heading('Supabase tabulky 0032–0044');
const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const missing = [];
if (!base || !key) {
  console.log('  Přeskočeno — chybí SUPABASE_URL nebo SERVICE_ROLE_KEY');
} else {
  for (const [name, mig] of TABLES) {
    try {
      const exists = await tableExists(base, key, name);
      ok(`${name} (${mig})`, exists);
      if (!exists) missing.push(name);
    } catch (e) {
      ok(`${name} (${mig})`, false, e.message);
      missing.push(name);
    }
  }
}

heading('SQL k vložení');
const { out, files } = concatBetaSql();
console.log(`  Sloučeno ${files.length} migrací → ${out}`);
if (missing.length) {
  console.log(`  Chybí tabulky: ${missing.join(', ')}`);
  console.log('  Otevřete Supabase → SQL Editor → vložte _apply_beta_0032_0044.sql');
} else if (base && key) {
  console.log('  Všechny sledované tabulky odpovídají.');
}

heading('Čára B — ještě ne kód');
console.log('  1. Vložit SQL pokud něco chybí.');
console.log('  2. Nasadit landing makio.cz + API + app.makio.cz (Vercel).');
console.log('  3. Tři parcely a tři AML lustrace vedle tebe v přihlášené apce.');
console.log('  4. WSDP / advokát — čekáme, nestavíme Signi ani platby.');

const failed = !isAuthEnforced() || isRadarDemoFallbackEnabled();
process.exit(failed ? 1 : 0);
