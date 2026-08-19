/*
  Copies `@opendocument/odr-core` out of node_modules into `public/odr/`.

  The package is loaded at runtime by URL rather than bundled, because the
  emscripten glue finds its `.wasm` sibling through `import.meta.url` — copying
  the three files next to each other preserves that, whereas passing them
  through a bundler does not. Serving them ourselves also keeps the promise the
  page makes: opening a document reaches no origin but this one.

  npm stays the source of truth for the version, so `public/odr/` is generated
  and gitignored. Run by `prebuild` and `predev`.
*/
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'public', 'odr');

// `index.js` is the only export, so resolve the manifest and walk from there.
const manifestPath = require.resolve('@opendocument/odr-core/package.json');
const source = dirname(manifestPath);
const { version } = JSON.parse(await readFile(manifestPath, 'utf8'));

// The glue imports './odr-core.mjs', which in turn fetches './odr-core.wasm'.
const files = ['index.js', 'odr-core.mjs', 'odr-core.wasm', 'index.d.ts'];

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await Promise.all(files.map((f) => copyFile(join(source, f), join(target, f))));

console.log(`odr-core ${version} → public/odr/ (${files.length} files)`);
