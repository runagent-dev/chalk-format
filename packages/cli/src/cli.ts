#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { convertPdfToChalk, titleFromFilename } from '@chalk-format/convert-pdf';

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--') || arg === '-o') {
      const key = arg === '-o' ? 'out' : arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const USAGE = `chalkbook-pdf — convert a PDF into a .chalk lesson

Usage:
  chalkbook-pdf convert <file.pdf> [-o <out.chalk>] [--title <title>] \\
      [--width <px>] [--format webp|png] [--quality 0-1]

Renders each page (WebP by default), extracts its text layer, and packs
a portable .chalk document. Runs entirely in Node — no browser.`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return;
  }
  if (command !== 'convert') {
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const { positional, flags } = parseFlags(rest);
  const input = positional[0];
  if (!input) throw new Error('convert needs a <file.pdf> path');

  const title = flags.title ?? titleFromFilename(basename(input));
  const out = flags.out ?? input.replace(/\.pdf$/i, '') + '.chalk';

  const pdfBytes = new Uint8Array(await readFile(input));
  const chalk = await convertPdfToChalk(pdfBytes, title, {
    ...(flags.width ? { targetWidth: Number(flags.width) } : {}),
    ...(flags.format === 'png' || flags.format === 'webp' ? { format: flags.format } : {}),
    ...(flags.quality ? { quality: Number(flags.quality) } : {}),
    onProgress: (n, total) => process.stderr.write(`\rrendering page ${n}/${total}…`),
  });
  process.stderr.write('\n');

  await writeFile(out, chalk);
  console.log(`wrote ${out} (${(chalk.byteLength / 1024).toFixed(0)} KB)`);
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exitCode = 1;
});
