/*
  The viewer, shared by the demo section on the homepage and the full-screen
  page at `/tryit`. Both mount this against their own markup: every control is
  found by a `data-viewer-*` attribute inside the root element, and the ones a
  layout leaves out are simply absent rather than fatal.

  One viewer per page. The drop target is the window - dropping anywhere works,
  and the zone is only what lights up - so a second mount on one page would
  open the same file twice.
*/

/*
  The renderer is ~1.4 MB gzipped, so it is never part of the page load: the
  first drop, pick or sample click pulls it in. It is served from `/odr/`
  rather than bundled - the emscripten glue resolves its `.wasm` sibling from
  `import.meta.url`, which survives being copied into `public/` untouched but
  not being run through a bundler.

  Under the version, because that same sibling resolution is what makes one
  stable path dangerous: the three files are three cache entries on their own
  clocks, and a visitor holding yesterday's glue beside today's wasm is a
  broken renderer rather than an old one. A versioned directory is a set of
  urls nothing has cached, so a release lands with the page that names it.
*/
const ODR_ENTRY = `/odr/${__ODR_VERSION__}/index.js`;

/*
  A sheet is written into `srcdoc` as one string, so its markup is this page's
  memory rather than a file the browser streams, and the frame parses all of
  it before anything paints. Core's own budget is 500k cells, which a styled
  ods spends at ~226 bytes each: ~108 MB for one sheet.

  50k is not a byte figure - a cell ranges from ~44 bytes in a csv to ~226 in
  a styled ods - but it is where the two cases we have both land well. An
  ordinary 40k-cell xlsx stays uncut and opens in under a second, and the
  worst sheet in the test corpus (66523x21, the business register) comes out
  at 10.8 MB and ~14s in a browser instead of 108 MB and probably never.
  Lowering it to 20k would halve that wait and start cutting the ordinary
  xlsx, which is the wrong trade for a demo. `sheetCut` is what tells the
  visitor the rest of the sheet is still there.
*/
const SHEET_CELL_BUDGET = 50000;

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;

const DROP_ACTIVE = ['border-primary', 'bg-primary-container/30'];

/* Touch devices have no drag and drop, so "drop a document here" describes an
   action the visitor cannot perform. */
const CAN_DROP = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const IDLE_TITLE = CAN_DROP ? 'Drop a document here' : 'Open a document';
const IDLE_HINT = 'ODT, ODS, ODP, DOCX, XLSX, PPTX, PDF and more — it stays on your device';

/*
  Loaded once per page, whatever mounts. The rejection is not cached, so a
  failed first attempt can be retried by opening something again.
*/
let odrPromise: Promise<any> | null = null;

function loadOdr() {
  if (!odrPromise) {
    odrPromise = import(/* @vite-ignore */ ODR_ENTRY)
      .then((m) => m.Odr.load())
      .catch((e) => {
        odrPromise = null;
        throw e;
      });
  }
  return odrPromise;
}

/*
  Core detects every format it ships from the bytes, with one exception: a
  format that carries no signature can only be asked for by name. Markdown is
  the one today - a `.md` is text, and reads as text, so nothing in the file
  says it wants the prose treatment. Keyed off the capability rather than a
  hard-coded `md` so it stays true as the engine gains and loses types, and
  narrowed to types that render: asking for one that cannot is how you turn a
  file that opened as plain text into one that does not open at all.
*/
let askable: Map<string, number> | null = null;

/* Every type the engine knows, by ordinal: what it can do, and what to call the
   bytes when one is handed back as a download. */
let types: Map<number, any> | null = null;

function typeInfo(odr: any, fileType: number | undefined) {
  if (fileType === undefined) return undefined;
  if (!types) {
    types = new Map();
    for (const t of odr.fileTypes()) types.set(t.fileType, t);
  }
  return types.get(fileType);
}

/* Only to look the type up, never to force it: `open` detects for itself, and
   what it settles on is its business. A file it cannot place at all is not our
   problem here either - `open` says so in a moment, with a better message. */
function detectedType(odr: any, bytes: Uint8Array): number | undefined {
  try {
    const found = odr.detect(bytes).fileTypes;
    return found[found.length - 1];
  } catch {
    return undefined;
  }
}

function askedType(odr: any, name: string): number | undefined {
  if (!askable) {
    askable = new Map();
    for (const t of odr.fileTypes()) {
      if (t.capabilities?.detectByContent || !t.capabilities?.translateHtml) continue;
      for (const ext of t.extensions ?? []) askable.set(ext.toLowerCase(), t.fileType);
    }
  }
  const dot = name.lastIndexOf('.');
  return dot < 0 ? undefined : askable.get(name.slice(dot + 1).toLowerCase());
}

export interface ViewerOptions {
  /** Owns the viewer: every control is looked up inside it, and its width is
   *  what the document is rendered for. */
  root: HTMLElement;
  /** Scrolled into view before a file opens, where the viewer is one section
   *  of a longer page. */
  scrollTarget?: Element | null;
  /**
   * Lay a text document out as the fixed-size pages it was written as, rather
   * than reflowing it to the frame. Worth the room it costs only where there
   * is room: the full-screen page shows pages on their canvas the way the
   * apps do, while the demo's 32rem box would spend most of it on margins.
   */
  textDocumentMargin?: boolean;
}

export function mountViewer({
  root,
  scrollTarget = null,
  textDocumentMargin = false,
}: ViewerOptions) {
  const find = <T extends HTMLElement>(name: string) =>
    root.querySelector<T>(`[data-viewer-${name}]`);
  const need = <T extends HTMLElement>(name: string) => {
    const el = find<T>(name);
    if (!el) throw new Error(`viewer: no [data-viewer-${name}] inside the root`);
    return el;
  };

  const panel = need('panel');
  const zone = need('zone');
  const spinner = need('spinner');
  const idleIcon = need('idle-icon');
  const status = need('status');
  const hint = need('hint');
  const actions = need('actions');
  const fileInput = need<HTMLInputElement>('file');
  const pickBtn = need<HTMLButtonElement>('pick');
  const sampleBtn = need<HTMLButtonElement>('sample');
  const result = need('result');
  const frameHost = need('frame-host');
  const filename = need('filename');
  const resetBtn = need<HTMLButtonElement>('reset');
  const zoomBar = need('zoom');
  const zoomOutBtn = need<HTMLButtonElement>('zoom-out');
  const zoomInBtn = need<HTMLButtonElement>('zoom-in');
  const zoomLabel = need<HTMLButtonElement>('zoom-level');
  const cutNote = need('cut');
  const alertNote = need('alert');
  const editBtn = need<HTMLButtonElement>('edit');
  const penIcon = need('edit-pen');
  const discIcon = need('edit-disc');
  /* Everything about the open document. Inside the hidden box on the demo, and
     the right-hand half of the page's only bar on `/tryit`, which has to empty
     itself when the document goes. */
  const openOnly = root.querySelectorAll<HTMLElement>('[data-viewer-open]');
  /* Only the demo has these: links out to the full-screen page, which is
     pointless on the full-screen page itself. */
  const expandLinks = root.querySelectorAll<HTMLElement>('[data-viewer-expand]');

  let currentFrame: HTMLIFrameElement | null = null;
  /** The width the document was rendered for, which it was fitted to. */
  let renderedFor = 0;
  /** The document's own width in css pixels where the renderer stated it;
      null where it has to be measured, because it may also reflow. */
  let statedPixels: number | null = null;
  /** Scale at which the document's full width fits the frame. */
  let fitZoom = 1;
  /** null means "follow the fit", any number is a deliberate choice. */
  let userZoom: number | null = null;

  let currentDoc: any = null;
  /** What to call the bytes a save hands back; the type the document opened as. */
  let currentMime = 'application/octet-stream';

  /** Whether the markup in the frame was rendered editable, which is what the
      `contenteditable` the frame mounts with has to be turned off again. */
  let renderedEditable = false;
  /** Whether this document can be edited *and* written back out. Both, because
      an edit nobody can save is a promise the demo cannot keep. Narrower than
      `renderedEditable`: the format's answer, then the document's. */
  let editable = false;
  /** Whether the pen has been pressed and not yet answered by the disc. */
  let editing = false;
  /** The diff being collected: the path the renderer wrote against the element
      that carries it, whose text is read when the disc is pressed. */
  const edited = new Map<string, HTMLElement>();
  let editWatcher: MutationObserver | null = null;
  /** Set once edits nobody saved have been reported, so the second attempt at
      whatever would drop them goes through. */
  let discardArmed = false;

  /** Swaps the page between the idle panel and a mounted document. */
  function showResult(on: boolean) {
    panel.hidden = on;
    result.hidden = !on;
    for (const el of openOnly) el.hidden = !on;
  }

  function setBusy(message: string) {
    spinner.hidden = false;
    idleIcon.hidden = true;
    actions.hidden = true;
    hint.hidden = true;
    status.textContent = message;
  }

  function setIdle(message: string, detail: string, isError = false) {
    spinner.hidden = true;
    idleIcon.hidden = false;
    actions.hidden = false;
    hint.hidden = false;
    status.textContent = message;
    hint.textContent = detail;
    status.classList.toggle('text-red-600', isError);
    status.classList.toggle('dark:text-red-400', isError);
  }

  /* Lets the busy message actually paint before `render()` blocks the thread. */
  const nextFrame = () =>
    new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      // A background tab fires no animation frames at all, so this is not a
      // belt-and-braces fallback: without it, a document opened just before
      // switching tabs strands the panel on "Opening…" until you come back.
      setTimeout(finish, 50);
    });

  function friendlyError(e: any, name: string) {
    switch (e?.name) {
      case 'UnsupportedFileType':
      case 'UnknownFileType':
        return [`${name} is not a format we can open`, 'Try an ODT, DOCX, XLSX, PPTX or PDF file.'];
      case 'FileEncrypted':
        return [
          `${name} is password-protected`,
          'The app opens encrypted documents; this demo does not ask for passwords.',
        ];
      case 'FileNotFound':
      case 'NoDocumentFile':
        return [`${name} could not be read`, 'The file looks empty or truncated.'];
      default:
        return [`${name} could not be opened`, e?.message ? String(e.message) : 'Unknown error.'];
    }
  }

  /*
    A sheet bigger than the budget is written short, and `sheetCut` is the only
    thing that says so - the `<table>` just ends. Saying which way it was cut
    beats a vague "some rows are missing", and the apps have no such budget, so
    the honest sentence is also the one that sells them.
  */
  function showCut(cut: any) {
    if (!cut) {
      cutNote.hidden = true;
      return;
    }
    const n = (value: number) => value.toLocaleString();
    const parts: string[] = [];
    if (cut.renderedRows < cut.contentRows) {
      parts.push(`the first ${n(cut.renderedRows)} of ${n(cut.contentRows)} rows`);
    }
    if (cut.renderedColumns < cut.contentColumns) {
      parts.push(`the first ${n(cut.renderedColumns)} of ${n(cut.contentColumns)} columns`);
    }
    if (!parts.length) {
      cutNote.hidden = true;
      return;
    }
    cutNote.textContent = `This preview keeps ${parts.join(' and ')} — the demo caps how much of a sheet it builds in one page. The apps open the whole thing.`;
    cutNote.hidden = false;
  }

  /* What went wrong with an edit, and the one warning before unsaved edits are
     thrown away. Everything else the viewer has to say it says on the idle
     panel, which is not on screen while a document is. */
  function showAlert(message: string | null) {
    alertNote.textContent = message ?? '';
    alertNote.hidden = !message;
  }

  function paintEdit() {
    editBtn.hidden = !editable;
    penIcon.hidden = editing;
    discIcon.hidden = !editing;
    const label = editing
      ? 'Save this document with your changes'
      : 'Edit the text in this document';
    editBtn.title = label;
    editBtn.setAttribute('aria-label', label);
    editBtn.setAttribute('aria-pressed', String(editing));
    /* Filled while it is a mode rather than a way into one: the frame below is
       taking typing, and the bar should say so without a word. */
    editBtn.classList.toggle('bg-primary', editing);
    editBtn.classList.toggle('text-on-primary', editing);
    editBtn.classList.toggle('border-transparent', editing);
    editBtn.classList.toggle('border-outline', !editing);
    editBtn.classList.toggle('hover:bg-surface', !editing);
  }

  /*
    Asked for editable output, the renderer writes `contenteditable="true"` onto
    every text run it will take an edit back for, so the markup is editable from
    the moment it mounts. That is not a mode anyone asked for - on a phone a tap
    meant to scroll would raise the keyboard over a document being read - so the
    attributes are turned off as the frame loads and the pen turns them on
    again.

    Toggling them beats re-rendering the document for a second config: the
    frame, the scroll position and the zoom all stay as they were, and the
    engine keeps the one open document the edit is applied to. The selector
    reads the value it is about to write over, so which runs the renderer chose
    is never something this side has to remember.
  */
  function setEditing(on: boolean) {
    const doc = frameDocument();
    if (!doc) return;
    editing = on;
    for (const el of doc.querySelectorAll(`[contenteditable="${on ? 'false' : 'true'}"]`)) {
      el.setAttribute('contenteditable', String(on));
    }
    // Lets go of the caret, which is what closes a phone's keyboard.
    if (!on) (doc.activeElement as HTMLElement | null)?.blur();
    paintEdit();
  }

  /*
    The frame runs no script of its own - the sandbox withholds `allow-scripts`,
    so the `odr.generateDiff()` the renderer ships never exists - and the diff is
    collected from here instead, exactly as that script would have: a changed
    piece of text is attributed to the nearest ancestor carrying
    `data-odr-path`, which is the address the engine reads it back at.

    `childList` counts as well as `characterData`: emptying a run removes its
    text node rather than shortening it, and that is as much an edit as any
    other. Nothing else mutates this document - no script runs in it, and what
    this side writes is attributes - so anything the observer sees is the
    visitor typing.
  */
  function watchEdits(doc: Document) {
    editWatcher = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const near =
          mutation.type === 'characterData'
            ? mutation.target.parentElement
            : (mutation.target as Element);
        const owner = near?.closest?.('[data-odr-path]') as HTMLElement | null;
        const path = owner?.getAttribute('data-odr-path');
        if (path) edited.set(path, owner!);
      }
    });
    editWatcher.observe(doc.body, { childList: true, subtree: true, characterData: true });

    /* `Enter` is refused the way the renderer's own frontend refuses it: the
       diff carries text, and a new line is structure. `Escape` is ours - with
       one button doing both jobs, it is the way out of edit mode that does not
       write a file. Both listeners are ours too, attached from this realm onto
       the frame's document, which is what `allow-same-origin` buys. */
    doc.addEventListener('keydown', (event) => {
      if (!editing) return;
      if (event.key === 'Escape') setEditing(false);
      if (event.key !== 'Enter') return;
      event.preventDefault();
      showAlert(
        'A new line is more than an edit can hand back — this changes the text a document already has.',
      );
    });
  }

  /*
    `isEditable`/`isSavable` are 6.12.0 bindings, and a renderer older than the
    page is not the only way to be without them: `/odr/` served the wrapper, the
    glue and the wasm under one path until 6.12.0, and those are three cache
    entries on their own clocks. A visitor can therefore hold a 6.11.0 wasm
    under a 6.12.0 wrapper, where the method is on the object and the module
    behind it has nothing to call - a `TypeError`, not an answer. Asking is the
    only way to find out, so the question is asked in a net.

    Either way the reply is the same, and it is not an error: this renderer does
    not edit. Everything else about it still works, so the document opens as it
    always did, without a pen.
  */
  function canEdit(doc: any) {
    try {
      return doc.isEditable?.() === true && doc.isSavable?.() === true;
    } catch {
      return false;
    }
  }

  /*
    A save is a download: there is no file behind the document, only the bytes
    that were dropped on the page. It is written under the name it was opened
    as, so a browser that still has the original puts this one beside it - the
    page cannot overwrite anything, and should not look like it did.

    `Uint8Array<ArrayBuffer>` rather than the plain alias: the engine copies the
    save out of the wasm heap into a buffer of its own, and a `Blob` takes no
    view that might be over a shared one.
  */
  function saveBytes(bytes: Uint8Array<ArrayBuffer>, name: string) {
    const url = URL.createObjectURL(new Blob([bytes], { type: currentMime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    // Revoked on the next task rather than this one: Safari reads the url after
    // the click returns.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /*
    The round trip the engine gained in 6.12.0: what the visitor typed goes back
    in as a diff, and the document - not the html it was rendered into - comes
    out as bytes. The edits stay in the frame either way, so a failure costs the
    visitor nothing but the file.
  */
  async function saveDocument() {
    if (!currentDoc) return;
    const name = filename.textContent || 'document';
    showAlert(null);
    editBtn.disabled = true;
    // The engine works synchronously, so the disabled button has to paint
    // before it starts.
    await nextFrame();

    try {
      if (edited.size) {
        const modifiedText: Record<string, string> = {};
        for (const [path, el] of edited) modifiedText[path] = el.innerText;
        currentDoc.edit(JSON.stringify({ modifiedText }));
      }
      saveBytes(currentDoc.save(), name);
      edited.clear();
      discardArmed = false;
      setEditing(false);
    } catch (e: any) {
      const detail = e?.message || e?.name || 'Unknown error.';
      showAlert(`${name} could not be saved — ${detail} Your changes are still here.`);
    } finally {
      editBtn.disabled = false;
    }
  }

  /*
    True where the caller should stand down: edits nobody saved are about to be
    dropped, and this is the first time it was asked for. Saying so once and
    letting the second attempt through beats a modal - the page never blocks on
    a dialog - and beats losing the edits silently.
  */
  function wouldDiscard() {
    if (!edited.size || discardArmed) return false;
    discardArmed = true;
    showAlert(
      'This document has changes that were never saved. The pen, then the disc, writes them out — or repeat what you just did to drop them.',
    );
    return true;
  }

  function teardown() {
    editWatcher?.disconnect();
    editWatcher = null;
    edited.clear();
    editing = false;
    editable = false;
    renderedEditable = false;
    discardArmed = false;
    paintEdit();
    showAlert(null);
    currentDoc?.close();
    currentDoc = null;
    frameHost.replaceChildren();
    currentFrame = null;
    zoomBar.hidden = true;
    cutNote.hidden = true;
  }

  /*
    A fresh iframe per document, appended to a container that is already
    visible. Reusing one long-lived frame looks tidier but races the layout:
    assigning content to a frame the browser has not laid out yet - because it
    was `display:none` a moment ago, or because wasm instantiation hogged the
    main thread through the intervening frames - loads the document and never
    paints it.

    The markup goes in through `srcdoc` rather than a `blob:` URL. Both are
    equivalent on Chrome and Firefox, but iOS Safari does not reliably render a
    `blob:` document inside an iframe - it shows an empty frame - and that is
    what a phone saw here. `srcdoc` also removes the object-URL lifecycle, so
    there is no revoke to get wrong.

    With `embedImages` on, the markup is self-contained and needs nothing
    fetched, so the frame reaches no origin at all. What `sandbox` grants it is
    the comment on the attribute below.
  */
  function mountFrame(html: string) {
    const frame = document.createElement('iframe');
    frame.title = 'Rendered document';
    // `allow-same-origin` without `allow-scripts`: reaching into the document
    // is what lets the zoom bar drive it, and no script can run in the frame at
    // all. That is strictly tighter than the reverse - the renderer's own inline
    // scripts were already refused by the page's `script-src`, so nothing is
    // lost but its zoom api, which the fit written into its css stands in for.
    frame.setAttribute('sandbox', 'allow-same-origin');
    // No background of our own: a rendered document paints its own canvas
    // (white for text flow, #525659 behind paginated pages), and forcing white
    // here is what shows through when a phone rubber-bands past the content.
    frame.className = 'h-full w-full border-0';
    frame.addEventListener('load', () => {
      currentFrame = frame;
      const doc = frame.contentDocument;
      if (doc) {
        defuseLinks(doc);
        matchCanvas(frame, doc);
        if (renderedEditable) {
          // Off, and the pen is what turns it on: the document mounts as
          // something to read. Off even where the pen never appears - markup
          // rendered editable is editable on sight, and a document nobody can
          // save is the last one to leave that way.
          setEditing(false);
          if (editable) watchEdits(doc);
        }
      }
      userZoom = null;
      fitZoom = 1;
      statedPixels = statedContent();
      // The document already opened at the fit written into its own css. This
      // only corrects the width that was guessed for it: the frame's scrollbar
      // comes off it, and the window may have been resized while it rendered.
      refit();
      applyZoom();
      zoomBar.hidden = false;
    });
    frameHost.replaceChildren(frame);
    frame.srcdoc = html;
  }

  /*
    The renderer paints its canvas on the document's `body` - white behind
    reflowing text, #525659 behind paginated pages. A body background normally
    propagates to the frame's own canvas, which is what a rubber-band scroll
    past either end of the document paints; it stops propagating as soon as the
    zoom bar writes `zoom` onto that same body, and the overscroll then showed
    the frame host's `bg-surface-container` through the transparent root - our
    colour, not the document's, and light behind a dark page canvas.

    So the frame is given the colour its document chose. On the element rather
    than on the document's root: what is being shown stays exactly as the
    renderer wrote it, and the fix goes away with the frame.
  */
  function matchCanvas(frame: HTMLIFrameElement, doc: Document) {
    const background = getComputedStyle(doc.body).backgroundColor;
    // A transparent body has nothing to say; leave the host colour showing.
    if (background && !/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(background)) {
      frame.style.background = background;
    }
  }

  /*
    6.11.0 dropped the blanket `<base target="_blank">`, so the renderer now
    tells three kinds of link apart: one that leaves the page carries
    `target="_blank"`, one back into what serves the page carries nothing and
    navigates in place, and one whose scheme is refused carries no `href` at
    all. That is right for a host that serves what it rendered - it is what
    makes an archive listing's entries work - and this demo is not one. There
    is a single `srcdoc` document and no route behind `a.txt`, so a click on an
    archive entry used to be swallowed by the missing `allow-popups` and now
    navigates the frame onto our own 404.

    So the relative ones are drawn as what they are here: named, not openable.
    External ones are left alone, still inert against the missing
    `allow-popups`; granting it so a dropped document could open tabs is not a
    trade this page should make.

    A fragment needs the opposite treatment. `srcdoc` resolves urls against
    *this* page, not the frame's own document, so a pdf's `#p2` points at
    `https://opendocument.app/#p2` and a click on the contents page replaces
    the document with our homepage. Stripping the href and scrolling from here
    is what the link meant: the frame runs no script, but this document is
    same-origin, so the handler runs in our realm and reaches into it - the
    same access the zoom bar already needs. A pdf's contents page therefore
    works here for the first time.
  */
  function defuseLinks(doc: Document) {
    for (const a of doc.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = a.getAttribute('href');
      if (!href) continue;

      if (href.startsWith('#')) {
        a.removeAttribute('href');
        a.style.cursor = 'pointer';
        a.addEventListener('click', (event) => {
          event.preventDefault();
          // `smooth` is dropped on the floor in this frame - the animation wants
          // a user activation in the frame's own realm, and the click arrives
          // in ours. A page anchor is a jump anyway.
          doc.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'instant', block: 'start' });
        });
        continue;
      }

      if (a.target === '_blank') continue;
      a.removeAttribute('href');
      a.title = 'This demo renders one document. Opening what it links to is what the apps do.';
      a.style.cursor = 'default';
    }
  }

  /* The frame is same-origin, so the document can be measured from here. */
  function frameDocument() {
    try {
      return currentFrame?.contentDocument ?? null;
    } catch {
      return null;
    }
  }

  /*
    Rendering for a width makes the renderer fit paged output to it and say so:
    `--odr-fit` is the factor it applied, and the document's own width follows
    from the width it was given. It is stated only where the document had to be
    scaled down - one that already fitted keeps its width to itself, and is
    measured instead.
  */
  function statedContent() {
    const root = frameDocument()?.documentElement;
    if (!root || !renderedFor) return null;
    const fit = parseFloat(getComputedStyle(root).getPropertyValue('--odr-fit'));
    return fit > 0 && fit < 1 ? renderedFor / fit : null;
  }

  function refit() {
    const doc = frameDocument();
    const available = doc?.documentElement.clientWidth ?? 0;
    if (!doc || !available) return;

    let content = statedPixels;
    if (content === null) {
      // Measured unscaled, or each pass would compound the previous one, and
      // each time: what was not fitted may be reflowing to the frame instead,
      // and then its width is a different number after every resize.
      showZoom(doc, 1);
      content = doc.body.scrollWidth;
      showZoom(doc, userZoom ?? fitZoom);
    }

    // Never enlarge: a document narrower than the frame belongs at its own size.
    fitZoom = content ? Math.min(1, available / content) : 1;
  }

  /** Writes a scale everywhere the document reads one. */
  function showZoom(doc: Document, zoom: number) {
    // The renderer wrote the fit onto `body{zoom}`; overriding that rule keeps
    // one scale on the document rather than stacking a second one above it.
    doc.body.style.zoom = String(zoom);
    // An image view is sized by `max-width` instead, and reads this to grow
    // past the frame along with the zoom. Inert in every other view.
    doc.documentElement.style.setProperty('--odr-zoom', String(zoom));
  }

  function applyZoom() {
    const doc = frameDocument();
    if (!doc) return;
    const zoom = userZoom ?? fitZoom;
    showZoom(doc, zoom);
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    zoomOutBtn.disabled = zoom <= ZOOM_MIN;
    zoomInBtn.disabled = zoom >= ZOOM_MAX;
  }

  const clampZoom = (zoom: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

  function nudgeZoom(factor: number) {
    userZoom = clampZoom((userZoom ?? fitZoom) * factor);
    applyZoom();
  }

  async function open(bytes: Uint8Array, name: string) {
    teardown();
    setBusy('Loading the renderer…');

    let odr;
    try {
      odr = await loadOdr();
    } catch (e: any) {
      const detail = [e?.name, e?.message].filter(Boolean).join(': ');
      setIdle(
        'The renderer could not be loaded',
        detail || 'Check your connection and try again.',
        true,
      );
      return;
    }

    setBusy(`Opening ${name}…`);
    await nextFrame();

    // The frame is not laid out yet - the panel is what is on screen - but it
    // will take the width of the box that panel sits in.
    renderedFor = Math.round(root.clientWidth);
    const asked = askedType(odr, name);
    /*
      Editable output carries `contenteditable` and a document path on every
      text run, which is markup nobody can use where the format cannot be
      written back out - a pdf, or an xlsx today. So the type is looked up
      first, and only a format that can both edit and save is rendered for it.
    */
    const info = typeInfo(odr, asked ?? detectedType(odr, bytes));
    const editableFormat = Boolean(info?.capabilities?.edit && info?.capabilities?.save);
    renderedEditable = editableFormat;
    currentMime = info?.mimeTypes?.[0] ?? 'application/octet-stream';

    const options: Record<string, unknown> = {
      editable: editableFormat,
      spreadsheetCellLimit: SHEET_CELL_BUDGET,
      textDocumentMargin,
    };
    if (renderedFor > 0) options.viewportWidth = renderedFor;
    if (asked !== undefined) options.fileType = asked;

    try {
      currentDoc = odr.open(bytes, options);
    } catch (e) {
      const [msg, detail] = friendlyError(e, name);
      setIdle(msg, detail, true);
      return;
    }

    if (currentDoc.isPasswordEncrypted()) {
      teardown();
      setIdle(
        `${name} is password-protected`,
        'The app opens encrypted documents; this demo does not ask for passwords.',
        true,
      );
      return;
    }

    // `capabilities()` answers for the format, `canEdit` for the document that
    // was actually opened - a text file the engine renders read-only answers no
    // there and yes here.
    editable = editableFormat && canEdit(currentDoc);
    paintEdit();

    // Instant on anything that is not a huge sheet, and on one that is (~2.2s
    // for the business register) it is work `render` does anyway and caches -
    // asking first costs ~10% of the total, and buys saying so before the wait
    // rather than after. Absent on an older renderer, which reads as no cut.
    showCut(currentDoc.listViews()[0]?.sheetCut);

    setBusy(`Rendering ${name}…`);
    await nextFrame();

    // View 0 is the document itself. A spreadsheet's further views are its
    // other sheets, and what counts as one is the renderer's business, not
    // something worth reporting in a chrome bar that would only ever be
    // approximately right.
    let html: string;
    try {
      html = currentDoc.render(0).html;
    } catch (e) {
      const [msg, detail] = friendlyError(e, name);
      teardown();
      setIdle(msg, detail, true);
      return;
    }

    filename.textContent = name;

    showResult(true);
    mountFrame(html);
  }

  /*
    `open` reports what it knows how to fail at - a format it will not open, a
    password, a render that gave up - and leaves anything else to throw. What
    used to catch that was whoever called it: nothing, on a dropped file, which
    left the panel on `Reading…` for good, and the sample's own handler, which
    called every failure a fetch that did not arrive. Both were wrong about a
    renderer that is not quite the one this page was built against, which is a
    state a visitor can be left in for a day.

    So there is one net, and it says the true thing: this document did not open,
    here is why, and the panel is back.
  */
  async function openSafely(bytes: Uint8Array, name: string) {
    try {
      await open(bytes, name);
    } catch (e: any) {
      teardown();
      showResult(false);
      setIdle(
        `${name} could not be opened`,
        e?.message ? String(e.message) : 'Something went wrong inside the viewer.',
        true,
      );
    }
  }

  async function openFile(file: File) {
    if (wouldDiscard()) return;
    scrollTarget?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    showResult(false);
    setBusy(`Reading ${file.name}…`);
    await openSafely(new Uint8Array(await file.arrayBuffer()), file.name);
  }

  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void openFile(file);
    fileInput.value = '';
  });

  sampleBtn.addEventListener('click', async () => {
    if (wouldDiscard()) return;
    setBusy('Fetching the sample…');

    // Only the fetch is inside this: opening the bytes can fail for reasons
    // that have nothing to do with the network, and saying "could not be
    // fetched" about one of those sends the visitor to look at their wifi.
    let bytes: Uint8Array;
    try {
      const response = await fetch('/sample.odt');
      if (!response.ok) throw new Error(String(response.status));
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      setIdle('The sample could not be fetched', 'Check your connection and try again.', true);
      return;
    }

    await openSafely(bytes, 'sample.odt');
  });

  resetBtn.addEventListener('click', () => {
    if (wouldDiscard()) return;
    // `teardown` drops the frame along with the document.
    teardown();
    showResult(false);
    setIdle(IDLE_TITLE, IDLE_HINT);
  });

  /* The full-screen page opens empty: a navigation drops the wasm heap the
     document lives in, so there is nothing to hand over. Saying so beats a
     visitor watching their document disappear. */
  for (const link of expandLinks) {
    link.title = 'Open the full-screen viewer — it starts empty, so pick the file again there.';
  }

  /* Dropping anywhere on the page works; the zone is what lights up. A counter,
     because dragleave also fires when the pointer crosses a child element. */
  let dragDepth = 0;

  function highlight(on: boolean) {
    zone.classList.toggle('border-dashed', !on);
    for (const c of DROP_ACTIVE) zone.classList.toggle(c, on);
  }

  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    if (++dragDepth === 1) highlight(true);
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      highlight(false);
    }
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepth = 0;
    highlight(false);
    const file = e.dataTransfer.files[0];
    if (file) void openFile(file);
  });

  if (!CAN_DROP) {
    status.textContent = IDLE_TITLE;
  }

  /* One button, two jobs: the pen opens the document to typing, the disc it
     turns into hands the typing back to the engine and writes the file. */
  editBtn.addEventListener('click', () => {
    if (editing) {
      void saveDocument();
      return;
    }
    showAlert(null);
    setEditing(true);
  });

  zoomInBtn.addEventListener('click', () => nudgeZoom(ZOOM_STEP));
  zoomOutBtn.addEventListener('click', () => nudgeZoom(1 / ZOOM_STEP));
  zoomLabel.addEventListener('click', () => {
    userZoom = null;
    refit();
    applyZoom();
  });

  // A rotated phone changes the frame width, so the fit has to be recomputed.
  let resizeTimer: number | undefined;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      refit();
      if (userZoom === null) applyZoom();
    }, 150);
  });

  window.addEventListener('pagehide', teardown);
}
