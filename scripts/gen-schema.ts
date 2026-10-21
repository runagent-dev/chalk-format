// Generates the language-neutral JSON Schemas in schema/ from the Zod model (the source of truth).
// Run: pnpm gen:schema. CI checks the committed files are up to date.
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { CHALK_FORMAT_VERSION, LAB_PARAMS_MAX_BYTES, LAB_PLUGIN_ID, indexShardSchema, labManifestSchema, streamIndexSchema, streamTextSchema, lessonPageSchema, lessonSchema, overlaySchema, storeDescriptorSchema } from '@chalk-format/model';
import * as registry from '@chalk-format/store';

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
  if (props && (props.type as Json | undefined)?.const === 'embed') {
    o.allOf = EMBED_RULES;
    // a byte limit JSON Schema cannot state: annotated, and readers check it themselves
    const params = ((props.lab as Json | undefined)?.properties as Json | undefined)?.params as Json | undefined;
    if (!params) throw new Error('embed.lab.params not found');
    params.description = `At most ${LAB_PARAMS_MAX_BYTES} bytes as UTF-8 JSON. Not expressible in JSON Schema: readers MUST check it (spec 1.1 §2).`;
    params['x-chalk-max-bytes'] = LAB_PARAMS_MAX_BYTES;
    return 1;
  }
  return Object.values(o).reduce((n: number, x) => n + addEmbedRules(x), 0);
}

const header = (name: string, title: string) => ({
  $id: `https://chalk-format.dev/schema/v${CHALK_FORMAT_VERSION}/${name}`,
  title,
  'x-chalk-format-version': CHALK_FORMAT_VERSION,
});
const write = (name: string, json: object) => {
  writeFileSync(new URL(`../schema/${name}`, import.meta.url), JSON.stringify(json, null, 2) + '\n');
  console.log(`schema/${name}`);
};
const out = (name: string, schema: z.ZodType, title: string) => {
  const json = { ...header(name, title), ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) };
  if (!addEmbedRules(json)) throw new Error(`${name}: no embed object found to add the plugin/lab rules to`);
  write(name, json);
};

out('lesson.schema.json', lessonSchema, 'Chalk lesson (assembled model)');
out('page.schema.json', lessonPageSchema, 'Chalk page (pages/page-N.json)');
out('overlay.schema.json', overlaySchema, 'Chalk overlay (overlay.json)');

// ---- 1.2: asset stores ----
// The descriptor's kind-dependent rules are refinements in Zod; stated here so JSON Schema users get them too.
write('store.schema.json', {
  ...header('store.schema.json', 'Chalk store descriptor (spec 1.2 §5.1)'),
  ...z.toJSONSchema(storeDescriptorSchema, { target: 'draft-2020-12', io: 'input' }),
  allOf: [
    { if: { properties: { kind: { const: 'derived' } } }, then: { required: ['template'] } },
    { if: { properties: { kind: { enum: ['indexed', 'api'] } } }, then: { required: ['base'] } },
    { if: { required: ['base'] }, then: { properties: { base: { pattern: '/$' } } } },
  ],
});
write('index-shard.schema.json', { ...header('index-shard.schema.json', 'Chalk index shard (spec 1.2 §5.3)'), ...z.toJSONSchema(indexShardSchema, { target: 'draft-2020-12', io: 'input' }) });
const defs = {
  assetRecord: registry.assetRecordSchema, checkRequest: registry.checkRequestSchema, checkResponse: registry.checkResponseSchema,
  uploadRequest: registry.uploadRequestSchema, uploadResponse: registry.uploadResponseSchema, registerRequest: registry.registerRequestSchema,
  searchQuery: registry.searchQuerySchema, searchResponse: registry.searchResponseSchema, storesResponse: registry.storesResponseSchema, error: registry.errorSchema,
};
write('registry.schema.json', {
  ...header('registry.schema.json', 'Chalk registry API v1: requests and responses (spec/1.2/registry-api.md)'),
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: Object.fromEntries(Object.entries(defs).map(([k, v]) => { const { $schema: _s, ...rest } = z.toJSONSchema(v as z.ZodType, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>; return [k, rest]; })),
});

// ---- 1.4: streamed books ----
// The path rule is a refinement in Zod; stated here so JSON Schema users get it too (relative, no .., no scheme).
const PATH = { type: 'string', minLength: 1, maxLength: 500, pattern: '^(?![/\\\\])(?![a-zA-Z][a-zA-Z0-9+.-]*:)(?!(?:.*/)?\\.\\.(?:/|$))[^\\\\]+$' };
const withPaths = (j: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(j), (k, v) => (k === 'file' || k === 'path') && v && typeof v === 'object' && (v as { type?: string }).type === 'string' ? PATH : v);
write('stream-index.schema.json', withPaths({ ...header('stream-index.schema.json', 'Chalk streamed book index, book.json (spec 1.4 §3)'), ...z.toJSONSchema(streamIndexSchema, { target: 'draft-2020-12', io: 'input' }) }));
write('stream-text.schema.json', { ...header('stream-text.schema.json', 'Chalk streamed book search text (spec 1.4 §4)'), ...z.toJSONSchema(streamTextSchema, { target: 'draft-2020-12', io: 'input' }) });

// ---- 1.5: lab manifests ----
write('lab-manifest.schema.json', { ...header('lab-manifest.schema.json', 'Chalk lab manifest, what a store keeps about a lab (spec 1.5 §4)'), ...z.toJSONSchema(labManifestSchema, { target: 'draft-2020-12', io: 'input' }) });
