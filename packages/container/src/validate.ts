import JSZip from 'jszip';
import { CHALKBOOK_FORMAT } from './manifest.js';
import { checkEntryCount, type UnpackInput, type UnpackLimits } from './unpack.js';

export type ValidationSeverity = 'error' | 'warning';

export type ValidationIssue = {
  severity: ValidationSeverity;
  message: string;
};

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
};

export async function validateLessonPackage(
  input: UnpackInput,
  limits?: UnpackLimits,
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input);
  } catch (err) {
    return {
      ok: false,
      issues: [{ severity: 'error', message: `invalid zip: ${(err as Error).message}` }],
    };
  }

  try {
    checkEntryCount(zip, limits);
  } catch (err) {
    return {
      ok: false,
      issues: [{ severity: 'error', message: (err as Error).message }],
    };
  }

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    return { ok: false, issues: [{ severity: 'error', message: 'missing manifest.json' }] };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(await manifestFile.async('string'));
  } catch {
    return {
      ok: false,
      issues: [{ severity: 'error', message: 'manifest.json is not valid JSON' }],
    };
  }

  if (!isRecord(manifest)) {
    return {
      ok: false,
      issues: [{ severity: 'error', message: 'manifest.json is not an object' }],
    };
  }

  if (manifest.format !== CHALKBOOK_FORMAT) {
    issues.push({
      severity: 'error',
      message: `unexpected format: ${String(manifest.format)}`,
    });
  }

  const pages = manifest.pages;
  if (!Array.isArray(pages)) {
    issues.push({ severity: 'error', message: 'manifest.pages must be an array' });
  } else {
    for (const p of pages) {
      if (!isRecord(p) || typeof p.file !== 'string') {
        issues.push({
          severity: 'error',
          message: `page entry missing 'file': ${JSON.stringify(p)}`,
        });
        continue;
      }
      if (p.file.includes('..')) {
        issues.push({ severity: 'error', message: `unsafe path in page entry: ${p.file}` });
      }
      if (!zip.file(p.file)) {
        issues.push({ severity: 'error', message: `page file missing: ${p.file}` });
      }
    }
  }

  const metadata = manifest.metadata;
  if (
    !isRecord(metadata) ||
    typeof metadata.createdAt !== 'string' ||
    typeof metadata.updatedAt !== 'string'
  ) {
    issues.push({
      severity: 'error',
      message: 'manifest.metadata must be an object with createdAt/updatedAt strings',
    });
  }

  const assets = manifest.assets;
  if (assets !== undefined) {
    if (!Array.isArray(assets)) {
      issues.push({ severity: 'error', message: 'manifest.assets must be an array' });
    } else {
      const seenPaths = new Set<string>();
      for (const a of assets) {
        if (!isRecord(a) || typeof a.id !== 'string' || typeof a.path !== 'string') {
          issues.push({
            severity: 'error',
            message: `asset entry missing 'id'/'path': ${JSON.stringify(a)}`,
          });
          continue;
        }
        if (a.path.includes('..')) {
          issues.push({ severity: 'error', message: `unsafe path in asset entry: ${a.path}` });
          continue;
        }
        if (seenPaths.has(a.path)) {
          issues.push({ severity: 'error', message: `duplicate asset path: ${a.path}` });
        }
        seenPaths.add(a.path);
        if (!zip.file(a.path)) {
          issues.push({ severity: 'error', message: `asset file missing: ${a.path}` });
        }
      }
    }
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  return { ok: !hasErrors, issues };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
