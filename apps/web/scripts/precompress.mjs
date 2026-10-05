// After `vite build`: writes a brotli and a gzip copy next to every large text file in dist/, so the API (which serves
// the web app, see apps/api/src/web.ts) sends the compressed bytes as they are (`@fastify/static` `preCompressed`).
// The engine worker alone is ~1.8 MB of JavaScript; compressed it is a fifth of that. Plain Node, no dependency.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|txt|xml|map|webmanifest)$/i;
/** Below this a compressed copy saves nothing worth a second file. */
const MIN_BYTES = 1024;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

let count = 0;
for (const file of files(dist)) {
  if (!COMPRESSIBLE.test(file) || statSync(file).size < MIN_BYTES) continue;
  const bytes = readFileSync(file);
  const br = brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length },
  });
  const gz = gzipSync(bytes, { level: 9 });
  // A copy that is not smaller is not worth sending.
  if (br.length < bytes.length) writeFileSync(`${file}.br`, br);
  if (gz.length < bytes.length) writeFileSync(`${file}.gz`, gz);
  count++;
  console.log(`precompress: ${path.relative(dist, file)}  ${bytes.length} -> br ${br.length}, gz ${gz.length}`);
}
console.log(`precompress: ${count} file(s)`);
