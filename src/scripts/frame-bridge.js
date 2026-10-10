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

  The page's own callbacks do not pass through here. The viewer renders with
  `hostMessageHandler: 'odrHost.post'`, and the renderer's `host-bridge.js`
  sends every `odr.on*` callback to that function as one JSON string. The
  viewer writes `odrHost` into the head, so it exists before the renderer's
  scripts run, and no callback is lost before this script runs.
*/
(function () {
  'use strict';

  /** @type {any} */
  var odr = /** @type {any} */ (window).odr || {};
  var editing = odr.editing || null;
  var annotation = odr.annotation || null;
  var root = document.documentElement;

  /* The row and column edits of a sheet, in the names `odr.editing` takes. */
  var STRUCTURE = ['insertRows', 'deleteRows', 'insertColumns', 'deleteColumns'];

  /** @param {Record<string, unknown>} message */
  function post(message) {
    message.odrViewer = true;
    // `*`: the frame has no origin to name, and nothing here is a secret.
    window.parent.postMessage(message, '*');
  }

  /*
    A `srcdoc` document resolves urls against the page that holds it, so a
    pdf's `#p2` points at the page's own url, and a click would navigate the
    frame onto the homepage. This script scrolls a fragment in the frame. The
    renderer removes the `href` of a relative link, and it gives an external
    link `target="_blank"`, which the sandbox keeps inert because it has no
    `allow-popups`.
  */
  var anchors = document.querySelectorAll('a[href^="#"]');
  for (var i = 0; i < anchors.length; ++i) {
    var a = /** @type {HTMLAnchorElement} */ (anchors[i]);
    var href = a.getAttribute('href') || '';
    a.removeAttribute('href');
    a.style.cursor = 'pointer';
    a.addEventListener('click', onFragment(href.slice(1)));
  }

  /** @param {string} id */
  function onFragment(id) {
    return function (/** @type {Event} */ event) {
      event.preventDefault();
      var target = document.getElementById(id);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }

  /*
    Escape leaves whatever mode the pen turned on, unless something in the
    frame - a sheet's cell editor, say - took the key for itself first.
  */
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !event.defaultPrevented) post({ type: 'escape' });
  });

  /* The zoom is the renderer's where its viewport script is present, and a
     bare `body{zoom}` where a view carries none. Then this script reports the
     zoom in the form `host-bridge.js` uses. */
  /** @param {number} value */
  function setZoom(value) {
    if (typeof odr.setZoom === 'function') {
      odr.setZoom(value);
      return;
    }
    document.body.style.zoom = String(value);
    root.style.setProperty('--odr-zoom', String(value));
    var host = /** @type {any} */ (window).odrHost;
    if (host) host.post(JSON.stringify({ type: 'zoomChange', detail: { zoom: value, followsFit: false } }));
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
      case 'structure':
        // Only the four row and column calls. The page refuses a call that
        // the open document does not have, so a text document says why.
        if (editing && STRUCTURE.indexOf(m.call) >= 0) editing[m.call](m.where || undefined);
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
    // A csv states no style, so its cells take no format.
    sheetStyles: document.body.getAttribute('data-odr-sheet-styles') !== 'false',
    annotatable: !!annotation,
    // The canvas the renderer painted on the body, for the frame to wear on
    // the overscroll; see the viewer.
    background: getComputedStyle(document.body).backgroundColor,
    zoom: typeof odr.getZoom === 'function' ? odr.getZoom() : 1,
  });
})();
