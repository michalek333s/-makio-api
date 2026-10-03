/**
 * Sestaví advokátní template.docx z PDF extraktů ([xxx] → CRM tagy).
 * Právní text se NEPŘEPISUJE AI — jen se nahradí placeholdery a uloží DOCX.
 *
 * node scripts/build-lawyer-contract-templates.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import PizZip from 'pizzip';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../templates/contracts');
const SRC = join(ROOT, '_source_pdf');

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function para(text, bold = false) {
  const t = escapeXml(text);
  if (bold) {
    return `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  }
  return `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
}

function buildDocx(paragraphs) {
  const body = paragraphs.map((p) => (typeof p === 'string' ? para(p) : para(p.text, p.bold))).join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr/></w:body>
</w:document>`;
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
  const zip = new PizZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', RELS);
  zip.folder('word').file('document.xml', documentXml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Collapse PDF line-noise into readable paragraphs (does not invent words). */
function cleanPdfText(raw) {
  return String(raw || '')
    .replace(/\u200b/g, '')
    .replace(/\r/g, '')
    .replace(/--- PAGE \d+ ---/g, '\n')
    .replace(/Strana\s+\d+\s+z\s+\d+/gi, '')
    .replace(/^\d+\s*$/gm, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function replaceXxxInOrder(text, tags) {
  let i = 0;
  const out = text.replace(/\[xxx\]/gi, () => {
    const tag = tags[i++];
    if (!tag) return '………………';
    return `{{${tag}}}`;
  });
  if (i < tags.length) {
    console.warn(`  ⚠ unused tags: ${tags.slice(i).join(', ')}`);
  }
  if (i > tags.length) {
    console.warn(`  ⚠ more [xxx] than tags (${i} vs ${tags.length})`);
  }
  console.log(`  replaced ${Math.min(i, tags.length)} placeholders`);
  return out;
}

function textToParagraphs(text) {
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      if (/^[IVX]+\.?\s/.test(line) || /^(KUPNÍ|NÁJEMNÍ|Smlouva)/i.test(line)) {
        return { text: line, bold: true };
      }
      return line;
    });
}

function writeTemplate({ id, folder, title, version, requiredKeys, roleHints, tags, lawyerNote, pdfName }) {
  const txtPath = join(SRC, `${pdfName}.txt`);
  const pdfPath = join(SRC, `${pdfName}.pdf`);
  if (!existsSync(txtPath)) throw new Error(`Missing ${txtPath}`);
  const cleaned = cleanPdfText(readFileSync(txtPath, 'utf8'));
  let body = replaceXxxInOrder(cleaned, tags);

  // Lease: dotted blanks for nájemce (PDF used dots, not [xxx])
  if (id === 'lease') {
    const najemceFields = [
      '{{najemce_name}}',
      '{{najemce_address}}',
      '{{najemce_rc}}',
      '{{najemce_id_card}}',
    ];
    let ni = 0;
    body = body.replace(/\.{6,}/g, () => najemceFields[ni++] || '………………');
  }

  const dir = join(ROOT, folder);
  mkdirSync(dir, { recursive: true });
  const paragraphs = [
    {
      text: `${title} — pracovní DOCX s CRM tagy (zdroj: advokátní PDF). Makio nevyplňuje právní klauzule, jen {{tagy}}.`,
      bold: false,
    },
    '',
    ...textToParagraphs(body),
  ];
  writeFileSync(join(dir, 'template.docx'), buildDocx(paragraphs));
  if (existsSync(pdfPath)) {
    copyFileSync(pdfPath, join(dir, 'original.pdf'));
  }
  const approvedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        id,
        title,
        version,
        requiredKeys,
        roleHints,
        lawyer: 'Dodáno uživatelem (PDF) — DOCX = fillovatelná kopie s {{tagy}} místo [xxx]',
        approvedAt,
        sourcePdf: pdfName + '.pdf',
        note: lawyerNote,
        fillMode: 'deterministic_crm_only',
        antiHallucination: true,
      },
      null,
      2,
    ),
  );
  console.log(`✓ ${id} → ${folder}/template.docx`);
}

const RESERVATION_TAGS = [
  'prodavajici_identity',
  'kupujici_identity',
  'property_item_a',
  'property_item_b',
  'property_item_c',
  'property_municipality',
  'property_ku',
  'property_lv',
  'purchase_price',
  'reservation_deadline',
  'reservation_deposit',
  'reservation_deposit_words',
  'place_of_signing',
  'date_today_cs',
  'place_of_signing',
  'date_today_cs',
  'prodavajici_name',
  'kupujici_name',
];

const PURCHASE_TAGS = [
  'prodavajici_identity',
  'kupujici_identity',
  'property_item_a',
  'property_municipality',
  'property_ku',
  'property_lv',
  'purchase_price',
  'purchase_price_words',
  'escrow_lawyer_name',
  'escrow_lawyer_address',
  'escrow_lawyer_ico',
  'escrow_cak_number',
  'escrow_account',
  'escrow_bank',
  'place_of_signing',
  'date_today_cs',
  'place_of_signing',
  'date_today_cs',
  'prodavajici_name',
  'kupujici_name',
];

const LEASE_TAGS = [
  'pronajimatel_name',
  'pronajimatel_address',
  'pronajimatel_rc',
  'pronajimatel_id_card',
  'property_unit',
  'property_area_m2',
  'property_cp',
  'property_district',
  'property_parcel',
  'parcel_a_area',
  'parcel_b',
  'parcel_b_area',
  'property_municipality',
  'property_ku',
  'max_occupants',
  'lease_start',
  'rent_monthly',
  'rent_monthly_words',
  'services_fee',
  'services_fee_words',
  'lease_account',
  'deposit_amount',
  'deposit_amount_words',
];

writeTemplate({
  id: 'reservation',
  folder: 'reservation/v1',
  title: 'Smlouva o smlouvě budoucí — Rezervační smlouva',
  version: 'v1.1.0-lawyer',
  requiredKeys: [
    'kupujici_name',
    'prodavajici_name',
    'property_lv',
    'purchase_price',
    'reservation_deposit',
    'reservation_deadline',
    'date_today_cs',
  ],
  roleHints: { partyA: 'Zájemce / kupující', partyB: 'Prodávající' },
  tags: RESERVATION_TAGS,
  pdfName: 'reservation',
  lawyerNote: 'Zdroj: rezervační smlouva.pdf. Právní text zachován; [xxx] → CRM tagy.',
});

writeTemplate({
  id: 'purchase',
  folder: 'purchase/v1',
  title: 'Kupní smlouva',
  version: 'v1.0.0-lawyer',
  requiredKeys: [
    'prodavajici_name',
    'kupujici_name',
    'property_lv',
    'purchase_price',
    'date_today_cs',
  ],
  roleHints: { partyA: 'Prodávající', partyB: 'Kupující' },
  tags: PURCHASE_TAGS,
  pdfName: 'purchase',
  lawyerNote: 'Zdroj: kupní smlouva.pdf. Právní text zachován; [xxx] → CRM tagy.',
});

writeTemplate({
  id: 'lease',
  folder: 'lease/v1',
  title: 'Nájemní smlouva',
  version: 'v1.1.0-lawyer',
  requiredKeys: [
    'pronajimatel_name',
    'najemce_name',
    'property_unit',
    'rent_monthly',
    'deposit_amount',
    'lease_start',
    'date_today_cs',
  ],
  roleHints: { partyA: 'Pronajímatel', partyB: 'Nájemce' },
  tags: LEASE_TAGS,
  pdfName: 'lease',
  lawyerNote: 'Zdroj: nájemní smlouva.pdf. Právní text zachován; [xxx]/tečky → CRM tagy.',
});

console.log('\nHotovo. Spusťte smoke: npm run test:contracts / smoke-contracts.');
