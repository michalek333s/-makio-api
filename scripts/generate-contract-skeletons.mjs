/**
 * Vygeneruje technické skeleton .docx pro 3 typy smluv (NE právní text).
 * Spuštění: node scripts/generate-contract-skeletons.mjs
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import PizZip from 'pizzip';
import { CONTRACT_TEMPLATE_DEFS } from '../src/services/contractTemplates.js';
import { listContractTagDocumentation } from '../src/services/contractCrmMap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../templates/contracts');

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function para(text) {
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function buildDocumentXml(title, lines) {
  const body = [para(title), para(''), ...lines.map((l) => para(l)), para(''), para('Datum: {{date_today_cs}}')].join(
    '',
  );
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr/></w:body>
</w:document>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function buildDocx(title, tagLines) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', RELS);
  zip.folder('word').file('document.xml', buildDocumentXml(title, tagLines));
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const BODY = {
  brokerage: [
    'TECHNICKÝ SKELETON — nahraďte advokátním textem. Nejde o právní dokument.',
    'Kancelář: {{agency_name}}, IČO {{agency_ico}}, makléř {{broker_name}} ({{broker_email}}, {{broker_phone}})',
    'Klient: {{party_a_name}}, RČ {{party_a_rc}}, adresa {{party_a_address}}, tel {{party_a_phone}}, e-mail {{party_a_email}}',
    'Nemovitost: {{property_address}}, LV {{property_lv}}, parcela {{property_parcel}}, výměra {{property_area_m2}} m²',
    'Provize: {{commission_pct}} % / {{commission_amount}} Kč, exkluzivita: {{exclusivity}}, doba: {{contract_term_months}} měsíců',
  ],
  reservation: [
    'TECHNICKÝ SKELETON — nahraďte advokátním textem. Nejde o právní dokument.',
    'Zájemce (kupující): {{kupujici_name}}, {{kupujici_address}}, {{kupujici_rc}}, {{kupujici_email}}, {{kupujici_phone}}',
    'Prodávající: {{prodavajici_name}}, {{prodavajici_address}}, {{prodavajici_rc}}, {{prodavajici_email}}, {{prodavajici_phone}}',
    'Zprostředkovatel: {{agency_name}} / {{broker_name}}',
    'Nemovitost: {{property_address}}',
    'Kupní cena: {{purchase_price}}, záloha: {{reservation_deposit}}, lhůta: {{reservation_deadline}}',
  ],
  lease: [
    'TECHNICKÝ SKELETON — nahraďte advokátním textem. Nejde o právní dokument.',
    'Pronajímatel: {{pronajimatel_name}}, {{pronajimatel_address}}, {{pronajimatel_rc}}, {{pronajimatel_email}}, {{pronajimatel_phone}}',
    'Nájemce: {{najemce_name}}, {{najemce_address}}, {{najemce_rc}}, {{najemce_email}}, {{najemce_phone}}',
    'Předmět nájmu: {{property_address}}, dispozice {{property_disposition}}, výměra {{property_area_m2}} m²',
    'Nájem {{rent_monthly}} Kč/měsíc, kauce {{deposit_amount}}, od {{lease_start}} do {{lease_end}}, splatnost den {{payment_day}}',
  ],
};

for (const def of Object.values(CONTRACT_TEMPLATE_DEFS)) {
  const dir = join(ROOT, def.folder);
  mkdirSync(dir, { recursive: true });
  const buf = buildDocx(def.title, BODY[def.id] || ['{{party_a_name}}', '{{property_address}}']);
  writeFileSync(join(dir, 'skeleton.docx'), buf);
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        id: def.id,
        title: def.title,
        version: def.version,
        requiredKeys: def.requiredKeys,
        lawyer: null,
        approvedAt: null,
        note: 'Skeleton pro vývoj. Ostrý právní text dodá advokát jako template.docx.',
      },
      null,
      2,
    ),
  );
  console.log('OK', def.id, '→', join(dir, 'skeleton.docx'));
}

const tags = listContractTagDocumentation();
const md = [
  '# Tagy pro advokátní šablony Makio',
  '',
  'Používejte pouze `{{snake_case}}` v jednom souvislém textovém běhu Wordu (bez formátování uprostřed tagu).',
  'Makio **negeneruje** právní text — pouze vyplní tyto placeholdery z CRM.',
  '',
  '| Tag | Popis |',
  '|-----|-------|',
  ...tags.map((t) => `| \`{{${t.tag}}}\` | ${t.description} |`),
  '',
  '## Typy smluv (vlna 1)',
  '',
  ...Object.values(CONTRACT_TEMPLATE_DEFS).flatMap((d) => [
    `### ${d.title} (\`${d.id}\`)`,
    `Povinné: ${d.requiredKeys.map((k) => `\`${k}\``).join(', ')}`,
    '',
  ]),
].join('\n');

writeFileSync(join(ROOT, 'TAGY_PRO_ADVOKATA.md'), md, 'utf8');
console.log('OK TAGY_PRO_ADVOKATA.md', tags.length, 'tagů');
