# GeoPas — napojení Nemio

## Architektura (Claude tool-use)

```
1. Makléř napíše cokoli (adresa, parcela 1247/12, LV, záplavy…)
2. POST /api/ai/chat → backend detekuje GeoPas dotaz
3. Claude agent volí nástroje (entityByTerm, landByCode, flood, noise, POI, WSDP…)
4. Paralelní GeoPas volání (Promise.all u environment)
5. Odpověď v češtině (markdown) + karta GeoPas + modal Detail

Vyžaduje: GEOPAS_API_KEY + ANTHROPIC_API_KEY v nemio-backend/.env
Bez Claude: fallback na pevný pipeline (Gemini chat + runPropertyAnalysis).

Ruční analýza: POST /api/property/analyze
```

### Nástroje agenta

| Tool | GeoPas endpoint |
|------|-----------------|
| `geopas_search_entities` | entityByTerm |
| `geopas_get_address` | addressByCode |
| `geopas_get_land` | landByCode |
| `geopas_get_land_environment` | waterFlood + noise + poi (paralelně) |
| `geopas_get_wsdp_lv` | wsdpLvByLand |

Klíč `GEOPAS_API_KEY` je **token** (`t=…` v URL). Frontend ho nevidí.

### Příklady dotazů v chatu

- „Analyzuj Mánesovu 12, Praha 2“
- „Co je na parcele 2201/1 Vinohrady?“
- „Záplavy a hluk u Na Valech 5 Říčany“

## Konfigurace `.env`

```env
GEOPAS_API_KEY=váš_token_od_geopas
GEOPAS_DEV_IP=85.207.0.17
GEOPAS_WSDP_TEST=true
```

| Proměnná | Popis |
|----------|--------|
| `GEOPAS_API_KEY` | Povinné — token z e-mailu GeoPas |
| `GEOPAS_DEV_IP` | Volitelné — dev server (jako `curl --resolve geopas.cz:443:85.207.0.17`) |
| `GEOPAS_WSDP_LOGIN` / `GEOPAS_WSDP_PASSWORD` | Pro skutečné LV a vlastníka (`wsdpLvByLand`) |
| `GEOPAS_WSDP_TEST=true` | Ukázková LV bez poplatku (dokud nemáte WSDP přístup) |

**Vlastník / LV / ceny WSDP:** viz [GEOPAS_OWNER.md](./GEOPAS_OWNER.md).

## Spuštění

```bash
cd nemio-backend
npm run dev
```

V aplikaci: u klienta **Analyzovat nemovitost** (nebo AI akce `ANALYZE_PROPERTY`) — volá se adresa z CRM.

## Endpointy používané v Nemio

| GeoPas | Účel |
|--------|------|
| `entityByTerm` | Vyhledání adresy / parcely |
| `addressByCode` | Detail adresy → odkaz na parcelu |
| `landByCode` | Parcela, KÚ, výměra |
| `poiByAddress` | Školy, MHD, služby v okolí |
| `waterFloodByLand` | Záplavové zóny |
| `noiseByLand` | Hluk |
| `wsdpLvByLand` | LV, vlastník (WSDP — placené) |

Zatím **nepoužíváme** (na dev nefunkční / v přípravě): `populationByMunicipality`, `radonByPoint`, `up`, `ageByMunicipality`.

## Ruční test (curl)

```bash
curl --resolve geopas.cz:443:85.207.0.17 ^
  "https://geopas.cz/api/entityByTerm?t=VÁŠ_TOKEN&term=Mánesova%2012%20Praha&entities=address,land"
```

## API Nemio

- `POST /api/property/analyze` — body `{ "query": "Mánesova 12, Praha 2" }`
- `GET /api/property/search?q=Mánesova` — našeptávač

## Cache (urychlení + úspora volání)

Analýza (`runPropertyAnalysis`, chat, modal) prochází **vrstvenou cache**:

| Vrstva | Kde | Účel |
|--------|-----|------|
| L1 | RAM na backendu | Okamžitá odpověď při opakovaném dotazu ve stejné session |
| L2 | Supabase `geopas_analysis_cache` | Přežije restart serveru, sdílení mezi instancemi |

**Migrace:** spusťte `supabase/migrations/0015_geopas_analysis_cache.sql` v SQL Editoru.

**`.env` (backend):**

```env
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
GEOPAS_CACHE_BACKEND=layered
GEOPAS_CACHE_TTL_HOURS=24
```

| Proměnná | Výchozí | Popis |
|----------|---------|--------|
| `GEOPAS_CACHE_ENABLED` | `true` | `false` vypne cache |
| `GEOPAS_CACHE_BACKEND` | `layered` | `memory` \| `supabase` \| `layered` |
| `GEOPAS_CACHE_TTL_HOURS` | `168` (7 dní) | Katastr se mění pomalu — déle = méně plateb |
| `GEOPAS_SEARCH_CACHE_TTL_HOURS` | `24` | Našeptávač adres |

Ukládá se **kompletní analýza + surová GeoPas data** pod klíče: dotaz, `parcel_{id}`, normalizovaná adresa.

Ověření: `node --import dotenv/config scripts/verify-geopas-cache.mjs`

`GET /api/property/cache-stats` — počítadla hit/miss.

Klíče: normalizovaný dotaz (`liskovec_310_frydek_mistek`) + alias `parcel_{kn_id}` — stejná parcela pod jinou adresou najde cache.

**Vynucené obnovení:** `POST /api/property/analyze` s `{ "query": "...", "refresh": true }`.

Odpověď obsahuje `fromCache`, `cacheSource`, `cacheAgeMinutes` (UI badge „cache“).

Bez Supabase funguje jen RAM (do restartu procesu).
