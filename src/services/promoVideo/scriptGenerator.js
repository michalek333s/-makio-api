/**
 * LLM sales script for ~35–40s Czech promo voiceover.
 */

function foldHighlights(details) {
  const h = Array.isArray(details?.highlights) ? details.highlights.filter(Boolean) : [];
  return h.slice(0, 6).join(', ');
}

export function buildPromoScriptFallback(details = {}) {
  const title = details.title || 'Tato nemovitost';
  const loc = details.location || 'skvělé lokalitě';
  const layout = details.layout || '';
  const area = details.areaM2 ? `${details.areaM2} m²` : '';
  const price = details.price || '';
  const usps = foldHighlights(details) || 'světlé interiéry a praktická dispozice';

  return [
    `Představte si život v ${loc}.`,
    `${title}${layout ? ` — ${layout}` : ''}${area ? ` o velikosti ${area}` : ''}.`,
    `Co vás chytí hned: ${usps}.`,
    price ? `Aktuální cena ${price}.` : 'Cenu a termín prohlídky doladíme osobně.',
    `Napište mi a domluvíme si prohlídku — ať si prostor projdete naživo.`,
  ].join(' ');
}

/**
 * @param {object} details
 * @returns {Promise<{ script: string, provider: string, cuesHint?: string[] }>}
 */
export async function generatePromoScript(details = {}) {
  const system = `Jsi copywriter realitních Reels/TikTok (ČR). Piš mluvený český scénář 35–40 sekund (cca 90–110 slov).
Pravidla:
- Hovorový, lidský tón zkušeného makléře — ne katalog.
- Začni hookem (1 věta), pak dispozice/lokalita, 2–3 USP, cena, CTA na prohlídku.
- Bez emoji, bez hashtagů, bez uvozovek kolem celku.
- Jen čistý souvislý text ke namluvení.`;

  const user = JSON.stringify({
    title: details.title,
    price: details.price,
    location: details.location,
    layout: details.layout,
    areaM2: details.areaM2,
    highlights: details.highlights || [],
  });

  const geminiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const openaiKey = String(process.env.OPENAI_API_KEY || '').trim();

  if (geminiKey) {
    try {
      const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ parts: [{ text: `Napiš scénář pro: ${user}` }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
        }),
      });
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('')?.trim();
      if (res.ok && text) {
        return { script: text.replace(/^["«]|["»]$/g, '').trim(), provider: 'gemini' };
      }
    } catch (e) {
      console.warn('[promoScript] gemini:', e.message);
    }
  }

  if (openaiKey) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.OPENAI_PROMO_SCRIPT_MODEL || 'gpt-4o-mini',
          temperature: 0.7,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `Napiš scénář pro: ${user}` },
          ],
        }),
      });
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (res.ok && text) {
        return { script: text.replace(/^["«]|["»]$/g, '').trim(), provider: 'openai' };
      }
    } catch (e) {
      console.warn('[promoScript] openai:', e.message);
    }
  }

  return { script: buildPromoScriptFallback(details), provider: 'fallback' };
}
