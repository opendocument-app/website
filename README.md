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
| `src/scripts/frame-bridge.js` | the one script of ours inside the frame; the viewer's other half |
| `public/samples/` | one sample document per format, the same content saved as each |
| `scripts/sync-odr.mjs` | vendors the wasm renderer into `public/odr/` |

## The demo

[`@opendocument/odr-core`](https://www.npmjs.com/package/@opendocument/odr-core)
is the C++ engine compiled to WebAssembly. A dropped document is decoded and
laid out in the browser and shown in a sandboxed `srcdoc` iframe. Nothing is
uploaded — the page's `connect-src 'self'` makes that checkable in devtools
rather than merely claimed.

Several things about it are deliberate and easy to undo by accident:

- **The renderer is not bundled, and its path carries its version.**
  `prebuild` copies `index.js`, `odr-core.mjs` and `odr-core.wasm` into
  `public/odr/<version>/`, and the page imports `/odr/<version>/index.js` at
  runtime — `astro.config.mjs` reads the same manifest and defines the version
  into the bundle. The emscripten glue locates its `.wasm` sibling through
  `import.meta.url`, which survives being copied but not being passed through a
  bundler; that resolution is also why the version is a *directory* rather than
  a query string, which the glue would not carry to its siblings.
  `public/odr/` is generated, so it is gitignored — npm is the source of truth
  for the version. **One version is ever on the site**: `/odr/index.js` is a
  generated forwarder to it, for html cached from before a release, and there
  is no second copy of anything to be half loaded from.
- **It loads on interaction, never on page load.** The wasm is 4.4 MB (about
  1.7 MB gzipped), many times the rest of the page put together. The first
  drop, file pick or sample click is what fetches it.
- **The frame runs the renderer's scripts, and has no origin.** The iframe is
  sandboxed with `allow-scripts` and *without* `allow-same-origin`, which is
  the arrangement core's own readme recommends for untrusted input: the
  renderer's scripts — the text editor, the cell overlay, the pdf annotator,
  the zoom — run inside the document, and the document runs in an opaque
  origin, so a `javascript:` link in a dropped file runs there and reaches
  nothing of this page. The price is that this page cannot reach in either:
  `contentDocument` is null. So the one script of ours in the frame,
  `src/scripts/frame-bridge.js`, is appended to the markup before it mounts
  and talks to `viewer.ts` over `postMessage` in both directions. It forwards
  the renderer's `odr.on*` callbacks out, and takes commands in — zoom, the
  editing mode, a format, a marking tool, and the two requests whose answers a
  save is made of. It is inlined as a string (`?raw`), so it is plain
  javascript and must never contain a closing script tag. This is also why
  `script-src` carries `'unsafe-inline'`; see the notes on `firebase.json`.
- **The renderer fits and zooms the document itself.** No width is passed to
  `open`: the css states `--odr-fit: auto`, the renderer's viewport script
  measures the frame it landed in, refits on a resize or a rotation, and
  reports every change through `odr.onZoomChange`. The zoom bar sends
  `setZoom` and `resetZoom` and shows what comes back. Before 7.0.0 the page
  computed the fit and wrote `body{zoom}` from outside, because the frame ran
  no script.
- **A sheet is capped at 50,000 cells.** The markup goes into `srcdoc` as one
  string, so a sheet costs this page's memory rather than a stream the browser
  can page through, and a styled ODS runs ~226 bytes a cell — core's own
  500,000-cell default is ~108 MB for one sheet. At 50,000 the worst sheet in
  the test corpus is 10.8 MB and about fourteen seconds in a browser, and an
  ordinary 40,000-cell XLSX is untouched and opens in well under a second.
  `sheetCut` says what was left out, and the demo says so above the frame. The
  apps have no such cap.
- **Links in the frame are rewired by the bridge.** A `srcdoc` document
  resolves urls against *this page*, so a PDF's `#p2` pointed at
  `https://opendocument.app/#p2` and a click replaced the document with the
  homepage; an archive entry's relative link went to our 404. Fragments scroll
  the frame from inside, relative links are drawn as text, and external links
  keep `target="_blank"` and stay inert against the missing `allow-popups`.
- **A format with no signature is asked for by name.** Everything else core
  detects from the bytes. Markdown is the exception — a `.md` is text and reads
  as text — so the demo maps the extension to the type for any format whose
  `detectByContent` is false and which renders. Hard-coding `md` would rot; this
  does not.

### The samples

`public/samples/` holds one document per format, all the same three pieces of
content: a text document, a budget sheet with formulas, a three-slide deck and
a drawing, hand-written as flat ODF and saved by LibreOffice as ODT, DOCX, DOC,
RTF and PDF; ODS, XLSX, XLS and CSV; ODP, PPTX and PPT; ODG — plus a TXT and an
MD written by hand, and the DOCX, XLSX and PPTX saved again by Pages, Numbers
and Keynote. One per format because what the engine can do depends on the
format it is handed, and the idle panel's chips say so: a pen on the ones that
edit and save, a marker on the PDF, a tooltip on each. The sources are not
kept; regenerating one is a `soffice --headless --convert-to` away.

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
past either end paints. It stops propagating the moment a `zoom` is written
onto that same body, and the overscroll then revealed the frame host's own
light `bg-surface-container` behind a dark page canvas. The bridge reports the
body's computed background in its `ready` message and the viewer copies it
onto the `iframe` element — on the element rather than the document's root, so
what is shown stays exactly as the renderer wrote it.

### Editing, marking, and what the pen does

Core 7.0.0 made editing one mode every format shares
([`docs/design/editing.md`](https://github.com/opendocument-app/OpenDocument.core/blob/main/docs/design/editing.md)
in the core repository): the render writes an address on every run and
paragraph, `odr.editing` on the page owns the mode, the operation log, undo
and the refusals, and each format attaches its own editor — the caret editor
for a text document (with bold, italic, underline, strikethrough, highlight,
colour and size), the cell overlay for a sheet. A pdf has `odr.annotation`
instead: five kinds of mark, drawn in the page, written into the file by
`annotate()` as an incremental update. The bar has a pen and a disc for all of
it.

- **The pen only appears where a change can be saved.** `odr.fileTypes()`
  reports `edit` and `save` for odt, odp, odg, docx, pptx, ods, xlsx and txt,
  and `annotate` for pdf. The type is looked up before `open`, so `editable:
  true` — which writes the addresses and the editor script — is only asked for
  where it leads somewhere. After opening, `isEditable()`/`isSavable()` and
  `isAnnotatable()` answer for the document itself, and the bridge's `ready`
  message answers for the markup that was actually rendered. Any of them
  saying no is the same honest thing: no pen. txt is one of those: the engine
  can edit and save a plain file, but the npm package routes `isEditable` and
  `save` through the document and throws `NoDocumentFile` for one.
- **The mode starts off, and the pen turns it on in the frame.** The rendered
  markup is not editable on sight — 7.0.0's `editable` writes scaffolding, and
  `odr.editing.enable()` is what writes `contenteditable`. The pen sends
  `edit`, the page answers with `onEditModeChange`, and that answer is what
  flips the button; a refused `enable()` comes back the same way with a
  reason. For a pdf the pen only shows the marking tools, and the button flips
  here, because the annotator has no mode to report. Escape inside the frame
  sends the mode off, unless something in the frame took the key first.
- **The strip under the bar is the host's buttons.** For a text document:
  bold, italic, underline, strikethrough, a text colour, a highlight with a
  colour of its own, and a size, each a `toggle` or a `format` sent to the
  page, with `onSelectionChange` painting what the selection has. For a pdf:
  the five tools, each with a colour of its own. With text selected, a tool
  marks it once; without a selection, a press arms the tool and a second press
  disarms it. A second press on a colour's arrow closes its picker. Undo and
  redo for both, driven by `onEditChange`; a pdf has undo only. A sheet gets
  no buttons — the cells are the editor — and a hint instead. The buttons
  cancel their `mousedown` so the frame keeps the focus and the selection.
- **A refusal is a sentence of ours.** The page reports a reason and a message
  meant for a console; `REFUSALS` in the viewer holds the wording a visitor
  sees, keyed by reason, because a host owns the wording. A sheet's stale
  formula cells come through `onCellsStale` and get a persistent note of their
  own: writing a cell takes the cached result of every formula reading it
  away, and the saved file leaves them for a spreadsheet app to recompute.
- **A save is two questions and a download.** `getOperations` or
  `getAnnotations` goes into the frame, the envelope comes back as a json
  string, and it goes into `edit()` + `save()` or into `annotate()` as that
  string — the package's readme says `edit` takes the object, but the binding
  is a `std::string` and an object throws `BindingError`, in 7.0.0 as in
  6.12.0. The bytes go into a `blob:` and out through an `<a download>` under
  the name the document was opened as. After an edit is saved, `committed`
  resets the page's log; after a pdf is saved, the marks stay pending, because
  `annotate()` writes onto the original bytes and a second save has to carry
  them all again.
- **Unsaved changes are warned about once.** Closing the document, or opening
  another, says so above the frame and lets the second attempt through. The
  page blocks on no dialog.

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

- **`script-src` allows `'wasm-unsafe-eval'` and `'unsafe-inline'`.** The
  first compiles the module and nothing more: odr-core is linked with
  emscripten's `-sDYNAMIC_EXECUTION=0`, so embind builds its invokers without
  `new Function`. The second is for the frame, which inherits this policy:
  the renderer writes its scripts inline into every document — the editor,
  the annotator, the zoom — and the bridge is inline too, so refusing inline
  script is refusing everything the pen does. It could not be narrowed to
  hashes, because the frame has an opaque origin and a `blob:` or `'self'`
  script would not load there. The page itself has no inline script: Astro
  bundles its own. What `'unsafe-inline'` also permits, a `javascript:` url
  in a dropped document, runs in the frame's opaque origin and reaches
  nothing — see the demo.
- **`frame-src blob:`** is left over from the `blob:` URL the demo used to
  mount a document with; it goes in through `srcdoc` now, which needs nothing
  from this directive. Harmless, and untested to remove — the demo is what
  would tell you.
- **`/_astro/**` is immutable for a year** — Astro fingerprints those filenames.
  **`/odr/<version>/**` is immutable for a year too**, because the version is in
  the path. It used to be one stable path cached for a day, which cost 6.12.0's
  save buttons their first day on the site — the page had them and the renderer
  the browser kept did not — and then broke opening a document altogether, when
  a refreshed wrapper met the wasm still in cache and called a binding that was
  not there. Three files under one path are three cache entries on their own
  clocks; a version per directory is the only thing all three inherit. A `?v=`
  would not do it: the glue resolves its siblings from `import.meta.url`, and a
  relative resolution drops the query, so the wasm would still come from the
  old entry.
- **`/odr/index.js` is `no-store`.** It is the generated forwarder to the
  current version — two `export` lines, no renderer of its own — and a cached
  copy of it could pin a version, which is the whole thing being avoided.
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
