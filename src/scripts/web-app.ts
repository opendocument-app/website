/*
  What makes `/web` an app, around the viewer that `/tryit` also uses: the
  title of the window, the recent files, the files that the operating system
  opens with the app, the shortcuts, the install button, the service worker,
  and the notice of a new version.
*/
import type { Viewer } from './viewer';

/** True when the page runs as the installed app, not in a browser tab. */
function standalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as any).standalone === true
  );
}

function find<T extends HTMLElement>(selector: string) {
  return document.querySelector<T>(selector);
}

/*
  The page starts the app before it mounts the viewer, because the viewer
  takes `documentChanged` as its callback. `attach` then connects the parts
  that need the viewer.
*/
export function startWebApp() {
  keepHomeOutside();
  offerInstall();
  if (import.meta.env.PROD) void startWorker();
  const recent = startRecent();

  return {
    documentChanged(doc: { name: string; handle: FileSystemFileHandle | null } | null) {
      // The title is what the window of the installed app shows.
      document.title = doc ? `${doc.name} — OpenDocument Reader` : APP_TITLE;
      if (doc?.handle) void recent.add(doc.handle);
    },
    attach(viewer: Viewer) {
      recent.attach(viewer);
      takeLaunchedFiles(viewer);
      takeShortcut();
    },
  };
}

const APP_TITLE = 'OpenDocument Reader';

/*
  A file that the user opens with the app ("Open with", a double click) comes
  in through the launch queue, as a handle. The viewer gets the handle too, so
  a save writes back to that file. Only Chromium on a computer has the queue.
*/
function takeLaunchedFiles(viewer: Viewer) {
  const queue = (window as any).launchQueue;
  queue?.setConsumer(async (params: any) => {
    const handle = params.files?.[0];
    if (!handle || handle.kind !== 'file') return;
    await viewer.openFile(await handle.getFile(), handle);
  });
}

/*
  The shortcuts of the manifest (the menu of the app icon) open `/web?new=odt`
  and the like. The page clicks the matching "New" tile, so a shortcut does
  what the tile does. The page removes the query, so a reload does not make a
  second document.
*/
function takeShortcut() {
  const ext = new URLSearchParams(window.location.search).get('new');
  if (!ext) return;
  history.replaceState(null, '', window.location.pathname);
  find<HTMLButtonElement>(`[data-viewer-blank="${CSS.escape(ext)}"]`)?.click();
}

/*
  The recent files: the handles of the files that were opened or saved, kept
  in IndexedDB. A handle survives a restart of the browser, but the access to
  the file does not, so a click asks the browser for access again. Only
  Chromium gives handles. In every other browser the list stays empty and
  hidden.
*/
const RECENT_MAX = 12;

interface RecentEntry {
  handle: FileSystemFileHandle;
  name: string;
  opened: number;
}

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('odr-web', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadRecent(): Promise<RecentEntry[]> {
  try {
    const db = await openStore();
    return await new Promise((resolve) => {
      const request = db.transaction('state').objectStore('state').get('recent');
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

async function saveRecent(entries: RecentEntry[]) {
  try {
    const db = await openStore();
    await new Promise<void>((resolve) => {
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put(entries, 'recent');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Without storage, the app works without the list.
  }
}

/* The colour of a file by its kind, as the tiles of the start screen show it. */
function toneOf(name: string) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (/^(ods|ots|fods|xlsx|xlsm|xltx|xltm|xls|xlt|csv|numbers)$/.test(ext)) return 'text-brand-sheet';
  if (/^(odp|otp|fodp|pptx|pptm|potx|potm|ppsx|ppsm|ppt|pot|pps|key)$/.test(ext)) return 'text-brand-slide';
  if (/^(pdf|txt|md|markdown)$/.test(ext)) return 'text-on-surface-variant';
  return 'text-brand-text';
}

function ago(time: number) {
  const words = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const minutes = Math.round((time - Date.now()) / 60000);
  if (minutes > -1) return 'just now';
  if (minutes > -60) return words.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours > -24) return words.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (days > -30) return words.format(days, 'day');
  return `on ${new Date(time).toLocaleDateString()}`;
}

function startRecent() {
  const section = find('[data-web-recent]');
  const list = find('[data-web-recent-list]');
  const note = find('[data-web-recent-note]');
  let viewer: Viewer | null = null;
  // A queue, so that two changes never read and write the list at once.
  let chain: Promise<unknown> = Promise.resolve();
  const queue = <T>(job: () => Promise<T>) => {
    const next = chain.then(job, job);
    chain = next.catch(() => {});
    return next;
  };

  async function paint() {
    if (!section || !list) return;
    const entries = await loadRecent();
    section.hidden = entries.length === 0;
    list.replaceChildren(...entries.map(row));
  }

  function row(entry: RecentEntry) {
    const dot = entry.name.lastIndexOf('.');
    const ext = dot < 0 ? '' : entry.name.slice(dot + 1);
    const li = document.createElement('li');
    li.className = 'group flex items-center bg-surface transition-colors hover:bg-surface-container';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'flex min-w-0 flex-1 items-center gap-4 px-4 py-3 text-left';
    open.title = `Open ${entry.name}`;
    const badge = document.createElement('span');
    badge.className = `flex h-10 w-8 shrink-0 items-center justify-center rounded-md border border-current/40 bg-current/10 text-[9px] font-bold uppercase tracking-wide ${toneOf(entry.name)}`;
    badge.textContent = ext.slice(0, 4);
    const text = document.createElement('span');
    text.className = 'min-w-0 flex-1';
    const nameEl = document.createElement('span');
    nameEl.className = 'block truncate text-sm font-medium';
    nameEl.textContent = entry.name;
    const whenEl = document.createElement('span');
    whenEl.className = 'block text-xs text-on-surface-variant';
    whenEl.textContent = `Opened ${ago(entry.opened)}`;
    text.append(nameEl, whenEl);
    open.append(badge, text);
    open.addEventListener('click', () => void reopen(entry));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className =
      'mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant opacity-0 transition hover:bg-surface group-hover:opacity-100 focus-visible:opacity-100';
    remove.title = 'Remove from the list';
    remove.setAttribute('aria-label', `Remove ${entry.name} from the list`);
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    remove.addEventListener('click', () => void forget(entry.handle));

    li.append(open, remove);
    return li;
  }

  function say(text: string | null) {
    if (!note) return;
    note.hidden = !text;
    note.textContent = text ?? '';
  }

  async function reopen(entry: RecentEntry) {
    say(null);
    const handle: any = entry.handle;
    try {
      // The click is the user gesture that the browser needs for its prompt.
      if ((await handle.queryPermission({ mode: 'read' })) !== 'granted') {
        if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') return;
      }
      const file = await entry.handle.getFile();
      await viewer?.openFile(file, entry.handle);
    } catch (e: any) {
      if (e?.name === 'NotFoundError') {
        say(`${entry.name} is no longer where it was, so it is off the list now.`);
        await forget(entry.handle);
      } else {
        say(`${entry.name} could not be opened. ${e?.message ?? ''}`.trim());
      }
    }
  }

  async function without(entries: RecentEntry[], handle: FileSystemFileHandle) {
    const keep: RecentEntry[] = [];
    for (const e of entries) {
      if (!(await e.handle.isSameEntry(handle))) keep.push(e);
    }
    return keep;
  }

  const forget = (handle: FileSystemFileHandle) =>
    queue(async () => {
      await saveRecent(await without(await loadRecent(), handle));
      await paint();
    });

  const add = (handle: FileSystemFileHandle) =>
    queue(async () => {
      const rest = await without(await loadRecent(), handle);
      const entry = { handle, name: handle.name, opened: Date.now() };
      await saveRecent([entry, ...rest].slice(0, RECENT_MAX));
      await paint();
    });

  return {
    add,
    attach(v: Viewer) {
      viewer = v;
      void queue(paint);
    },
  };
}

/*
  The logo links to the website. In the installed app, a link out of the scope
  of the app would open the website in the app window, so it opens in the
  browser instead.
*/
function keepHomeOutside() {
  const home = find<HTMLAnchorElement>('[data-web-home]');
  if (!home || !standalone()) return;
  home.target = '_blank';
  home.rel = 'noopener';
  home.title = 'Open opendocument.app in your browser';
}

/*
  The install button shows only on a computer, because on a phone the store
  apps come first. The manifest says the same to Chrome on Android with
  `prefer_related_applications`.

  Chrome and Edge send `beforeinstallprompt` when the app can be installed,
  and the button opens their dialog. Safari on macOS 17 and later can add the
  page to the Dock, but it sends no event, so the button there opens a hint.
  Firefox can do neither, so it shows no button.
*/
function offerInstall() {
  if (standalone() || document.documentElement.dataset.platform !== 'desktop') return;
  const installBtn = find<HTMLButtonElement>('[data-web-install]');
  const dockBtn = find<HTMLButtonElement>('[data-web-dock]');
  if (!installBtn || !dockBtn) return;

  let prompt: any = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    // Without this, the browser shows its own banner as well as our button.
    e.preventDefault();
    prompt = e;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', async () => {
    if (!prompt) return;
    prompt.prompt();
    await prompt.userChoice;
    // An event can show its dialog only once. If the user said no, the browser
    // sends a new event later, and the button comes back with it.
    prompt = null;
    installBtn.hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    prompt = null;
    installBtn.hidden = true;
  });

  const ua = navigator.userAgent;
  const safari = /Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua);
  const version = Number(/Version\/(\d+)/.exec(ua)?.[1] ?? 0);
  if (safari && version >= 17) dockBtn.hidden = false;
}

/*
  The service worker keeps one version of the app in its cache: this page, its
  scripts and the renderer, together. A new version installs next to the old
  one and waits. The notice lets the user restart into it now. If the user
  does not, the new version starts the next time the app opens. A restart
  reloads the page, so an open document closes, and the button says so.
*/
async function startWorker() {
  if (!('serviceWorker' in navigator)) return;
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register('/web-sw.js', { scope: '/web' });
  } catch {
    // The app still works online without the worker.
    return;
  }

  const notice = find('[data-web-update]');
  const nowBtn = find<HTMLButtonElement>('[data-web-update-now]');
  const laterBtn = find<HTMLButtonElement>('[data-web-update-later]');
  if (!notice || !nowBtn || !laterBtn) return;

  // The first worker of a page takes control without a new version, so only
  // a worker that comes while another one is in control is an update.
  const showIfWaiting = () => {
    if (registration.waiting && navigator.serviceWorker.controller) notice.hidden = false;
  };
  showIfWaiting();
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed') showIfWaiting();
    });
  });

  let restarting = false;
  nowBtn.addEventListener('click', () => {
    restarting = true;
    registration.waiting?.postMessage({ type: 'skipWaiting' });
  });
  laterBtn.addEventListener('click', () => {
    notice.hidden = true;
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (restarting) window.location.reload();
  });

  // The browser looks for a new worker when the page loads. An app window
  // can stay open for days, so it looks again every hour as well.
  window.setInterval(() => void registration.update().catch(() => {}), 60 * 60 * 1000);
}
