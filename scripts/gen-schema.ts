// Generates the language-neutral JSON Schemas in schema/ from the Zod model (the source of truth).
// Run: pnpm gen:schema. CI checks the committed files are up to date.
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { CHALK_FORMAT_VERSION, lessonPageSchema, lessonSchema, overlaySchema } from '@chalk-format/model';

const out = (name: string, schema: z.ZodType, title: string) => {
  const json = {
    $id: `https://chalk-format.dev/schema/v${CHALK_FORMAT_VERSION}/${name}`,
    title,
    'x-chalk-format-version': CHALK_FORMAT_VERSION,
    ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }),
  };
  writeFileSync(new URL(`../schema/${name}`, import.meta.url), JSON.stringify(json, null, 2) + '\n');
  console.log(`schema/${name}`);
};

out('lesson.schema.json', lessonSchema, 'Chalk lesson (assembled model)');
out('page.schema.json', lessonPageSchema, 'Chalk page (pages/page-N.json)');
out('overlay.schema.json', overlaySchema, 'Chalk overlay (overlay.json)');
