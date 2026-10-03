/**
 * Centrální limity vstupů — ochrana před DoS a zneužitím drahých AI volání.
 * (Validace je na serveru; frontend může zkrátit jen pro UX.)
 */
export const LIMITS = {
  /** Adresa / dotaz do GeoPas */
  PROPERTY_QUERY_CHARS: 512,
  /** Uživatelská zpráva do chatu (Gemini) */
  CHAT_MESSAGE_CHARS: 12_000,
  /** Kontext CRM poslaný do chatu */
  CLIENTS_CONTEXT_CHARS: 32_000,
  /** Kontext otevřené obrazovky (Radar/CRM/…) */
  SCREEN_CONTEXT_CHARS: 4_000,
  /** Počet záznamů historie v jednom requestu */
  CHAT_HISTORY_MAX_ITEMS: 40,
  /** Podklad pro inzerát */
  LISTING_PROPERTY_CHARS: 50_000,
  /** Base64 obrázku (staging) — cca horní hranice rozumné fotky */
  IMAGE_BASE64_MAX_CHARS: 12_000_000,
  /** Povolené MIME pro vision */
  IMAGE_MIME_WHITELIST: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  /** Radar / Apify scan */
  RADAR_MAX_LISTINGS: 200,
  RADAR_REGIONS_MAX: 30,
  RADAR_REGION_NAME_MAX: 120,
  RADAR_CRM_CLIENTS_MAX: 80,
  RADAR_CRM_NAME_MAX: 120,
  RADAR_CRM_BUDGET_MAX: 40,
  /** JSON jednoho leadu do POST /radar/score-lead */
  RADAR_LEAD_JSON_MAX: 48_000,
};
