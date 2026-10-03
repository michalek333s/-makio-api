/**
 * Accuracy harness — GeoPas cache, locality profiles, parcel pick, chat extract.
 * node scripts/eval-makio-accuracy.mjs
 */
import '../src/loadEnv.js';
import { runPropertyAnalysis } from '../src/services/runPropertyAnalysis.js';
import { extractLocalityProfileFromMessage } from '../src/lib/extractLocalityProfileFromMessage.js';
import { getGeopasCacheStatsAsync } from '../src/services/geopasCacheStore.js';
import { handleGeopasChatMessage } from '../src/services/geopasChatHandler.js';

function assertCase(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

const CASES = [
  {
    q: 'Lískovec 310',
    expectAddress: /lískovec/i,
    expectVibe: 'klidna_vesnice',
    expectKu: /lískovec/i,
  },
  {
    q: 'Lískovec 537',
    expectAddress: /lískovec/i,
    expectVibe: 'klidna_vesnice',
  },
  {
    q: 'Mánesova 12, Praha 2',
    expectAddress: /mánesova/i,
    expectCity: /praha/i,
  },
  {
    q: '2201/1 Vinohrady',
    expectKu: /vinohrad/i,
    // nesmí být Bystřice ani jiná náhodná obec
    rejectAddress: /bystřice|bystrice|brloh|horažďovice|horazdovice/i,
  },
  {
    q: '4136/8 Lískovec',
    expectKu: /lískovec/i,
    rejectAddress: /teplice/i,
  },
  {
    q: 'Nádražní 1, Ostrava',
    expectAddress: /nádražní|nadrazni/i,
    expectCity: /ostrava/i,
  },
  {
    q: '2201/1 Praha Vinohrady',
    expectCity: /praha|vinohrad/i,
    rejectAddress: /bystřice|bystrice/i,
  },
  {
    q: 'Ostrava Poruba Hlavní třída 10',
    expectCity: /ostrava/i,
    expectVibe: 'sidliste',
  },
  {
    q: 'Baška 50',
    expectCity: /baška|baska|kunčičky|kuncicky/i,
    expectVibe: 'klidna_vesnice',
  },
  {
    q: 'Frenštát pod Radhoštěm Markova 1',
    expectCity: /frenštát|frenstat/i,
    expectVibe: 'primesti',
  },
  {
    q: 'Frýdlant nad Ostravicí Náměstí 1',
    expectCity: /frýdlant|frydlant/i,
    expectVibe: 'smisene',
  },
  {
    q: 'Sedliště ve Slezsku 1',
    expectCity: /sedliště|sedliste|slezsk/i,
    rejectAddress: /jimramov/i,
    expectVibe: 'klidna_vesnice',
  },
  {
    q: 'Morávka 100',
    expectCity: /morávka|moravka/i,
    rejectAddress: /malá morávka|mala moravka/i,
    expectVibe: 'rekreace',
    refresh: true,
  },
];

async function main() {
  let pass = 0;
  let total = 0;

  console.log('=== A) Locality extract ===');
  total++;
  const ex = extractLocalityProfileFromMessage('Lískovec je klidná vesnice');
  if (assertCase('extract Lískovec', ex?.vibe === 'klidna_vesnice' && ex?.placeKey === 'liskovec', JSON.stringify(ex))) {
    pass++;
  }

  console.log('\n=== A2) AI feedback store ===');
  total++;
  try {
    const { storeAiFeedback } = await import('../src/services/aiFeedback.js');
    const fb = await storeAiFeedback({
      input: 'eval harness',
      aiOutput: 'test output',
      feedbackType: 'other',
      meta: { source: 'eval-makio-accuracy' },
    });
    if (assertCase('storeAiFeedback', fb?.ok, JSON.stringify(fb))) pass++;
  } catch (e) {
    assertCase('storeAiFeedback', false, e.message);
  }

  console.log('\n=== B) Property analysis accuracy ===');
  for (const c of CASES) {
    total++;
    try {
      const refresh = c.refresh || /\d+\/\d+/.test(c.q);
      const a = await runPropertyAnalysis(c.q, { useCache: true, refresh });
      const blob = `${a.address || ''} ${a.ku || ''}`;
      let ok = true;
      if (c.expectAddress && !c.expectAddress.test(a.address || '')) ok = false;
      if (c.expectKu && !c.expectKu.test(a.ku || blob)) ok = false;
      if (c.expectCity && !c.expectCity.test(blob)) ok = false;
      if (c.rejectAddress && c.rejectAddress.test(blob)) ok = false;
      if (c.expectVibe && a.localityProfile?.vibe !== c.expectVibe) ok = false;
      if (
        assertCase(
          c.q,
          ok,
          `${a.address || a.errorCode} | vibe=${a.localityProfile?.vibe || '—'} | cache=${a.fromCache ? a.cacheSource : 'live'}`,
        )
      ) {
        pass++;
      }
    } catch (e) {
      assertCase(c.q, false, e.message);
    }
  }

  console.log('\n=== C) Chat GeoPas Lískovec ===');
  total++;
  try {
    const chat = await handleGeopasChatMessage({ message: 'Analyzuj Lískovec 310' });
    const text = chat.chatResponse || '';
    const hasProfile =
      /klidn/i.test(text) ||
      chat.propertyAnalysis?.localityProfile?.vibe === 'klidna_vesnice';
    if (assertCase('chat mentions klid/profile', hasProfile, text.slice(0, 120).replace(/\n/g, ' '))) {
      pass++;
    }
  } catch (e) {
    assertCase('chat Lískovec', false, e.message);
  }

  console.log('\n=== D) Cache stats ===');
  const stats = await getGeopasCacheStatsAsync();
  console.log(JSON.stringify(stats, null, 2));

  console.log(`\n=== SCORE ${pass}/${total} (${Math.round((pass / total) * 100)}%) ===`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
