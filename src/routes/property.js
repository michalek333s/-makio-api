import { Router } from 'express';
import { searchProperty, probeGeopasHealth } from '../services/geopas.js';
import { runPropertyAnalysis } from '../services/runPropertyAnalysis.js';
import { getGeopasCacheStats } from '../services/geopasCacheStore.js';
import {
  resolveLocalityProfile,
  upsertLocalityProfile,
} from '../services/localityProfiles.js';
import { placeKeyFromParts } from '../lib/localityPlaceKey.js';
import { LIMITS } from '../config/limits.js';
import { assertMaxLen } from '../lib/requestValidation.js';

const router = Router();

router.get('/cache-stats', (_req, res) => {
  res.json(getGeopasCacheStats());
});

router.get('/geopas-health', async (_req, res, next) => {
  try {
    res.json(await probeGeopasHealth());
  } catch (error) {
    next(error);
  }
});

router.post('/analyze', async (req, res, next) => {
  try {
    const { query, refresh, code, type } = req.body || {};
    const q = String(query || '').trim();
    if (!q && (code == null || String(code).trim() === '')) {
      return res.status(400).json({ error: 'Chybí parametr query (adresa nebo parcela).' });
    }
    if (q) assertMaxLen(q, LIMITS.PROPERTY_QUERY_CHARS, 'query');

    const result = await runPropertyAnalysis(q || String(code), {
      useCache: true,
      refresh: refresh === true || refresh === 'true' || refresh === 1,
      userId: req.user?.id || null,
      code: code != null && String(code).trim() !== '' ? String(code).trim() : null,
      type: type ? String(type).trim() : null,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 3) {
      return res.json({ results: [] });
    }
    const results = await searchProperty(q);
    res.json(results);
  } catch (error) {
    next(error);
  }
});

/** Lookup soft profilu lokality (seed / DB). */
router.get('/locality-profile', async (req, res, next) => {
  try {
    const municipality = String(req.query.municipality || req.query.q || '').trim();
    const cadastralArea = String(req.query.ku || '').trim();
    if (!municipality && !cadastralArea) {
      return res.status(400).json({ error: 'Chybí municipality nebo ku.' });
    }
    const fake = {
      ku: cadastralArea || municipality,
      municipality: { name: municipality || cadastralArea },
      address: municipality,
    };
    const profile = await resolveLocalityProfile(fake, { userId: req.user?.id || null });
    res.json({ profile, placeKey: placeKeyFromParts({ municipality, cadastralArea }) });
  } catch (error) {
    next(error);
  }
});

/** Uložit / upravit soft profil (makléř). */
router.post('/locality-profile', async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Přihlášení vyžadováno.', code: 'AUTH_REQUIRED' });
    }
    const {
      placeKey,
      municipalityName,
      cadastralArea,
      vibe,
      noiseFeel,
      tags,
      notes,
      confidence,
    } = req.body || {};
    assertMaxLen(String(municipalityName || ''), 120, 'municipalityName');
    assertMaxLen(String(notes || ''), 2000, 'notes');

    const saved = await upsertLocalityProfile({
      userId,
      placeKey: placeKey || placeKeyFromParts({ municipality: municipalityName, cadastralArea }),
      municipalityName,
      cadastralArea,
      vibe,
      noiseFeel,
      tags,
      notes,
      source: 'broker',
      confidence: confidence || 'medium',
    });
    res.json({ ok: true, profile: saved });
  } catch (error) {
    next(error);
  }
});

export default router;
