/**
 * Compose final Instagram-ready reel with FFmpeg when available.
 * Uses FFMPEG_PATH, then ffmpeg-static bundle, then PATH `ffmpeg`.
 * Fallback: playlist of clips (no fake "final" = first room only).
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import ffmpegStatic from 'ffmpeg-static';
import { uploadReelMp4 } from './reelMediaStore.js';

function resolveFfmpegBin() {
  const fromEnv = String(process.env.FFMPEG_PATH || '').trim();
  if (fromEnv) return fromEnv;
  if (ffmpegStatic) return ffmpegStatic;
  return 'ffmpeg';
}

export async function isFfmpegAvailable() {
  const bin = resolveFfmpegBin();
  return new Promise((resolve) => {
    const p = spawn(bin, ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

function escapeAssText(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N');
}

/**
 * Build simple ASS subtitles for 9:16.
 * @param {Array<{ startSec?: number, endSec?: number, text?: string }>} cues
 * @param {string} style hormozi|minimalist|classic_lower_third
 */
export function buildAssSubtitles(cues, style = 'hormozi') {
  const isHormozi = style === 'hormozi';
  const isClassic = style === 'classic_lower_third';
  const alignment = isClassic ? 2 : 5; // bottom-center vs middle-center
  const fontSize = isHormozi ? 64 : isClassic ? 42 : 48;
  const marginV = isClassic ? 120 : isHormozi ? 0 : 40;

  const header = `[Script Info]
Title: Makio Reel
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,${isHormozi ? -1 : 0},0,0,0,100,100,0,0,1,${isHormozi ? 6 : 3},${isHormozi ? 2 : 1},${alignment},60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = (Array.isArray(cues) ? cues : [])
    .map((c) => {
      const start = Number(c.startSec) || 0;
      const end = Number(c.endSec) || start + 2.5;
      const text = escapeAssText(c.text || '');
      if (!text) return null;
      return `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${text}`;
    })
    .filter(Boolean);

  return header + lines.join('\n') + '\n';
}

function toAssTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const whole = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Titulky z nabídky (cena / lokalita) — i bez voiceoveru.
 * @param {{ title?: string, price?: string, location?: string, disposition?: string }} listing
 * @param {number} clipCount
 */
export function buildListingSubtitleCues(listing, clipCount = 1) {
  const n = Math.max(1, Number(clipCount) || 1);
  const clipDur = 5;
  const total = n * clipDur;
  const cues = [];
  const title = String(listing?.title || '').trim();
  const price = String(listing?.price || '').trim();
  const location = String(listing?.location || '').trim();
  const disposition = String(listing?.disposition || '').trim();

  if (title) cues.push({ startSec: 0.4, endSec: Math.min(3.2, total - 0.2), text: title });
  const mid = [disposition, price].filter(Boolean).join(' · ');
  if (mid) {
    cues.push({
      startSec: Math.min(3.4, Math.max(0.5, total * 0.25)),
      endSec: Math.min(6.5, Math.max(2, total * 0.45)),
      text: mid,
    });
  }
  if (location) {
    cues.push({
      startSec: Math.max(0.5, total - 3.2),
      endSec: Math.max(1, total - 0.4),
      text: location,
    });
  }
  return cues;
}

async function downloadToFile(url, dest) {
  if (String(url).startsWith('data:')) {
    const b64 = url.split(',')[1] || '';
    await fs.writeFile(dest, Buffer.from(b64, 'base64'));
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url.slice(0, 80)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

function runFfmpeg(args) {
  const bin = resolveFfmpegBin();
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      err += d.toString();
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${err.slice(-400)}`));
    });
  });
}

async function uploadMp4(buffer, userId) {
  return uploadReelMp4(buffer, userId, { folder: 'final' });
}

/**
 * @param {{
 *  clipUrls: string[],
 *  audioUrl?: string|null,
 *  subtitleCues?: object[],
 *  subtitleStyle?: string,
 *  userId: string,
 * }} opts
 */
export async function composeReelMp4(opts) {
  const clips = (opts.clipUrls || []).filter((u) => /^https?:\/\//i.test(u) || String(u).startsWith('data:'));
  if (!clips.length) {
    throw Object.assign(new Error('Žádné klipy ke compose.'), { status: 400 });
  }

  const hasFfmpeg = await isFfmpegAvailable();
  if (!hasFfmpeg) {
    console.warn('[reelCompose] ffmpeg not found — returning playlist only (not first clip as fake final)');
    return {
      finalVideoUrl: clips.length === 1 ? clips[0] : null,
      composed: false,
      reason: 'ffmpeg_missing',
      playlistUrls: clips,
    };
  }

  const listingCues = buildListingSubtitleCues(opts.listingDetails, clips.length);
  const cues = [
    ...(Array.isArray(opts.subtitleCues) ? opts.subtitleCues.filter((c) => c?.text) : []),
  ];
  if (!cues.length && listingCues.length) cues.push(...listingCues);

  // Single clip still needs title burn-in + 9:16 normalize when cues exist
  if (clips.length === 1 && !cues.length && !opts.audioUrl) {
    return {
      finalVideoUrl: clips[0],
      composed: true,
      reason: 'single_clip',
      playlistUrls: clips,
    };
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'makio-reel-'));
  try {
    const clipFiles = [];
    for (let i = 0; i < clips.length; i += 1) {
      const dest = path.join(tmp, `clip${i}.mp4`);
      // eslint-disable-next-line no-await-in-loop
      await downloadToFile(clips[i], dest);
      clipFiles.push(dest);
    }

    let work;
    if (clips.length === 1) {
      work = clipFiles[0];
    } else {
      const listFile = path.join(tmp, 'list.txt');
      await fs.writeFile(
        listFile,
        clipFiles.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'),
        'utf8',
      );

      const concatOutPath = path.join(tmp, 'concat.mp4');
      try {
        await runFfmpeg([
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listFile,
          '-c',
          'copy',
          concatOutPath,
        ]);
      } catch (copyErr) {
        console.warn('[reelCompose] concat copy failed, re-encoding:', copyErr.message?.slice?.(0, 120));
        await runFfmpeg([
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listFile,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-c:a',
          'aac',
          '-ar',
          '44100',
          '-ac',
          '2',
          concatOutPath,
        ]);
      }
      work = concatOutPath;
    }

    const withAudio = path.join(tmp, 'with-audio.mp4');
    if (opts.audioUrl) {
      const audioFile = path.join(tmp, 'voice.mp3');
      await downloadToFile(opts.audioUrl, audioFile);
      await runFfmpeg([
        '-y',
        '-i',
        work,
        '-i',
        audioFile,
        '-filter_complex',
        '[1:a]loudnorm=I=-16:TP=-1.5:LRA=11[a]',
        '-map',
        '0:v:0',
        '-map',
        '[a]',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-shortest',
        withAudio,
      ]);
      work = withAudio;
    }

    const finalLocal = path.join(tmp, 'final.mp4');
    if (cues.length) {
      const assPath = path.join(tmp, 'subs.ass');
      const ass = buildAssSubtitles(cues, opts.subtitleStyle || 'hormozi');
      await fs.writeFile(assPath, ass, 'utf8');
      const assEsc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      await runFfmpeg([
        '-y',
        '-i',
        work,
        '-vf',
        `ass='${assEsc}',scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        finalLocal,
      ]);
    } else {
      await runFfmpeg([
        '-y',
        '-i',
        work,
        '-vf',
        'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        finalLocal,
      ]);
    }

    const buf = await fs.readFile(finalLocal);
    const finalVideoUrl = await uploadMp4(buf, opts.userId);
    return {
      finalVideoUrl,
      composed: true,
      playlistUrls: clips,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
