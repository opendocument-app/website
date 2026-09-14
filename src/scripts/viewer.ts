/*
  The viewer, shared by the demo section on the homepage and the full-screen
  page at `/tryit`. Both mount this against their own markup: every control is
  found by a `data-viewer-*` attribute inside the root element, and the ones a
  layout leaves out are simply absent rather than fatal.

  One viewer per page. The drop target is the window - dropping anywhere works,
  and the zone is only what lights up - so a second mount on one page would
  open the same file twice.

  The document lives in an iframe that runs the renderer's own scripts and
  nothing of ours but `frame-bridge.js`, which is written into the markup
  before it mounts. The frame is sandboxed without `allow-same-origin`, so
  this side never touches its dom: every command goes over `postMessage`, and
  every answer comes back the same way. The engine - the wasm - stays here,
  holding the one open document that an edit is applied to and a save is read
  from.
*/
import bridgeSource from './frame-bridge.js?raw';

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

/* The width of a line the Draw tool makes. The colour of each tool is on its
   own colour input, in `#rrggbb`; the annotator takes it as 0..1 rgb. */
const INK_WIDTH = 2;

/*
  What a refused edit says here. The page reports a reason and an English
  message meant for a console; the wording a visitor sees is the host's, and
  this is the host.
*/
const REFUSALS: Record<string, string> = {
  newLine: 'A line break inside a paragraph is more than an edit can hand back.',
  formula: 'That cell holds a formula, which stays as it is — type into a plain cell instead.',
  formulaInput: 'Typing a formula is not supported yet; a number or some text is.',
  rich: 'That cell holds more than plain text, so it stays as it is.',
  shapes: 'That cell holds a drawing, so it stays as it is.',
  readOnly: 'This document cannot be edited.',
  unsupportedEdit: 'That kind of edit is not supported here.',
  range: 'An edit cannot reach over a picture or a table.',
  unnameableEdit: 'That edit landed where the engine cannot name it, so it was not taken.',
  outOfScope: 'That edit reaches past what this page offers.',
};

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

/* `#rrggbb` to the 0..1 rgb triple the annotator takes. */
function rgbOf(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/*
  The bridge goes in just before `</body>`: after the renderer's own scripts,
  which are written at the end of the body, so everything it wires exists by
  the time it runs. A view without a body - there is none today - gets it at
  the end, where it still runs.
*/
function withBridge(html: string) {
  const script = `<script>${bridgeSource}</script>`;
  const at = html.lastIndexOf('</body>');
  return at < 0 ? html + script : html.slice(0, at) + script + html.slice(at);
}

export interface ViewerOptions {
  /** Owns the viewer: every control is looked up inside it. */
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
  const all = <T extends HTMLElement>(name: string) =>
    root.querySelectorAll<T>(`[data-viewer-${name}]`);

  const panel = need('panel');
  const zone = need('zone');
  const spinner = need('spinner');
  const idleIcon = need('idle-icon');
  const status = need('status');
  const hint = need('hint');
  const actions = need('actions');
  const fileInput = need<HTMLInputElement>('file');
  const pickBtn = need<HTMLButtonElement>('pick');
  const sampleBtns = all<HTMLButtonElement>('sample');
  const result = need('result');
  const frameHost = need('frame-host');
  const filename = need('filename');
  const resetBtn = need<HTMLButtonElement>('reset');
  const zoomBar = need('zoom');
  const zoomOutBtn = need<HTMLButtonElement>('zoom-out');
  const zoomInBtn = need<HTMLButtonElement>('zoom-in');
  const zoomLabel = need<HTMLButtonElement>('zoom-level');
  const cutNote = need('cut');
  const staleNote = need('stale');
  const alertNote = need('alert');
  const penBtn = need<HTMLButtonElement>('pen');
  const penEdit = need('pen-edit');
  const penMark = need('pen-mark');
  const saveBtn = need<HTMLButtonElement>('save');
  const tools = need('tools');
  const toolsHint = need('tools-hint');
  const formatGroup = need('format');
  const styleBtns = all<HTMLButtonElement>('style');
  const highlightBtn = need<HTMLButtonElement>('highlight');
  const colorInput = need<HTMLInputElement>('color');
  const colorBar = need('color-bar');
  const highlightColorInput = need<HTMLInputElement>('highlight-color');
  const highlightBar = need('highlight-bar');
  const sizeSelect = need<HTMLSelectElement>('size');
  const markGroup = need('mark');
  const toolBtns = all<HTMLButtonElement>('tool');
  const toolColors = [...all<HTMLInputElement>('tool-color')];
  const toolBars = [...all('tool-bar')];
  const undoBtn = need<HTMLButtonElement>('undo');
  const redoBtn = need<HTMLButtonElement>('redo');
  /* Everything about the open document. Inside the hidden box on the demo, and
     the right-hand half of the page's only bar on `/tryit`, which has to empty
     itself when the document goes. */
  const openOnly = all('open');
  /* Only the demo has these: links out to the full-screen page, which is
     pointless on the full-screen page itself. */
  const expandLinks = all('expand');

  let currentFrame: HTMLIFrameElement | null = null;
  let currentDoc: any = null;
  /** What to call the bytes a save hands back; the type the document opened as. */
  let currentMime = 'application/octet-stream';
  let currentName = 'document';

  /** What the open document takes, settled once the frame reports in. */
  let canEdit = false;
  let canFormat = false;
  let canMark = false;
  /** Whether the pen has been pressed: edit mode, or the marking tools shown. */
  let modeOn = false;
  /** The tool the frame reports as armed, which is what the buttons show. */
  let armedTool: string | null = null;
  /** What the page's log holds, as it reports it. */
  let editDirty = false;
  let canUndo = false;
  let canRedo = false;
  /** Marks pending in a pdf, and how many of them the last save carried. */
  let marks = 0;
  let savedMarks = 0;
  /** Set once edits nobody saved have been reported, so the second attempt at
      whatever would drop them goes through. */
  let discardArmed = false;
  /** The zoom the frame reports, 1 being actual size. */
  let currentZoom = 1;

  /** Answers the frame owes: a request id to what resolves it. */
  const asks = new Map<number, (payload: string | null) => void>();
  let nextAsk = 1;

  const dirty = () => editDirty || marks !== savedMarks;

  /* One way in, one way out. `*` because the frame has no origin to name. */
  function send(message: Record<string, unknown>) {
    currentFrame?.contentWindow?.postMessage({ ...message, odrViewer: true }, '*');
  }

  /* A question with an answer: the frame replies with the same id. A frame
     that never answers - torn down meanwhile - fails the ask rather than
     hanging the button that waits on it. */
  function ask(type: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const id = nextAsk++;
      const timer = window.setTimeout(() => {
        asks.delete(id);
        reject(new Error('The document did not answer.'));
      }, 5000);
      asks.set(id, (payload) => {
        window.clearTimeout(timer);
        resolve(payload);
      });
      send({ type, id });
    });
  }

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

  /* What went wrong with an edit, and the one warning before unsaved changes
     are thrown away. Everything else the viewer has to say it says on the idle
     panel, which is not on screen while a document is. A refusal is news for
     a moment and then in the way, so it clears itself. */
  const ALERT_TONES = {
    error: ['bg-red-50', 'text-red-700', 'dark:bg-red-950/40', 'dark:text-red-300'],
    warn: ['bg-amber-50', 'text-amber-800', 'dark:bg-amber-950/40', 'dark:text-amber-200'],
  };
  let alertTimer: number | undefined;
  function showAlert(message: string | null, tone: keyof typeof ALERT_TONES = 'error') {
    window.clearTimeout(alertTimer);
    alertNote.textContent = message ?? '';
    alertNote.hidden = !message;
    for (const t of Object.values(ALERT_TONES)) alertNote.classList.remove(...t);
    if (message) alertNote.classList.add(...ALERT_TONES[tone]);
    if (message && tone === 'warn') {
      alertTimer = window.setTimeout(() => showAlert(null), 6000);
    }
  }

  /*
    Writing a cell takes the cached result of every formula that reads it away
    - the engine has no evaluator yet, and a number it knows to be wrong is
    worse than none. The page marks those cells; this says what the mark means
    and that the formulas are still there for the app that opens the file.
  */
  function showStale(count: number) {
    if (!count) {
      staleNote.hidden = true;
      return;
    }
    staleNote.textContent = `${count} formula ${count === 1 ? 'cell shows a result' : 'cells show results'} your edit made out of date. The saved file keeps the formulas, and a spreadsheet app recomputes them when it opens the file.`;
    staleNote.hidden = false;
  }

  /* The bar and the strip, from the state above. */
  function paintChrome() {
    const changeable = canEdit || canMark;
    penBtn.hidden = !changeable;
    saveBtn.hidden = !changeable;
    penEdit.hidden = canMark;
    penMark.hidden = !canMark;
    const penLabel = canMark
      ? modeOn
        ? 'Put the marker down'
        : 'Mark up this PDF'
      : modeOn
        ? 'Stop editing'
        : 'Edit this document';
    penBtn.title = penLabel;
    penBtn.setAttribute('aria-label', penLabel);
    penBtn.setAttribute('aria-pressed', String(modeOn));
    /* Filled while it is a mode rather than a way into one: the frame below is
       taking typing or marks, and the bar should say so without a word. */
    penBtn.classList.toggle('bg-primary', modeOn);
    penBtn.classList.toggle('text-on-primary', modeOn);
    penBtn.classList.toggle('border-transparent', modeOn);
    penBtn.classList.toggle('border-outline', !modeOn);
    penBtn.classList.toggle('hover:bg-surface', !modeOn);

    saveBtn.disabled = !dirty();
    const saveLabel = canMark
      ? 'Save this PDF with your marks'
      : 'Save this document with your changes';
    saveBtn.title = saveLabel;
    saveBtn.setAttribute('aria-label', saveLabel);

    tools.hidden = !modeOn;
    formatGroup.hidden = !canFormat;
    markGroup.hidden = !canMark;
    undoBtn.disabled = canMark ? marks === 0 : !canUndo;
    redoBtn.hidden = canMark;
    redoBtn.disabled = !canRedo;
    for (const b of toolBtns) {
      b.setAttribute('aria-pressed', String(b.dataset.viewerTool === armedTool));
    }
    toolsHint.textContent = canMark
      ? 'Select text, then a tool, to mark it once. A pressed tool marks every selection; Draw draws on the page.'
      : canFormat
        ? 'Type into the document. Select some text for the buttons, or Ctrl+B, I and U.'
        : 'Double-click a cell, or just start typing into it. Enter keeps the value, Escape drops it.';
  }

  /* The buttons show what the selection has, as the page reports it: a key
     per property the selected runs agree on, and none where they differ. */
  function paintSelection(style: Record<string, unknown>) {
    for (const b of styleBtns) {
      b.setAttribute('aria-pressed', String(style[b.dataset.viewerStyle ?? ''] === true));
    }
    highlightBtn.setAttribute('aria-pressed', String(typeof style.highlight === 'string'));
    if (typeof style.color === 'string' && /^#[0-9a-f]{6}$/i.test(style.color)) {
      colorInput.value = style.color;
    }
    if (typeof style.highlight === 'string' && /^#[0-9a-f]{6}$/i.test(style.highlight)) {
      highlightColorInput.value = style.highlight;
    }
    paintColor();
    paintHighlight();
    const size = typeof style.size === 'string' ? style.size : '';
    sizeSelect.value = [...sizeSelect.options].some((o) => o.value === size) ? size : '';
  }

  /*
    The pen. For a document it asks the page to turn its editing mode on, and
    the page's own answer - `editMode` below - is what flips the button. For a
    pdf it only opens the strip of marking tools, and closing the strip
    disarms whatever tool is armed. The annotator has no mode to report, so the
    button flips here.
  */
  function setMode(on: boolean) {
    showAlert(null);
    if (canMark) {
      modeOn = on;
      if (!on) sendTool(null, false);
      paintChrome();
    } else if (canEdit) {
      send({ type: 'edit', on });
    }
    if (on) currentFrame?.focus();
  }

  /** The colour a marking tool uses, from its own input. */
  function colorOf(tool: string): string {
    return toolColors.find((i) => i.dataset.viewerToolColor === tool)?.value ?? '#000000';
  }

  function sendTool(tool: string | null, toggle: boolean, recolor = false) {
    const color = tool ? rgbOf(colorOf(tool)) : null;
    send({ type: 'tool', tool, color, width: INK_WIDTH, toggle, recolor });
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
    The round trip. What the visitor did in the frame comes out of it as the
    engine's own envelope - the operation log for an edit, the marks for a pdf
    - goes into the engine here, and the file the engine writes goes out as a
    download. The frame keeps what it holds either way, so a failure costs the
    visitor nothing but the file.

    Both envelopes are json strings and stay strings: the package's readme says
    `edit` takes the object, but the binding underneath is a `std::string` and
    an object throws `BindingError` there - in 7.0.0 as in 6.12.0.
  */
  async function saveDocument() {
    if (!currentDoc) return;
    showAlert(null);
    saveBtn.disabled = true;
    // The engine works synchronously, so the disabled button has to paint
    // before it starts.
    await nextFrame();

    try {
      if (canMark) {
        const payload = await ask('getAnnotations');
        if (!payload) throw new Error('The marks could not be read back.');
        saveBytes(currentDoc.annotate(payload), currentName);
        savedMarks = marks;
      } else {
        const payload = await ask('getOperations');
        if (!payload) throw new Error('The edits could not be read back.');
        if (JSON.parse(payload).ops.length) currentDoc.edit(payload);
        saveBytes(currentDoc.save(), currentName);
        // The page and the file agree now: its log resets, undo starts over.
        send({ type: 'committed' });
      }
      discardArmed = false;
    } catch (e: any) {
      const detail = e?.message || e?.name || 'Unknown error.';
      showAlert(`${currentName} could not be saved — ${detail} Your changes are still here.`);
    } finally {
      paintChrome();
    }
  }

  /*
    True where the caller should stand down: changes nobody saved are about to
    be dropped, and this is the first time it was asked for. Saying so once and
    letting the second attempt through beats a modal - the page never blocks on
    a dialog - and beats losing the changes silently.
  */
  function wouldDiscard() {
    if (!dirty() || discardArmed) return false;
    discardArmed = true;
    showAlert(
      'This document has changes that were never saved. The disc writes them out — or repeat what you just did to drop them.',
    );
    return true;
  }

  function teardown() {
    for (const [, resolve] of asks) resolve(null);
    asks.clear();
    modeOn = false;
    canEdit = false;
    canFormat = false;
    canMark = false;
    editDirty = false;
    canUndo = false;
    canRedo = false;
    marks = 0;
    savedMarks = 0;
    armedTool = null;
    discardArmed = false;
    paintChrome();
    showAlert(null);
    showStale(0);
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
    // `allow-scripts` without `allow-same-origin`: the renderer's own scripts
    // run - they are the editor, the cell overlay, the annotator and the zoom
    // - and the document gets an opaque origin, so a `javascript:` link in it
    // runs there and nowhere else. This side cannot reach in either, which is
    // what the bridge is for. Granting both would be no sandbox at all.
    frame.setAttribute('sandbox', 'allow-scripts');
    // No background of our own: a rendered document paints its own canvas
    // (white for text flow, #525659 behind paginated pages), and forcing white
    // here is what shows through when a phone rubber-bands past the content.
    frame.className = 'h-full w-full border-0';
    frameHost.replaceChildren(frame);
    currentFrame = frame;
    frame.srcdoc = withBridge(html);
  }

  /*
    The frame's side of the conversation. Only the current frame is listened
    to: a message from a frame that was torn down, or from anything else on
    the page, is not ours.
  */
  window.addEventListener('message', (event) => {
    if (!currentFrame || event.source !== currentFrame.contentWindow) return;
    const m = event.data;
    if (!m || m.odrViewer !== true) return;
    switch (m.type) {
      case 'ready':
        /*
          The renderer paints its canvas on the document's `body` - white
          behind reflowing text, #525659 behind paginated pages - and that is
          what a rubber-band scroll past either end should paint, not the
          host's own colour behind a transparent root. The frame is given the
          colour its document chose. On the element rather than in the
          document, so what is shown stays exactly as the renderer wrote it.
        */
        if (m.background && !/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(m.background)) {
          currentFrame.style.background = m.background;
        }
        // The engine answered for the format and the document; the page
        // answers for the markup it was actually given.
        canEdit = canEdit && m.editable === true;
        canFormat = canEdit && !m.sheet;
        canMark = canMark && m.annotatable === true;
        paintZoom(m.zoom);
        zoomBar.hidden = false;
        paintChrome();
        break;
      case 'zoom':
        paintZoom(m.zoom);
        break;
      case 'editMode':
        modeOn = m.event?.editing === true;
        if (m.event?.reason) showAlert(REFUSALS[m.event.reason] ?? m.event.message, 'warn');
        paintChrome();
        break;
      case 'editChange':
        editDirty = m.event?.dirty === true;
        canUndo = m.event?.canUndo === true;
        canRedo = m.event?.canRedo === true;
        paintChrome();
        break;
      case 'editRefused':
        showAlert(REFUSALS[m.event?.reason] ?? m.event?.message ?? 'That edit was not taken.', 'warn');
        break;
      case 'cellsStale':
        showStale(Array.isArray(m.event?.cells) ? m.event.cells.length : 0);
        break;
      case 'selection':
        paintSelection(m.style ?? {});
        break;
      case 'marks':
        marks = Number(m.count) || 0;
        paintChrome();
        break;
      case 'tool':
        armedTool = typeof m.armed === 'string' ? m.armed : null;
        paintChrome();
        break;
      case 'escape':
        if (modeOn) setMode(false);
        break;
      case 'error':
        console.warn(`renderer error ${m.code}: ${m.message}`);
        break;
      case 'operations':
      case 'annotations': {
        const resolve = asks.get(m.id);
        asks.delete(m.id);
        resolve?.(typeof m.payload === 'string' ? m.payload : null);
        break;
      }
    }
  });

  /* The zoom is the renderer's: it fits the document to the frame, refits on
     a rotation, and reports every change. These only ask, and show. */
  function paintZoom(zoom: number) {
    currentZoom = zoom;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    zoomOutBtn.disabled = zoom <= ZOOM_MIN;
    zoomInBtn.disabled = zoom >= ZOOM_MAX;
  }

  function nudgeZoom(factor: number) {
    const value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, currentZoom * factor));
    send({ type: 'setZoom', value });
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

    const asked = askedType(odr, name);
    /*
      Editable output carries an address on every run and the editor's script,
      which is markup nobody can use where the format cannot be written back
      out. So the type is looked up first, and only a format that can both
      edit and save is rendered for it. The mode still starts off: the pen is
      what turns it on, and only in the frame, so a phone does not raise its
      keyboard over a document being read.
    */
    const info = typeInfo(odr, asked ?? detectedType(odr, bytes));
    const editableFormat = Boolean(info?.capabilities?.edit && info?.capabilities?.save);
    const markableFormat = Boolean(info?.capabilities?.annotate);
    currentMime = info?.mimeTypes?.[0] ?? 'application/octet-stream';
    currentName = name;

    // No width: the renderer's viewport script measures the frame it lands in
    // and refits on a resize, which a width guessed here could not follow.
    const options: Record<string, unknown> = {
      editable: editableFormat,
      spreadsheetCellLimit: SHEET_CELL_BUDGET,
      textDocumentMargin,
    };
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

    /*
      `capabilities()` answers for the format, the document for itself: a pdf
      whose cross-reference table had to be rebuilt takes no marks, and a
      plain text file - which the engine can edit and save - is not a document
      to this package, so the questions throw rather than answer. Asking in a
      net turns both into the same honest thing: no pen.
    */
    canEdit = editableFormat && answers(() => currentDoc.isEditable() && currentDoc.isSavable());
    canMark = markableFormat && answers(() => currentDoc.isAnnotatable());
    paintChrome();

    // Instant on anything that is not a huge sheet, and on one that is (~2.2s
    // for the business register) it is work `render` does anyway and caches -
    // asking first costs ~10% of the total, and buys saying so before the wait
    // rather than after.
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

  function answers(question: () => boolean) {
    try {
      return question() === true;
    } catch {
      return false;
    }
  }

  /*
    `open` reports what it knows how to fail at - a format it will not open, a
    password, a render that gave up - and leaves anything else to throw. There
    is one net, and it says the true thing: this document did not open, here
    is why, and the panel is back.
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

  /* One sample per format, each chip naming its file. */
  for (const btn of sampleBtns) {
    btn.addEventListener('click', async () => {
      if (wouldDiscard()) return;
      const path = btn.dataset.viewerSample ?? '';
      const name = path.slice(path.lastIndexOf('/') + 1) || 'sample';
      setBusy(`Fetching ${name}…`);

      // Only the fetch is inside this: opening the bytes can fail for reasons
      // that have nothing to do with the network, and saying "could not be
      // fetched" about one of those sends the visitor to look at their wifi.
      let bytes: Uint8Array;
      try {
        const response = await fetch(path);
        if (!response.ok) throw new Error(String(response.status));
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch {
        setIdle('The sample could not be fetched', 'Check your connection and try again.', true);
        return;
      }

      await openSafely(bytes, name);
    });
  }

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

  penBtn.addEventListener('click', () => setMode(!modeOn));
  saveBtn.addEventListener('click', () => void saveDocument());

  /*
    A button in the strip must not take the focus from the frame: the
    selection it acts on lives there, and a click that moved the focus would
    still find it, but the typing after it would land nowhere. Cancelling the
    mousedown keeps the caret where it is - on touch too, through the mouse
    events a tap synthesises.
  */
  const keepFocus = (e: Event) => e.preventDefault();
  for (const b of [...styleBtns, highlightBtn, ...toolBtns, undoBtn, redoBtn]) {
    b.addEventListener('mousedown', keepFocus);
  }
  for (const b of styleBtns) {
    b.addEventListener('click', () => send({ type: 'toggle', property: b.dataset.viewerStyle }));
  }
  highlightBtn.addEventListener('click', () => {
    const on = highlightBtn.getAttribute('aria-pressed') === 'true';
    send({ type: 'format', style: { highlight: on ? null : highlightColorInput.value } });
  });
  sizeSelect.addEventListener('change', () => {
    if (sizeSelect.value) send({ type: 'format', style: { size: sizeSelect.value } });
  });

  /*
    A tool button: with text selected in the frame it marks that selection
    once and leaves no tool armed; pressed while armed it disarms; otherwise it
    arms. The frame decides, because only it can see the selection, and it
    reports back what is armed.
  */
  for (const b of toolBtns) {
    b.addEventListener('click', () => sendTool(b.dataset.viewerTool ?? 'highlight', true));
  }

  /*
    A colour control: a picker laid over a bar that shows its colour. `apply`
    runs on `change`, not `input`, because a picker fires `input` for every
    pixel the pointer crosses, and each one would be an edit of its own.

    A second press closes the picker. The browser opens the picker on every
    click, also while it is open, so that click is cancelled, and a change of
    the input's type closes the picker, because the picker belongs to the
    colour type. The close fires `change` itself, because a browser may not,
    and a colour that was applied since the picker opened is not applied
    again. A blur means that the picker closed some other way.
  */
  function colourControl(input: HTMLInputElement, bar: HTMLElement | undefined, apply: () => void) {
    let open = false;
    let applied = input.value;
    const paint = () => {
      if (bar) bar.style.background = input.value;
    };
    paint();
    input.addEventListener('input', paint);
    input.addEventListener('change', () => {
      if (input.value === applied) return;
      applied = input.value;
      apply();
    });
    input.addEventListener('click', (e) => {
      if (!open) {
        open = true;
        applied = input.value;
        return;
      }
      e.preventDefault();
      open = false;
      input.type = 'text';
      input.type = 'color';
      input.blur();
      input.dispatchEvent(new Event('change'));
    });
    input.addEventListener('blur', () => {
      open = false;
    });
    return paint;
  }

  const paintColor = colourControl(colorInput, colorBar, () =>
    send({ type: 'format', style: { color: colorInput.value } }),
  );
  // A highlight colour goes where a text colour goes: onto the selection, or
  // onto the word at the caret.
  const paintHighlight = colourControl(highlightColorInput, highlightBar, () =>
    send({ type: 'format', style: { highlight: highlightColorInput.value } }),
  );
  // A tool's colour marks a selection once, or recolours the tool if it is
  // armed; the frame decides which.
  for (const input of toolColors) {
    const tool = input.dataset.viewerToolColor ?? '';
    const bar = toolBars.find((b) => b.dataset.viewerToolBar === tool);
    colourControl(input, bar, () => sendTool(tool, false, true));
  }
  undoBtn.addEventListener('click', () => send({ type: 'undo' }));
  redoBtn.addEventListener('click', () => send({ type: 'redo' }));

  zoomInBtn.addEventListener('click', () => nudgeZoom(ZOOM_STEP));
  zoomOutBtn.addEventListener('click', () => nudgeZoom(1 / ZOOM_STEP));
  zoomLabel.addEventListener('click', () => send({ type: 'resetZoom' }));

  window.addEventListener('pagehide', teardown);
}
