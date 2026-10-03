# Vlastník a list vlastnictví (LV) — nejlevnější cesta v Nemio

## Co už máte zdarma / v základním GeoPas tarifu

Přes `GEOPAS_API_KEY` (token od GeoPas) Nemio stahuje bez WSDP:

| Data | Endpoint GeoPas |
|------|-------------------|
| Adresa, parcela, KÚ, výměra | `entityByTerm`, `addressByCode`, `landByCode` |
| Záplavy | `waterFloodByLand` |
| Hluk | `noiseByLand` |
| Okolí (školy, MHD, …) | `poiByAddress` |

To odpovídá výstupu v chatu kromě řádku **Vlastník / LV**.

## Proč vlastník chybí (i když máte endpoint v seznamu)

GeoPas vám na dev serveru ukáže **`wsdpLvByLand` v tabulce endpointů** — to znamená, že API metoda existuje a server ji umí obsloužit.

To **není to samé** jako mít aktivní **WSDP účet**. Potřebujete **dvě různé přihlašovací věci**:

| Co | Env proměnná | K čemu |
|----|--------------|--------|
| API token | `GEOPAS_API_KEY` (`t=…` v URL) | entityByTerm, landByCode, záplavy, POI… |
| WSDP účet | `GEOPAS_WSDP_LOGIN` + `GEOPAS_WSDP_PASSWORD` | **jen** wsdpLvByLand (LV, vlastník) |

Typická chyba bez WSDP loginu: `Mandatory parameter 'login' not found`.

Jméno vlastníka a plný obsah LV jsou chráněné údaje ČÚZK. GeoPas endpoint `wsdpLvByLand` je placený most k WSDP.

## Tři úrovně (od nejlevnější)

### 1. Vývoj / demo — `GEOPAS_WSDP_TEST=true` (e-mail Jiří Kynčl / GeoPas)

```env
GEOPAS_WSDP_TEST=true
GEOPAS_WSDP_DEV_LOGIN=test
GEOPAS_WSDP_DEV_PASSWORD=test
```

- GeoPas na dev: **`test=true` + `login` + `password`** (hodnoty `test`/`test` stačí).
- Vrací **stále stejné ukázkové LV** (XML v `base64EncodedFile`) — **bez placení**.
- Nemio volá WSDP v test režimu **jen jednou na běh serveru**, pak reuse (šetření volání).
- Vlastník v UI je označen jako ukázkový — nemusí sedět k vaší parcele.

### 2. Produkce — WSDP přihlašovací údaje od GeoPas

```env
GEOPAS_WSDP_LOGIN=váš_wsdp_login
GEOPAS_WSDP_PASSWORD=váš_wsdp_heslo
# GEOPAS_WSDP_TEST=false   # nebo proměnnou smažte
```

**Postup:**

1. Kontaktovat **GeoPas** (máte už `GEOPAS_API_KEY`) — požádat o aktivaci **WSDP** k vašemu účtu.
2. GeoPas/ČÚZK nastaví přístup k WSDP; dostanete login a heslo.
3. Doplnit do `nemio-backend/.env`, restart backendu.
4. Nemio pak u analýzy volá `wsdpLvByLand` s reálnými údaji (`ownerAccess: credentials`).

**Náklady:** závisí na smlouvě ČÚZK WSDP (často poplatek za uživatele + za stažení LV). GeoPas vám řekne aktuální ceník — obvykle výhodnější než stavět vlastní integraci na ČÚZK.

### 3. Ručně bez API (0 Kč za volání, ale čas makléře)

- [Nahlížení do katastru](https://nahlizeni.cuzk.cz) — vlastní účet makléře, účel dle pravidel ČÚZK.
- Jméno pak zadat do CRM klienta a spustit v Nemio **AML / insolvenci** (ISIR, sankce EU).

Vhodné jako doplněk, ne jako automat pro každý dotaz v chatu.

## Captcha na nahlizeni.cuzk.cz — proč ji neobcházíme

Web **Nahlížení do katastru** používá captcha a přihlášení záměrně: chrání osobní údaje vlastníků a omezuje automatické stahování.

| Přístup | Captcha? | Legální pro Nemio? |
|---------|----------|-------------------|
| Ruční nahlížení (makléř) | Ano | Ano — jednotlivé dotazy |
| Scraping / obcházení captcha | — | **Ne** — porušení podmínek ČÚZK, GDPR, riziko sankcí |
| **WSDP API** (GeoPas `wsdpLvByLand`) | Ne (login+heslo / smlouva) | **Ano** — určené pro software |

**Captcha obejít nejde legálně** a v Nemio to implementovat nebudeme. Ekvivalent bez captcha pro aplikace je **WSDP** — placená, ale oficiální cesta k LV a vlastníkovi.

## Co Nemio nedělá (a proč)

| Zdroj | Vlastník z LV? |
|-------|----------------|
| RUIAN / mapy | Ne |
| Inzeráty (Sreality, …) | Nelegální / nespolehlivé |
| „Levné“ scrapery katastru | Porušení podmínek ČÚZK, právní riziko |

Jediná legální API cesta pro automat v produktu je **WSDP přes GeoPas** (nebo přímá smlouva s ČÚZK — dražší na údržbu).

## Doporučený produktový postup

1. **Teď:** bohatý report v chatu (katastr, rizika, ocenění) + jasná hláška u vlastníka s odkazem na WSDP.
2. **Pilot:** `GEOPAS_WSDP_TEST=true` pro makléře.
3. **Go-live:** jeden firemní WSDP účet kanceláře v `.env` (nebo později per-tenant v Supabase secrets).
4. **Po získání jména:** AML audit v Nemio na stejném klientovi.

## Ověření

```bash
cd nemio-backend
node -e "
import('./src/services/runPropertyAnalysis.js').then(async ({runPropertyAnalysis}) => {
  const r = await runPropertyAnalysis('Lískovec 310 Frýdek-Místek', { useCache: false });
  console.log({ owner: r.owner, ownerAccess: r.ownerAccess, lv: r.lv });
});
"
```

V chatu: *„analyzuj Lískovec 310, Frýdek-Místek“* — výstup by měl být strukturovaný report (nadpisy, tabulka cen), ne prostý odráčkový seznam.

## Související soubory

- `src/services/geopas.js` — `wsdpLvByLand`, `mapWsdpToParcel`
- `src/services/formatPropertyNarrative.js` — markdown pro chat
- `GEOPAS.md` — obecné napojení
