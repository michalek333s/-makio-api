/**
 * Odpověď na dotaz o lokalitě — broker styl, bez automatického GeoPas / parcely.
 */

import { resolveLocalityProfile } from './localityProfiles.js';
import {
  formatLocalityProfileLine,
  VIBE_LABELS,
  NOISE_LABELS,
} from '../lib/localityPlaceKey.js';
import { invokeTextLlm, AiTask } from './llmRouter.js';
import { sanitizeBrokerGreeting } from '../lib/sanitizeBrokerGreeting.js';

function fallbackResponse(name, profile) {
  const vibe = profile?.vibe ? VIBE_LABELS[profile.vibe] || profile.vibe : null;
  const noise = profile?.noiseFeel ? NOISE_LABELS[profile.noiseFeel] || profile.noiseFeel : null;
  const notes = profile?.notes ? String(profile.notes).trim() : '';

  let text = `**${name}** — tady je, co k té lokalitě dává smysl z pohledu makléře.\n\n`;

  if (vibe || noise) {
    text += `**Charakter:** ${[vibe, noise].filter(Boolean).join(' · ')}\n\n`;
  }
  if (notes) {
    text += `${notes}\n\n`;
  } else if (!profile) {
    text +=
      'V Makio zatím nemáme uložený detailní soft profil — obecně jde o část **Frýdecko-Místek / MSK**. ' +
      'Doporučuji projet místo autem: klid, sousedství, parkování, dojezd do centra FM a Ostravy.\n\n';
  }

  text +=
    '**Co ještě nemám bez konkrétní adresy:** katastr parcely, LV, záplavy u konkrétního domu — to až po zadání **č.p. nebo ulice**.\n\n' +
    `Chceš **analyzovat konkrétní adresu v ${name}** (např. \`${name} 310\`)?`;

  return text;
}

export async function handleLocalityInfoChat({
  message,
  municipalityName,
  userId = null,
  brokerFirstName = '',
}) {
  const name = String(municipalityName || '').trim();
  const profile = await resolveLocalityProfile(
    {
      municipality: { name },
      municipalityName: name,
      ku: name,
      address: name,
    },
    { userId },
  );

  const profileFacts = profile
    ? [
        `Vibe: ${VIBE_LABELS[profile.vibe] || profile.vibe || '—'}`,
        `Hluk: ${NOISE_LABELS[profile.noiseFeel] || profile.noiseFeel || '—'}`,
        `Poznámka: ${profile.notes || '—'}`,
        `Zdroj profilu: ${profile.source || '—'}`,
      ].join('\n')
    : 'Soft profil v Makio zatím chybí — odpověz z obecné znalosti MSK / ČR, ale neuváděj fiktivní katastr.';

  const brokerLine = brokerFirstName
    ? `Makléř v chatu: **${brokerFirstName}** — oslov ho křestním jménem (např. „Ahoj ${brokerFirstName}“), NIKDY ne „Ahoj Makio“ (to jsi ty).`
    : 'Makléř v chatu — neoslovuj „Makio“, to jsi ty (asistent).';

  const systemPrompt = `
Jsi Makio AI — elitní realitní partner (technický auditor, právní stratég, komerční poradce).
Makléř se ptá na **lokalitu / obec / charakter místa** — NE na konkrétní parcelu, LV ani vlastníka.

${brokerLine}

Styl (Claude-like):
- Okamžitě věcná odpověď — žádné „Jistě, rád pomohu“ ani „jako AI“.
- Struktura: charakter místa, cílovka, dojezd, rizika k ověření; u vhodných témat Diagnóza → Řešení → Dopad.
- Odborná hloubka: stavařina, právo, finance, marketing — podle relevance k lokalitě.

Pravidla:
- Použij znalost ČR + realitní praxi (klid vs. ruch, rodiny, dojezd, srovnání s okolními městy).
- Měkký profil z databáze zapracuj — **nepřeklápej POI skóre za verdikt o klidu**.
- **NIKDY** nevymýšlej parcelu, LV, vlastníka, přesnou cenu nemovitosti ani kriminalitu bez dat.
- Na konci jeden konkrétní krok: analyzovat adresu, Radar nabídek, nebo soft profil lokality.
- Markdown: krátké odstavce, **tučně** klíčová slova.

Profil z Makio (pokud existuje):
${profileFacts}
`.trim();

  try {
    const llm = await invokeTextLlm({
      task: AiTask.CHAT_CRM,
      systemPrompt,
      userMessage: message,
    });
    const chatResponse =
      sanitizeBrokerGreeting(String(llm?.text || '').trim(), brokerFirstName) ||
      fallbackResponse(name, profile);
    return {
      chatResponse,
      localityProfile: profile,
      municipalityName: name,
      llmProvider: llm?.provider,
    };
  } catch (e) {
    console.warn('[locality info chat]', e.message);
    return {
      chatResponse: fallbackResponse(name, profile),
      localityProfile: profile,
      municipalityName: name,
    };
  }
}
