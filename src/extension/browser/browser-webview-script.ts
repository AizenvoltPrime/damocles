// The browser panel webview script, kept as a standalone string so the frame pipeline can be
// evaluated directly under Vitest/happy-dom. It is interpolated into `buildHtml`'s `<script nonce>`
// block, so it must never contain a backtick or `${`.
export const BROWSER_WEBVIEW_SCRIPT: string = `
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('screen');
    const placeholder = document.getElementById('placeholder');
    const urlInput = document.getElementById('url-input');
    const btnBack = document.getElementById('btn-back');
    const btnForward = document.getElementById('btn-forward');
    const btnReload = document.getElementById('btn-reload');
    const btnPick = document.getElementById('btn-pick');
    const btnDevTools = document.getElementById('btn-devtools');
    const btnNewtab = document.getElementById('btn-newtab');
    const contentArea = document.getElementById('content-area');
    const overlay = document.getElementById('element-overlay');
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    let viewportW = 1920;
    let viewportH = 1080;
    let overlayTimer = null;
    let overlayHideTimer = null;
    let isPicking = false;
    let mouseIsDown = false;
    // Last page coordinate we mapped from a pointer event. A drag that ends outside the webview never
    // delivers a mouseup, so the synthetic release fired on blur needs a real position to release at:
    // releasing at (0,0) would look to the page like the pointer teleported to the corner first.
    let lastMouseX = 0;
    let lastMouseY = 0;

    // rAF-coalesced hover: store the freshest pointer position and post at most one
    // mousemove message per frame. moveRafScheduled guards a single in-flight rAF.
    let latestMove = null;
    let moveRafScheduled = false;
    function scheduleMove(x, y, buttons) {
      latestMove = { x, y, buttons };
      if (moveRafScheduled) return;
      moveRafScheduled = true;
      requestAnimationFrame(() => {
        moveRafScheduled = false;
        const m = latestMove;
        vscode.postMessage({ type: 'mousemove', x: m.x, y: m.y, buttons: m.buttons });
      });
    }

    // Frame pipeline: pendingFrame holds only the latest frame (latest-wins coalescing).
    // lastBitmap holds the most recently decoded bitmap so we can redraw on resize.
    let pendingFrame = null;
    let lastBitmap = null;
    let pumping = false;

    // The canvas is opaque (alpha:false), so the letterbox must be painted with the editor
    // background or it renders as black bars. getComputedStyle forces a style recalc, so the
    // value is cached and refreshed only on the two signals that can change it: a resize and a
    // theme switch (VS Code rewrites documentElement's class/style attributes on theme change).
    let letterboxColor = '#1e1e1e';
    function refreshLetterboxColor() {
      letterboxColor = getComputedStyle(document.body).backgroundColor;
    }
    refreshLetterboxColor();
    new MutationObserver(refreshLetterboxColor).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    const savedState = vscode.getState();
    if (savedState && savedState.url) {
      urlInput.value = savedState.url;
    }

    // Contain-fit letterbox rect of viewportW/H inside the canvas client area, in CSS px.
    // Single source of truth for the draw call, screenCoords, and showElementOverlay.
    function computeDrawRect() {
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      const scale = Math.min(cw / viewportW, ch / viewportH);
      const width = viewportW * scale;
      const height = viewportH * scale;
      return { x: (cw - width) / 2, y: (ch - height) / 2, width, height };
    }

    // clamp === false only during a drag: the page's own drag handler needs the pointer's TRUE
    // position, so the result may be negative or past the viewport. Clamping there pins the pointer
    // at the border and every drag handler mis-tracks.
    function screenCoords(e, clamp) {
      const canvasRect = canvas.getBoundingClientRect();
      const rect = computeDrawRect();
      const relX = (e.clientX - canvasRect.left - rect.x) / rect.width;
      const relY = (e.clientY - canvasRect.top - rect.y) / rect.height;
      const rawX = relX * viewportW;
      const rawY = relY * viewportH;
      // Clamp to the last addressable pixel: viewportW/H are counts, so the max valid coordinate is
      // width-1 / height-1. Clamping to the count itself lands one pixel outside the page.
      const x = Math.round(clamp ? Math.min(Math.max(rawX, 0), viewportW - 1) : rawX);
      const y = Math.round(clamp ? Math.min(Math.max(rawY, 0), viewportH - 1) : rawY);
      lastMouseX = x;
      lastMouseY = y;
      return { x, y };
    }

    // Draw lastBitmap into the letterbox rect on the dpr-scaled backing store.
    function redraw() {
      if (!lastBitmap) return;
      const dpr = window.devicePixelRatio;
      const bw = Math.round(canvas.clientWidth * dpr);
      const bh = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      const rect = computeDrawRect();
      ctx.fillStyle = letterboxColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(lastBitmap, rect.x * dpr, rect.y * dpr, rect.width * dpr, rect.height * dpr);
    }

    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        while (pendingFrame) {
          const frame = pendingFrame;
          pendingFrame = null;
          let bitmap;
          try {
            const blob = new Blob([frame.bytes], { type: 'image/jpeg' });
            bitmap = await createImageBitmap(blob);
          } catch (err) {
            // Ack the frame we could not draw. Chromium paces frame production by acks, so a decode
            // failure that posts nothing costs the host's full fallback timeout per frame — a
            // persistent one degrades the stream to 1fps with no signal anywhere. Reporting it as
            // rendered is honest about the only thing the host uses this for: releasing backpressure.
            console.error('frame decode failed', err);
            vscode.postMessage({ type: 'frameRendered', frameId: frame.frameId });
            continue;
          }
          if (pendingFrame) {
            // A newer frame arrived while decoding; discard this one and loop. No frameRendered is
            // posted: the host already released this frame's ack when it superseded it.
            bitmap.close();
            continue;
          }
          try {
            viewportW = frame.width;
            viewportH = frame.height;
            if (lastBitmap) lastBitmap.close();
            lastBitmap = bitmap;
            redraw();
            if (canvas.style.display === 'none') {
              canvas.style.display = 'block';
              placeholder.style.display = 'none';
            }
          } catch (err) {
            console.error('frame draw failed', err);
          }
          // Ack from inside rAF, after the frame is already on screen: this paces Chromium's frame
          // production to the compositor's real cadence at zero added display latency. Posted even if
          // the draw above threw — the ack is backpressure bookkeeping, and withholding it stalls the
          // stream rather than retrying anything.
          requestAnimationFrame(() => vscode.postMessage({ type: 'frameRendered', frameId: frame.frameId }));
        }
      } finally {
        pumping = false;
      }
    }

    btnBack.addEventListener('click', () => vscode.postMessage({ type: 'goBack' }));
    btnForward.addEventListener('click', () => vscode.postMessage({ type: 'goForward' }));
    btnReload.addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
    btnPick.addEventListener('click', () => vscode.postMessage({ type: 'pickElement' }));
    btnDevTools.addEventListener('click', () => vscode.postMessage({ type: 'openDevTools' }));
    btnNewtab.addEventListener('click', () => { vscode.postMessage({ type: 'tabNew' }); canvas.focus(); });

    urlInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        let url = urlInput.value.trim();
        if (!url) return;
        // A bare host gets https://; anything already carrying a scheme is left alone so the host can
        // judge it. The host re-checks the scheme and is the authority — this only avoids posting a
        // navigation that will certainly be refused.
        if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = 'https://' + url;
        if (!/^https?:/i.test(url) && url !== 'about:blank') return;
        vscode.postMessage({ type: 'navigate', url });
        vscode.setState({ url });
        canvas.focus();
      }
    });

    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d.type === 'frame') {
        pendingFrame = { bytes: d.bytes, width: d.width, height: d.height, frameId: d.frameId };
        pump();
      } else if (d.type === 'viewport') {
        viewportW = d.width;
        viewportH = d.height;
      } else if (d.type === 'urlChanged') {
        urlInput.value = d.url;
        vscode.setState({ url: d.url });
      } else if (d.type === 'pickingStateChanged') {
        isPicking = d.picking;
        btnPick.classList.toggle('active', d.picking);
        canvas.style.cursor = d.picking ? 'crosshair' : 'default';
      } else if (d.type === 'cursor') {
        if (!isPicking) canvas.style.cursor = d.cursor;
      } else if (d.type === 'elementInfo') {
        showElementOverlay(d.info);
      }
    });

    function showElementOverlay(info) {
      if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
      // The nested hide is armed 3s later, so a pick that lands during the 300ms fade would otherwise
      // be erased by the PREVIOUS overlay's pending hide firing on top of it.
      if (overlayHideTimer) { clearTimeout(overlayHideTimer); overlayHideTimer = null; }
      const canvasRect = canvas.getBoundingClientRect();
      const rect = computeDrawRect();
      const scaleX = rect.width / viewportW;
      const scaleY = rect.height / viewportH;
      const box = info.boundingBox;
      const elCenterX = canvasRect.left + rect.x + (box.x + box.width / 2) * scaleX;
      const elBottomY = canvasRect.top + rect.y + (box.y + box.height) * scaleY;
      const elTopY = canvasRect.top + rect.y + box.y * scaleY;

      const w = Math.round(box.width);
      const h = Math.round(box.height);
      overlay.innerHTML =
        '<span class="selector">' + escapeHtml(info.selector) + '</span>' +
        '<span class="dims">' + w + ' \\u00d7 ' + h + '</span>';

      overlay.classList.remove('visible', 'fading');
      overlay.style.display = 'block';
      overlay.style.left = Math.max(0, Math.min(elCenterX - overlay.offsetWidth / 2, canvasRect.right - overlay.offsetWidth)) + 'px';

      const spaceBelow = window.innerHeight - elBottomY;
      if (spaceBelow > 40) {
        overlay.style.top = (elBottomY + 6) + 'px';
      } else {
        overlay.style.top = (elTopY - overlay.offsetHeight - 6) + 'px';
      }

      requestAnimationFrame(() => overlay.classList.add('visible'));
      overlayTimer = setTimeout(() => {
        overlay.classList.add('fading');
        overlayHideTimer = setTimeout(() => {
          overlayHideTimer = null;
          overlay.classList.remove('visible', 'fading');
          overlay.style.display = 'none';
        }, 300);
      }, 3000);
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      mouseIsDown = true;
      const { x, y } = screenCoords(e, true);
      const modifiers = (e.altKey?1:0) | (e.ctrlKey?2:0) | (e.metaKey?4:0) | (e.shiftKey?8:0);
      vscode.postMessage({ type: 'mousedown', x, y, button: e.button, buttons: e.buttons, clickCount: e.detail, modifiers });
      canvas.focus();
    });

    // Suppress the webview's native editor context menu over the canvas. The right click is forwarded
    // to the page via CDP, which renders the page's own context menu inside the screencast; without this
    // the host menu (Cut/Copy/Paste) would stack on top of it. Scoped to the canvas so the URL bar keeps
    // its native menu.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('mouseup', (e) => {
      if (!mouseIsDown) return;
      mouseIsDown = false;
      const { x, y } = screenCoords(e, false);
      const modifiers = (e.altKey?1:0) | (e.ctrlKey?2:0) | (e.metaKey?4:0) | (e.shiftKey?8:0);
      vscode.postMessage({ type: 'mouseup', x, y, button: e.button, buttons: e.buttons, clickCount: e.detail, modifiers });
    });

    canvas.addEventListener('mousemove', (e) => {
      const { x, y } = screenCoords(e, !mouseIsDown);
      scheduleMove(x, y, e.buttons);
    });

    document.addEventListener('mousemove', (e) => {
      if (!mouseIsDown || e.target === canvas) return;
      const { x, y } = screenCoords(e, false);
      scheduleMove(x, y, e.buttons);
    });

    // A drag whose mouseup lands outside the webview never reaches us, so mouseIsDown would stay set
    // forever and every later move would forward a phantom button-held event. Blur and tab-hide are
    // the two moments we can still prove the drag is over; release it at the last known position so
    // the page's drag handler unwinds instead of sticking.
    function unwindDrag() {
      if (!mouseIsDown) return;
      mouseIsDown = false;
      vscode.postMessage({ type: 'mouseup', x: lastMouseX, y: lastMouseY, button: 0, buttons: 0, clickCount: 1, modifiers: 0 });
    }
    window.addEventListener('blur', unwindDrag);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') unwindDrag();
    });

    // An IME turns a burst of keystrokes into one committed string. Every one of those keystrokes
    // still fires a keydown, so preventDefault-ing or forwarding them starves the IME of the input it
    // needs and duplicates the text the composition is about to commit. While composing we therefore
    // let the events through untouched and send only the committed string on compositionend.
    let isComposing = false;
    canvas.addEventListener('compositionstart', () => { isComposing = true; });
    canvas.addEventListener('compositionupdate', () => { isComposing = true; });
    canvas.addEventListener('compositionend', (e) => {
      isComposing = false;
      const text = e.data || '';
      // An abandoned composition (the user pressed Escape) commits nothing; inserting '' would be a
      // pointless CDP round trip.
      if (text) vscode.postMessage({ type: 'insertText', text });
    });

    // Modifier keys currently held, keyed by code so ShiftLeft and ShiftRight track independently.
    // Windows auto-repeats a held modifier's keydown; re-posting 'down' for one already in the set
    // would emit a stream of duplicate rawKeyDowns, exactly the unnatural input signature this
    // codebase avoids.
    const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta'];
    const heldModifiers = new Set();

    canvas.addEventListener('keydown', (e) => {
      // 'Process' is what Chromium reports for a keystroke the IME swallowed, and 'Dead' is a dead key
      // that produces no character on its own; forwarding either makes accents unproducible.
      // keyCode 229 is the browsers' universal "the IME is handling this key" marker and is the ONLY
      // signal available on the keystroke that STARTS a composition: it fires before compositionstart,
      // so isComposing is still false and e.key is still the raw letter.
      if (isComposing || e.isComposing || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault();
        vscode.postMessage({ type: 'copy' });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
        e.preventDefault();
        vscode.postMessage({ type: 'cut' });
        return;
      }
      e.preventDefault();
      const modifiers = (e.altKey?1:0) | (e.ctrlKey?2:0) | (e.metaKey?4:0) | (e.shiftKey?8:0);
      if (MODIFIER_KEYS.indexOf(e.key) !== -1) {
        if (heldModifiers.has(e.code)) return;
        heldModifiers.add(e.code);
        vscode.postMessage({ type: 'key', key: e.key, code: e.code, text: '', keyCode: e.keyCode, modifiers, phase: 'down' });
        return;
      }
      // AltGr is reported by Windows as ctrlKey && altKey, so a plain !ctrlKey test silently drops
      // every AltGr character (@ { } \\ ~ on many European layouts). Ctrl WITHOUT Alt is a real
      // shortcut and must stay text-free so Ctrl+A still selects all instead of typing an "a".
      const text = (e.key.length === 1 && !e.metaKey && !(e.ctrlKey && !e.altKey)) ? e.key : '';
      vscode.postMessage({ type: 'key', key: e.key, code: e.code, text, keyCode: e.keyCode, modifiers, phase: 'press' });
    });

    // Only modifiers get a keyup: a 'press' already expands to keyDown+keyUp on the host, so a second
    // release for a normal key would double-type it.
    canvas.addEventListener('keyup', (e) => {
      if (MODIFIER_KEYS.indexOf(e.key) === -1) return;
      if (!heldModifiers.delete(e.code)) return;
      const modifiers = (e.altKey?1:0) | (e.ctrlKey?2:0) | (e.metaKey?4:0) | (e.shiftKey?8:0);
      vscode.postMessage({ type: 'key', key: e.key, code: e.code, text: '', keyCode: e.keyCode, modifiers, phase: 'up' });
    });

    document.addEventListener('copy', (e) => {
      if (document.activeElement === urlInput) return;
      e.preventDefault();
      vscode.postMessage({ type: 'copy' });
    });

    document.addEventListener('cut', (e) => {
      if (document.activeElement === urlInput) return;
      e.preventDefault();
      vscode.postMessage({ type: 'cut' });
    });

    document.addEventListener('paste', (e) => {
      if (document.activeElement === urlInput) return;
      e.preventDefault();
      const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      if (text) vscode.postMessage({ type: 'paste', text });
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x, y } = screenCoords(e, true);
      const scale = e.deltaMode === 1 ? 16 : 1;
      vscode.postMessage({ type: 'scroll', x, y, deltaX: e.deltaX * scale, deltaY: e.deltaY * scale });
    }, { passive: false });

    let resizeTimer;
    let contentW = 0;
    let contentH = 0;

    function postResize(width, height) {
      vscode.postMessage({ type: 'resize', width: Math.round(width), height: Math.round(height), dpr: window.devicePixelRatio });
    }

    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          contentW = width;
          contentH = height;
          // Redraw immediately so the panel never blanks while resizing.
          refreshLetterboxColor();
          redraw();
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            postResize(width, height);
          }, 150);
        }
      }
    });
    ro.observe(contentArea);

    // Re-arming resolution listener: monitor moves or zoom changes shift devicePixelRatio,
    // which ResizeObserver does not observe. Re-post a resize and re-arm on the new dpr.
    let dprMediaQuery = null;
    function armDprListener() {
      dprMediaQuery = window.matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)');
      dprMediaQuery.addEventListener('change', onDprChange, { once: true });
    }
    function onDprChange() {
      if (contentW > 0 && contentH > 0) postResize(contentW, contentH);
      redraw();
      armDprListener();
    }
    armDprListener();

    // MUST be the last statement of this script. A webview cannot receive a post before its message
    // listener is attached and every such post is silently dropped, so this is the host's only proof
    // that the webview is listening — it is what the host's resync and screencast start hang off.
    vscode.postMessage({ type: 'ready' });
`;
