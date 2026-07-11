import JSZip from 'jszip';
import { lessonPageSchema } from '@chalkbook/core';
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
        continue;
      }
      const pageFile = zip.file(p.file);
      if (!pageFile) {
        issues.push({ severity: 'error', message: `page file missing: ${p.file}` });
        continue;
      }
      // Validate the page's content against the model schema, so what
      // `validate` accepts is exactly what `unpack` can decode.
      let pageData: unknown;
      try {
        pageData = JSON.parse(await pageFile.async('string'));
      } catch {
        issues.push({ severity: 'error', message: `page file is not valid JSON: ${p.file}` });
        continue;
      }
      const parsed = lessonPageSchema.safeParse(pageData);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        issues.push({
          severity: 'error',
          message: `page ${p.file} does not match the model: ${
            first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid'
          }`,
        });
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
        // `inline: false` marks a thin-bundle asset whose bytes live in the
        // AssetService, not this ZIP — a missing file is expected, not
        // damage. Absent/true means inline: a missing file IS damage.
        const external = a.inline === false;
        if (!external && !zip.file(a.path)) {
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
