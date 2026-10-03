/**
 * Kontrolní list CRM (PDF) — NENÍ právní smlouva / layout Word šablony.
 */

import PDFDocument from 'pdfkit';

function line(doc, label, value) {
  const v = String(value || '—').trim() || '—';
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#333333').text(`${label}: `, { continued: true });
  doc.font('Helvetica').fillColor('#111111').text(v);
  doc.moveDown(0.35);
}

/**
 * @param {Record<string, string>} data — výstup buildContractRenderData
 * @returns {Promise<Buffer>}
 */
export function buildContractPdfBuffer(data = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 56, bottom: 56, left: 56, right: 56 },
        info: {
          Title: 'Makio — kontrolní list CRM ke smlouvě',
          Author: 'Makio',
        },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font('Helvetica-Bold').fontSize(16).fillColor('#111').text('Makio — kontrolní list CRM');
      doc.moveDown(0.4);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#555')
        .text(
          'Toto PDF NENÍ smlouva. Slouží ke kontrole údajů před vyplněním advokátní Word šablony. Právní text je pouze ve vyplněném .docx / PDF ze šablony.',
          { width: 480 },
        );
      doc.moveDown(1);

      if (data.contract_type_label) {
        line(doc, 'Typ smlouvy', data.contract_type_label);
        doc.moveDown(0.4);
      }

      doc.font('Helvetica-Bold').fontSize(12).fillColor('#ea580c').text('Strana A / klient');
      doc.moveDown(0.4);
      line(doc, 'Jméno', data.party_a_name || data.client_name);
      line(doc, 'Telefon', data.party_a_phone || data.client_phone);
      line(doc, 'E-mail', data.party_a_email || data.client_email);
      line(doc, 'Adresa', data.party_a_address || data.client_address);
      line(doc, 'RČ', data.party_a_rc || data.client_rc);
      line(doc, 'Číslo OP', data.party_a_id_card || data.client_id_card);

      if (data.party_b_name) {
        doc.moveDown(0.8);
        doc.font('Helvetica-Bold').fontSize(12).fillColor('#ea580c').text('Strana B / protistrana');
        doc.moveDown(0.4);
        line(doc, 'Jméno', data.party_b_name);
        line(doc, 'Telefon', data.party_b_phone);
        line(doc, 'E-mail', data.party_b_email);
        line(doc, 'Adresa', data.party_b_address);
      }

      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#ea580c').text('Kancelář / makléř');
      doc.moveDown(0.4);
      line(doc, 'Kancelář', data.agency_name);
      line(doc, 'IČO', data.agency_ico);
      line(doc, 'Makléř', data.broker_name);
      line(doc, 'Kontakt', [data.broker_phone, data.broker_email].filter(Boolean).join(' · '));

      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#ea580c').text('Nemovitost / obchod');
      doc.moveDown(0.4);
      line(doc, 'Adresa', data.property_address);
      line(doc, 'LV', data.property_lv);
      line(doc, 'Parcela', data.property_parcel);
      line(doc, 'Výměra', data.property_area_m2);
      line(doc, 'Dispozice', data.property_disposition);
      line(doc, 'Provize %', data.commission_pct);
      line(doc, 'Provize Kč', data.commission_amount);
      line(doc, 'Kupní cena', data.purchase_price);
      line(doc, 'Rezervace / záloha', data.reservation_deposit);
      line(doc, 'Lhůta rezervace', data.reservation_deadline);
      line(doc, 'Nájem / měs.', data.rent_monthly);
      line(doc, 'Kauce', data.deposit_amount);
      line(doc, 'Nájem od–do', [data.lease_start, data.lease_end].filter(Boolean).join(' – '));

      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#ea580c').text('Meta');
      doc.moveDown(0.4);
      line(doc, 'Datum', data.date_today_cs || data.date_iso);
      line(doc, 'Šablona', [data.template_id, data.template_version].filter(Boolean).join(' · '));
      line(doc, 'Vygenerováno', new Date().toLocaleString('cs-CZ'));

      doc.moveDown(1.2);
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#888')
        .text('Makio — kontrolní list. Není právním posudkem ani smlouvou.', {
          width: 480,
        });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
