import { isAuthEnforced } from '../middleware/requireAuth.js';
import { resolveWsdpAccessMode } from '../lib/wsdpTestMode.js';
import { isRadarDemoFallbackEnabled } from '../data/radarDemoListings.js';
import { allowMemoryCredits } from './credits.js';
import { isAmlPersistConfigured } from './amlCaseStore.js';
import { isAmlChecksConfigured } from './amlChecksStore.js';
import { isIsirConfigured } from './inshlidacIsir.js';
import { isSigniConfigured } from './signi.js';
import { isApifyQuotaCoolingDown, getApifyQuotaCooldownMs } from './radarBackgroundEnrich.js';
import { listContractTemplates } from './contractTemplates.js';
import { isLibreOfficeAvailable } from './contractLibreOffice.js';
import { isIdOcrConfigured } from './idDocumentOcr.js';

function has(name) {
  return Boolean(String(process.env[name] || '').trim());
}

function item(id, label, ok, detail = '') {
  return { id, label, ok: Boolean(ok), detail: detail || null };
}

export function getCapabilityStatus() {
  const geopas = has('GEOPAS_API_KEY');
  const gemini = has('GEMINI_API_KEY');
  const anthropic = has('ANTHROPIC_API_KEY');
  const openai = has('OPENAI_API_KEY');
  const supabase = has('SUPABASE_URL') && has('SUPABASE_SERVICE_ROLE_KEY');
  const supabaseAuth = has('SUPABASE_URL') && has('SUPABASE_ANON_KEY');
  const apify = has('APIFY_TOKEN');
  const decor8 = has('DECOR8_API_KEY');
  const higgsfield =
    has('HF_CREDENTIALS') || has('HIGGSFIELD_CREDENTIALS') || (has('HF_API_KEY') && has('HF_API_SECRET'));
  const rejstriky = has('REJSTRIKY_USERNAME') && has('REJSTRIKY_PASSWORD');
  const opensanctions = has('OPENSANCTIONS_API_KEY');
  const isir = isIsirConfigured();
  const amlChecks = isAmlChecksConfigured();
  const zoom = has('ZOOM_ACCOUNT_ID') && has('ZOOM_CLIENT_ID') && has('ZOOM_CLIENT_SECRET');
  const wsdp = resolveWsdpAccessMode();
  const radarDemo = isRadarDemoFallbackEnabled();
  const memoryCredits = allowMemoryCredits() && !supabase;
  const googleCal = has('GOOGLE_CLIENT_ID') && has('GOOGLE_CLIENT_SECRET');
  const signi = isSigniConfigured();
  const feedbackGov = has('FEEDBACK_GOVERNANCE_SECRET');
  const apifyBlocked = isApifyQuotaCoolingDown();
  const templates = listContractTemplates();
  const templatesOnDisk = templates.length > 0 && templates.every((t) => t.fileExists);
  const lawyerApproved = templates.length > 0 && templates.every((t) => Boolean(t.approvedAt));
  const libre = isLibreOfficeAvailable();

  const items = [
    item('auth', 'Přihlášení makléře', isAuthEnforced() && supabaseAuth, isAuthEnforced() ? 'Supabase JWT' : 'Auth není vynucené'),
    item('crm', 'CRM v cloudu', supabase, supabase ? 'RLS + service role' : 'Chybí SUPABASE_*'),
    item('ai', 'Makio chat', gemini || anthropic, gemini || anthropic ? 'Gemini / Claude' : 'Chybí GEMINI_API_KEY nebo ANTHROPIC_API_KEY'),
    item('geopas', 'Katastr a okolí (GeoPas)', geopas, geopas ? 'parcela, záplavy, hluk, POI' : 'Chybí GEOPAS_API_KEY'),
    item(
      'wsdp',
      'Vlastník a list vlastnictví',
      wsdp === 'credentials',
      wsdp === 'credentials'
        ? 'Produkční WSDP'
        : wsdp === 'test'
          ? 'Testovací WSDP — jméno vlastníka se nezobrazuje'
          : 'Chybí GEOPAS_WSDP_LOGIN / PASSWORD (GEOPAS_WSDP_TEST vypněte)',
    ),
    item(
      'radar',
      'Radar příležitostí',
      apify && !radarDemo && !apifyBlocked,
      radarDemo
        ? 'Ukázkové inzeráty jsou zapnuté (RADAR_DEMO_FALLBACK) — vypněte je'
        : apifyBlocked
          ? `Apify limit/cooldown ~${Math.max(1, Math.round(getApifyQuotaCooldownMs() / 3_600_000))} h — chat používá historickou cache`
          : apify
            ? 'Apify cache živých inzerátů'
            : 'Chybí APIFY_TOKEN — bez něj je Radar prázdný, ne demo',
    ),
    item(
      'contracts',
      'Automatizace smluv',
      templatesOnDisk,
      !templatesOnDisk
        ? 'Chybí skeleton/template.docx — npm run contracts:skeletons'
        : lawyerApproved
          ? 'Advokátní šablony schválené'
          : 'Technické skeletony — nahraďte advokátním template.docx',
    ),
    item(
      'contractsPdf',
      'PDF smluv (LibreOffice)',
      libre,
      libre ? `soffice: ${process.env.LIBREOFFICE_PATH || 'PATH'}` : 'Nainstalujte LibreOffice nebo LIBREOFFICE_PATH',
    ),
    item(
      'signi',
      'E-podpis Signi',
      signi,
      signi ? 'SIGNI_API_KEY nastaven — UI odemčeno' : 'UI skryté do doplnění SIGNI_API_KEY',
    ),
    item(
      'calendar',
      'Google Calendar',
      googleCal,
      googleCal
        ? 'OAuth připraven — ověřte migrace 0038/0040'
        : 'Chybí GOOGLE_CLIENT_ID / SECRET (+ migrace 0038/0040)',
    ),
    item(
      'feedbackGov',
      'Governance AI feedback',
      feedbackGov || process.env.NODE_ENV !== 'production',
      feedbackGov
        ? 'FEEDBACK_GOVERNANCE_SECRET — schvalování lekcí'
        : 'V production nastavte FEEDBACK_GOVERNANCE_SECRET (anti-poisoning)',
    ),
    item(
      'aml',
      'AML lustrace',
      opensanctions || isir || rejstriky,
      [
        opensanctions ? 'OpenSanctions' : null,
        isir ? 'ISIR (Inshlidac/Rejstříky)' : null,
        'ARES REST',
      ]
        .filter(Boolean)
        .join(' · ') || 'Doplňte OPENSANCTIONS_API_KEY a INSHLIDAC_*',
    ),
    item(
      'amlPersist',
      'AML spis & audit log',
      isAmlPersistConfigured() || amlChecks,
      [
        isAmlPersistConfigured() ? 'aml_cases' : null,
        amlChecks ? 'aml_checks (0033)' : null,
      ]
        .filter(Boolean)
        .join(' + ') || 'Spusťte migraci 0033_aml_checks.sql',
    ),
    item('staging', 'Vizuální staging', decor8, decor8 ? 'Decor8' : 'Chybí DECOR8_API_KEY'),
    item('video', 'AI video / reels', higgsfield, higgsfield ? 'Higgsfield' : 'Chybí HF_CREDENTIALS'),
    item('openai', 'Copywriter (GPT)', openai, openai ? 'OpenAI' : 'Stačí Gemini; GPT-4o Vision jen s OPENAI_API_KEY'),
    item(
      'credits',
      'Kredity (ledger)',
      supabase && !memoryCredits,
      memoryCredits
        ? 'RAM peněženka (jen lokální demo)'
        : supabase
          ? 'Supabase ledger · online platba ještě není — top-up přes admin / info@makio.cz'
          : 'Chybí Supabase — v production 503',
    ),
    item('zoom', 'Videohovory Zoom', zoom, zoom ? 'S2S OAuth' : 'Volitelné'),
    item(
      'ocr',
      'OCR dokladu (Vision)',
      isIdOcrConfigured(),
      isIdOcrConfigured()
        ? 'Gemini / GPT-4o Vision — návrh, ověřit podle OP'
        : 'Chybí GEMINI_API_KEY nebo OPENAI_API_KEY',
    ),
  ];

  const blocking = items.filter(
    (i) =>
      !i.ok &&
      ![
        'zoom',
        'openai',
        'video',
        'wsdp',
        'aml',
        'amlPersist',
        'staging',
        'signi',
        'calendar',
        'contractsPdf',
        'feedbackGov',
        'ocr',
      ].includes(i.id),
  );
  const coreOk = items.filter((i) => ['auth', 'crm', 'ai', 'geopas'].includes(i.id)).every((i) => i.ok);

  const goLiveChecklist = [
    {
      id: 'mig_calendar',
      label: 'Migrace 0038 + 0040 (Google Calendar)',
      ok: null,
      detail: 'Spusťte v Supabase SQL Editor',
    },
    {
      id: 'mig_radar_scans',
      label: 'Migrace 0039 (radar_user_scans)',
      ok: null,
      detail: 'Per-user Radar persist',
    },
    {
      id: 'mig_feedback',
      label: 'Migrace 0041 (ai_feedback governance)',
      ok: null,
      detail: 'is_approved_for_context',
    },
    {
      id: 'mig_contracts',
      label: 'Migrace 0042 (contract_generations)',
      ok: null,
      detail: 'Audit fill smluv',
    },
    {
      id: 'lawyer_docx',
      label: 'Advokátní template.docx (3 typy)',
      ok: lawyerApproved,
      detail: lawyerApproved ? 'OK' : 'Skeleton ≠ právní produkt',
    },
    {
      id: 'apify_live',
      label: 'Apify bez limitu',
      ok: apify && !apifyBlocked,
      detail: apifyBlocked ? 'Cooldown aktivní' : apify ? 'Token OK' : 'Chybí token',
    },
    {
      id: 'wsdp_prod',
      label: 'WSDP produkce',
      ok: wsdp === 'credentials',
      detail: wsdp === 'test' ? 'Test mode' : String(wsdp),
    },
    {
      id: 'radar_demo_off',
      label: 'Radar bez ukázkových inzerátů',
      ok: !radarDemo,
      detail: radarDemo ? 'Vypněte RADAR_DEMO_FALLBACK' : 'Demo fallback vypnutý',
    },
    {
      id: 'auth_on',
      label: 'Auth vynucený',
      ok: isAuthEnforced(),
      detail: isAuthEnforced() ? 'JWT' : 'AUTH_DISABLED nebo chybí Supabase',
    },
  ];

  return {
    live: coreOk && !radarDemo,
    radarDemo,
    wsdpMode: wsdp,
    apifyQuotaBlocked: apifyBlocked,
    items,
    blocking: blocking.map((i) => i.id),
    goLiveChecklist,
    hint: coreOk
      ? radarDemo
        ? 'Jádro běží, ale Radar má ukázková data. Vypněte RADAR_DEMO_FALLBACK.'
        : apifyBlocked
          ? 'Jádro živé. Radar čte cache (Apify limit) — provoz dál funguje.'
          : 'Jádro živé (login, CRM, chat, GeoPas). Volitelně: WSDP produkce, právní šablony smluv, Google Calendar.'
      : 'Doplňte klíče v nemio-backend/.env a obnovte server — bez nich to není ostrý provoz.',
  };
}
