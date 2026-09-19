// @ts-check
/*
  Runs inside the rendered document, appended by the viewer after the
  renderer's own scripts, and is the only thing in the frame that knows there
  is a page around it. The frame is sandboxed with `allow-scripts` and without
  `allow-same-origin`, so it has an opaque origin: the page cannot reach into
  it, and nothing in it - a `javascript:` link in a dropped document included -
  can reach the page. What crosses is `postMessage`, in both directions, and
  this script is one end of it. `viewer.ts` is the other.

  Plain javascript rather than typescript because it is inlined verbatim: the
  viewer imports it as a string and writes it into the markup before mounting.
  Nothing here may spell a closing script tag, which would end the inline
  block early.
*/
(function () {
  'use strict';

  /** @type {any} */
  var odr = /** @type {any} */ (window).odr || {};
  var editing = odr.editing || null;
  var annotation = odr.annotation || null;
  var root = document.documentElement;

  /** @param {Record<string, unknown>} message */
  function post(message) {
    message.odrViewer = true;
    // `*`: the frame has no origin to name, and nothing here is a secret.
    window.parent.postMessage(message, '*');
  }

  /*
    A `srcdoc` document resolves urls against the page that holds it, so a
    pdf's `#p2` points at the page's own url and a click would navigate the
    frame onto the homepage; an archive entry's relative link would land on
    the 404. Fragments are scrolled here, where they are meant; relative links
    are drawn as text; external links keep `target="_blank"` and stay inert
    against the sandbox's missing `allow-popups`.
  */
  var anchors = document.querySelectorAll('a[href]');
  for (var i = 0; i < anchors.length; ++i) {
    var a = /** @type {HTMLAnchorElement} */ (anchors[i]);
    var href = a.getAttribute('href');
    if (!href) continue;
    if (href.charAt(0) === '#') {
      a.removeAttribute('href');
      a.style.cursor = 'pointer';
      a.addEventListener('click', onFragment(href.slice(1)));
      continue;
    }
    if (a.target === '_blank') continue;
    a.removeAttribute('href');
    a.title = 'This demo renders one document. Opening what it links to is what the apps do.';
    a.style.cursor = 'default';
  }

  /** @param {string} id */
  function onFragment(id) {
    return function (/** @type {Event} */ event) {
      event.preventDefault();
      var target = document.getElementById(id);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }

  /* The page's callbacks, forwarded whole: the page owns the wording. */
  odr.onEditModeChange = function (/** @type {unknown} */ event) {
    post({ type: 'editMode', event: event });
  };
  odr.onEditChange = function (/** @type {unknown} */ event) {
    post({ type: 'editChange', event: event });
  };
  odr.onEditRefused = function (/** @type {unknown} */ event) {
    post({ type: 'editRefused', event: event });
  };
  odr.onCellsStale = function (/** @type {unknown} */ event) {
    post({ type: 'cellsStale', event: event });
  };
  odr.onSelectionChange = function (/** @type {unknown} */ style) {
    post({ type: 'selection', style: style });
  };
  odr.onZoomChange = function (/** @type {number} */ zoom, /** @type {boolean} */ fitted) {
    post({ type: 'zoom', zoom: zoom, fitted: fitted });
  };
  odr.onError = function (/** @type {number} */ code, /** @type {string} */ message) {
    post({ type: 'error', code: code, message: message });
  };

  if (annotation) {
    // The annotator reports the count of pending marks after each change: a
    // mark, a finished stroke, an undo, a removal and a clear.
    odr.onAnnotationChange = function (/** @type {{count: number}} */ event) {
      post({ type: 'marks', count: event.count });
    };
    // A selection marks itself with the armed tool, which is what a touch
    // screen needs: there is no button to press with a selection standing.
    annotation.setOptions({ markOnSelection: true });
  }

  /*
    Escape leaves whatever mode the pen turned on, unless something in the
    frame - a sheet's cell editor, say - took the key for itself first.
  */
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !event.defaultPrevented) post({ type: 'escape' });
  });

  /* The zoom is the renderer's where its viewport script is present, and a
     bare `body{zoom}` where a view carries none. */
  /** @param {number} value */
  function setZoom(value) {
    if (typeof odr.setZoom === 'function') {
      odr.setZoom(value);
      return;
    }
    document.body.style.zoom = String(value);
    root.style.setProperty('--odr-zoom', String(value));
    post({ type: 'zoom', zoom: value, fitted: false });
  }
  function resetZoom() {
    if (typeof odr.resetZoom === 'function') {
      odr.resetZoom();
      return;
    }
    setZoom(1);
  }

  /*
    A tool button does one of three things, and only the frame can tell which,
    because only the frame can see the selection. The annotator's `press`
    decides: with text selected, the tool marks that selection once, and then
    no tool stays armed. Without a selection, a press arms the tool, and a
    second press disarms it. An armed tool marks every selection as it is
    made. The pen sends `null`, so it disarms outright.

    A new colour for a tool goes to `recolor`, which acts as the document
    editor's highlight colour does: it marks a selection once, and it
    recolours the tool if the tool is armed. Otherwise the page only keeps the
    colour.
  */
  /** @param {number[] | null} rgb */
  function setTool(
    /** @type {string | null} */ tool,
    rgb,
    /** @type {number} */ width,
    /** @type {boolean} */ recolor
  ) {
    if (!annotation) return;
    /** @type {{color?: number[], width?: number}} */
    var style = {};
    if (rgb) style.color = rgb;
    if (width) style.width = width;
    if (recolor) annotation.recolor(tool, style);
    else if (tool) annotation.press(tool, style);
    else annotation.setTool(null);
    post({ type: 'tool', armed: annotation.getTool() });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var m = event.data;
    if (!m || m.odrViewer !== true) return;
    switch (m.type) {
      case 'setZoom':
        setZoom(m.value);
        break;
      case 'resetZoom':
        resetZoom();
        break;
      case 'edit':
        if (editing) m.on ? editing.enable() : editing.disable();
        break;
      case 'undo':
        if (annotation) {
          annotation.undo();
        } else if (editing) {
          editing.undo();
        }
        break;
      case 'redo':
        if (editing) editing.redo();
        break;
      case 'format':
        if (editing) editing.format(m.style);
        break;
      case 'toggle':
        if (editing) editing.toggle(m.property);
        break;
      case 'getOperations':
        post({ type: 'operations', id: m.id, payload: editing ? editing.getOperations() : null });
        break;
      case 'committed':
        if (editing) editing.committed();
        break;
      case 'tool':
        setTool(m.tool || null, m.color, m.width, m.recolor === true);
        break;
      case 'getAnnotations':
        post({
          type: 'annotations',
          id: m.id,
          payload: annotation ? annotation.getAnnotations() : null,
        });
        break;
    }
  });

  post({
    type: 'ready',
    editable: editing ? editing.isEditable() === true : false,
    sheet: !!odr.sheet,
    annotatable: !!annotation,
    // The canvas the renderer painted on the body, for the frame to wear on
    // the overscroll; see the viewer.
    background: getComputedStyle(document.body).backgroundColor,
    zoom: typeof odr.getZoom === 'function' ? odr.getZoom() : 1,
    fitted: typeof odr.isZoomFitted === 'function' ? odr.isZoomFitted() : true,
  });
})();
