import { Router } from 'express';

const router = Router();

/**
 * CRM data žijí v Supabase (crm_clients / crm_events) přes RLS z frontendu
 * (useNemioCrmSync). Tento Express router není zdroj pravdy — jen diagnostika.
 *
 * @see nemio-proto/src/hooks/useNemioCrmSync.js
 * @see supabase/migrations/0009_nemio_tenant_crm.sql
 */

router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    persistence: 'supabase_rls',
    tables: ['crm_clients', 'crm_events'],
    note: 'Čtení/zápis CRM probíhá z Makio frontendu přes Supabase JWT + RLS, ne přes tento endpoint.',
  });
});

router.get('/clients', (_req, res) => {
  res.status(410).json({
    error: 'CRM klienti jsou v Supabase (crm_clients), ne v Express API.',
    code: 'CRM_VIA_SUPABASE',
    hint: 'Použijte frontend sync (NemioCrmProvider) nebo přímé Supabase volání s JWT makléře.',
  });
});

router.post('/clients', (_req, res) => {
  res.status(410).json({
    error: 'CRM zápis probíhá přes Supabase RLS z aplikace, ne přes POST /api/crm/clients.',
    code: 'CRM_VIA_SUPABASE',
  });
});

export default router;
