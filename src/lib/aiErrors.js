/** Chyby, při kterých má smysl přepnout na Gemini / pipeline místo Clauda. */
export function isClaudeBillingError(err) {
  const m = String(err?.message || err || '');
  return /credit balance|insufficient|billing|payment|too low to access/i.test(m);
}

export function isClaudeQuotaError(err) {
  const m = String(err?.message || err || '');
  return err?.status === 429 || /rate limit|429|overloaded/i.test(m);
}
