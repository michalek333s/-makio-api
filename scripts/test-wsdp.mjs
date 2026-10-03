/**
 * Diagnostika WSDP: node --import dotenv/config scripts/test-wsdp.mjs "Lískovec 310 Frýdek-Místek"
 */
import { getFullPropertyAnalysis } from '../src/services/geopas.js';

const query = process.argv[2] || 'Mánesova 12 Praha';

if (!process.env.GEOPAS_API_KEY?.trim()) {
  console.error('❌ GEOPAS_API_KEY chybí v nemio-backend/.env');
  process.exit(1);
}

console.log('WSDP test pro:', query);
console.log('GEOPAS_DEV_IP:', process.env.GEOPAS_DEV_IP || '(produkce)');
console.log('GEOPAS_WSDP_LOGIN:', process.env.GEOPAS_WSDP_LOGIN ? '✅ nastaven' : '❌ chybí');
console.log('GEOPAS_WSDP_PASSWORD:', process.env.GEOPAS_WSDP_PASSWORD ? '✅ nastaven' : '❌ chybí');
console.log('GEOPAS_WSDP_TEST:', process.env.GEOPAS_WSDP_TEST || 'false');
console.log('---');

try {
  const data = await getFullPropertyAnalysis(query);
  const meta = data.geopasMeta || {};
  console.log('Adresa:', data.property?.address);
  console.log('parcel_id (land_kn_id):', meta.landKnId);
  console.log('wsdpAccess:', data.wsdpAccess);
  console.log('wsdpOk:', meta.wsdpOk);
  console.log('Vlastník:', data.parcel?.owner || '—');
  console.log('LV:', data.parcel?.lv);
  if (meta.wsdpError) {
    console.log('\n❌ WSDP chyba:', meta.wsdpError);
    console.log('💡 Hint:', meta.wsdpHint);
    process.exit(2);
  }
  if (data.parcel?.owner) {
    console.log('\n✅ WSDP OK — vlastník načten');
  } else {
    console.log('\n⚠️ WSDP volání prošlo, ale vlastník v odpovědi chybí (zkontrolujte strukturu LV)');
  }
} catch (e) {
  console.error('❌', e.message);
  process.exit(1);
}
