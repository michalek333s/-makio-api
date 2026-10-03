/**
 * Pravidla náběru / cold-call podle portálu.
 * Není právní posudek — produktová politika Makio podle OP portálů, GDPR a ZEK.
 */

export const OUTREACH = {
  ALLOW: 'allow',
  CAUTION: 'caution',
  FORBIDDEN: 'forbidden',
};

const BY_SOURCE = {
  sreality: {
    level: OUTREACH.ALLOW,
    label: 'Sreality — soukromník',
    short: 'Náběr možný',
    note:
      'Klasický náběrový kanál u soukromých inzerátů. Když je v inzerátu „RK nevolat“, je to signál — náběr pořád může dávat smysl, ale jděte jemně a nepředstírejte kupce.',
  },
  bezrealitky: {
    level: OUTREACH.FORBIDDEN,
    label: 'Bezrealitky',
    short: 'Mimo Radar',
    note: 'Bezrealitky v Makio Radaru nepoužíváme.',
  },
  bazos: {
    level: OUTREACH.CAUTION,
    label: 'Bazoš',
    short: 'Jen s opatrností',
    note:
      'Inzerát není souhlas s telemarketingem. „RK nevolat“ jen zvýrazníme — pořád může jít o náběr, pokud se představíte jako makléř a netlačíte.',
  },
  facebook: {
    level: OUTREACH.CAUTION,
    label: 'Facebook Marketplace',
    short: 'Jen s opatrností',
    note:
      'Pravidla Meta zakazují scrapování. Oslovení přes Marketplace jen v rámci platformy, bez klamání identity. Není primární náběrový kanál Makia.',
  },
  facebook_marketplace: {
    level: OUTREACH.CAUTION,
    label: 'Facebook Marketplace',
    short: 'Jen s opatrností',
    note:
      'Pravidla Meta zakazují scrapování. Oslovení přes Marketplace jen v rámci platformy, bez klamání identity.',
  },
};

export function getOutreachPolicy(leadOrSource) {
  const source =
    typeof leadOrSource === 'string'
      ? leadOrSource
      : String(leadOrSource?.source || '').toLowerCase();
  return (
    BY_SOURCE[source] || {
      level: OUTREACH.CAUTION,
      label: source || 'Neznámý portál',
      short: 'Ověřit pravidla',
      note: 'Než budete volat, ověřte podmínky portálu a zda inzerát nezakazuje RK.',
    }
  );
}

export const RK_NO_CALL_RE =
  /rk\s*nevolat|makl[eé][rř](e|ům|um)?\s*nevolat|realitk[yá]\s*nevolat|nevolat\s*rk/i;

export function listingHasRkNoCall(lead) {
  const blob = [lead?.title, lead?.description, lead?.aiNote, ...(lead?.radarReasons || [])]
    .filter(Boolean)
    .join(' ');
  return RK_NO_CALL_RE.test(blob);
}

export function canColdCallListing(lead) {
  return getOutreachPolicy(lead).level !== OUTREACH.FORBIDDEN;
}
