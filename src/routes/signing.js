/**
 * E-podpis — Signi integrace
 */

import { Router } from 'express';
import { buildFullContractRenderData } from '../services/contractCrmMap.js';
import { buildContractPdfBuffer } from '../services/contractPdf.js';
import {
  isSigniConfigured,
  sendContractToSigni,
  getSigniContractStatus,
} from '../services/signi.js';
import { contractRouteLimiter } from '../middleware/rateLimits.js';

const router = Router();

router.get('/signi/status', (req, res) => {
  res.json({
    configured: isSigniConfigured(),
    provider: 'signi',
  });
});

/**
 * POST /api/signing/signi/send
 * Body: { client, property, contractName?, signers? }
 * signers override — jinak client.email + client.name
 */
router.post('/signi/send', contractRouteLimiter, async (req, res, next) => {
  try {
    if (!isSigniConfigured()) {
      return res.status(503).json({
        error: 'Signi není nakonfigurován.',
        hint: 'Doplňte SIGNI_API_KEY v nemio-backend/.env (workspace klíč z app.signi.com).',
      });
    }

    const { client, property, contractName, signers: signersOverride } = req.body || {};
    if (!client || typeof client !== 'object') {
      return res.status(400).json({ error: 'Chybí client (objekt z CRM).' });
    }

    const renderData = buildFullContractRenderData(client, property ?? '');
    const pdfBuffer = await buildContractPdfBuffer(renderData);

    const signers =
      Array.isArray(signersOverride) && signersOverride.length
        ? signersOverride
        : [
            {
              name: client.name || renderData.client_name,
              email: client.email,
              phone: client.phone,
              role: 'signer',
            },
          ].filter((s) => s.email && s.email !== 'Nezadáno');

    if (!signers.length) {
      return res.status(400).json({
        error: 'Klient nemá e-mail v CRM.',
        hint: 'Doplňte e-mail klienta — Signi pošle odkaz k podpisu.',
      });
    }

    const name =
      contractName ||
      `Smlouva — ${renderData.client_name || client.name || 'klient'}`.slice(0, 200);

    const result = await sendContractToSigni({
      pdfBuffer,
      filename: `smlouva_${Date.now()}.pdf`,
      contractName: name,
      signers,
    });

    res.json({
      ok: true,
      provider: 'signi',
      contractId: result.contractId,
      status: result.status,
      signUrl: result.signUrl,
      message: `Dokument odeslán k podpisu na ${signers.map((s) => s.email).join(', ')}.`,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/signi/status/:contractId', async (req, res, next) => {
  try {
    if (!isSigniConfigured()) {
      return res.status(503).json({ error: 'Signi není nakonfigurován.' });
    }
    const data = await getSigniContractStatus(req.params.contractId);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

export default router;
