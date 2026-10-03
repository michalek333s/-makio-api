/**
 * LLM občas osloví uživatele „Makio“ (jméno asistenta). Opravíme na křestní jméno makléře.
 */
export function sanitizeBrokerGreeting(text, brokerFirstName) {
  const out = String(text || '');
  const name = String(brokerFirstName || '').trim();
  if (!out || !name) return out;

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return out
    .replace(/\bAhoj\s+Makio\b/gi, `Ahoj ${name}`)
    .replace(/\bDobrý\s+den,\s*Makio\b/gi, `Dobrý den, ${name}`)
    .replace(/\bDobré\s+ráno,\s*Makio\b/gi, `Dobré ráno, ${name}`)
    .replace(/\bDobrý\s+večer,\s*Makio\b/gi, `Dobrý večer, ${name}`)
    .replace(new RegExp(`\\b${escaped},\\s*Makio\\b`, 'gi'), `${name}`)
    .replace(/\bMakio,\s*jasně\b/gi, `${name}, jasně`);
}
