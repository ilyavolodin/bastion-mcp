// Converts CustomResourceDefinition YAML files to the JSON Schema files kubeconform reads, one per kind and version.
//   node crd-to-jsonschema.mjs <out-dir> <crd.yaml>...
// Output names match the kubeconform schema location template
//   <out-dir>/{{.ResourceKind}} (kubeconform lower-cases the kind)_{{.Group}}_{{.ResourceAPIVersion}}.json
// `yaml` is resolved from packages/core (pnpm does not hoist it to the root).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const { parseAllDocuments } = require('yaml');

const [outDir, ...files] = process.argv.slice(2);
if (!outDir || files.length === 0) {
  console.error('usage: crd-to-jsonschema.mjs <out-dir> <crd.yaml>...');
  process.exit(2);
}

/** Replaces Kubernetes OpenAPI extensions with plain JSON Schema and closes objects (strict mode). */
const convert = (node) => {
  if (Array.isArray(node)) return node.map(convert);
  if (node === null || typeof node !== 'object') return node;
  if (node['x-kubernetes-int-or-string'] === true) {
    return { oneOf: [{ type: 'integer' }, { type: 'string' }] };
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('x-kubernetes-')) continue;
    if (key === 'properties' || key === 'additionalProperties' || key === 'items') {
      out[key] =
        key === 'properties'
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)]))
          : convert(value);
    } else {
      out[key] = convert(value);
    }
  }
  if (out.type === 'object' && out.properties && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }
  return out;
};

mkdirSync(outDir, { recursive: true });
let written = 0;
for (const file of files) {
  for (const doc of parseAllDocuments(readFileSync(file, 'utf8'))) {
    const crd = doc.toJS();
    if (crd?.kind !== 'CustomResourceDefinition') continue;
    const { group, names } = crd.spec;
    for (const version of crd.spec.versions) {
      const schema = convert(version.schema?.openAPIV3Schema ?? { type: 'object' });
      // metadata is validated by the core schema machinery; keep it open.
      if (schema.properties?.metadata) schema.properties.metadata = { type: 'object' };
      const name = `${names.kind.toLowerCase()}_${group}_${version.name}.json`;
      writeFileSync(join(outDir, name), `${JSON.stringify(schema, null, 2)}\n`);
      written += 1;
    }
  }
}
console.log(`wrote ${written} schema file(s) to ${outDir}`);
