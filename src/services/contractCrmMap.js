/**
 * Mapování CRM → placeholdery ve Word šabloně (docxtemplater).
 * Hodnoty jsou deterministické — žádné generování textu AI.
 *
 * DŮLEŽITÉ: Každý povolený klíč má vždy hodnotu typu string (i prázdný řetězec),
 * aby docxtemplater nikdy nedostal undefined.
 */

function safe(s) {
  return String(s ?? '').trim();
}

function splitName(name) {
  const parts = safe(name).split(/\s+/).filter(Boolean);
  return {
    full: safe(name),
    first: parts[0] || '',
    last: parts.length > 1 ? parts.slice(1).join(' ') : '',
  };
}

function partyFromClient(client, prefix) {
  const n = splitName(client?.name);
  const addr = safe(client?.address_home || client?.address);
  return {
    [`${prefix}_name`]: n.full,
    [`${prefix}_first_name`]: n.first,
    [`${prefix}_last_name`]: n.last,
    [`${prefix}_email`]: safe(client?.email),
    [`${prefix}_phone`]: safe(client?.phone),
    [`${prefix}_address`]: addr,
    [`${prefix}_rc`]: safe(client?.rc),
    [`${prefix}_id_card`]: safe(client?.idCard || client?.id_card),
  };
}

/** Identifikační blok strany — jen z CRM polí, nic se nedomýšlí. */
function identityFromClient(client) {
  const n = splitName(client?.name);
  const addr = safe(client?.address_home || client?.address);
  const rc = safe(client?.rc);
  const op = safe(client?.idCard || client?.id_card);
  const email = safe(client?.email);
  const phone = safe(client?.phone);
  const parts = [];
  if (n.full) parts.push(n.full);
  if (addr) parts.push(`trvale bytem ${addr}`);
  if (rc) parts.push(`RČ ${rc}`);
  if (op) parts.push(`OP ${op}`);
  if (email) parts.push(email);
  if (phone) parts.push(phone);
  return parts.join(', ');
}

const PARTY_SUFFIXES = ['_name', '_first_name', '_last_name', '_email', '_phone', '_address', '_rc', '_id_card'];

function partyKeys(prefix) {
  return PARTY_SUFFIXES.map((s) => `${prefix}${s}`);
}

const BASE_KEYS = [
  'client_name',
  'client_first_name',
  'client_last_name',
  'client_email',
  'client_phone',
  'client_address',
  'address_property_sell',
  'address_property_buy',
  'client_rc',
  'client_id_card',
  'client_interest',
  'client_budget',
  'client_type',
  'client_status',
  'client_priority',
  'client_last_contact',
  'client_context',
  'property_address',
  'property_lv',
  'property_parcel',
  'property_area_m2',
  'property_disposition',
  'date_today_cs',
  'date_iso',
  'datetime_now_iso',
  'year',
  // legacy aliases
  'jmeno_kupujiciho',
  'jmeno',
  'prijmeni',
  'email',
  'telefon',
  'adresa_trvala',
  'adresa_klienta',
  'rodne_cislo',
  'cislo_op',
  'predmet_nemovitosti',
  'adresa_nemovitosti',
  // parties
  ...partyKeys('party_a'),
  ...partyKeys('party_b'),
  // role aliases
  ...partyKeys('klient'),
  ...partyKeys('prodavajici'),
  ...partyKeys('kupujici'),
  ...partyKeys('pronajimatel'),
  ...partyKeys('najemce'),
  // agency / broker
  'agency_name',
  'agency_ico',
  'agency_address',
  'broker_name',
  'broker_phone',
  'broker_email',
  // brokerage
  'commission_pct',
  'commission_amount',
  'exclusivity',
  'contract_term_months',
  // reservation / purchase
  'reservation_deposit',
  'reservation_deposit_words',
  'reservation_deadline',
  'purchase_price',
  'purchase_price_words',
  // lease
  'rent_monthly',
  'rent_monthly_words',
  'deposit_amount',
  'deposit_amount_words',
  'lease_start',
  'lease_end',
  'payment_day',
  'services_fee',
  'services_fee_words',
  'lease_account',
  'max_occupants',
  // property detail (lawyer PDFs)
  'property_item_a',
  'property_item_b',
  'property_item_c',
  'property_municipality',
  'property_ku',
  'property_unit',
  'property_cp',
  'property_district',
  'parcel_a_area',
  'parcel_b',
  'parcel_b_area',
  // party identity blocks (composed from CRM only — never invented)
  'prodavajici_identity',
  'kupujici_identity',
  'pronajimatel_identity',
  'najemce_identity',
  // escrow (kupní)
  'escrow_lawyer_name',
  'escrow_lawyer_address',
  'escrow_lawyer_ico',
  'escrow_cak_number',
  'escrow_account',
  'escrow_bank',
  'place_of_signing',
  // meta
  'template_id',
  'template_version',
  'contract_type_label',
];

/** Jediný zdroj pravdy pro názvy polí ve šabloně ({{...}}). */
export const CONTRACT_CRM_KEYS = Object.freeze([...new Set(BASE_KEYS)]);

export const CONTRACT_CRM_KEY_SET = new Set(CONTRACT_CRM_KEYS);

const TAG_DESCRIPTIONS = {
  client_name: 'Celé jméno klienta (primární / Party A fallback)',
  client_first_name: 'Křestní jméno',
  client_last_name: 'Příjmení',
  client_email: 'E-mail',
  client_phone: 'Telefon',
  client_address: 'Adresa / trvalá adresa klienta',
  address_property_sell: 'Adresa nemovitosti k prodeji (z CRM)',
  address_property_buy: 'Lokalita / poptávka (co klient hledá)',
  client_rc: 'Rodné číslo',
  client_id_card: 'Číslo občanského průkazu',
  client_interest: 'Záměr (např. 3+kk)',
  client_budget: 'Rozpočet',
  client_type: 'Typ (Kupující, …)',
  client_status: 'Stav v CRM',
  client_priority: 'Priorita (hot/warm/cold)',
  client_last_contact: 'Poslední kontakt',
  client_context: 'Poznámka / kontext',
  property_address: 'Adresa nemovitosti (z formuláře)',
  property_lv: 'List vlastnictví (LV)',
  property_parcel: 'Parcela / k.ú.',
  property_area_m2: 'Výměra m²',
  property_disposition: 'Dispozice (2+kk…)',
  date_today_cs: 'Dnešní datum (cs-CZ)',
  date_iso: 'Dnešní datum YYYY-MM-DD',
  datetime_now_iso: 'Datum a čas ISO',
  year: 'Rok (číslo)',
  jmeno_kupujiciho: 'Alias: celé jméno (české šablony)',
  jmeno: 'Alias: křestní jméno',
  prijmeni: 'Alias: příjmení',
  email: 'Alias: e-mail',
  telefon: 'Alias: telefon',
  adresa_trvala: 'Alias: trvalá adresa',
  adresa_klienta: 'Alias: adresa klienta',
  rodne_cislo: 'Alias: rodné číslo',
  cislo_op: 'Alias: číslo občanského průkazu',
  predmet_nemovitosti: 'Alias: předmět / nemovitost',
  adresa_nemovitosti: 'Alias: adresa nemovitosti',
  agency_name: 'Název realitní kanceláře',
  agency_ico: 'IČO kanceláře',
  agency_address: 'Sídlo kanceláře',
  broker_name: 'Jméno makléře',
  broker_phone: 'Telefon makléře',
  broker_email: 'E-mail makléře',
  commission_pct: 'Provize %',
  commission_amount: 'Provize Kč',
  exclusivity: 'Exkluzivita (ano/ne / text)',
  contract_term_months: 'Doba trvání smlouvy (měsíce)',
  reservation_deposit: 'Rezervační záloha',
  reservation_deadline: 'Lhůta rezervace',
  purchase_price: 'Kupní cena',
  rent_monthly: 'Měsíční nájem',
  deposit_amount: 'Kauce',
  lease_start: 'Začátek nájmu',
  lease_end: 'Konec nájmu',
  payment_day: 'Den splatnosti nájmu',
  template_id: 'ID šablony (interní)',
  template_version: 'Verze šablony',
  contract_type_label: 'Název typu smlouvy',
};

for (const prefix of ['party_a', 'party_b', 'klient', 'prodavajici', 'kupujici', 'pronajimatel', 'najemce']) {
  const labels = {
    party_a: 'Strana A',
    party_b: 'Strana B',
    klient: 'Klient',
    prodavajici: 'Prodávající',
    kupujici: 'Kupující / zájemce',
    pronajimatel: 'Pronajímatel',
    najemce: 'Nájemce',
  };
  const L = labels[prefix] || prefix;
  TAG_DESCRIPTIONS[`${prefix}_name`] = `${L} — jméno`;
  TAG_DESCRIPTIONS[`${prefix}_first_name`] = `${L} — křestní`;
  TAG_DESCRIPTIONS[`${prefix}_last_name`] = `${L} — příjmení`;
  TAG_DESCRIPTIONS[`${prefix}_email`] = `${L} — e-mail`;
  TAG_DESCRIPTIONS[`${prefix}_phone`] = `${L} — telefon`;
  TAG_DESCRIPTIONS[`${prefix}_address`] = `${L} — adresa`;
  TAG_DESCRIPTIONS[`${prefix}_rc`] = `${L} — rodné číslo`;
  TAG_DESCRIPTIONS[`${prefix}_id_card`] = `${L} — číslo OP`;
}

/**
 * @param {object} opts
 * @param {object} [opts.client] — legacy primary client (= party A fallback)
 * @param {object} [opts.clientA]
 * @param {object} [opts.clientB]
 * @param {object} [opts.agency] — { name, ico, address, brokerName, brokerPhone, brokerEmail }
 * @param {object} [opts.extras] — typová pole + property_*
 * @param {string} [opts.propertyAddress]
 * @param {string} [opts.templateId]
 * @param {string} [opts.templateVersion]
 * @param {string} [opts.contractType] — brokerage | reservation | lease
 * @param {string} [opts.roleMapping] — jak mapovat role (auto dle typu)
 */
export function buildContractRenderData(opts = {}) {
  const clientA = opts.clientA || opts.client || {};
  const clientB = opts.clientB || {};
  const agency = opts.agency || {};
  const extras = opts.extras && typeof opts.extras === 'object' ? opts.extras : {};
  const propertyAddress = safe(
    opts.propertyAddress ||
      extras.property_address ||
      clientA.address_property_sell ||
      clientA.address_property_buy ||
      '',
  );

  const a = splitName(clientA?.name);
  const now = new Date();
  const dateIso = now.toISOString().slice(0, 10);
  const type = String(opts.contractType || extras.contract_type || '').toLowerCase();

  const partyA = partyFromClient(clientA, 'party_a');
  const partyB = partyFromClient(clientB, 'party_b');

  // Role aliases dle typu smlouvy
  let roleA = { ...partyFromClient(clientA, 'klient') };
  let roleB = {};
  if (type === 'lease') {
    roleA = { ...partyFromClient(clientA, 'pronajimatel') };
    roleB = { ...partyFromClient(clientB, 'najemce') };
  } else if (type === 'reservation') {
    roleA = { ...partyFromClient(clientA, 'kupujici') };
    roleB = { ...partyFromClient(clientB, 'prodavajici') };
  } else if (type === 'purchase') {
    // Kupní PDF: 1.1 prodávající, 1.2 kupující — Party A = prodávající
    roleA = { ...partyFromClient(clientA, 'prodavajici') };
    roleB = { ...partyFromClient(clientB, 'kupujici') };
  } else if (type === 'brokerage') {
    roleA = { ...partyFromClient(clientA, 'klient'), ...partyFromClient(clientA, 'prodavajici') };
  }

  const typeLabels = {
    brokerage: 'Smlouva o zprostředkování',
    reservation: 'Rezervační smlouva',
    lease: 'Nájemní smlouva',
    purchase: 'Kupní smlouva',
  };

  const sellerClient = type === 'purchase' ? clientA : type === 'reservation' ? clientB : clientA;
  const buyerClient = type === 'purchase' ? clientB : type === 'reservation' ? clientA : clientB;

  const partial = {
    client_name: a.full,
    client_first_name: a.first,
    client_last_name: a.last,
    client_email: safe(clientA?.email),
    client_phone: safe(clientA?.phone),
    client_address: safe(clientA?.address_home || clientA?.address),
    address_property_sell: safe(clientA?.address_property_sell),
    address_property_buy: safe(clientA?.address_property_buy),
    client_rc: safe(clientA?.rc),
    client_id_card: safe(clientA?.idCard || clientA?.id_card),
    client_interest: safe(clientA?.interest),
    client_budget: safe(clientA?.budget),
    client_type: safe(clientA?.type),
    client_status: safe(clientA?.status),
    client_priority: safe(clientA?.priority),
    client_last_contact: safe(clientA?.lastContact || clientA?.last_contact),
    client_context: safe(clientA?.context),
    property_address: propertyAddress,
    property_lv: safe(extras.property_lv),
    property_parcel: safe(extras.property_parcel),
    property_area_m2: safe(extras.property_area_m2),
    property_disposition: safe(extras.property_disposition),
    property_item_a: safe(extras.property_item_a || extras.property_parcel || propertyAddress),
    property_item_b: safe(extras.property_item_b),
    property_item_c: safe(extras.property_item_c),
    property_municipality: safe(extras.property_municipality),
    property_ku: safe(extras.property_ku),
    property_unit: safe(extras.property_unit),
    property_cp: safe(extras.property_cp),
    property_district: safe(extras.property_district),
    parcel_a_area: safe(extras.parcel_a_area),
    parcel_b: safe(extras.parcel_b),
    parcel_b_area: safe(extras.parcel_b_area),
    date_today_cs: now.toLocaleDateString('cs-CZ'),
    date_iso: dateIso,
    datetime_now_iso: now.toISOString(),
    year: String(now.getFullYear()),
    jmeno_kupujiciho: a.full,
    jmeno: a.first,
    prijmeni: a.last,
    email: safe(clientA?.email),
    telefon: safe(clientA?.phone),
    adresa_trvala: safe(clientA?.address_home || clientA?.address),
    adresa_klienta: safe(clientA?.address_home || clientA?.address),
    rodne_cislo: safe(clientA?.rc),
    cislo_op: safe(clientA?.idCard || clientA?.id_card),
    predmet_nemovitosti: propertyAddress,
    adresa_nemovitosti: propertyAddress,
    ...partyA,
    ...partyB,
    ...roleA,
    ...roleB,
    prodavajici_identity: identityFromClient(sellerClient),
    kupujici_identity: identityFromClient(buyerClient),
    pronajimatel_identity: identityFromClient(type === 'lease' ? clientA : {}),
    najemce_identity: identityFromClient(type === 'lease' ? clientB : {}),
    agency_name: safe(agency.name || agency.agency || extras.agency_name),
    agency_ico: safe(agency.ico || extras.agency_ico),
    agency_address: safe(agency.address || extras.agency_address),
    broker_name: safe(agency.brokerName || agency.broker_name || extras.broker_name),
    broker_phone: safe(agency.brokerPhone || agency.broker_phone || extras.broker_phone),
    broker_email: safe(agency.brokerEmail || agency.broker_email || extras.broker_email),
    commission_pct: safe(extras.commission_pct),
    commission_amount: safe(extras.commission_amount),
    exclusivity: safe(extras.exclusivity),
    contract_term_months: safe(extras.contract_term_months),
    reservation_deposit: safe(extras.reservation_deposit),
    reservation_deposit_words: safe(extras.reservation_deposit_words),
    reservation_deadline: safe(extras.reservation_deadline),
    purchase_price: safe(extras.purchase_price),
    purchase_price_words: safe(extras.purchase_price_words),
    rent_monthly: safe(extras.rent_monthly),
    rent_monthly_words: safe(extras.rent_monthly_words),
    deposit_amount: safe(extras.deposit_amount),
    deposit_amount_words: safe(extras.deposit_amount_words),
    lease_start: safe(extras.lease_start),
    lease_end: safe(extras.lease_end),
    payment_day: safe(extras.payment_day),
    services_fee: safe(extras.services_fee),
    services_fee_words: safe(extras.services_fee_words),
    lease_account: safe(extras.lease_account),
    max_occupants: safe(extras.max_occupants),
    escrow_lawyer_name: safe(extras.escrow_lawyer_name),
    escrow_lawyer_address: safe(extras.escrow_lawyer_address),
    escrow_lawyer_ico: safe(extras.escrow_lawyer_ico),
    escrow_cak_number: safe(extras.escrow_cak_number),
    escrow_account: safe(extras.escrow_account),
    escrow_bank: safe(extras.escrow_bank),
    place_of_signing: safe(extras.place_of_signing),
    template_id: safe(opts.templateId),
    template_version: safe(opts.templateVersion),
    contract_type_label: safe(typeLabels[type] || extras.contract_type_label),
  };

  const out = {};
  for (const key of CONTRACT_CRM_KEYS) {
    const v = partial[key];
    out[key] = v != null ? String(v) : '';
  }
  return out;
}

/**
 * Zpětná kompatibilita: (client, propertyAddress) → render data.
 */
export function buildFullContractRenderData(client, propertyAddress) {
  return buildContractRenderData({
    client,
    propertyAddress: propertyAddress != null ? String(propertyAddress) : '',
  });
}

/** Alias */
export function buildContractData(client, propertyAddress) {
  return buildFullContractRenderData(client, propertyAddress);
}

export function describeContractTag(key) {
  return TAG_DESCRIPTIONS[key] || key;
}

export function listContractTagDocumentation() {
  return CONTRACT_CRM_KEYS.map((tag) => ({
    tag,
    description: describeContractTag(tag),
  }));
}

/**
 * Chybějící povinné klíče z manifestu vůči render datům.
 * @returns {{ tag: string, description: string }[]}
 */
export function findMissingRequiredKeys(crmData, requiredKeys = []) {
  const keys = Array.isArray(requiredKeys) ? requiredKeys : [];
  return keys
    .filter((k) => {
      const v = crmData?.[k];
      return v === '' || v == null;
    })
    .map((tag) => ({
      tag,
      description: describeContractTag(tag),
      label: describeContractTag(tag),
    }));
}
