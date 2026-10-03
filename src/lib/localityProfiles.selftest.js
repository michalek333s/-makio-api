import { extractLocalityProfileFromMessage } from './extractLocalityProfileFromMessage.js';
import { placeKeysFromAnalysis, placeKeyFromParts } from './localityPlaceKey.js';
import { attachLocalityProfile, resolveLocalityProfile } from '../services/localityProfiles.js';
import { buildEngagingPropertyMarkdown } from '../services/formatPropertyNarrative.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const extracted = extractLocalityProfileFromMessage('Lískovec je klidná vesnice');
assert(extracted?.vibe === 'klidna_vesnice', 'vibe');
assert(extracted?.placeKey === 'liskovec', `placeKey got ${extracted?.placeKey}`);
assert(extracted?.noiseFeel === 'tiche', 'noise');

const keys = placeKeysFromAnalysis({
  ku: 'Lískovec u Frýdku-Místku · parcela 4136/8',
  address: 'Lískovec 310, Frýdek-Místek',
  municipality: { name: 'Lískovec' },
});
assert(keys.includes('liskovec'), `keys ${keys.join(',')}`);

const profile = await resolveLocalityProfile({
  ku: 'Lískovec u Frýdku-Místku · parcela 4136/8',
  address: 'Lískovec 310, 73801, Frýdek-Místek',
  municipality: { name: 'Lískovec' },
});
assert(profile?.vibe === 'klidna_vesnice', 'seed profile');
assert(profile?.from === 'seed' || profile?.from === 'supabase', profile?.from);

const analysis = {
  address: 'Lískovec 310, Frýdek-Místek',
  ku: 'Lískovec u Frýdku-Místku · parcela 4136/8',
  area: '110 m²',
  safetyScore: { score: 58, label: 'Průměrná lokalita', targetBuyer: 'Investoři' },
  risks: { flood: 'mimo záplavovou zónu', summary: [] },
  amenities: { schools: [1, 2, 3], transit: [1], health: [] },
  ownerAccess: 'test',
  isTestOwner: true,
};
await attachLocalityProfile(analysis);
assert(analysis.localityProfile?.vibe === 'klidna_vesnice', 'attached');
const md = buildEngagingPropertyMarkdown(analysis);
assert(/Profil lokality|klidn/i.test(md), 'markdown has profile');
assert(/klidněj/i.test(md) || /Profil lokality/i.test(md), 'noise honesty with profile');

assert(placeKeyFromParts({ municipality: 'Frýdek-Místek' }) === 'frydek-mistek', 'fold');

console.log('localityProfiles.selftest OK', {
  keys,
  from: profile.from,
  vibe: analysis.localityProfile.vibe,
});
