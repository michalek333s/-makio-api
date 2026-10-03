/**
 * Polling intervaly Radar v2 — výchozí VYPNUTO.
 * Cache-only (`RADAR_CACHE_ONLY` default ON) má vždy přednost.
 * Žádný live scrape v dev, dokud není RADAR_LIVE_SCRAPE=1 a RADAR_CACHE_ONLY=0.
 */

function intEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getRadarPollConfig() {
  const cacheOnly = process.env.RADAR_CACHE_ONLY !== '0';
  const liveScrape = process.env.RADAR_LIVE_SCRAPE === '1';
  return {
    cacheOnly,
    liveScrape,
    /** Live poll jen když je výslovně zapnutý a cache-only je pryč. */
    enabled: liveScrape && !cacheOnly,
    bazosMs: intEnv('RADAR_POLL_BAZOS_MS', 5 * 60_000),
    bezrealitkyMs: intEnv('RADAR_POLL_BEZREALITKY_MS', 10 * 60_000),
    srealityMs: intEnv('RADAR_POLL_SREALITY_MS', 15 * 60_000),
    proxyUrl: String(process.env.RADAR_PROXY_URL || '').trim() || null,
    region: String(process.env.RADAR_LIVE_REGION || process.env.RADAR_BG_REGIONS || 'Moravskoslezský')
      .split(',')[0]
      .trim(),
    propertyType: String(process.env.RADAR_LIVE_PROPERTY_TYPE || 'byty').trim() || 'byty',
  };
}

export function describeRadarPollConfig() {
  const c = getRadarPollConfig();
  if (!c.enabled) {
    return c.cacheOnly
      ? 'Radar live scrape: vypnuto (RADAR_CACHE_ONLY, výchozí)'
      : 'Radar live scrape: vypnuto (RADAR_LIVE_SCRAPE≠1)';
  }
  return `Radar live scrape: ${c.region}/${c.propertyType} · Bazoš ${c.bazosMs / 60000} min · Bezrealitky ${c.bezrealitkyMs / 60000} min`;
}

let timers = [];

/**
 * Spustí intervaly přes existující Apify enrich — ne HTML bypass.
 * Ve výchozím stavu no-op.
 */
export function startRadarLivePollScheduler(queueEnrichFn) {
  const cfg = getRadarPollConfig();
  for (const t of timers) clearInterval(t);
  timers = [];

  if (!cfg.enabled) {
    console.log(`   ${describeRadarPollConfig()}`);
    return cfg;
  }

  if (typeof queueEnrichFn !== 'function') {
    console.warn('   Radar live scrape: chybí queueEnrichFn');
    return cfg;
  }

  console.log(`   ${describeRadarPollConfig()}`);

  const tick = (reason) => {
    queueEnrichFn(cfg.region, cfg.propertyType, { reason, force: false }).catch((e) =>
      console.warn(`[Radar poll ${reason}]`, e.message),
    );
  };

  timers.push(setInterval(() => tick('poll_bazos'), cfg.bazosMs));
  timers.push(setInterval(() => tick('poll_bezrealitky'), cfg.bezrealitkyMs));
  return cfg;
}

/**
 * Veřejný fetch listing page — žádný WAF bypass.
 * Volitelně RADAR_PROXY_URL přes undici ProxyAgent (Node 20+).
 */
export async function radarPublicFetch(url, { timeoutMs = 15_000, accept = 'text/html,application/json' } = {}) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (compatible; NemioRadar/2.0; +https://makio.cz) AppleWebKit/537.36 Chrome/124.0.0.0',
    Accept: accept,
    'Accept-Language': 'cs',
  };
  const proxy = getRadarPollConfig().proxyUrl;
  const signal = AbortSignal.timeout(timeoutMs);

  if (proxy) {
    try {
      const { ProxyAgent, fetch: undiciFetch } = await import('undici');
      const agent = new ProxyAgent(proxy);
      return await undiciFetch(url, { dispatcher: agent, headers, signal });
    } catch (e) {
      console.warn('[Radar] proxy fetch selhal, jdu bez proxy:', e.message);
    }
  }
  return fetch(url, { headers, signal });
}
