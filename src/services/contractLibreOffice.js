/**
 * DOCX → PDF přes LibreOffice / soffice headless.
 */

import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { existsSync } from 'fs';

const WIN_CANDIDATES = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
];

export function resolveSofficeBinary() {
  if (process.env.LIBREOFFICE_PATH && existsSync(process.env.LIBREOFFICE_PATH)) {
    return process.env.LIBREOFFICE_PATH;
  }
  if (process.platform === 'win32') {
    for (const p of WIN_CANDIDATES) {
      if (existsSync(p)) return p;
    }
  }
  return process.env.LIBREOFFICE_PATH || 'soffice';
}

export function isLibreOfficeAvailable() {
  const bin = resolveSofficeBinary();
  if (bin !== 'soffice' && existsSync(bin)) return true;
  // PATH — best-effort; actual convert will fail with clear error
  return bin === 'soffice';
}

function run(cmd, args, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let stderr = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('LibreOffice převod vypršel (timeout).'));
    }, timeoutMs);
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ stderr });
      else reject(new Error(`LibreOffice exit ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

/**
 * @param {Buffer} docxBuffer
 * @returns {Promise<Buffer>}
 */
export async function convertDocxToPdf(docxBuffer) {
  const bin = resolveSofficeBinary();
  const dir = await mkdtemp(join(tmpdir(), 'makio-contract-'));
  const inPath = join(dir, 'input.docx');
  const outPath = join(dir, 'input.pdf');
  try {
    await writeFile(inPath, docxBuffer);
    await run(bin, ['--headless', '--nologo', '--nofirststartwizard', '--convert-to', 'pdf', '--outdir', dir, inPath], {
      cwd: dir,
    });
    const pdf = await readFile(outPath);
    if (!pdf?.length) {
      const err = new Error('LibreOffice nevytvořil PDF.');
      err.status = 502;
      throw err;
    }
    return pdf;
  } catch (e) {
    if (e.code === 'ENOENT' || /ENOENT|not found|není rozpozn/i.test(String(e.message))) {
      const err = new Error(
        'PDF export vyžaduje LibreOffice (soffice). Nainstalujte LibreOffice nebo nastavte LIBREOFFICE_PATH.',
      );
      err.status = 503;
      err.code = 'LIBREOFFICE_MISSING';
      throw err;
    }
    if (!e.status) e.status = 502;
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
