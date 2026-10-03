/**
 * Signi e-podpis — REST API wrapper (klíč jen na serveru).
 * Docs: https://helpdesk.signi.com/cs/support/solutions/articles/201000062797
 */

const SIGNI_API = 'https://api.signi.com/api/v1/contract/';

export function isSigniConfigured() {
  return Boolean(String(process.env.SIGNI_API_KEY || '').trim());
}

/**
 * Odešle PDF k podpisu přes Signi.
 * @param {{ pdfBuffer: Buffer, filename: string, contractName: string, signers: Array<{name:string,email:string,phone?:string}> }}
 */
export async function sendContractToSigni({ pdfBuffer, filename, contractName, signers }) {
  const apiKey = String(process.env.SIGNI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('Signi není nakonfigurován — doplňte SIGNI_API_KEY v nemio-backend/.env');
  }

  const list = (signers || []).filter((s) => s?.email?.trim());
  if (!list.length) {
    throw new Error('Chybí e-mail podepisujícího — doplňte u klienta v CRM.');
  }

  const payload = {
    name: String(contractName || 'Smlouva Nemio').slice(0, 200),
    signers: list.map((s, i) => ({
      name: String(s.name || `Podepisující ${i + 1}`).slice(0, 120),
      email: String(s.email).trim(),
      phone: s.phone ? String(s.phone).replace(/\s/g, '') : undefined,
      role: s.role || (i === 0 ? 'signer' : 'signer'),
      order: i + 1,
    })),
    settings: {
      lang: 'cs',
      send_email: true,
    },
  };

  const form = new FormData();
  form.append(
    'data',
    new Blob([JSON.stringify(payload)], { type: 'application/json' }),
    'data.json',
  );
  form.append(
    'uploaded_file_key',
    new Blob([pdfBuffer], { type: 'application/pdf' }),
    filename || 'smlouva.pdf',
  );

  const res = await fetch(`${SIGNI_API}?type=doc`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: form,
    signal: AbortSignal.timeout(45_000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data.message ||
      data.error ||
      data.detail ||
      (typeof data === 'string' ? data : null) ||
      `Signi HTTP ${res.status}`;
    throw new Error(String(msg));
  }

  return {
    contractId: data.contract_id || data.id || data.contractId,
    status: data.state || data.status || 'sent',
    signUrl: data.sign_url || data.url || null,
    raw: data,
  };
}

/** Stav smlouvy ve Signi */
export async function getSigniContractStatus(contractId) {
  const apiKey = String(process.env.SIGNI_API_KEY || '').trim();
  if (!apiKey || !contractId) {
    throw new Error('Signi není nakonfigurován nebo chybí ID smlouvy.');
  }

  const res = await fetch(`${SIGNI_API}${encodeURIComponent(contractId)}/`, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `Signi HTTP ${res.status}`);
  }
  return data;
}
