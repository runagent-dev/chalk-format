// Generates the language-neutral JSON Schemas in schema/ from the Zod model (the source of truth).
// Run: pnpm gen:schema. CI checks the committed files are up to date.
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { CHALK_FORMAT_VERSION, LAB_PLUGIN_ID, lessonPageSchema, lessonSchema, overlaySchema } from '@chalk-format/model';

// Rules the Zod model states as refinements, which toJSONSchema cannot see: added by hand to the
// embed object so JSON Schema readers enforce them too (spec 1.1 §2).
type Json = Record<string, unknown>;
const EMBED_RULES = [
  { if: { required: ['plugin'] }, then: { properties: { embed: { const: 'plugin' } } } },
  { if: { required: ['plugin'], properties: { plugin: { const: LAB_PLUGIN_ID } } }, then: { required: ['lab'] } },
  { if: { required: ['lab'] }, then: { required: ['plugin'], properties: { plugin: { const: LAB_PLUGIN_ID } } } },
];
function addEmbedRules(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  if (Array.isArray(node)) return node.reduce((n: number, x) => n + addEmbedRules(x), 0);
  const o = node as Json, props = o.properties as Json | undefined;
  if (props && (props.type as Json | undefined)?.const === 'embed') { o.allOf = EMBED_RULES; return 1; }
  return Object.values(o).reduce((n: number, x) => n + addEmbedRules(x), 0);
}

const out = (name: string, schema: z.ZodType, title: string) => {
  const json = {
    $id: `https://chalk-format.dev/schema/v${CHALK_FORMAT_VERSION}/${name}`,
    title,
    'x-chalk-format-version': CHALK_FORMAT_VERSION,
    ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }),
  };
  if (!addEmbedRules(json)) throw new Error(`${name}: no embed object found to add the plugin/lab rules to`);
  writeFileSync(new URL(`../schema/${name}`, import.meta.url), JSON.stringify(json, null, 2) + '\n');
  console.log(`schema/${name}`);
};

out('lesson.schema.json', lessonSchema, 'Chalk lesson (assembled model)');
out('page.schema.json', lessonPageSchema, 'Chalk page (pages/page-N.json)');
out('overlay.schema.json', overlaySchema, 'Chalk overlay (overlay.json)');
