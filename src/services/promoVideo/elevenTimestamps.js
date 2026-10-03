/**
 * ElevenLabs TTS with character timestamps → subtitle cues.
 */

import { randomUUID } from 'crypto';

function supabaseCfg() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceKey) return null;
  return { supabaseUrl, serviceKey };
}

async function uploadAudioBuffer(buffer, userId, contentType = 'audio/mpeg') {
  const cfg = supabaseCfg();
  if (!cfg) {
    if (buffer.length < 900_000) {
      return `data:${contentType};base64,${buffer.toString('base64')}`;
    }
    throw Object.assign(new Error('TTS upload vyžaduje Supabase storage.'), { status: 503 });
  }
  const bucket = String(process.env.REEL_UPLOAD_BUCKET || 'staging-uploads').trim();
  const safeUser = String(userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'anon';
  const path = `promo/${safeUser}/audio/${randomUUID()}.mp3`;
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

/**
 * Group character alignment into phrase cues (~0.8–2.2s).
 */
export function alignmentToSubtitleCues(alignment, maxCueSec = 2.2) {
  if (!alignment?.characters?.length) return [];
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds || [];
  const ends = alignment.character_end_times_seconds || [];

  const cues = [];
  let buf = '';
  let cueStart = null;
  let cueEnd = 0;

  const flush = () => {
    const text = buf.replace(/\s+/g, ' ').trim();
    if (text && cueStart != null) {
      cues.push({
        text,
        start: Math.max(0, cueStart),
        end: Math.max(cueStart + 0.4, cueEnd),
      });
    }
    buf = '';
    cueStart = null;
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const s = Number(starts[i] ?? 0);
    const e = Number(ends[i] ?? s);
    if (cueStart == null) cueStart = s;
    buf += ch;
    cueEnd = e;
    const duration = e - cueStart;
    const boundary = /[\s.!?,;:]/.test(ch);
    if ((boundary && duration >= 0.8) || duration >= maxCueSec) {
      flush();
    }
  }
  flush();
  return cues;
}

/**
 * Fallback cues from plain text + duration hint.
 */
export function estimateCuesFromText(text, durationSec) {
  const sentences = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sentences.length) return [];
  const total = Math.max(8, Number(durationSec) || 35);
  const slice = total / sentences.length;
  return sentences.map((t, i) => ({
    text: t,
    start: Math.round(i * slice * 100) / 100,
    end: Math.round((i + 1) * slice * 100) / 100,
  }));
}

/**
 * @returns {Promise<{ audioUrl: string|null, provider: string, cues: object[], durationSec: number, skipped?: boolean, chars: number }>}
 */
export async function synthesizePromoVoiceWithTimestamps({ text, userId, voiceId }) {
  const script = String(text || '').trim();
  const chars = script.length;
  if (!script) {
    return { audioUrl: null, provider: 'none', cues: [], durationSec: 0, skipped: true, chars: 0 };
  }

  const elevenKey = String(process.env.ELEVENLABS_API_KEY || '').trim();
  const voice = String(voiceId || process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMbwgpEHTg').trim();
  const model = String(process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2').trim();

  if (elevenKey) {
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': elevenKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            text: script.slice(0, 4500),
            model_id: model,
            voice_settings: { stability: 0.42, similarity_boost: 0.78 },
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.audio_base64) {
        const buffer = Buffer.from(data.audio_base64, 'base64');
        const audioUrl = await uploadAudioBuffer(buffer, userId, 'audio/mpeg');
        const alignment = data.alignment || data.normalized_alignment;
        const cues = alignmentToSubtitleCues(alignment);
        const durationSec =
          cues.length > 0
            ? cues[cues.length - 1].end
            : Math.max(8, Math.round(script.split(/\s+/).length / 2.2));
        return {
          audioUrl,
          provider: 'elevenlabs_timestamps',
          cues: cues.length ? cues : estimateCuesFromText(script, durationSec),
          durationSec,
          chars,
        };
      }
      console.warn('[promoTts] with-timestamps failed', res.status, JSON.stringify(data).slice(0, 160));
    } catch (e) {
      console.warn('[promoTts] eleven timestamps:', e.message);
    }

    // Fallback: plain TTS without timestamps
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
        method: 'POST',
        headers: {
          'xi-api-key': elevenKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: script.slice(0, 4500),
          model_id: model,
          voice_settings: { stability: 0.42, similarity_boost: 0.78 },
        }),
      });
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        const audioUrl = await uploadAudioBuffer(buffer, userId, 'audio/mpeg');
        const durationSec = Math.max(8, Math.round(script.split(/\s+/).length / 2.2));
        return {
          audioUrl,
          provider: 'elevenlabs',
          cues: estimateCuesFromText(script, durationSec),
          durationSec,
          chars,
        };
      }
    } catch (e) {
      console.warn('[promoTts] eleven plain:', e.message);
    }
  }

  const durationSec = Math.max(12, Math.round(script.split(/\s+/).length / 2.2));
  return {
    audioUrl: null,
    provider: 'skipped',
    skipped: true,
    cues: estimateCuesFromText(script, durationSec),
    durationSec,
    chars,
  };
}
