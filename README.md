# opendocument.app

The website for **OpenDocument Reader** — one page, plus a privacy policy, plus
a live demo that renders whatever document you drop on it using the same engine
the apps use.

Replaces the Webflow export that used to live in
[OpenDocument.fx](https://github.com/opendocument-app/OpenDocument.fx). That
repository still owns three Cloud Functions from 2020 (`inspectMime`,
`download`, `deleteOldFilesPeriodic`) which nothing on the site ever called;
once this is live it should be archived, or a `firebase deploy` run from it will
overwrite what this repository publishes.

## Running it

```sh
npm install
npm run dev      # http://localhost:4321
npm run build    # -> dist/
npm run preview  # serve dist/
```

Node **22.12+** (Astro 7). `.nvmrc` pins it; `nvm use` picks it up, and CI reads
the same file.

## What is where

| Path | |
|---|---|
| `src/pages/index.astro` | the single page — composes the sections below |
| `src/pages/privacy.astro` | the privacy policy, carried over verbatim from the author's blog |
| `src/components/Demo.astro` | the drag-and-drop viewer, markup and script |
| `src/components/StoreBadge.astro` | official Play / App Store / F-Droid artwork, aligned |
| `src/data/links.ts` | every outbound URL, in one place |
| `src/styles/global.css` | the design tokens |
| `scripts/sync-odr.mjs` | vendors the wasm renderer into `public/odr/` |

## The demo

[`@opendocument/odr-core`](https://www.npmjs.com/package/@opendocument/odr-core)
is the C++ engine compiled to WebAssembly. A dropped document is decoded and
laid out in the browser and shown in a sandboxed `blob:` iframe. Nothing is
uploaded — the page's `connect-src 'self'` makes that checkable in devtools
rather than merely claimed.

Two things about it are deliberate and easy to undo by accident:

- **The renderer is not bundled.** `prebuild` copies `index.js`,
  `odr-core.mjs` and `odr-core.wasm` into `public/odr/`, and the page imports
  `/odr/index.js` at runtime. The emscripten glue locates its `.wasm` sibling
  through `import.meta.url`, which survives being copied but not being passed
  through a bundler. `public/odr/` is generated, so it is gitignored — npm is
  the source of truth for the version.
- **It loads on interaction, never on page load.** The wasm is 3.5 MB (1.35 MB
  gzipped), about thirty times the rest of the page put together. The first
  drop, file pick or sample click is what fetches it.
- **The renderer is told the width it renders for.** `viewportWidth` fits a
  paged document to the frame and states the factor as `--odr-fit`, so the
  document opens fitted with no script of ours involved. The zoom bar overrides
  the `body{zoom}` that carries it. The renderer's own zoom api would do this
  better, but it is script inside the frame, and the frame runs none: `sandbox`
  grants `allow-same-origin` (so the bar can reach the document) and withholds
  `allow-scripts`, which is what keeps a `javascript:` link in a dropped
  document off this origin.

The sample document is `public/sample.odt`, hand-written for this page.

## Deployment

Pushes to `main` build and deploy to Firebase Hosting via
`.github/workflows/deploy.yml`; pull requests from this repository get their own
preview channel that expires after 14 days. The project is
`admob-app-id-9025061963` — the same one that already serves the domain, so
nothing about DNS changes.

The workflow needs one repository secret:

- `FIREBASE_SERVICE_ACCOUNT` — the JSON key of a service account with the
  *Firebase Hosting Admin* role. `firebase init hosting:github` generates one,
  or create it in the Google Cloud console and paste the whole JSON in.

### Notes on `firebase.json`

JSON has no comments, so the reasoning lives here:

- **`script-src` allows `'wasm-unsafe-eval'`.** Compiling the module needs it
  and nothing more: odr-core is linked with emscripten's
  `-sDYNAMIC_EXECUTION=0` as of 6.10.0, so embind builds its invokers without
  `new Function` and the `'unsafe-eval'` this used to carry is gone. It is what
  refuses the renderer's own inline scripts inside the frame, too — see the
  demo.
- **`frame-src blob:`** is what lets a rendered document into its iframe.
- **`/_astro/**` is immutable for a year** — Astro fingerprints those filenames.
  **`/odr/**` is one day**, because the wasm filename is stable across versions
  and pinning it forever would strand an old renderer in caches.
- **`/app-ads.txt`** is served as plain text and cached for an hour. It carries
  the AdMob publisher line (`pub-8161473686436957`) and must stay reachable at
  the domain root, or ad revenue on the free apps breaks. It is not decoration.

## Content

The copy descends from the store listings. Two details worth keeping straight:

- The store identifiers do not line up across platforms —
  `at.tomtasche.reader` is the **free** app on Android and the **paid** app on
  iOS. `src/data/links.ts` says so at more length; pick links by edition and
  platform, never by recognising an id.
- The download buttons point at the **free** edition on both platforms. The old
  site linked the paid iOS listing instead.

## Design

The palette is the Android app's Material 3 roles, copied from
`OpenDocument.droid/app/src/main/res/values/colors.xml` and its `values-night`
counterpart, so the site and the app look like the same product. The three
accent colours are sampled from the launcher icon's stacked pages and stand for
text / spreadsheet / presentation throughout.

Dark mode follows `prefers-color-scheme` alone — the tokens flip, nothing else
does. There is no webfont: a page whose argument is that nothing leaves your
machine should not open a connection to a font CDN to make it.
