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

**The viewer only works under `preview`, not `dev`.** The renderer is imported
from `public/odr/` at runtime, and Vite's dev server refuses to serve a
`public/` file through its module pipeline — it rewrites the import to
`/odr/index.js?import` and answers 500, so the demo reports that the renderer
could not be loaded. `@vite-ignore` does not help; the query is injected at
runtime, after the comment has done its job. Everything else on the page is
fine in `dev`; check the viewer with `npm run build && npm run preview`.

## What is where

| Path | |
|---|---|
| `src/pages/index.astro` | the single page — composes the sections below |
| `src/pages/privacy.astro` | the privacy policy, carried over verbatim from the author's blog |
| `src/pages/tryit.astro` | the viewer with the whole window to itself |
| `src/scripts/viewer.ts` | the viewer itself — one implementation, mounted by both |
| `src/components/viewer/` | the markup those two share: the idle panel and the bar |
| `src/components/Demo.astro` | the viewer as one section of the homepage |
| `src/components/StoreBadge.astro` | official Play / App Store / F-Droid / Obtainium artwork, aligned |
| `src/data/links.ts` | every outbound URL, in one place |
| `src/styles/global.css` | the design tokens |
| `scripts/sync-odr.mjs` | vendors the wasm renderer into `public/odr/` |

## The demo

[`@opendocument/odr-core`](https://www.npmjs.com/package/@opendocument/odr-core)
is the C++ engine compiled to WebAssembly. A dropped document is decoded and
laid out in the browser and shown in a sandboxed `srcdoc` iframe. Nothing is
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
- **A sheet is capped at 50,000 cells.** The markup goes into `srcdoc` as one
  string, so a sheet costs this page's memory rather than a stream the browser
  can page through, and a styled ODS runs ~226 bytes a cell — core's own
  500,000-cell default is ~108 MB for one sheet. At 50,000 the worst sheet in
  the test corpus is 10.8 MB and about fourteen seconds in a browser, and an
  ordinary 40,000-cell XLSX is untouched and opens in well under a second.
  `sheetCut` says what was left out, and the demo says so above the frame. The
  apps have no such cap.
- **Links in the frame are rewired from here.** 6.11.0 dropped the blanket
  `<base target="_blank">`, which is right for a host that serves what it
  rendered and wrong for this one. A `srcdoc` document resolves urls against
  *this page*, so a PDF's `#p2` pointed at `https://opendocument.app/#p2` and a
  click replaced the document with the homepage; an archive entry's relative
  link went to our 404. Fragments now scroll the frame from the parent — the
  document is same-origin, the same access the zoom bar needs — and relative
  links are drawn as text. External links keep `target="_blank"` and stay inert
  against the missing `allow-popups`.
- **A format with no signature is asked for by name.** Everything else core
  detects from the bytes. Markdown is the exception — a `.md` is text and reads
  as text — so the demo maps the extension to the type for any format whose
  `detectByContent` is false and which renders. Hard-coding `md` would rot; this
  does not.

The sample document is `public/sample.odt`, hand-written for this page.

### Two mounts, one viewer

`src/scripts/viewer.ts` is the whole thing; `Demo.astro` and `tryit.astro` are
two sets of markup around it, found by `data-viewer-*` attributes so a layout
can leave a control out rather than having to carry it. One viewer per page:
the drop target is the window, so a second mount would open the same file
twice.

They differ in two deliberate ways:

- **`/tryit` asks for `textDocumentMargin`.** A text document then comes out as
  the fixed-size pages it was written as, on the renderer's own canvas, instead
  of reflowing to the frame. That is the right trade only where there is room —
  the demo's 32rem box would spend most of it on margins, so the demo leaves it
  off and gets reflowed text.
- **`/tryit` has no site header.** The bar the demo draws above a document is
  the page's only furniture, with the mark on its left as the way back. So the
  document half of that bar carries `data-viewer-open` and is toggled with the
  frame; inside the demo, where the whole bar is hidden until something
  renders, that costs nothing.

The full-screen page starts empty on purpose: a navigation drops the wasm heap
the document lives in, so the link out of the demo cannot carry it over and
says so in its `title`.

### The frame is given the colour its document chose

The renderer paints its canvas on the document's `body` — white behind
reflowing text, `#525659` behind paginated pages — and a body background
normally propagates to the frame's canvas, which is what a rubber-band scroll
past either end paints. It stops propagating the moment the zoom bar writes
`zoom` onto that same body, and the overscroll then revealed the frame host's
own light `bg-surface-container` behind a dark page canvas. The `load` handler
copies the body's computed background onto the `iframe` element — on the
element rather than the document's root, so what is shown stays exactly as the
renderer wrote it.

### Editing, and how a diff gets out of a frame that runs no script

6.12.0 bound the other half of the round trip — `edit(diff)`, `save()`,
`isEditable()` and `isSavable()`
([core#777](https://github.com/opendocument-app/OpenDocument.core/issues/777)) —
so the bar has a pen on it. It turns into a disc: the pen opens the document to
typing, the disc hands the typing back to the engine and downloads the document
the engine writes. Both viewers get it, because both are the same script around
the same bar.

- **The pen only appears where an edit can be saved.** `odr.fileTypes()` reports
  `edit` and `save` for odt, odp, odg and docx; ods can be saved but not edited,
  and everything else neither. The type is looked up before `open`, so
  `editable: true` — which writes `contenteditable` and a `data-odr-path` onto
  every text run — is only asked for where it leads somewhere. After opening,
  `isEditable()` and `isSavable()` answer for the document itself and settle it.
- **Edit mode is an attribute toggle, not a second render.** The renderer's
  editable output is editable the moment it mounts, which is not a mode anyone
  asked for — on a phone a tap meant to scroll would raise the keyboard over a
  document being read. So the `load` handler writes `contenteditable="false"`
  across the frame and the pen writes it back to `true`. Re-rendering for a
  second config would cost the scroll position, the zoom and the frame.
- **The diff is collected from this side.** The renderer ships an
  `odr.generateDiff()` that watches the document and reports the text of every
  run that changed. It never runs — the frame is given `allow-same-origin` and
  not `allow-scripts` — so a `MutationObserver` in the parent realm does the
  same job through the same access the zoom bar uses, attributing a change to
  the nearest `[data-odr-path]` ancestor. `childList` counts as well as
  `characterData`: emptying a run removes its text node rather than shortening
  it. `Enter` is refused the way the renderer's own script refuses it — the diff
  carries text, and a new line is structure — and `Escape` leaves edit mode
  without writing a file, which one button doing both jobs otherwise has no way
  out of.
- **A save is a download.** There is no file behind the document, only the bytes
  that were dropped, so `save()` goes into a `blob:` and out through an `<a
  download>` under the name it was opened as. Nothing is uploaded here either.
- **Unsaved edits are warned about once.** Closing the document, or opening
  another, says so above the frame and lets the second attempt through. The page
  blocks on no dialog.

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
- **`frame-src blob:`** is left over from the `blob:` URL the demo used to
  mount a document with; it goes in through `srcdoc` now, which needs nothing
  from this directive. Harmless, and untested to remove — the demo is what
  would tell you.
- **`/_astro/**` is immutable for a year** — Astro fingerprints those filenames.
  **`/odr/**` is one day**, because the wasm filename is stable across versions
  and pinning it forever would strand an old renderer in caches.
- **`/app-ads.txt`** is served as plain text and cached for an hour. It carries
  the AdMob publisher line (`pub-8161473686436957`) and must stay reachable at
  the domain root, or ad revenue on the free apps breaks. It is not decoration.

## Content

The copy descends from the store listings. Three details worth keeping straight:

- The store identifiers do not line up across platforms —
  `at.tomtasche.reader` is the **free** app on Android and the **paid** app on
  iOS. `src/data/links.ts` says so at more length; pick links by edition and
  platform, never by recognising an id.
- The download buttons point at the **free** edition on both platforms. The old
  site linked the paid iOS listing instead.
- **The format list is the engine's, not the store's.** The store listing claims
  EPS, DXF, PSD and HTML; core has no type for the first three at all, and as of
  6.11.0 it stops claiming HTML output for PSD — the `<img>` never painted, so
  the app showed a blank page. `Formats.astro` lists what
  `odr.fileTypes()` says renders. When they disagree, the store listing is the
  one to fix.

## Design

The palette is the Android app's Material 3 roles, copied from
`OpenDocument.droid/app/src/main/res/values/colors.xml` and its `values-night`
counterpart, so the site and the app look like the same product. The three
accent colours are sampled from the launcher icon's stacked pages and stand for
text / spreadsheet / presentation throughout.

Dark mode follows `prefers-color-scheme` alone — the tokens flip, nothing else
does. There is no webfont: a page whose argument is that nothing leaves your
machine should not open a connection to a font CDN to make it.
