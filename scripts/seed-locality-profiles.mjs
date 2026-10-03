/**
 * Bulk seed + sync systémových locality profiles do Supabase + memory.
 * node scripts/seed-locality-profiles.mjs
 */
import '../src/loadEnv.js';

const PROFILES = [
  {
    place_key: 'liskovec',
    municipality_name: 'Lískovec',
    cadastral_area: 'Lískovec u Frýdku-Místku',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'klid', 'frydecko', 'msk'],
    notes:
      'Klidná vesnická část Frýdku-Místku — večer spíš mrtvo, vhodné pro rodiny hledající klid.',
    confidence: 'high',
  },
  {
    place_key: 'liskovec|frydek-mistek',
    municipality_name: 'Lískovec',
    cadastral_area: 'Lískovec u Frýdku-Místku',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'klid', 'msk'],
    notes: 'Klidná vesnická část Frýdku-Místku.',
    confidence: 'high',
  },
  {
    place_key: 'paskov',
    municipality_name: 'Paskov',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'msk'],
    notes: 'Menší obec u Ostravy — spíš klidnější než město, ověřte dopravu na Ostravu.',
    confidence: 'medium',
  },
  {
    place_key: 'baska',
    municipality_name: 'Baška',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'frydecko', 'msk'],
    notes: 'Obec u Frýdku-Místku / přehrady — typicky klidnější, sezónně ruch u vody.',
    confidence: 'medium',
  },
  {
    place_key: 'kuncicky-u-basky',
    municipality_name: 'Kunčičky u Bašky',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'baska'],
    notes: 'Malá část Bašky — klidná zástavba.',
    confidence: 'medium',
  },
  {
    place_key: 'poruba',
    municipality_name: 'Poruba',
    vibe: 'sidliste',
    noise_feel: 'prumer',
    tags: ['ostrava', 'sidliste', 'msk'],
    notes: 'Ostrava-Poruba — sídlištní charakter, dobré služby, průměrný ruch.',
    confidence: 'medium',
  },
  {
    place_key: 'poruba|ostrava',
    municipality_name: 'Poruba',
    vibe: 'sidliste',
    noise_feel: 'prumer',
    tags: ['ostrava', 'sidliste'],
    notes: 'Ostrava-Poruba — hustší zástavba a služby.',
    confidence: 'medium',
  },
  {
    place_key: 'havirov',
    municipality_name: 'Havířov',
    vibe: 'sidliste',
    noise_feel: 'prumer',
    tags: ['msk', 'sidliste'],
    notes: 'Město sídlištního typu — služby OK, klid závisí na ulici.',
    confidence: 'low',
  },
  {
    place_key: 'opava',
    municipality_name: 'Opava',
    vibe: 'smisene',
    noise_feel: 'prumer',
    tags: ['msk', 'mesto'],
    notes: 'Krajské město — centrum rušnější, okraje klidnější.',
    confidence: 'low',
  },
  {
    place_key: 'vinohrady',
    municipality_name: 'Vinohrady',
    vibe: 'centrum',
    noise_feel: 'hlucne',
    tags: ['praha', 'centrum'],
    notes: 'Praha-Vinohrady — městský ruch, služby, vyšší poptávka.',
    confidence: 'medium',
  },
  {
    place_key: 'vinohrady|praha',
    municipality_name: 'Vinohrady',
    vibe: 'centrum',
    noise_feel: 'prumer',
    tags: ['praha'],
    notes: 'Pražské Vinohrady — atraktivní městská čtvrť.',
    confidence: 'medium',
  },
  {
    place_key: 'frydek-mistek',
    municipality_name: 'Frýdek-Místek',
    vibe: 'smisene',
    noise_feel: 'prumer',
    tags: ['msk', 'mesto'],
    notes: 'Okresní město — centrum průměrný ruch, okolní obce klidnější.',
    confidence: 'low',
  },
  {
    place_key: 'frenstat-pod-radhostem',
    municipality_name: 'Frenštát pod Radhoštěm',
    vibe: 'primesti',
    noise_feel: 'tiche',
    tags: ['beskydy', 'msk'],
    notes: 'Podhorské město — spíš klidnější, rekreace / Beskydy.',
    confidence: 'medium',
  },
  {
    place_key: 'koprivnice',
    municipality_name: 'Kopřivnice',
    vibe: 'smisene',
    noise_feel: 'prumer',
    tags: ['msk', 'prumysl'],
    notes: 'Průmyslové město (Tatra) — ověřte vzdálenost od závodu / silnic.',
    confidence: 'low',
  },
  {
    place_key: 'cesky-tesin',
    municipality_name: 'Český Těšín',
    vibe: 'smisene',
    noise_feel: 'prumer',
    tags: ['msk', 'hranice'],
    notes: 'Příhraniční město — smíšený charakter, ověřte konkrétní ulici.',
    confidence: 'low',
  },
  {
    place_key: 'metylovice',
    municipality_name: 'Metylovice',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'frydecko', 'msk'],
    notes: 'Podhorská obec u Frýdlantu — typicky klidnější.',
    confidence: 'medium',
  },
  {
    place_key: 'prazmo',
    municipality_name: 'Pražmo',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'beskydy', 'msk'],
    notes: 'Malá obec v Beskydech — klid, rekreace.',
    confidence: 'medium',
  },
  {
    place_key: 'moravka',
    municipality_name: 'Morávka',
    vibe: 'rekreace',
    noise_feel: 'tiche',
    tags: ['beskydy', 'rekreace', 'msk'],
    notes: 'Rekreační obec u přehrady — sezónní ruch, jinak klid.',
    confidence: 'medium',
  },
  {
    place_key: 'hrcava',
    municipality_name: 'Hrčava',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'hranice', 'msk'],
    notes: 'Odlehlejší obec — velmi klidná.',
    confidence: 'medium',
  },
  {
    place_key: 'bocanovice',
    municipality_name: 'Bocanovice',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'tesinsko', 'msk'],
    notes: 'Malá obec na Těšínsku — klidná zástavba.',
    confidence: 'medium',
  },
  {
    place_key: 'marianske-hory',
    municipality_name: 'Mariánské Hory',
    vibe: 'sidliste',
    noise_feel: 'prumer',
    tags: ['ostrava', 'msk'],
    notes: 'Ostrava-Mariánské Hory — městská část, průměrný ruch.',
    confidence: 'low',
  },
  {
    place_key: 'trinec',
    municipality_name: 'Třinec',
    vibe: 'prumysl',
    noise_feel: 'prumer',
    tags: ['msk', 'prumysl'],
    notes: 'Průmyslové město (hutě) — ověřte vzdálenost od závodu.',
    confidence: 'medium',
  },
  {
    place_key: 'novy-jicin',
    municipality_name: 'Nový Jičín',
    vibe: 'smisene',
    noise_feel: 'prumer',
    tags: ['msk', 'mesto'],
    notes: 'Okresní město — centrum průměrný ruch, okraje klidnější.',
    confidence: 'low',
  },
  {
    place_key: 'karvina',
    municipality_name: 'Karviná',
    vibe: 'sidliste',
    noise_feel: 'prumer',
    tags: ['msk', 'sidliste'],
    notes: 'Sídlištní charakter, ověřte konkrétní ulici a důlní vlivy.',
    confidence: 'low',
  },
  {
    place_key: 'smilovice',
    municipality_name: 'Smilovice',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'tesinsko', 'msk'],
    notes: 'Obec na Těšínsku — typicky klidnější.',
    confidence: 'medium',
  },
  {
    place_key: 'sedliste',
    municipality_name: 'Sedliště',
    cadastral_area: 'Sedliště ve Slezsku',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'frydecko', 'msk', 'slezsko'],
    notes: 'Sedliště ve Slezsku u Frýdku-Místku — klidnější než město (ne Jimramov).',
    confidence: 'medium',
  },
  {
    place_key: 'sedliste-ve-slezsku',
    municipality_name: 'Sedliště',
    cadastral_area: 'Sedliště ve Slezsku',
    vibe: 'klidna_vesnice',
    noise_feel: 'tiche',
    tags: ['vesnice', 'frydecko', 'msk'],
    notes: 'KÚ Sedliště ve Slezsku — MSK / Frýdecko.',
    confidence: 'high',
  },
  {
    place_key: 'stare-mesto',
    municipality_name: 'Staré Město',
    vibe: 'primesti',
    noise_feel: 'tiche',
    tags: ['frydecko', 'msk'],
    notes: 'Staré Město u Frýdku — příměstský klid, ověřte konkrétní část.',
    confidence: 'low',
  },
  {
    place_key: 'frydlant-nad-ostravici',
    municipality_name: 'Frýdlant nad Ostravicí',
    vibe: 'smisene',
    noise_feel: 'prumer',
    tags: ['beskydy', 'msk'],
    notes: 'Podhorské město — smíšený charakter, rekreace v okolí.',
    confidence: 'low',
  },
];

async function main() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!url || !key) {
    console.error('Chybí SUPABASE_URL / SERVICE_ROLE_KEY');
    process.exit(1);
  }

  let ok = 0;
  let fail = 0;
  for (const p of PROFILES) {
    const body = {
      user_id: null,
      ...p,
      source: 'system',
      updated_at: new Date().toISOString(),
    };
    // delete+insert for system rows (partial unique)
    const del = await fetch(
      `${url}/rest/v1/locality_profiles?user_id=is.null&place_key=eq.${encodeURIComponent(p.place_key)}`,
      { method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    const res = await fetch(`${url}/rest/v1/locality_profiles`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      console.log('✅', p.place_key, p.vibe, `(del ${del.status})`);
      ok++;
    } else {
      console.log('❌', p.place_key, res.status, await res.text());
      fail++;
    }
  }
  console.log(`\nDone ok=${ok} fail=${fail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
