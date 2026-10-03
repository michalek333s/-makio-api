/**
 * Decor8 AI — virtuální staging (generate_designs_for_room).
 * Klíč pouze v serverovém .env (DECOR8_API_KEY).
 */

import {
  buildDecor8ApiPrompt,
  getDecor8DesignCreativity,
  getDecor8NumImages,
  getDecor8ScaleFactor,
} from '../lib/decor8PromptQuality.js';

const DECOR8_API_URL = 'https://api.decor8.ai/generate_designs_for_room';
const MAX_DATA_URI_BYTES = 4 * 1024 * 1024;

const ROOM_TYPE_MAP = {
  'Obývací pokoj': 'livingroom',
  Ložnice: 'bedroom',
  Kuchyně: 'kitchen',
  Pracovna: 'office',
  Jídelna: 'diningroom',
  livingroom: 'livingroom',
  bedroom: 'bedroom',
  kitchen: 'kitchen',
  office: 'office',
  diningroom: 'diningroom',
};

const DESIGN_STYLE_MAP = {
  Moderní: 'modern',
  Skandinávský: 'scandinavian',
  Minimalistický: 'minimalist',
  Luxusní: 'luxemodern',
  Rustikální: 'rustic',
  modern: 'modern',
  scandinavian: 'scandinavian',
  minimalist: 'minimalist',
  luxemodern: 'luxemodern',
  rustic: 'rustic',
};

export function isDecor8Configured() {
  return Boolean(process.env.DECOR8_API_KEY?.trim());
}

function mapRoomType(raw) {
  const key = String(raw || '').trim();
  return ROOM_TYPE_MAP[key] || null;
}

function mapDesignStyle(raw) {
  const key = String(raw || '').trim();
  return DESIGN_STYLE_MAP[key] || null;
}

function toDataUri(imageBase64, mimeType = 'image/jpeg') {
  const raw = String(imageBase64 || '').trim();
  if (!raw) {
    const err = new Error('Chybí image_base64.');
    err.status = 400;
    throw err;
  }
  if (raw.startsWith('data:')) return raw;

  const mt = mimeType.includes('png') ? 'image/png' : 'image/jpeg';
  const approxBytes = Math.ceil((raw.length * 3) / 4);
  if (approxBytes > MAX_DATA_URI_BYTES) {
    const err = new Error('Fotka je příliš velká pro Decor8 (max. 4 MB). Zmenšete obrázek.');
    err.status = 400;
    throw err;
  }
  return `data:${mt};base64,${raw}`;
}

export async function generateDecor8Staging({
  imageUrl,
  imageBase64,
  mimeType = 'image/jpeg',
  roomType,
  designStyle,
  prompt,
  apiPrompt,
  numImages = 1,
}) {
  const decor8Key = process.env.DECOR8_API_KEY?.trim();
  if (!decor8Key) {
    const err = new Error('DECOR8_API_KEY není nastaven v nemio-backend/.env');
    err.status = 503;
    throw err;
  }

  const userPrompt = String(prompt || '').trim();
  const optimizedPrompt = String(apiPrompt || '').trim();
  const usePromptMode = userPrompt.length >= 10 || optimizedPrompt.length >= 10;

  let room_type = mapRoomType(roomType);
  let design_style = null;

  if (!usePromptMode) {
    design_style = mapDesignStyle(designStyle);
    if (!room_type) {
      const err = new Error(`Neplatný room_type: ${roomType}`);
      err.status = 400;
      throw err;
    }
    if (!design_style) {
      const err = new Error(`Neplatný design_style: ${designStyle}`);
      err.status = 400;
      throw err;
    }
  } else if (userPrompt.length > 1500 && !optimizedPrompt) {
    const err = new Error('Popis místnosti je příliš dlouhý (max. 1500 znaků).');
    err.status = 400;
    throw err;
  }

  let input_image_url = String(imageUrl || '').trim();
  if (!input_image_url || !/^https?:\/\//i.test(input_image_url)) {
    input_image_url = toDataUri(imageBase64, mimeType);
  }

  const num_images = getDecor8NumImages(numImages);
  const scale_factor = getDecor8ScaleFactor();
  const design_creativity = getDecor8DesignCreativity();

  const payload = {
    input_image_url,
    num_images,
    scale_factor,
    design_creativity,
  };

  if (usePromptMode) {
    const decor8Prompt = buildDecor8ApiPrompt({
      userPrompt: userPrompt || optimizedPrompt,
      apiPrompt: optimizedPrompt || undefined,
      roomTypeApi: room_type || undefined,
    });
    if (decor8Prompt.length < 20) {
      const err = new Error('Popis místnosti je příliš krátký.');
      err.status = 400;
      throw err;
    }
    payload.prompt = decor8Prompt;
  } else {
    payload.room_type = room_type;
    payload.design_style = design_style;
  }

  const res = await fetch(DECOR8_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${decor8Key}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.message || data?.error || `Decor8 API chyba (${res.status})`;
    const err = new Error(msg);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }

  const urls = (data?.info?.images || [])
    .map((img) => String(img?.url || '').trim())
    .filter((u) => /^https?:\/\//i.test(u));

  if (!urls.length) {
    const err = new Error('Decor8 nevrátil žádné obrázky.');
    err.status = 502;
    err.detail = data;
    throw err;
  }

  return {
    urls,
    message: data?.message || 'Staging hotový.',
    room_type,
    design_style,
    prompt: usePromptMode ? userPrompt || optimizedPrompt : null,
    mode: usePromptMode ? 'prompt' : 'presets',
    scale_factor,
    design_creativity,
    num_images,
  };
}
