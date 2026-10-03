/**
 * FFmpeg Ken Burns for interior stills + final concat with optional drone clip + VO + ASS.
 * Remotion Player mirrors this timeline on the frontend; production export stays FFmpeg (no Lambda cost).
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import ffmpegStatic from 'ffmpeg-static';
import { uploadReelMp4 } from '../reelMediaStore.js';

function ffmpegBin() {
  return String(process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg').trim();
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegBin();
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${err.slice(-400)}`));
    });
  });
}

async function downloadToFile(url, dest) {
  if (String(url).startsWith('data:')) {
    const m = String(url).match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('Neplatný data URL');
    await fs.writeFile(dest, Buffer.from(m[2], 'base64'));
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

function escapeAssText(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N');
}

function toAssTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const whole = Math.floor(ss);
  const cs = Math.round((ss - whole) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function buildAssFromCues(cues, aspectRatio = '9:16') {
  const isVertical = aspectRatio !== '16:9';
  const playRes = isVertical ? '1080 1920' : '1920 1080';
  const fontSize = isVertical ? 56 : 48;
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playRes.split(' ')[0]}`,
    `PlayResY: ${playRes.split(' ')[1]}`,
    '',
    '[V4+ Styles]',
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding`,
    `Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,120,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const c of cues || []) {
    if (!c?.text) continue;
    const start = Number(c.start ?? c.startSec ?? 0) || 0;
    const end = Number(c.end ?? c.endSec ?? start + 2.5) || start + 2.5;
    lines.push(
      `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${escapeAssText(c.text)}`,
    );
  }
  return lines.join('\n');
}

async function uploadMp4(buffer, userId) {
  return uploadReelMp4(buffer, userId, { folder: 'promo' });
}

/**
 * One Ken Burns clip from still image.
 */
async function renderKenBurnsClip({ imagePath, outPath, durationSec, width, height, variant = 0 }) {
  const frames = Math.max(24, Math.round(durationSec * 25));
  // Alternate zoom-in / slight pan for visual variety
  const zExpr =
    variant % 2 === 0
      ? `'min(zoom+0.0012,1.28)'`
      : `'if(eq(on,1),1.28,max(1.0,zoom-0.0012))'`;
  const xExpr = variant % 3 === 0 ? `'iw/2-(iw/zoom/2)'` : `'iw/2-(iw/zoom/2)+20*sin(on/40)'`;
  const yExpr = variant % 3 === 1 ? `'ih/2-(ih/zoom/2)'` : `'ih/2-(ih/zoom/2)+12*cos(on/35)'`;

  await runFfmpeg([
    '-y',
    '-loop',
    '1',
    '-i',
    imagePath,
    '-vf',
    `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z=${zExpr}:x=${xExpr}:y=${yExpr}:d=${frames}:s=${width}x${height}:fps=25`,
    '-t',
    String(durationSec),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-an',
    outPath,
  ]);
}

/**
 * @param {{
 *  droneVideoUrl?: string|null,
 *  interiorPhotoUrls: string[],
 *  audioUrl?: string|null,
 *  cues?: object[],
 *  durationSec: number,
 *  aspectRatio?: '9:16'|'16:9',
 *  userId: string,
 *  musicUrl?: string|null,
 * }} opts
 */
export async function composePromoKenBurnsMp4(opts) {
  const aspect = opts.aspectRatio === '16:9' ? '16:9' : '9:16';
  const width = aspect === '16:9' ? 1920 : 1080;
  const height = aspect === '16:9' ? 1080 : 1920;
  const totalDur = Math.max(12, Number(opts.durationSec) || 36);
  const interiors = (opts.interiorPhotoUrls || []).filter((u) => /^https?:\/\//i.test(u) || String(u).startsWith('data:'));
  if (!interiors.length && !opts.droneVideoUrl) {
    throw Object.assign(new Error('Chybí fotky / drone klip pro compose.'), { status: 400 });
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'makio-promo-'));
  const clipPaths = [];

  try {
    let remaining = totalDur;
    let droneDur = 0;

    if (opts.droneVideoUrl) {
      droneDur = Math.min(3.5, Math.max(1.5, totalDur * 0.12));
      const droneIn = path.join(tmp, 'drone-in.mp4');
      const droneOut = path.join(tmp, 'drone.mp4');
      await downloadToFile(opts.droneVideoUrl, droneIn);
      await runFfmpeg([
        '-y',
        '-i',
        droneIn,
        '-t',
        String(droneDur),
        '-vf',
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-an',
        droneOut,
      ]);
      clipPaths.push(droneOut);
      remaining = Math.max(8, totalDur - droneDur);
    }

    const n = Math.max(1, interiors.length);
    const each = remaining / n;
    for (let i = 0; i < interiors.length; i++) {
      const imgPath = path.join(tmp, `img-${i}.jpg`);
      const clipPath = path.join(tmp, `kb-${i}.mp4`);
      await downloadToFile(interiors[i], imgPath);
      await renderKenBurnsClip({
        imagePath: imgPath,
        outPath: clipPath,
        durationSec: each,
        width,
        height,
        variant: i,
      });
      clipPaths.push(clipPath);
    }

    const listFile = path.join(tmp, 'list.txt');
    await fs.writeFile(
      listFile,
      clipPaths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'),
      'utf8',
    );
    const concatPath = path.join(tmp, 'concat.mp4');
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', concatPath]);

    const assPath = path.join(tmp, 'subs.ass');
    await fs.writeFile(assPath, buildAssFromCues(opts.cues || [], aspect), 'utf8');
    const assEsc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    const finalPath = path.join(tmp, 'final.mp4');
    const args = ['-y', '-i', concatPath];

    if (opts.audioUrl) {
      const audioPath = path.join(tmp, 'vo.mp3');
      await downloadToFile(opts.audioUrl, audioPath);
      args.push('-i', audioPath);
    }
    if (opts.musicUrl) {
      const musicPath = path.join(tmp, 'music.mp3');
      try {
        await downloadToFile(opts.musicUrl, musicPath);
        args.push('-i', musicPath);
      } catch {
        /* optional */
      }
    }

    // Video + ASS; audio mix if present
    const filterParts = [`[0:v]ass='${assEsc}'[v]`];
    let mapAudio = null;
    if (opts.audioUrl && opts.musicUrl && args.filter((a) => a.endsWith('music.mp3')).length) {
      filterParts.push(
        `[1:a]volume=1.0[a1];[2:a]volume=0.18[a2];[a1][a2]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
      );
      mapAudio = '[aout]';
    } else if (opts.audioUrl) {
      mapAudio = '1:a';
    }

    args.push('-filter_complex', filterParts.join(';'), '-map', '[v]');
    if (mapAudio) {
      args.push('-map', mapAudio, '-c:a', 'aac', '-b:a', '192k', '-shortest');
    } else {
      args.push('-an');
    }
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', finalPath);

    await runFfmpeg(args);

    const buffer = await fs.readFile(finalPath);
    const videoUrl = await uploadMp4(buffer, opts.userId);
    return {
      videoUrl,
      durationSec: totalDur,
      width,
      height,
      clipCount: clipPaths.length,
      engine: 'ffmpeg_kenburns',
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
