/*
  Copies `@opendocument/odr-core` out of node_modules into
  `public/odr/<version>/`.

  The package is loaded at runtime by URL rather than bundled, because the
  emscripten glue finds its `.wasm` sibling through `import.meta.url` — copying
  the three files next to each other preserves that, whereas passing them
  through a bundler does not. Serving them ourselves also keeps the promise the
  page makes: opening a document reaches no origin but this one.

  The version is in the path because that sibling resolution is also what makes
  a shared, stable path dangerous: `index.js`, `odr-core.mjs` and
  `odr-core.wasm` are three cache entries that expire on their own clocks, so a
  visitor could pair new glue with an old wasm — and a caller of a binding the
  old one lacks throws rather than degrading. One directory per version means a
  release is one set of urls nothing has cached, and 6.12.0's save buttons
  appear the moment the page does rather than a day later. `astro.config.mjs`
  reads the same manifest and defines the version into the bundle.

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

const versioned = join(target, version);
await mkdir(versioned, { recursive: true });
await Promise.all(files.map((f) => copyFile(join(source, f), join(versioned, f))));

/*
  The same files once more at the path that was the entry until 6.12.0. A page
  is cached for an hour and a left-open tab for as long as it is open, so html
  that still asks for `/odr/index.js` is served for a while after this deploys —
  and answering it with a 404 would break opening a document altogether, which
  is worse than the stale renderer this move is about. Drop this, and the
  `/odr/*` rule in `firebase.json`, one release after 6.12.0.
*/
await Promise.all(files.map((f) => copyFile(join(source, f), join(target, f))));

console.log(`odr-core ${version} → public/odr/${version}/ (${files.length} files, plus a legacy copy)`);
