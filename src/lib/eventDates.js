/** Pomocné funkce pro agenda události (kalendář + export) — zrcadlí nemio-proto/src/lib/eventDates.js */

export function formatIsoLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * České názvy měsíců (často 2. pád po čísle dne).
 */
const CZ_MONTH_BY_NAME = {
  leden: 1,
  únor: 2,
  unor: 2,
  březen: 3,
  brezen: 3,
  duben: 4,
  květen: 5,
  kveten: 5,
  května: 5,
  kvetna: 5,
  květnu: 5,
  kvetnu: 5,
  červen: 6,
  cerven: 6,
  červenec: 7,
  cervenec: 7,
  srpen: 8,
  září: 9,
  zari: 9,
  říjen: 10,
  rijen: 10,
  listopad: 11,
  prosinec: 12,
  ledna: 1,
  února: 2,
  unora: 2,
  března: 3,
  brezna: 3,
  dubna: 4,
  dubnu: 4,
  června: 6,
  cervna: 6,
  července: 7,
  cervence: 7,
  červenci: 7,
  srpna: 8,
  srpnu: 8,
  října: 10,
  rijna: 10,
  říjnu: 10,
  rijnu: 10,
  listopadu: 11,
  prosince: 12,
  prosinci: 12,
};

function monthNumFromToken(tok) {
  const k = String(tok || '').toLowerCase();
  return CZ_MONTH_BY_NAME[k] ?? null;
}

export function parseCzechDateStringToIso(raw, refDate = new Date()) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  const isoFull = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoFull) {
    const y = +isoFull[1];
    const mo = +isoFull[2];
    const d = +isoFull[3];
    const dt = new Date(y, mo - 1, d);
    if (!Number.isNaN(dt.getTime()) && dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) {
      return formatIsoLocal(dt);
    }
  }

  const dot = s.match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{2}|\d{4})\b/);
  if (dot) {
    let y = parseInt(dot[3], 10);
    if (y < 100) y += 2000;
    const mo = parseInt(dot[2], 10);
    const d = parseInt(dot[1], 10);
    const dt = new Date(y, mo - 1, d);
    if (!Number.isNaN(dt.getTime()) && dt.getMonth() === mo - 1) return formatIsoLocal(dt);
  }

  const named = s.match(/\b(\d{1,2})\.\s*([a-zA-ZáčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]+)\s*(?:(\d{2}|\d{4})\b)?/);
  if (named) {
    const d = parseInt(named[1], 10);
    const mo = monthNumFromToken(named[2]);
    if (mo) {
      let y = named[3] ? parseInt(named[3], 10) : refDate.getFullYear();
      if (y < 100) y += 2000;
      const dt = new Date(y, mo - 1, d);
      if (!Number.isNaN(dt.getTime()) && dt.getMonth() === mo - 1) return formatIsoLocal(dt);
    }
  }

  return null;
}

export function eventDateLabelToIso(label, refDate = new Date()) {
  const raw = String(label ?? '').trim();
  const ref = refDate instanceof Date && !Number.isNaN(refDate.getTime()) ? refDate : new Date();

  const parsed = parseCzechDateStringToIso(raw, ref);
  if (parsed) return parsed;

  const l = raw.toLowerCase();
  if (l === 'dnes') return formatIsoLocal(ref);
  if (l === 'zítra' || l === 'zitra') {
    const t = new Date(ref);
    t.setDate(t.getDate() + 1);
    return formatIsoLocal(t);
  }
  if (/^zítra\b/u.test(raw.trim()) || /^zitra\b/u.test(raw.trim())) {
    const t = new Date(ref);
    t.setDate(t.getDate() + 1);
    return formatIsoLocal(t);
  }
  if (l === 'pozítří' || l === 'pozitri') {
    const t = new Date(ref);
    t.setDate(t.getDate() + 2);
    return formatIsoLocal(t);
  }
  if (l === 'brzy') {
    const b = new Date(ref);
    b.setDate(b.getDate() + 3);
    return formatIsoLocal(b);
  }

  const b = new Date(ref);
  b.setDate(b.getDate() + 3);
  return formatIsoLocal(b);
}

/** Normalizace času HH:MM */
export function normalizeTime(t) {
  if (!t || typeof t !== 'string') return '12:00';
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '12:00';
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
