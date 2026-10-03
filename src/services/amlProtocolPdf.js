/**
 * AML auditní protokol — 1× A4, Figma layout.
 * Hlavička: ikona (bez textu v PNG) + „MAKIO“ + badge AML.
 */

import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.resolve(__dirname, '../../assets/fonts');
const LOGO_PATH = path.resolve(__dirname, '../../assets/brand/logo-makio.png');

const FONT_REGULAR = path.join(FONTS_DIR, 'Roboto-Regular.ttf');
const FONT_MEDIUM = path.join(FONTS_DIR, 'Roboto-Medium.ttf');
const FONT_BOLD = path.join(FONTS_DIR, 'Roboto-Bold.ttf');

/** CSS px (794) → PDF body A4 (595.28 pt) */
const S = 595.28 / 794;

function px(n) {
  return n * S;
}

const C = {
  page: '#F8FAFC',
  header: '#050A14',
  white: '#FFFFFF',
  ink: '#0F172A',
  muted: '#64748B',
  slate: '#475569',
  slateDim: '#334155',
  label: '#94A3B8',
  line: '#E2E8F0',
  lineSoft: '#F1F5F9',
  sig: '#CBD5E1',
  orange: '#EA580C',
  orangeSoft: '#FB923C',
  green: '#22C55E',
  greenInk: '#166534',
  greenText: '#15803D',
  greenBg: '#F0FDF4',
  greenBorder: '#BBF7D0',
  amber: '#F59E0B',
  amberInk: '#92400E',
  amberBg: '#FFFBEB',
  amberBorder: '#FDE68A',
  red: '#EF4444',
  redInk: '#991B1B',
  redBg: '#FEF2F2',
  redBorder: '#FECACA',
};

function assertAssets() {
  for (const f of [FONT_REGULAR, FONT_MEDIUM, FONT_BOLD]) {
    if (!fs.existsSync(f)) throw new Error(`Chybí font pro AML PDF: ${f}`);
  }
}

function val(v, fallback = '—') {
  const s = String(v ?? '').trim();
  return s || fallback;
}

/** Makléř nesmí být pomlčka — zákonný údaj. */
function resolveBrokerName(check, meta = {}) {
  const s = String(meta.brokerName || check.broker_name || meta.fullName || '').trim();
  return s || 'Neuvedeno v profilu';
}

/** Kancelář: profil → fallback Makio Reality + volitelné IČO. */
function resolveAgencyName(check, meta = {}) {
  const name = String(meta.agencyName || check.agency_name || '').trim() || 'Makio Reality';
  const ico = String(meta.agencyIco || check.agency_ico || check.agencyIco || '')
    .replace(/\s/g, '')
    .trim();
  if (/^\d{8}$/.test(ico)) {
    return `${name} · IČO ${ico.slice(0, 2)} ${ico.slice(2, 5)} ${ico.slice(5)}`;
  }
  return name;
}

function formatCreated(iso) {
  if (!iso) return new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' });
  try {
    return new Date(iso).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' });
  } catch {
    return String(iso);
  }
}

function formatDateOnly(isoOrDate) {
  if (!isoOrDate) return null;
  try {
    const d = new Date(
      /^\d{4}-\d{2}-\d{2}$/.test(String(isoOrDate))
        ? `${isoOrDate}T12:00:00`
        : isoOrDate,
    );
    if (Number.isNaN(d.getTime())) return String(isoOrDate);
    return d.toLocaleDateString('cs-CZ', {
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      timeZone: 'Europe/Prague',
    });
  } catch {
    return String(isoOrDate);
  }
}

function formatTimeUtc(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    return (
      d.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'UTC',
      }) + ' UTC'
    );
  } catch {
    return '—';
  }
}

function protocolCode(check) {
  const d = check.created_at ? new Date(check.created_at) : new Date();
  const year = d.getFullYear();
  const digits = String(check.id || '')
    .replace(/[^0-9a-f]/gi, '')
    .slice(-5)
    .toUpperCase()
    .padStart(5, '0');
  return `MKO-${year}-${digits}`;
}

function formatIco(identifier, clientType) {
  const raw = String(identifier || '').replace(/\s/g, '');
  if (clientType === 'legal_entity' && /^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 2)} ${raw.slice(2, 5)} ${raw.slice(5)}`;
  }
  return val(identifier);
}

function riskWord(score) {
  const map = { low: 'Nízké', medium: 'Střední', high: 'Vysoké' };
  if (map[score]) return map[score];
  const s = String(score || '').toUpperCase();
  if (s.includes('VYS')) return 'Vysoké';
  if (s.includes('STŘ') || s.includes('STR') || s === 'MEDIUM') return 'Střední';
  if (s.includes('NÍZ') || s.includes('NIZ') || s === 'LOW') return 'Nízké';
  return map[String(score || '').toLowerCase()] || '—';
}

function statusKey(check) {
  if (check.check_status === 'rejected' || check.is_sanctioned || check.isir_status === 'in_insolvency') {
    return 'fail';
  }
  if (check.check_status === 'requires_review' || check.is_pep || check.isir_status === 'error') {
    return 'warn';
  }
  return 'ok';
}

function isirCaseDetails(check) {
  const cases = check.isir_details?.cases || check.isir_details?.spisy || [];
  if (!Array.isArray(cases) || !cases.length) return null;
  return cases
    .slice(0, 4)
    .map((c) => `${c.fileNumber || '—'} | ${c.court || '—'} | ${c.status || '—'}`)
    .join('; ');
}

/**
 * Mapování API check → pole šablony.
 */
export function mapCheckToFullAmlReport(check = {}, meta = {}) {
  const birth = formatDateOnly(check.birth_date);
  const identifier =
    check.client_type === 'natural_person' && birth
      ? `${val(check.identifier)} / ${birth}`
      : formatIco(check.identifier, check.client_type);

  let representativeName = check.representative_name || null;
  if (
    !representativeName &&
    check.client_type === 'legal_entity' &&
    Array.isArray(check.ares_data?.statutarniOrgany) &&
    check.ares_data.statutarniOrgany[0]?.name
  ) {
    const o = check.ares_data.statutarniOrgany[0];
    representativeName = o.role ? `${o.name}, ${String(o.role).toLowerCase()}` : o.name;
  }

  return {
    id: String(check.id || ''),
    protocolCode: protocolCode(check),
    createdAt: formatCreated(check.created_at),
    createdDate: formatDateOnly(check.created_at) || formatDateOnly(new Date()) || formatCreated(check.created_at),
    createdTimeUtc: formatTimeUtc(check.created_at),
    brokerName: resolveBrokerName(check, meta),
    agencyName: resolveAgencyName(check, meta),
    clientType: check.client_type === 'legal_entity' ? 'legal_entity' : 'natural_person',
    fullName: val(check.full_name),
    identifier,
    address: val(check.address, 'Neuvedeno'),
    representativeName: representativeName || '—',
    representativeIdDoc: check.representative_id_doc || null,
    uboName: check.beneficial_owner || '—',
    transactionType: check.transaction_type || 'Zprostředkování převodu nemovitosti',
    propertyAddress: check.property_address || 'Dle zprostředkovatelské smlouvy',
    fundsSource: check.funds_source || 'Vlastní úspory / Hypoteční úvěr',
    isPep: Boolean(check.is_pep),
    isSanctioned: Boolean(check.is_sanctioned),
    isirStatus: check.isir_status || 'clean',
    isirCaseDetails: isirCaseDetails(check),
    riskWord: riskWord(check.risk_score),
    status: statusKey(check),
    note: check.note ? String(check.note).trim() : null,
  };
}

export const mapCheckToDarkAmlReport = mapCheckToFullAmlReport;

function drawCheckIcon(doc, cx, cy, color) {
  doc.save();
  doc.lineWidth(1.6).lineCap('round').lineJoin('round').strokeColor(color);
  doc.moveTo(cx - 3.8, cy).lineTo(cx - 1, cy + 2.8).lineTo(cx + 4.4, cy - 3).stroke();
  doc.restore();
}

function drawWarnIcon(doc, cx, cy, color) {
  doc.save();
  doc.lineWidth(1.4).lineCap('round').strokeColor(color);
  doc.moveTo(cx, cy - 4).lineTo(cx, cy + 0.8).stroke();
  doc.circle(cx, cy + 3.4, 0.6).fill(color);
  doc.restore();
}

function drawFailIcon(doc, cx, cy, color) {
  doc.save();
  doc.lineWidth(1.5).lineCap('round').strokeColor(color);
  doc.moveTo(cx - 3.4, cy - 3.4).lineTo(cx + 3.4, cy + 3.4).stroke();
  doc.moveTo(cx + 3.4, cy - 3.4).lineTo(cx - 3.4, cy + 3.4).stroke();
  doc.restore();
}

function roundedRect(doc, x, y, w, h, r, fill, stroke) {
  doc.save();
  doc.roundedRect(x, y, w, h, r);
  if (fill && stroke) doc.fillAndStroke(fill, stroke);
  else if (fill) doc.fill(fill);
  else if (stroke) doc.stroke(stroke);
  doc.restore();
}

/**
 * Stacked logo PNG obsahuje text „MAKIO“ pod ikonou — ořízneme jen 3D mark.
 */
function drawMakioMark(doc, x, y, size) {
  if (!fs.existsSync(LOGO_PATH)) return;
  doc.save();
  doc.rect(x, y, size, size).clip();
  doc.image(LOGO_PATH, x, y, {
    width: size,
    height: size * 1.42,
  });
  doc.restore();
}

function sectionLabel(doc, title, x, y) {
  doc
    .font('Roboto-Bold')
    .fontSize(px(9))
    .fillColor(C.orange)
    .text(title.toUpperCase(), x, y, { characterSpacing: 0.7, lineBreak: false });
  return y + px(12);
}

function fieldCell(doc, label, value, x, y, w) {
  doc.font('Roboto-Medium').fontSize(px(8.5)).fillColor(C.label);
  doc.text(label, x, y, { width: w - px(6), lineGap: 0 });
  const afterLabel = doc.y;
  doc.font('Roboto-Medium').fontSize(px(11)).fillColor(C.ink);
  doc.text(val(value), x, afterLabel + px(1), { width: w - px(6), lineGap: 1 });
  return doc.y + px(4);
}

function screeningRow(doc, { label, sublabel, value, status, last }, x, y, w) {
  const tone =
    status === 'ok'
      ? { dot: C.green, bg: C.greenBg, border: C.greenBorder, text: C.greenText }
      : status === 'warn'
        ? { dot: C.amber, bg: C.amberBg, border: C.amberBorder, text: C.amberInk }
        : { dot: C.red, bg: C.redBg, border: C.redBorder, text: C.redInk };

  doc.save().circle(x + px(3), y + px(11), px(3)).fill(tone.dot);
  doc.restore();

  doc.font('Roboto-Medium').fontSize(px(11)).fillColor(C.ink);
  doc.text(label, x + px(14), y + px(1), { width: w * 0.58, lineBreak: false });
  doc.font('Roboto').fontSize(px(8.5)).fillColor(C.label);
  doc.text(sublabel, x + px(14), y + px(14), { width: w * 0.58, lineGap: 0 });

  doc.font('Roboto-Medium').fontSize(px(9.5));
  const badgeW = Math.max(doc.widthOfString(value) + px(18), px(72));
  const badgeH = px(17);
  const bx = x + w - badgeW;
  const by = y + px(4);
  roundedRect(doc, bx, by, badgeW, badgeH, px(8), tone.bg, tone.border);
  doc
    .font('Roboto-Medium')
    .fontSize(px(9.5))
    .fillColor(tone.text)
    .text(value, bx, by + px(3), { width: badgeW, align: 'center', lineBreak: false });

  if (!last) {
    doc
      .moveTo(x, y + px(30))
      .lineTo(x + w, y + px(30))
      .lineWidth(0.6)
      .strokeColor(C.lineSoft)
      .stroke();
  }
  return y + px(34);
}

/**
 * @param {object} check
 * @param {{ brokerName?: string, agencyName?: string, agencyIco?: string, fullName?: string }} [meta]
 */
export function buildAmlProtocolPdf(check, meta = {}) {
  assertAssets();
  const data = mapCheckToFullAmlReport(check, meta);
  const hasLogo = fs.existsSync(LOGO_PATH);
  const fingerprint = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        id: data.id,
        code: data.protocolCode,
        name: data.fullName,
        identifier: data.identifier,
        status: data.status,
        created: data.createdAt,
      }),
    )
    .digest('hex')
    .slice(0, 32);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        autoFirstPage: true,
        bufferPages: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        info: {
          Title: `AML auditní protokol ${data.protocolCode}`,
          Author: 'Makio',
          Subject: 'Zákon č. 253/2008 Sb.',
        },
      });

      // Protokol musí být přesně 1× A4 — zakážeme automatické nové stránky
      doc.addPage = () => doc;

      doc.registerFont('Roboto', FONT_REGULAR);
      doc.registerFont('Roboto-Medium', FONT_MEDIUM);
      doc.registerFont('Roboto-Bold', FONT_BOLD);

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageW = doc.page.width;
      const pageH = doc.page.height;
      // padding ≈ 24×32 CSS px na 794 canvas
      const contentX = px(32);
      const contentW = pageW - px(64);
      const footerH = px(40);
      const bottomLimit = pageH - footerH;

      // Page background
      doc.save().rect(0, 0, pageW, pageH).fill(C.page);
      doc.restore();

      // Watermark M — jemnější, ať netiskne přes údaje
      doc.save();
      doc.fillColor('#0F172A').fillOpacity(0.03);
      doc.font('Roboto-Bold').fontSize(px(380));
      doc.text('M', pageW - px(200), px(160), { lineBreak: false });
      doc.restore();

      // ── HEADER ──────────────────────────────────────────────
      const headerH = px(88);
      doc.save().rect(0, 0, pageW, headerH).fill(C.header);
      doc.restore();

      doc.save().fillColor('#FFFFFF').fillOpacity(0.04);
      for (let gx = 6; gx < pageW; gx += px(22)) {
        for (let gy = 6; gy < headerH; gy += px(22)) {
          doc.circle(gx, gy, 0.45).fill();
        }
      }
      doc.restore();

      doc.save();
      const glow = doc.linearGradient(pageW - px(200), headerH - px(36), pageW, headerH);
      glow.stop(0, C.orange, 0.1).stop(1, C.header, 0);
      doc.rect(pageW - px(200), headerH - px(60), px(200), px(60)).fill(glow);
      doc.restore();

      // Protocol card (pravá strana) — nejdřív, ať víme max šířku brandu
      const cardW = px(188);
      const cardH = px(58);
      const cardX = pageW - px(32) - cardW;
      const cardY = px(15);
      roundedRect(doc, cardX, cardY, cardW, cardH, px(8), '#0C1220', '#1E293B');
      doc
        .font('Roboto-Medium')
        .fontSize(px(7.5))
        .fillColor(C.slate)
        .text('ZÁKONNÝ AUDITNÍ ZÁZNAM', cardX + px(12), cardY + px(8), {
          width: cardW - px(24),
          align: 'right',
          characterSpacing: 0.6,
          lineBreak: false,
        });
      doc
        .font('Roboto-Bold')
        .fontSize(px(13.5))
        .fillColor(C.white)
        .text(data.protocolCode, cardX + px(10), cardY + px(22), {
          width: cardW - px(20),
          align: 'right',
          lineBreak: false,
        });
      doc
        .font('Roboto')
        .fontSize(px(8.5))
        .fillColor(C.slate)
        .text(`${data.createdDate}  •  253/2008 Sb.`, cardX + px(10), cardY + px(40), {
          width: cardW - px(20),
          align: 'right',
          lineBreak: false,
        });

      // Brand: pouze ikona + text MAKIO + AML (flex, bez ořezu)
      const logoSize = px(48);
      const logoY = px(20);
      if (hasLogo) drawMakioMark(doc, contentX, logoY, logoSize);

      const brandX = contentX + logoSize + px(12);
      const brandMaxW = cardX - brandX - px(10);
      const titleSize = px(18);
      doc.font('Roboto-Bold').fontSize(titleSize).fillColor(C.white);
      const makioLabel = 'MAKIO';
      const makioW = doc.widthOfString(makioLabel);
      doc.text(makioLabel, brandX, logoY + px(4), {
        width: Math.min(makioW + 2, brandMaxW),
        lineBreak: false,
      });

      const amlBadge = 'AML';
      doc.font('Roboto-Medium').fontSize(px(8));
      const amlW = doc.widthOfString(amlBadge) + px(12);
      const amlX = brandX + makioW + px(8);
      if (amlX + amlW < cardX - px(8)) {
        roundedRect(doc, amlX, logoY + px(6), amlW, px(14), px(8), '#1A0E08', C.orange);
        doc
          .font('Roboto-Medium')
          .fontSize(px(8))
          .fillColor(C.orange)
          .text(amlBadge, amlX, logoY + px(8.5), { width: amlW, align: 'center', lineBreak: false });
      }

      doc
        .font('Roboto')
        .fontSize(px(9.5))
        .fillColor(C.muted)
        .text('Realitní platforma  •  AML prověrka klienta', brandX, logoY + px(28), {
          width: brandMaxW,
          lineBreak: false,
        });

      // Orange accent bar
      const barY = headerH;
      const barGrad = doc.linearGradient(0, barY, pageW, barY);
      barGrad.stop(0, C.orange).stop(0.5, C.orangeSoft).stop(1, C.page);
      doc.save().rect(0, barY, pageW, px(2.5)).fill(barGrad);
      doc.restore();

      let y = headerH + px(2.5) + px(14);

      // ── STATUS BLOCK ───────────────────────────────────────
      const st = data.status;
      const stTone =
        st === 'ok'
          ? {
              bar: C.green,
              iconBg: C.greenBg,
              title: 'Ověřeno bez nálezu',
              riskBg: C.greenBg,
              riskBorder: C.greenBorder,
              riskText: C.greenInk,
            }
          : st === 'warn'
            ? {
                bar: C.amber,
                iconBg: C.amberBg,
                title: 'Vyžaduje pozornost',
                riskBg: C.amberBg,
                riskBorder: C.amberBorder,
                riskText: C.amberInk,
              }
            : {
                bar: C.red,
                iconBg: C.redBg,
                title: 'Nález / zamítnuto',
                riskBg: C.redBg,
                riskBorder: C.redBorder,
                riskText: C.redInk,
              };

      const statusH = px(56);
      roundedRect(doc, contentX, y, contentW, statusH, px(7), C.white, C.line);
      doc.save().rect(contentX, y, px(3.5), statusH).fill(stTone.bar);
      doc.restore();

      const iconCx = contentX + px(18) + px(13);
      const iconCy = y + statusH / 2;
      doc.save().circle(iconCx, iconCy, px(13)).fill(stTone.iconBg);
      doc.restore();
      if (st === 'ok') drawCheckIcon(doc, iconCx, iconCy, C.green);
      else if (st === 'warn') drawWarnIcon(doc, iconCx, iconCy, C.amber);
      else drawFailIcon(doc, iconCx, iconCy, C.red);

      const textX = contentX + px(48);
      doc.font('Roboto-Bold').fontSize(px(13)).fillColor(C.ink);
      doc.text(stTone.title, textX, y + px(12), { lineBreak: false });
      doc.font('Roboto').fontSize(px(9)).fillColor(C.muted);
      doc.text(`Výsledek prověrky  •  Prověřeno ${data.createdDate}`, textX, y + px(30), {
        lineBreak: false,
      });

      const riskLabel = data.riskWord;
      doc.font('Roboto-Bold').fontSize(px(10.5));
      const riskW = Math.max(doc.widthOfString(riskLabel) + px(20), px(52));
      const riskX = contentX + contentW - px(18) - riskW - px(96);
      roundedRect(doc, riskX, y + px(10), riskW, px(18), px(8), stTone.riskBg, stTone.riskBorder);
      doc
        .font('Roboto-Bold')
        .fontSize(px(10.5))
        .fillColor(stTone.riskText)
        .text(riskLabel, riskX, y + px(13), { width: riskW, align: 'center', lineBreak: false });
      doc
        .font('Roboto')
        .fontSize(px(8))
        .fillColor(C.label)
        .text('Rizikový profil', riskX - px(6), y + px(32), {
          width: riskW + px(12),
          align: 'center',
          lineBreak: false,
        });

      doc
        .font('Roboto-Medium')
        .fontSize(px(10.5))
        .fillColor(C.ink)
        .text(data.createdTimeUtc, contentX + contentW - px(108), y + px(12), {
          width: px(90),
          align: 'center',
          lineBreak: false,
        });
      doc
        .font('Roboto')
        .fontSize(px(8))
        .fillColor(C.label)
        .text('Čas lustrace', contentX + contentW - px(108), y + px(32), {
          width: px(90),
          align: 'center',
          lineBreak: false,
        });

      y += statusH + px(12);

      // ── BLOCK A ─────────────────────────────────────────────
      y = sectionLabel(doc, '1 · Prověřovaný subjekt', contentX, y);
      {
        const colW = contentW / 2;
        const aLeft = [
          ['Název / Jméno', data.fullName],
          ['Adresa / Sídlo', data.address],
          [
            data.clientType === 'natural_person' ? 'Doklad totožnosti' : 'Skutečný majitel (UBO)',
            data.clientType === 'natural_person' ? check.id_document || '—' : data.uboName,
          ],
        ];
        const aRight = [
          ['Identifikátor (IČO / RČ)', data.identifier],
          ['Statutární zástupce', data.representativeName],
        ];
        let yl = y;
        let yr = y;
        for (const [l, v] of aLeft) yl = fieldCell(doc, l, v, contentX, yl, colW);
        for (const [l, v] of aRight) yr = fieldCell(doc, l, v, contentX + colW, yr, colW);
        y = Math.max(yl, yr) + px(2);
      }

      doc
        .moveTo(contentX, y)
        .lineTo(contentX + contentW, y)
        .lineWidth(0.7)
        .strokeColor(C.line)
        .stroke();
      y += px(10);

      // ── BLOCK B ─────────────────────────────────────────────
      y = sectionLabel(doc, '2 · Detail obchodu & původ prostředků', contentX, y);
      {
        const colW = contentW / 2;
        const bLeft = [
          ['Typ obchodu', data.transactionType],
          ['Specifikace nemovitosti', data.propertyAddress],
          ['Zdroj finančních prostředků', data.fundsSource],
        ];
        const bRight = [
          ['Prověřil makléř', data.brokerName],
          ['Realitní kancelář', data.agencyName],
        ];
        let yl = y;
        let yr = y;
        for (const [l, v] of bLeft) yl = fieldCell(doc, l, v, contentX, yl, colW);
        for (const [l, v] of bRight) yr = fieldCell(doc, l, v, contentX + colW, yr, colW);
        y = Math.max(yl, yr) + px(2);
      }

      doc
        .moveTo(contentX, y)
        .lineTo(contentX + contentW, y)
        .lineWidth(0.7)
        .strokeColor(C.line)
        .stroke();
      y += px(10);

      // ── BLOCK C ─────────────────────────────────────────────
      y = sectionLabel(doc, '3 · Zákonný registrový screening', contentX, y);

      const isirStatus =
        data.isirStatus === 'in_insolvency' ? 'fail' : data.isirStatus === 'error' ? 'warn' : 'ok';
      y = screeningRow(
        doc,
        {
          label: 'Insolvenční rejstřík',
          sublabel: data.isirCaseDetails
            ? data.isirCaseDetails
            : 'ISIR – Ministerstvo spravedlnosti ČR',
          value: isirStatus === 'ok' ? 'Bez záznamu' : isirStatus === 'warn' ? 'Chyba ověření' : 'Nález v ISIR',
          status: isirStatus,
        },
        contentX,
        y,
        contentW,
      );
      y = screeningRow(
        doc,
        {
          label: 'Sankční seznamy',
          sublabel: 'FAÚ / EU / OSN / Mezinárodní',
          value: data.isSanctioned ? 'Nález' : 'Bez záznamu',
          status: data.isSanctioned ? 'fail' : 'ok',
        },
        contentX,
        y,
        contentW,
      );
      y = screeningRow(
        doc,
        {
          label: 'Politicky exponovaná osoba',
          sublabel: 'PEP screening – domácí i zahraniční databáze',
          value: data.isPep ? 'Je PEP' : 'Není PEP',
          status: data.isPep ? 'warn' : 'ok',
          last: true,
        },
        contentX,
        y,
        contentW,
      );

      // Fixed zone: doložka + podpisy těsně nad patičkou (vždy na 1. straně)
      const legalBlockH = px(108);
      let legalY = Math.max(y + px(8), bottomLimit - legalBlockH);
      if (legalY + legalBlockH > bottomLimit) legalY = bottomLimit - legalBlockH;

      doc
        .moveTo(contentX, legalY)
        .lineTo(contentX + contentW, legalY)
        .lineWidth(0.7)
        .strokeColor(C.line)
        .stroke();
      legalY += px(8);

      doc
        .font('Roboto')
        .fontSize(7.5)
        .fillColor(C.label)
        .text(
          'Tento protokol byl vyhotoven v souladu se zákonem č. 253/2008 Sb. (AML zákon). Údaje byly ověřeny ve veřejných i neveřejných registrech. Protokol slouží jako auditní záznam pro Finanční analytický úřad a podléhá 10leté archivační povinnosti.',
          contentX,
          legalY,
          { width: contentW, lineGap: 1.5 },
        );
      legalY = doc.y + px(10);

      const sigW = (contentW - px(28)) / 2;
      doc
        .font('Roboto')
        .fontSize(px(8))
        .fillColor(C.label)
        .text('MÍSTO A DATUM', contentX, legalY, { characterSpacing: 0.4, lineBreak: false });
      doc
        .font('Roboto')
        .fontSize(px(8))
        .fillColor(C.label)
        .text('PODPIS ODPOVĚDNÉ OSOBY', contentX + sigW + px(28), legalY, {
          characterSpacing: 0.4,
          lineBreak: false,
        });

      // Volný prostor nad linkou pro ruční podpis
      const lineY = legalY + px(28);
      doc
        .moveTo(contentX, lineY)
        .lineTo(contentX + sigW, lineY)
        .lineWidth(1)
        .strokeColor(C.sig)
        .stroke();
      doc
        .moveTo(contentX + sigW + px(28), lineY)
        .lineTo(contentX + contentW, lineY)
        .lineWidth(1)
        .strokeColor(C.sig)
        .stroke();

      doc
        .font('Roboto')
        .fontSize(px(9.5))
        .fillColor(C.slate)
        .text(`Praha, ${data.createdDate}`, contentX, lineY + px(5), { lineBreak: false });
      doc
        .font('Roboto-Medium')
        .fontSize(px(9.5))
        .fillColor(C.ink)
        .text(data.brokerName, contentX + sigW + px(28), lineY + px(5), {
          width: sigW,
          lineBreak: false,
        });

      // ── FOOTER (vždy na 1. stránce) ─────────────────────────
      const fy = pageH - footerH;
      doc.save().rect(0, fy, pageW, footerH).fill(C.header);
      doc.restore();

      if (hasLogo) drawMakioMark(doc, contentX, fy + px(8), px(22));
      doc.font('Roboto').fontSize(px(8.5)).fillColor(C.slate);
      doc.text('Vygenerováno v systému ', contentX + px(30), fy + px(14), { continued: true });
      doc.fillColor(C.orange).font('Roboto-Medium').text('Makio', { continued: true });
      doc.font('Roboto').fillColor(C.slateDim).text('  (makio.cz)');

      doc
        .font('Roboto')
        .fontSize(px(7.5))
        .fillColor(C.slateDim)
        .text(`sha256:${fingerprint}`, pageW - px(32) - px(220), fy + px(14), {
          width: px(220),
          align: 'right',
          lineBreak: false,
        });

      // Jedna strana A4 — addPage je no-op výše
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
