/*
  The viewer, shared by the demo section on the homepage, the full-screen
  page at `/tryit` and the web app at `/web`. Each mounts this against their own markup: every control is
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
  The renderer is ~2.2 MB gzipped, so it is never part of the page load: the
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
  formula: 'That cell holds a formula that is shared with other cells, so it stays as it is.',
  formulaInput: 'This page cannot take a formula; a number or some text it can.',
  formulaInvalid: 'That formula does not parse, so the cell keeps what it had.',
  array: 'That cell is part of an array formula, so it stays as it is, and rows and columns cannot be added or removed through it.',
  rich: 'That cell holds more than plain text, so it stays as it is.',
  shapes: 'That cell holds a drawing, so it stays as it is.',
  readOnly: 'This document cannot be edited.',
  unsupportedEdit: 'That kind of edit is not supported here.',
  range: 'An edit cannot reach over a picture or a table.',
  unnameableEdit: 'That edit landed where the engine cannot name it, so it was not taken.',
  outOfScope: 'That edit reaches past what this page offers.',
  sheetCut: 'That part of the sheet is past what this preview builds, so it cannot be edited here.',
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

/* The type a blank document named `Untitled.<ext>` is made as, where the
   engine can make one. */
function blankType(odr: any, name: string): number | undefined {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return odr.fileTypes().find((t: any) => t.capabilities?.create && t.extensions?.includes(ext))?.fileType;
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
  The function that `hostMessageHandler` names. The renderer's `host-bridge.js`
  calls it with every `odr.on*` callback of the page as one JSON
  `{type, detail}` string, and it posts that string to this page unchanged.
*/
const HOST_HANDLER = 'odrHost.post';
const HOST_SCRIPT =
  "<script>window.odrHost={post:function(m){parent.postMessage({odrViewer:true,type:'page',message:m},'*')}};</script>";

/*
  The host function goes first in the head, because `host-bridge.js` looks
  for it when it runs, and a callback can come before the body is complete.
  The bridge goes in just before `</body>`: after the renderer's own scripts,
  which are written at the end of the body, so everything it wires exists by
  the time it runs. A view without a head or a body - there is none today -
  gets each script at the start or the end, where it still runs.
*/
function withBridge(html: string) {
  const head = html.indexOf('<head>');
  const at = head < 0 ? 0 : head + '<head>'.length;
  html = html.slice(0, at) + HOST_SCRIPT + html.slice(at);
  const script = `<script>${bridgeSource}</script>`;
  const end = html.lastIndexOf('</body>');
  return end < 0 ? html + script : html.slice(0, end) + script + html.slice(end);
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
  /**
   * Write a save back to the file it came from, where the browser gives the
   * page a handle to that file. Only the installable app at `/web` sets this.
   * The demo and `/tryit` keep the download, because a page in a tab must not
   * look like it changes files on the disk.
   */
  saveInPlace?: boolean;
  /** The words of the idle panel, where a page wants its own. */
  idleTitle?: string;
  idleHint?: string;
  /**
   * Told when a document shows, and with `null` when it goes. `handle` is the
   * file that a save writes to, if there is one. `/web` uses this for the
   * title of the window and for the list of recent files.
   */
  onDocument?: (doc: { name: string; handle: FileSystemFileHandle | null } | null) => void;
}

/** What `mountViewer` gives back to the page that mounts it. */
export interface Viewer {
  /** Opens a file, as a drop or a pick does. A `handle` lets a save write back
   *  to the file, where `saveInPlace` is on. */
  openFile(file: File, handle?: FileSystemFileHandle | null): Promise<void>;
}

export function mountViewer({
  root,
  scrollTarget = null,
  textDocumentMargin = false,
  saveInPlace = false,
  idleTitle = IDLE_TITLE,
  idleHint = IDLE_HINT,
  onDocument,
}: ViewerOptions): Viewer {
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
  const passwordForm = need<HTMLFormElement>('password');
  const passwordInput = need<HTMLInputElement>('password-input');
  const passwordCancelBtn = need<HTMLButtonElement>('password-cancel');
  const uploadIcon = need('icon-upload');
  const lockIcon = need('icon-lock');
  const fileInput = need<HTMLInputElement>('file');
  const pickBtn = need<HTMLButtonElement>('pick');
  const sampleBtns = all<HTMLButtonElement>('sample');
  const blankBtns = all<HTMLButtonElement>('blank');
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
  const highlightPick = need('highlight-pick');
  const fillBtn = need<HTMLButtonElement>('fill');
  const fillPick = need('fill-pick');
  const fillColorInput = need<HTMLInputElement>('fill-color');
  const fillBar = need('fill-bar');
  const alignBtns = all<HTMLButtonElement>('align');
  const structureGroup = need('structure');
  const structureBtns = all<HTMLButtonElement>('structure-call');
  const sizeSelect = need<HTMLSelectElement>('size');
  const markGroup = need('mark');
  const toolBtns = all<HTMLButtonElement>('tool');
  const toolColors = [...all<HTMLInputElement>('tool-color')];
  const toolBars = [...all('tool-bar')];
  const undoBtn = need<HTMLButtonElement>('undo');
  const redoBtn = need<HTMLButtonElement>('redo');
  const findOpenBtn = need<HTMLButtonElement>('find-open');
  const findStrip = need('find');
  const findText = need<HTMLInputElement>('find-text');
  const findCount = need('find-count');
  const findPreviousBtn = need<HTMLButtonElement>('find-previous');
  const findNextBtn = need<HTMLButtonElement>('find-next');
  const findCloseBtn = need<HTMLButtonElement>('find-close');
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
  /** The file on the disk that a save writes back to. Only with `saveInPlace`,
      and only where the browser gave the page a handle to the file. */
  let currentHandle: FileSystemFileHandle | null = null;

  /** What the open document takes, settled once the frame reports in. */
  let canEdit = false;
  let canFormat = false;
  let canMark = false;
  /** A plain text file: it takes typing, but it has no styles to format. */
  let plainText = false;
  /** A sheet: the format buttons act on the selected cells, which take a
      fill in place of a highlight and no justify. */
  let sheet = false;
  /** Turn the edit mode on when the next frame reports in: for a blank
      document, and for a sheet rendered again after a save. */
  let editOnReady = false;
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
  /** Whether the page has `odr.search`, as the frame reports it. */
  let canFind = false;

  /** Settles the open password prompt: the password, or null for a cancel. */
  let passwordAnswer: ((password: string | null) => void) | null = null;
  /** The document came with a password. Core cannot write it back with that
      password, so a save would give an unprotected copy. */
  let encrypted = false;
  /** The password that decrypted the document, for a save that encrypts. */
  let savePassword: string | null = null;

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
    passwordForm.hidden = true;
    spinner.hidden = false;
    idleIcon.hidden = true;
    actions.hidden = true;
    hint.hidden = true;
    status.textContent = message;
  }

  function setIdle(message: string, detail: string, isError = false) {
    passwordForm.hidden = true;
    uploadIcon.hidden = false;
    lockIcon.hidden = true;
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

  /*
    The panel asks for the password of an encrypted document. The promise
    gives the password, or null if the visitor cancels or another document
    replaces this one. `wrong` is true after a password that did not decrypt.
  */
  function askPassword(name: string, wrong: boolean): Promise<string | null> {
    spinner.hidden = true;
    idleIcon.hidden = false;
    actions.hidden = true;
    hint.hidden = false;
    status.textContent = wrong ? 'That password is not correct' : `${name} is password-protected`;
    hint.textContent = wrong
      ? `Type the password of ${name} again.`
      : 'Type its password. The document is decrypted on this device, and the password stays here.';
    status.classList.toggle('text-red-600', wrong);
    status.classList.toggle('dark:text-red-400', wrong);
    uploadIcon.hidden = true;
    lockIcon.hidden = false;
    passwordForm.hidden = false;
    passwordInput.value = '';
    passwordInput.focus();
    return new Promise((resolve) => {
      passwordAnswer = resolve;
    });
  }

  function friendlyError(e: any, name: string) {
    switch (e?.name) {
      case 'UnsupportedFileType':
      case 'UnknownFileType':
        return [`${name} is not a format we can open`, 'Try an ODT, DOCX, XLSX, PPTX or PDF file.'];
      case 'FileEncrypted':
        return [`${name} is password-protected`, 'Open it again, and type its password.'];
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
    The page computes the formula cells of a sheet as the visitor edits. It
    marks a formula cell as stale only if the evaluator has no answer for
    it. The engine tries again: a save calls `recalculate()`, and the sheet
    is rendered again with the new results. This says what the mark means
    until then.
  */
  let staleCount = 0;
  function showStale(count: number) {
    staleCount = count;
    if (!count) {
      staleNote.hidden = true;
      return;
    }
    staleNote.textContent = `${count} formula ${count === 1 ? 'cell shows a result' : 'cells show results'} that this page could not compute after your edit. A save computes ${count === 1 ? 'it' : 'them'} again.`;
    staleNote.hidden = false;
  }

  /*
    What `recalculate()` could not do: a formula with a function that the
    evaluator does not know, or a cycle in a document that does not iterate.
  */
  function showUncomputed(recalc: any) {
    const count = (recalc?.unevaluated?.length ?? 0) + (recalc?.circular?.length ?? 0);
    if (!count) return;
    staleNote.textContent = `${count} formula ${count === 1 ? 'cell' : 'cells'} could not be computed here. A spreadsheet app computes ${count === 1 ? 'it' : 'them'} when it opens the saved file.`;
    staleNote.hidden = false;
  }

  /* The bar and the strip, from the state above. */
  function paintChrome() {
    const changeable = canEdit || canMark;
    penBtn.hidden = !changeable;
    saveBtn.hidden = !changeable;
    findOpenBtn.hidden = !canFind;
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
    const saveLabel = currentHandle
      ? `Save your ${canMark ? 'marks' : 'changes'} to ${currentName}`
      : canMark
        ? 'Save this PDF with your marks'
        : 'Save this document with your changes';
    saveBtn.title = saveLabel;
    saveBtn.setAttribute('aria-label', saveLabel);

    tools.hidden = !modeOn;
    formatGroup.hidden = !canFormat;
    highlightBtn.hidden = sheet;
    highlightPick.hidden = sheet;
    fillBtn.hidden = !sheet;
    fillPick.hidden = !sheet;
    for (const b of alignBtns) b.hidden = sheet && b.dataset.viewerAlign === 'justify';
    structureGroup.hidden = !(canEdit && sheet);
    markGroup.hidden = !canMark;
    undoBtn.disabled = canMark ? marks === 0 : !canUndo;
    redoBtn.hidden = canMark;
    redoBtn.disabled = !canRedo;
    for (const b of toolBtns) {
      b.setAttribute('aria-pressed', String(b.dataset.viewerTool === armedTool));
    }
    toolsHint.textContent = canMark
      ? 'Select text, then a tool, to mark it once. A pressed tool marks every selection; Draw draws on the page.'
      : sheet
        ? canFormat
          ? 'Type a value or a formula such as =SUM(B2:B4) into a cell; the sheet computes as you go. Drag over cells, or click a header, to format them or to add and remove rows and columns.'
          : 'Type into a cell; Enter keeps the value, Escape drops it. Click a header to add and remove rows and columns. A csv has no styles.'
        : canFormat
          ? 'Type into the document. Select some text for the buttons, or Ctrl+B, I and U.'
          : 'Type into the file. It is plain text, so it saves as UTF-8 with no styles.';
  }

  /* The buttons show what the selection has, as the page reports it: a key
     per property the selected runs or cells agree on, and none where they
     differ. */
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
    fillBtn.setAttribute('aria-pressed', String(typeof style.fill === 'string'));
    if (typeof style.fill === 'string' && /^#[0-9a-f]{6}$/i.test(style.fill)) {
      fillColorInput.value = style.fill;
    }
    for (const b of alignBtns) {
      b.setAttribute('aria-pressed', String(style.align === b.dataset.viewerAlign));
    }
    paintColor();
    paintHighlight();
    paintFill();
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
      if (!on) sendTool(null);
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

  function sendTool(tool: string | null, recolor = false) {
    const color = tool ? rgbOf(colorOf(tool)) : null;
    send({ type: 'tool', tool, color, width: INK_WIDTH, recolor });
  }

  /*
    A save is a download: there is no file behind the document, only the bytes
    that were dropped on the page. It is written under the name it was opened
    as, so a browser that still has the original puts this one beside it - the
    page cannot overwrite anything, and should not look like it did.

    The installed app is the exception. If the browser gave it a handle to the
    file, `writeBytes` writes the save back to that file. If the browser
    refuses the write, the save is a download again, so the work is not lost.

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

  async function writeBytes(bytes: Uint8Array<ArrayBuffer>, name: string) {
    if (currentHandle) {
      try {
        // The browser asks the user for write access on the first save.
        const writable = await currentHandle.createWritable();
        await writable.write(bytes);
        await writable.close();
        return;
      } catch {
        // Refused or failed: the download below still gives the user the file.
      }
    }
    saveBytes(bytes, name);
  }

  /*
    The round trip. What the visitor did in the frame comes out of it as the
    engine's own envelope - the operation log for an edit, the marks for a pdf
    - goes into the engine here, and the file the engine writes goes out as a
    download. The frame keeps what it holds either way, so a failure costs the
    visitor nothing but the file.

    Both envelopes are json strings and stay strings: the binding underneath is
    a `std::string`, and an object throws `BindingError` there. A plain text
    file takes the same calls, with a log of one `setContent`.

    A sheet is recalculated before it is saved. `save()` would do that too,
    but only `recalculate()` names the formula cells it touched. The page
    computes its formula cells itself, so it already shows those results.
    Only if the page left some cells stale, and the recalculation names any
    cell, is the sheet rendered again, so the page shows what the file now
    holds. Otherwise the frame stays, with its scroll and its selection.
  */
  /*
    A new document in the installed app has no file yet. Its first save asks
    where to put it, as a "Save as" does, and every later save writes there.
    This must happen first in the click, because the browser opens its picker
    only shortly after a click.
  */
  const savePicker = saveInPlace ? (window as any).showSaveFilePicker : undefined;

  async function chooseTarget() {
    if (currentHandle || !savePicker) return true;
    const ext = currentName.slice(currentName.lastIndexOf('.'));
    try {
      currentHandle = await savePicker.call(window, {
        suggestedName: currentName,
        types: [{ description: currentName.slice(currentName.lastIndexOf('.') + 1).toUpperCase(), accept: { [currentMime]: [ext] } }],
      });
    } catch (e: any) {
      // A cancel is no error: nothing was saved, and the changes stay.
      if (e?.name === 'AbortError') return false;
      // Any other refusal: the save is a download, as in a browser tab.
      return true;
    }
    currentName = currentHandle!.name;
    filename.textContent = currentName;
    onDocument?.({ name: currentName, handle: currentHandle });
    return true;
  }

  async function saveDocument() {
    if (!currentDoc) return;
    if (!(await chooseTarget())) return;
    showAlert(null);
    saveBtn.disabled = true;
    // The engine works synchronously, so the disabled button has to paint
    // before it starts.
    await nextFrame();

    try {
      if (canMark) {
        const payload = await ask('getAnnotations');
        if (!payload) throw new Error('The marks could not be read back.');
        await writeBytes(currentDoc.annotate(payload), currentName);
        savedMarks = marks;
      } else {
        const payload = await ask('getOperations');
        if (!payload) throw new Error('The edits could not be read back.');
        if (JSON.parse(payload).ops.length) currentDoc.edit(payload);
        const recalc = sheet ? currentDoc.recalculate() : null;
        await writeBytes(encrypted ? currentDoc.save(savePassword ?? '') : currentDoc.save(), currentName);
        // The page and the file agree now: its log resets, undo starts over.
        send({ type: 'committed' });
        if (staleCount && recalc && Object.values(recalc).some((cells: any) => cells.length)) {
          renderAgain();
        }
        showUncomputed(recalc);
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
    // A prompt that waits for a password belongs to the document that goes.
    passwordAnswer?.(null);
    passwordAnswer = null;
    encrypted = false;
    savePassword = null;
    for (const [, resolve] of asks) resolve(null);
    asks.clear();
    modeOn = false;
    canEdit = false;
    canFormat = false;
    canMark = false;
    plainText = false;
    sheet = false;
    editOnReady = false;
    editDirty = false;
    canUndo = false;
    canRedo = false;
    marks = 0;
    savedMarks = 0;
    armedTool = null;
    discardArmed = false;
    canFind = false;
    showFind(false);
    paintChrome();
    showAlert(null);
    showStale(0);
    currentDoc?.close();
    currentDoc = null;
    currentHandle = null;
    onDocument?.(null);
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
    A new frame for the open document, after a save changed what the file
    holds. The page's state goes with the old frame, so the edit mode is
    turned on again when the new one reports in. The zoom fits again, and a
    sheet shows its first tab.
  */
  function renderAgain() {
    let html: string;
    try {
      html = currentDoc.render(0).html;
    } catch {
      // The file is saved already. The old frame stays, with its marks.
      return;
    }
    editOnReady = modeOn;
    modeOn = false;
    editDirty = false;
    canUndo = false;
    canRedo = false;
    showStale(0);
    paintChrome();
    mountFrame(html);
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
        sheet = m.sheet === true;
        canFormat = canEdit && !plainText && !(sheet && m.sheetStyles === false);
        canMark = canMark && m.annotatable === true;
        canFind = m.searchable === true;
        // A frame rendered again after a save has lost the hits, so the
        // search runs again.
        if (canFind && !findStrip.hidden && findText.value) {
          send({ type: 'search', text: findText.value, step: 0 });
        } else if (!canFind) {
          showFind(false);
        }
        paintZoom(m.zoom);
        zoomBar.hidden = false;
        paintChrome();
        if (editOnReady && canEdit) setMode(true);
        editOnReady = false;
        break;
      case 'page':
        onPage(m.message);
        break;
      case 'tool':
        armedTool = typeof m.armed === 'string' ? m.armed : null;
        paintChrome();
        break;
      case 'escape':
        if (!findStrip.hidden) showFind(false);
        else if (modeOn) setMode(false);
        break;
      case 'find':
        if (canFind) showFind(true);
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

  /*
    A callback of the page, as `host-bridge.js` sends it: one JSON string of
    `{type, detail}`. The page owns the wording; the viewer decides what a
    visitor sees.
  */
  function onPage(message: unknown) {
    if (typeof message !== 'string') return;
    let type: unknown;
    let detail: any;
    try {
      ({ type, detail } = JSON.parse(message));
    } catch {
      return;
    }
    switch (type) {
      case 'zoomChange':
        paintZoom(Number(detail?.zoom) || 1);
        break;
      case 'editModeChange':
        modeOn = detail?.editing === true;
        if (detail?.reason) showAlert(REFUSALS[detail.reason] ?? detail.message, 'warn');
        paintChrome();
        break;
      case 'editChange':
        editDirty = detail?.dirty === true;
        canUndo = detail?.canUndo === true;
        canRedo = detail?.canRedo === true;
        paintChrome();
        break;
      case 'editRefused':
        showAlert(REFUSALS[detail?.reason] ?? detail?.message ?? 'That edit was not taken.', 'warn');
        break;
      case 'cellsStale':
        showStale(Array.isArray(detail?.cells) ? detail.cells.length : 0);
        break;
      case 'selectionChange':
        paintSelection(detail ?? {});
        break;
      case 'searchChange':
        paintFind(detail ?? {});
        break;
      case 'annotationChange':
        // The count of pending marks after each change: a mark, a finished
        // stroke, an undo, a removal and a clear.
        marks = Number(detail?.count) || 0;
        paintChrome();
        break;
      case 'error':
        console.warn(`renderer error ${detail?.code}: ${detail?.message}`);
        break;
    }
  }

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

  /*
    The search is the page's: `odr.search` marks every hit, also in the parts
    that the page has not laid out, and scrolls to the selected one. The
    strip only sends the text and the steps, and shows the count that comes
    back. Closing the strip takes the marks away.
  */
  let findTimer: number | undefined;
  function showFind(on: boolean) {
    window.clearTimeout(findTimer);
    findStrip.hidden = !on;
    findOpenBtn.setAttribute('aria-expanded', String(on));
    if (on) {
      findText.focus();
      findText.select();
      return;
    }
    if (findText.value) send({ type: 'search', text: '', step: 0 });
    findText.value = '';
    paintFind({});
  }

  /* `current` is the place of the selected hit, from 0. While `complete` is
     false, the parts that have not loaded can still add hits. */
  function paintFind(state: { count?: number; current?: number; complete?: boolean }) {
    const count = Number(state.count) || 0;
    const more = state.complete === false;
    findPreviousBtn.disabled = count === 0;
    findNextBtn.disabled = count === 0;
    if (!findText.value) findCount.textContent = '';
    else if (count === 0) findCount.textContent = more ? 'Searching…' : 'No hits';
    else findCount.textContent = `${(state.current ?? 0) + 1} of ${count.toLocaleString()}${more ? '…' : ''}`;
  }

  function search(step: number) {
    window.clearTimeout(findTimer);
    send({ type: 'search', text: findText.value, step });
  }

  /* `bytes` null opens a blank document of the type that `name` says. */
  async function open(bytes: Uint8Array | null, name: string, handle: FileSystemFileHandle | null) {
    teardown();
    currentHandle = saveInPlace ? handle : null;
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

    const asked = bytes ? askedType(odr, name) : undefined;
    const blank = bytes ? undefined : blankType(odr, name);
    /*
      Editable output carries an address on every run and the editor's script,
      which is markup nobody can use where the format cannot be written back
      out. So the type is looked up first, and only a format that can both
      edit and save is rendered for it. The mode still starts off: the pen is
      what turns it on, and only in the frame, so a phone does not raise its
      keyboard over a document being read.
    */
    const info = typeInfo(odr, bytes ? (asked ?? detectedType(odr, bytes)) : blank);
    const editableFormat = Boolean(info?.capabilities?.edit && info?.capabilities?.save);
    const markableFormat = Boolean(info?.capabilities?.annotate);
    currentMime = info?.mimeTypes?.[0] ?? 'application/octet-stream';
    currentName = name;
    plainText = info?.category === odr.enums.FileCategory.text;

    // No width: the renderer's viewport script measures the frame it lands in
    // and refits on a resize, which a width guessed here could not follow.
    //
    // `pdfAnnotationMarkOnSelection`: an armed tool marks each selection as
    // it is made, which is what a touch screen needs, because there is no
    // button to press while a selection stands. `pdfEnforcePermissions`: a
    // pdf that refuses a copy refuses it here too.
    //
    // `lazyLayout`: the browser lays out only the lines, rows, pages and
    // slides near the viewport, so a long document shows its first frame
    // early. It is the default, but it is stated here because the search
    // strip exists for it: the find of the browser misses the rest.
    const options: Record<string, unknown> = {
      lazyLayout: true,
      editable: editableFormat,
      spreadsheetCellLimit: SHEET_CELL_BUDGET,
      textDocumentMargin,
      hostMessageHandler: HOST_HANDLER,
      pdfAnnotationMarkOnSelection: true,
      pdfEnforcePermissions: true,
    };
    if (asked !== undefined) options.fileType = asked;

    try {
      if (bytes) {
        currentDoc = odr.open(bytes, options);
      } else if (blank !== undefined) {
        currentDoc = odr.create(blank, options);
        // A blank page is there to be typed into.
        editOnReady = true;
      } else {
        throw new Error('This engine cannot make that type of document.');
      }
    } catch (e) {
      const [msg, detail] = friendlyError(e, name);
      setIdle(msg, detail, true);
      return;
    }

    /*
      Core decrypts ODF, Office (agile and standard encryption), the old
      binary Office formats and iWork. A wrong password throws `WrongPassword`,
      and the same document takes the next attempt. If the prompt gives null,
      or `currentDoc` changed, another open or a cancel already did the
      teardown, so this open stops and touches nothing.
    */
    let password: string | null = null;
    if (currentDoc.isPasswordEncrypted()) {
      const doc = currentDoc;
      encrypted = true;
      let wrong = false;
      for (;;) {
        password = await askPassword(name, wrong);
        if (password === null || currentDoc !== doc) return;
        setBusy(`Decrypting ${name}…`);
        await nextFrame();
        if (currentDoc !== doc) return;
        try {
          doc.decrypt(password);
          break;
        } catch (e: any) {
          if (e?.name !== 'WrongPassword') {
            const [msg, detail] = friendlyError(e, name);
            teardown();
            setIdle(msg, detail, true);
            return;
          }
          wrong = true;
        }
      }
    }
    savePassword = password;

    /*
      `capabilities()` answers for the format, the document for itself: a pdf
      whose cross-reference table had to be rebuilt takes no marks, and
      neither does a pdf whose permissions refuse a change to its
      annotations. Asking in a net turns a question that throws into the same
      honest thing: no pen.
    */
    // `isSavable(true)` asks for a save with the password. Without it, a save
    // of an encrypted document gives a copy that anyone can open, so such a
    // document is not editable here.
    canEdit =
      editableFormat &&
      answers(() => currentDoc.isEditable() && currentDoc.isSavable(encrypted));
    canMark =
      markableFormat &&
      answers(
        () =>
          currentDoc.isAnnotatable() && currentDoc.permissions()?.modifyAnnotations !== false,
      );
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
    onDocument?.({ name, handle: currentHandle });
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
  async function openSafely(
    bytes: Uint8Array | null,
    name: string,
    handle: FileSystemFileHandle | null = null,
  ) {
    try {
      await open(bytes, name, handle);
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

  async function openFile(file: File, handle: FileSystemFileHandle | null = null) {
    if (wouldDiscard()) return;
    scrollTarget?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    showResult(false);
    setBusy(`Reading ${file.name}…`);
    await openSafely(new Uint8Array(await file.arrayBuffer()), file.name, handle);
  }

  /*
    With `saveInPlace`, the pick uses the file picker of the browser where one
    exists, because only that picker gives a handle that a save can write to.
    The `<input>` stays the fallback for every other browser.
  */
  const openPicker = saveInPlace ? (window as any).showOpenFilePicker : undefined;
  pickBtn.addEventListener('click', async () => {
    if (!openPicker) {
      fileInput.click();
      return;
    }
    let handle: FileSystemFileHandle;
    try {
      [handle] = await openPicker.call(window, { multiple: false });
    } catch (e: any) {
      // A cancelled pick is an `AbortError` and needs no message.
      if (e?.name !== 'AbortError') fileInput.click();
      return;
    }
    void openFile(await handle.getFile(), handle);
  });
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

  /* A blank document of a type the engine can make, named for the
     download a save gives. Nothing to fetch, so it opens straight away. */
  for (const btn of blankBtns) {
    btn.addEventListener('click', () => {
      if (wouldDiscard()) return;
      void openSafely(null, `Untitled.${btn.dataset.viewerBlank}`);
    });
  }

  passwordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const answer = passwordAnswer;
    passwordAnswer = null;
    const value = passwordInput.value;
    passwordInput.value = '';
    answer?.(value);
  });

  function cancelPassword() {
    teardown();
    setIdle(idleTitle, idleHint);
  }

  passwordCancelBtn.addEventListener('click', cancelPassword);
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelPassword();
  });

  resetBtn.addEventListener('click', () => {
    if (wouldDiscard()) return;
    // `teardown` drops the frame along with the document.
    teardown();
    showResult(false);
    setIdle(idleTitle, idleHint);
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
    if (!file) return;
    /* A drop can give a handle too, in Chromium. The call must happen during
       the event, because the data of the drop is gone after it. */
    const asHandle = saveInPlace ? (e.dataTransfer.items[0] as any)?.getAsFileSystemHandle : undefined;
    if (!asHandle) {
      void openFile(file);
      return;
    }
    const pending: Promise<any> = asHandle.call(e.dataTransfer.items[0]);
    void pending
      .then((h) => (h?.kind === 'file' ? openFile(file, h) : openFile(file)))
      .catch(() => openFile(file));
  });

  // The markup has the words of the demo; a page can ask for its own.
  status.textContent = idleTitle;
  hint.textContent = idleHint;

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
  for (const b of [
    ...styleBtns,
    highlightBtn,
    fillBtn,
    ...alignBtns,
    ...structureBtns,
    ...toolBtns,
    undoBtn,
    redoBtn,
  ]) {
    b.addEventListener('mousedown', keepFocus);
  }
  for (const b of styleBtns) {
    b.addEventListener('click', () => send({ type: 'toggle', property: b.dataset.viewerStyle }));
  }
  highlightBtn.addEventListener('click', () => {
    const on = highlightBtn.getAttribute('aria-pressed') === 'true';
    send({ type: 'format', style: { highlight: on ? null : highlightColorInput.value } });
  });
  fillBtn.addEventListener('click', () => {
    const on = fillBtn.getAttribute('aria-pressed') === 'true';
    send({ type: 'format', style: { fill: on ? null : fillColorInput.value } });
  });
  // On a sheet, a second press sets the cells back to the alignment of their
  // value: text to the start, a number or a date to the right.
  for (const b of alignBtns) {
    b.addEventListener('click', () => {
      const off = sheet && b.getAttribute('aria-pressed') === 'true';
      send({ type: 'format', style: { align: off ? null : b.dataset.viewerAlign } });
    });
  }
  for (const b of structureBtns) {
    b.addEventListener('click', () =>
      send({
        type: 'structure',
        call: b.dataset.viewerStructureCall,
        where: b.dataset.viewerStructureWhere,
      }),
    );
  }
  sizeSelect.addEventListener('change', () => {
    if (sizeSelect.value) send({ type: 'format', style: { size: sizeSelect.value } });
  });

  /*
    A tool button: with text selected in the frame it marks that selection
    once and leaves no tool armed; pressed while armed it disarms; otherwise it
    arms. The frame decides, because only it can see the selection: the
    annotator's `press` does it, and the frame reports back what is armed.
  */
  for (const b of toolBtns) {
    b.addEventListener('click', () => sendTool(b.dataset.viewerTool ?? 'highlight'));
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
  // A fill colour goes onto the selected cells.
  const paintFill = colourControl(fillColorInput, fillBar, () =>
    send({ type: 'format', style: { fill: fillColorInput.value } }),
  );
  // A tool's colour marks a selection once, or recolours the tool if it is
  // armed; the frame decides which.
  for (const input of toolColors) {
    const tool = input.dataset.viewerToolColor ?? '';
    const bar = toolBars.find((b) => b.dataset.viewerToolBar === tool);
    colourControl(input, bar, () => sendTool(tool, true));
  }
  undoBtn.addEventListener('click', () => send({ type: 'undo' }));
  redoBtn.addEventListener('click', () => send({ type: 'redo' }));

  findOpenBtn.addEventListener('click', () => showFind(findStrip.hidden === true));
  findCloseBtn.addEventListener('click', () => showFind(false));
  findPreviousBtn.addEventListener('click', () => search(-1));
  findNextBtn.addEventListener('click', () => search(1));
  // A search per pause in the typing, not per key.
  findText.addEventListener('input', () => {
    window.clearTimeout(findTimer);
    findTimer = window.setTimeout(() => search(0), 200);
  });
  findText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      search(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      showFind(false);
      currentFrame?.focus();
    }
  });

  zoomInBtn.addEventListener('click', () => nudgeZoom(ZOOM_STEP));
  zoomOutBtn.addEventListener('click', () => nudgeZoom(1 / ZOOM_STEP));
  zoomLabel.addEventListener('click', () => send({ type: 'resetZoom' }));

  window.addEventListener('pagehide', teardown);

  return { openFile };
}
