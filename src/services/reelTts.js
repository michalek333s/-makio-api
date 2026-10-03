/**
 * Reel voiceover TTS — ElevenLabs primary, OpenAI fallback, mock silent skip.
 */

import { randomUUID } from 'crypto';

function supabaseCfg() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceKey) return null;
  return { supabaseUrl, serviceKey };
}

export function isTtsConfigured() {
  return Boolean(
    String(process.env.ELEVENLABS_API_KEY || '').trim() ||
      String(process.env.OPENAI_API_KEY || '').trim(),
  );
}

/**
 * @param {{ text: string, userId: string, voiceId?: string }} opts
 * @returns {Promise<{ audioUrl: string|null, provider: string, skipped?: boolean, durationHintSec?: number }>}
 */
export async function synthesizeReelVoiceover({ text, userId, voiceId }) {
  const script = String(text || '').trim();
  if (!script) {
    return { audioUrl: null, provider: 'none', skipped: true, durationHintSec: 0 };
  }

  const elevenKey = String(process.env.ELEVENLABS_API_KEY || '').trim();
  const openaiKey = String(process.env.OPENAI_API_KEY || '').trim();

  let buffer = null;
  let provider = 'mock';
  let contentType = 'audio/mpeg';

  if (elevenKey) {
    const voice =
      String(voiceId || process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMbwgpEHTg').trim();
    const model = String(process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2').trim();
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: 'POST',
      headers: {
        'xi-api-key': elevenKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: script.slice(0, 4500),
        model_id: model,
        voice_settings: { stability: 0.45, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn('[reelTts] ElevenLabs failed', res.status, errText.slice(0, 160));
    } else {
      buffer = Buffer.from(await res.arrayBuffer());
      provider = 'elevenlabs';
    }
  }

  if (!buffer && openaiKey) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
        voice: process.env.OPENAI_TTS_VOICE || 'nova',
        input: script.slice(0, 4000),
        response_format: 'mp3',
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn('[reelTts] OpenAI TTS failed', res.status, errText.slice(0, 160));
    } else {
      buffer = Buffer.from(await res.arrayBuffer());
      provider = 'openai';
    }
  }

  if (!buffer) {
    // No TTS keys — skip audio; compose will still produce video + burned titles
    const words = script.split(/\s+/).filter(Boolean).length;
    return {
      audioUrl: null,
      provider: 'skipped',
      skipped: true,
      durationHintSec: Math.max(8, Math.round(words / 2.2)),
    };
  }

  const uploaded = await uploadAudioBuffer(buffer, userId, contentType);
  const words = script.split(/\s+/).filter(Boolean).length;
  return {
    audioUrl: uploaded,
    provider,
    durationHintSec: Math.max(8, Math.round(words / 2.2)),
  };
}

async function uploadAudioBuffer(buffer, userId, contentType = 'audio/mpeg') {
  const cfg = supabaseCfg();
  if (!cfg) {
    // data URL fallback for local demo (small clips only)
    if (buffer.length < 900_000) {
      return `data:${contentType};base64,${buffer.toString('base64')}`;
    }
    throw Object.assign(new Error('TTS upload vyžaduje Supabase storage.'), { status: 503 });
  }
  const bucket = String(process.env.REEL_UPLOAD_BUCKET || 'staging-uploads').trim();
  const safeUser = String(userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'anon';
  const path = `reels/${safeUser}/audio/${randomUUID()}.mp3`;
  const res = await fetch(`${cfg.supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.serviceKey}`,
      apikey: cfg.serviceKey,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw Object.assign(new Error(`Upload audio selhal (${res.status}): ${t.slice(0, 160)}`), {
      status: 502,
    });
  }
  return `${cfg.supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;
}
