// injected.js
// Injected into admin page context by WP plugin. Exposes window.wpDevRuntimeLogs (with UI).
(function (window, document) {
    if (window.wpDevRuntimeLogs) return;

    // ---------- helpers ----------
    function msToHMS(ms) {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    }

    // storage
    var STORAGE_INDEX = 'wpDevRuntimeLogs:pages'; // JSON array of page keys (with metadata)
    var STORAGE_PREFIX = 'wpDevRuntimeLogs:logs::'; // followed by pageKey
    var MAX_LOGS = 5000;
    var MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

    function getPageKey() {
        // include pathname + search to differentiate pages with query strings
        return location.pathname + location.search;
    }

    function loadIndex() {
        try {
            const raw = localStorage.getItem(STORAGE_INDEX);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }

    function saveIndex(idx) {
        try {
            localStorage.setItem(STORAGE_INDEX, JSON.stringify(idx));
        } catch (e) { }
    }

    function addPageToIndex(pageKey) {
        try {
            const idx = loadIndex();
            if (!idx[pageKey]) {
                idx[pageKey] = { firstSeen: Date.now(), lastSeen: Date.now() };
            } else {
                idx[pageKey].lastSeen = Date.now();
            }
            saveIndex(idx);
        } catch (e) { }
    }

    function storageKeyFor(pageKey) {
        return STORAGE_PREFIX + pageKey;
    }

    function savePageLogs(pageKey, logs) {
        try {
            const cutoff = Date.now() - MAX_AGE_MS;
            logs = logs.filter(l => l.ts >= cutoff);
            if (logs.length > MAX_LOGS) logs = logs.slice(logs.length - MAX_LOGS);
            localStorage.setItem(storageKeyFor(pageKey), JSON.stringify(logs));
            addPageToIndex(pageKey);
        } catch (e) { }
    }

    function loadPageLogs(pageKey) {
        try {
            const raw = localStorage.getItem(storageKeyFor(pageKey));
            let logs = raw ? JSON.parse(raw) : [];
            const cutoff = Date.now() - MAX_AGE_MS;
            logs = logs.filter(l => l.ts >= cutoff);

            // migrate: ensure each entry has a datetime string
            let migrated = false;
            for (let i = 0; i < logs.length; i++) {
                const l = logs[i];
                if (!l.datetime) {
                    // if ts exists use it, otherwise generate now
                    const tsVal = (typeof l.ts === 'number' && isFinite(l.ts)) ? l.ts : Date.now();
                    l.datetime = formatDateTime(tsVal);
                    migrated = true;
                }
            }

            // if we migrated, save back deduped/trimmed logs
            if (migrated) {
                savePageLogs(pageKey, logs);
            }

            return logs;
        } catch (e) {
            return [];
        }
    }

    function loadAllPages() {
        const idx = loadIndex();
        return Object.keys(idx).sort((a, b) => idx[b].lastSeen - idx[a].lastSeen);
    }

    function clearPage(pageKey) {
        try {
            localStorage.removeItem(storageKeyFor(pageKey));
            const idx = loadIndex();
            delete idx[pageKey];
            saveIndex(idx);
        } catch (e) { }
    }

    function clearAll() {
        try {
            const pages = loadAllPages();
            pages.forEach(p => localStorage.removeItem(storageKeyFor(p)));
            saveIndex({});
        } catch (e) { }
    }

    function exportPageText(pageKey) {
        const logs = loadPageLogs(pageKey);
        return logs.map(l => {
            const dt = l && l.datetime ? ('[' + l.datetime + '] ') : '';
            const tm = '[' + (l && l.time ? l.time : '') + '] ';
            const txt = l && l.text ? l.text : '';
            return dt + tm + txt;
        }).join('\n');
    }

    function exportAllText() {
        const pages = loadAllPages();
        let out = [];
        pages.forEach(p => {
            out.push('--- PAGE: ' + p + ' ---');
            out.push(exportPageText(p));
        });
        return out.join('\n');
    }

    // Helper to decide log color
    function getLogColor(entry, isOld) {
        let color = '#4ade80'; // default live = green

        if (isOld) {
            color = '#60a5fa'; // saved = blue
        }
        if (entry && (!entry.text || entry.text === '')) {
            color = '#a3a3a3'; // timer tick = gray
        }
        if (entry && entry.text && entry.text.toLowerCase().includes('error')) {
            color = '#f87171'; // error = red
        }
        if (entry && entry.text && entry.text.toLowerCase().includes('manual')) {
            color = '#facc15'; // manual log = yellow
        }

        return color;
    }

    // format a Date into "YYYY-MM-DD HH:MM:SS"
    function formatDateTime(ts) {
        try {
            const d = ts ? new Date(ts) : new Date();
            function exportPageText(pageKey) {
                const logs = loadPageLogs(pageKey);
                return logs.map(l => {
                    const dt = l && l.datetime ? ('[' + l.datetime + '] ') : '';
                    const tm = '[' + (l && l.time ? l.time : '') + '] ';
                    const txt = l && l.text ? l.text : '';
                    return dt + tm + txt;
                }).join('\n');
            }

            function exportAllText() {
                const pages = loadAllPages();
                let out = [];
                pages.forEach(p => {
                    out.push('--- PAGE: ' + p + ' ---');
                    out.push(exportPageText(p));
                });
                return out.join('\n');
            }
            const YYYY = d.getFullYear();
            const MM = String(d.getMonth() + 1).padStart(2, '0');
            const DD = String(d.getDate()).padStart(2, '0');
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            const ss = String(d.getSeconds()).padStart(2, '0');
            return `${YYYY}-${MM}-${DD} ${hh}:${mm}:${ss}`;
        } catch (e) {
            return String(new Date());
        }
    }

    // ---------- single idempotent wpdevruntimelogs:log handler + dedupe ----------
    (function () {
        // recent map to dedupe identical events for a short window (ms)
        if (!window._tc_recent) window._tc_recent = new Map();
        const RECENT_WINDOW = 3000; // ms - treat identical logs within 3s as duplicates

        function makeKey(entry, pageKey) {
            // key uses timestamp + text + pageKey — adjust if you have other unique id
            return (entry && entry.ts ? entry.ts : '') + '|' + (entry && entry.text ? entry.text : '') + '|' + (pageKey || '');
        }

        function pruneRecent() {
            const now = Date.now();
            for (const [k, t] of window._tc_recent) {
                if (now - t > RECENT_WINDOW) window._tc_recent.delete(k);
            }
        }

        function isDuplicate(entry, pageKey) {
            // prune old entries first
            pruneRecent();

            const isTick = (!entry.text || entry.text === '');
            if (isTick) {
                const thisTick = entry.time || '';
                if (window._tc_last_tick_time === thisTick) return true;
                window._tc_last_tick_time = thisTick;
            } else {
                const key = makeKey(entry, pageKey || getPageKey());
                if (window._tc_recent.has(key)) return true;
                // don't set here — let the caller set after handling (to avoid race)
            }
            return false;
        }


        // register a single handler only once
        if (!window._wpDevRuntimeLogsLogHandlerAdded) {
            window._wpDevRuntimeLogsLogHandlerAdded = true;

            document.addEventListener('wpdevruntimelogs:log', function (ev) {
                try {
                    const detail = ev && ev.detail ? ev.detail : {};
                    const entry = detail.entry || detail; // support both shapes
                    const pKey = detail.pageKey || getPageKey();

                    // use the pageKey-aware duplicate check
                    if (isDuplicate(entry, pKey)) return;

                    // dedupe: record this event now
                    const key = makeKey(entry, pKey);
                    window._tc_recent.set(key, Date.now());

                    // ensure page index exists and selector updated
                    try { addPageToIndex(pKey); } catch (e) { /* ignore */ }
                    try { refreshPageSelector(); } catch (e) { /* ignore */ }

                    // append to UI (if flybox is visible / selector matches)
                    try { addLogToFlyBox(entry, false, pKey); } catch (e) { /* ignore */ }

                    try {
                        const isTick = (entry && (!entry.text || entry.text === ''));
                        const label = isTick ? '' : '';
                        // include datetime at the beginning if available
                        const dtPart = entry && entry.datetime ? ('[' + entry.datetime + '] ') : '';
                        const display = isTick
                            ? (dtPart + label + '[' + (entry && entry.time ? entry.time : '') + '] ....')
                            : (dtPart + '[' + (entry && entry.time ? entry.time : '') + '] ' + (entry && entry.text ? entry.text : ''));

                        // only this handler prints live console lines
                        console.log('%c' + display, 'color: green;');

                    } catch (e) { /* ignore console errors */ }

                } catch (err) {
                    // swallow to avoid breaking host page
                    try { console.warn('wpdevruntimelogs handler error', err); } catch (e) { }
                }
            }, { passive: true });
        }
    })();


    // ---------- fly box UI ----------

    // ---------- UI state + position/size helpers ----------
    var STORAGE_UI_STATE = 'wpDevRuntimeLogs:uiState';       // per-page state (object keyed by pageKey)
    var STORAGE_UI_GLOBAL = 'wpDevRuntimeLogs:uiGlobal';     // global UI state (object)

    /* Per-page UI state helpers */
    function loadUIStateIndex() {
        try {
            const raw = localStorage.getItem(STORAGE_UI_STATE);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }
    function saveUIStateIndex(idx) {
        try { localStorage.setItem(STORAGE_UI_STATE, JSON.stringify(idx)); } catch (e) { }
    }
    function getUIStateFor(pageKey) {
        const idx = loadUIStateIndex();
        return idx[pageKey] || { collapsed: false };
    }
    function setUIStateFor(pageKey, state) {
        const idx = loadUIStateIndex();
        idx[pageKey] = state;
        saveUIStateIndex(idx);
    }

    /* Global UI state helpers */
    function loadGlobalUIState() {
        try {
            const raw = localStorage.getItem(STORAGE_UI_GLOBAL);
            return raw ? JSON.parse(raw) : { collapsed: false, mode: 'per-page', left: null, top: null, width: null, height: null };
        } catch (e) {
            return { collapsed: false, mode: 'per-page', left: null, top: null, width: null, height: null };
        }
    }
    function saveGlobalUIState(obj) {
        try { localStorage.setItem(STORAGE_UI_GLOBAL, JSON.stringify(obj)); } catch (e) { }
    }

    /* Helpers to compute and persist layout */
    function ensureNumeric(v, fallback) {
        return (typeof v === 'number' && isFinite(v)) ? v : fallback;
    }

    function getSavedLayout(pageKey) {
        // layout priority: global saved position/size (if set), else per-page stored in per-page ui object if extended
        const g = loadGlobalUIState();
        const out = {
            left: ensureNumeric(g.left, null),
            top: ensureNumeric(g.top, null),
            width: ensureNumeric(g.width, null),
            height: ensureNumeric(g.height, null)
        };
        // If global has no position/size, check per-page state for legacy keys
        if (out.left === null || out.top === null) {
            const p = getUIStateFor(pageKey);
            if (p && (typeof p.left === 'number' || typeof p.top === 'number')) {
                out.left = ensureNumeric(p.left, out.left);
                out.top = ensureNumeric(p.top, out.top);
            }
        }
        if (out.width === null || out.height === null) {
            const p = getUIStateFor(pageKey);
            if (p && (typeof p.width === 'number' || typeof p.height === 'number')) {
                out.width = ensureNumeric(p.width, out.width);
                out.height = ensureNumeric(p.height, out.height);
            }
        }
        return out;
    }

    // function saveLayout(pageKey, layout, persistToGlobal) {
    //     // layout: { left, top, width, height } - numbers or null
    //     if (persistToGlobal) {
    //         const g = loadGlobalUIState();
    //         g.left = ensureNumeric(layout.left, g.left);
    //         g.top = ensureNumeric(layout.top, g.top);
    //         g.width = ensureNumeric(layout.width, g.width);
    //         g.height = ensureNumeric(layout.height, g.height);
    //         saveGlobalUIState(g);
    //     } else {
    //         // save into global as well as per-page so state persists reliably across loads
    //         const g = loadGlobalUIState();
    //         g.left = ensureNumeric(layout.left, g.left);
    //         g.top = ensureNumeric(layout.top, g.top);
    //         g.width = ensureNumeric(layout.width, g.width);
    //         g.height = ensureNumeric(layout.height, g.height);
    //         saveGlobalUIState(g);

    //         const p = getUIStateFor(pageKey);
    //         p.left = ensureNumeric(layout.left, p.left);
    //         p.top = ensureNumeric(layout.top, p.top);
    //         p.width = ensureNumeric(layout.width, p.width);
    //         p.height = ensureNumeric(layout.height, p.height);
    //         setUIStateFor(pageKey, p);
    //     }
    // }


    // compute and apply an initial/desired height for the flybox
    function computeDesiredFlyboxHeight(pageKey) {
        try {
            // prefer explicit saved layout height if available
            const saved = getSavedLayout(pageKey);
            if (saved && typeof saved.height === 'number' && saved.height > 0) {
                return Math.max(120, saved.height); // respect saved height but have a minimum
            }

            // base on number of saved logs
            const logs = loadPageLogs(pageKey) || [];
            const approxLinePx = 20; // approx height per log line
            const headerAndPadding = 90; // allowance for header, selector, padding, etc.
            const desired = Math.min( // clamp to viewport and max
                Math.max(120, logs.length * approxLinePx + headerAndPadding),
                Math.min(window.innerHeight - 80, 800) // never bigger than viewport minus margin; hard cap 800px
            );
            return desired;
        } catch (e) {
            return 200; // fallback
        }
    }

    function applyDesiredFlyboxHeight(box, pageKey) {
        try {
            if (!box) return;
            const g = loadGlobalUIState();
            // respect collapsed states (global or per-page)
            const isCollapsed = (g && g.mode === 'global') ? !!g.collapsed : !!getUIStateFor(pageKey).collapsed;
            if (isCollapsed) {
                // collapsed height (keep as-is)
                box.style.height = (getUIStateFor(pageKey).collapsed ? '20px' : box.style.height || 'auto');
                return;
            }

            // if global saved absolute width/height exists and user explicitly set, prefer it
            const saved = getSavedLayout(pageKey);
            if (saved && typeof saved.height === 'number' && saved.height > 0) {
                box.style.height = Math.max(120, saved.height) + 'px';
                box.style.maxHeight = 'none';
                return;
            }

            const h = computeDesiredFlyboxHeight(pageKey);
            box.style.height = h + 'px';
            // allow scroll inside but keep a sensible maxHeight to avoid covering the whole screen
            box.style.maxHeight = Math.min(window.innerHeight - 80, 800) + 'px';
        } catch (e) { /* ignore */ }
    }

    function clearAllFlyboxLayouts() {
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith('flybox:')) {
                localStorage.removeItem(key);
            }
        });
    }


    // ---------- Fly box UI with minimize/max, draggable, resizable, global/per-page mode ----------
    function createFlyBox() {
        const pageKey = getPageKey();
        let box = document.getElementById('wpdevruntimelogs-flybox');
        if (box) return box; // don't recreate

        // clearAllFlyboxLayouts();

        // --- Configuration / thresholds ---
        const MIN_NORMAL_WIDTH = 100;
        const MIN_NORMAL_HEIGHT = 40;
        const MINIMIZED_WIDTH = 300;
        const MINIMIZED_HEIGHT = 38;

        // base box
        box = document.createElement('div');
        box.id = 'wpdevruntimelogs-flybox';
        Object.assign(box.style, {
            position: 'fixed',
            bottom: '10px',
            right: '10px',
            width: '420px',
            maxHeight: '360px',
            overflow: 'hidden',
            background: '#0f0f13',
            color: '#cfeee0',
            fontFamily: 'monospace',
            fontSize: '12px',
            padding: '6px',
            borderRadius: '8px',
            boxShadow: '0 6px 24px rgba(0,0,0,0.6)',
            zIndex: 999999,
            display: 'flex',
            flexDirection: 'column',
            //transition: 'box-shadow 0.12s ease, height 0.18s ease, width 0.18s ease',
            height: MINIMIZED_HEIGHT + 'px'
        });

        // header (taller now)
        const header = document.createElement('div');
        header.id = 'wpdevruntimelogs-flybox-header';
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '6px',
            marginBottom: '6px',
            cursor: 'move',
            userSelect: 'none',
            padding: '2px 6px',    // increased padding for taller header
            minHeight: '40px',       // explicit taller header
            background: '#111117',
            borderTopLeftRadius: '8px',
            borderTopRightRadius: '8px'
        });

        // title
        const titlewrap = document.createElement('div');
        titlewrap.classList.add('flybox-title');

        const title = document.createElement('div');
        title.classList.add('flybox-title-track');

        title.textContent = 'WPDevRuntimeLogs - Development Logs';
        title.style.fontWeight = '700';
        title.style.fontSize = '13px';
        title.style.lineHeight = '1';

        titlewrap.appendChild(title);

        // header actions container (hidden when collapsed)
        const headerActions = document.createElement('div');
        headerActions.id = 'wpdevruntimelogs-header-actions';
        Object.assign(headerActions.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            marginLeft: 'auto' // pushes all buttons to the right
        });

        // Mode toggle (Per-page / Global)
        const modeBtn = document.createElement('button');
        modeBtn.id = 'wpdevruntimelogs-mode-btn';
        modeBtn.title = 'Toggle mode: per-page / global';
        modeBtn.style.padding = '2px 6px';
        headerActions.appendChild(modeBtn);

        // small action buttons (moved into headerActions)
        const btnClear = document.createElement('button');
        btnClear.id = 'wpdevruntimelogs-clear-btn';
        btnClear.textContent = 'Clear';
        btnClear.style.padding = '4px';
        headerActions.appendChild(btnClear);

        const btnClearAll = document.createElement('button');
        btnClearAll.id = 'wpdevruntimelogs-clearall-btn';
        btnClearAll.textContent = 'Clear All';
        btnClearAll.style.padding = '4px';
        headerActions.appendChild(btnClearAll);

        const btnExport = document.createElement('button');
        btnExport.id = 'wpdevruntimelogs-export-btn';
        btnExport.textContent = 'Export';
        btnExport.style.padding = '4px';
        headerActions.appendChild(btnExport);

        // Copy All Logs button
        const btnCopy = document.createElement('button');
        btnCopy.id = 'wpdevruntimelogs-copy-btn';
        btnCopy.textContent = 'Copy Logs';
        btnCopy.style.padding = '4px';
        headerActions.appendChild(btnCopy);

        // Toggle button (single arrow)
        const btnToggle = document.createElement('button');
        btnToggle.id = 'wpdevruntimelogs-toggle-btn';
        btnToggle.title = 'Minimize / Maximize';
        btnToggle.setAttribute('aria-expanded', 'true');
        Object.assign(btnToggle.style, {
            background: 'transparent',
            color: '#cfeee0',
            border: 'none',
            cursor: 'pointer',
            fontSize: '14px',
            padding: '0 6px',
            marginLeft: '8px',
            lineHeight: '1'
        });
        btnToggle.textContent = '▲'; // default expanded glyph

        // assemble header with inner wrapper so toggle sits at far right
        const headerInner = document.createElement('div');
        Object.assign(headerInner.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            width: '100%'
        });
        headerInner.appendChild(titlewrap);
        header.appendChild(headerInner);
        header.appendChild(btnToggle);

        const headerSub = document.createElement('div');
        Object.assign(headerSub.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            width: '100%'
        });
        // append header early (selector/logArea/resizer created below)
        box.appendChild(header);
        box.appendChild(headerSub);

        // page selector
        const selector = document.createElement('select');
        selector.id = 'wpdevruntimelogs-page-select';
        selector.title = 'Select page logs to view';
        selector.style.fontFamily = 'inherit';
        selector.style.fontSize = '12px';
        selector.style.padding = '0 8px';
        selector.style.marginBottom = '6px';
        selector.style.display = 'block';
        selector.style.boxSizing = 'border-box';

        headerSub.appendChild(selector);
        headerSub.appendChild(headerActions);

        // log area
        const logArea = document.createElement('div');
        logArea.id = 'wpdevruntimelogs-log-area';
        Object.assign(logArea.style, {
            overflowY: 'auto',
            background: '#050507',
            padding: '8px',
            borderRadius: '6px',
            flex: '1 1 auto',
        });
        box.appendChild(logArea);

        // resizer
        const resizer = document.createElement('div');
        resizer.id = 'wpdevruntimelogs-resizer';
        Object.assign(resizer.style, {
            width: '12px',
            height: '12px',
            position: 'absolute',
            right: '6px',
            bottom: '6px',
            cursor: 'se-resize',
            zIndex: 1000000,
            background: 'transparent'
        });
        box.appendChild(resizer);

        // existing copy handler (unchanged)
        btnCopy.addEventListener('click', function () {
            const sel = document.getElementById('wpdevruntimelogs-page-select');
            const pk = sel ? sel.value : getPageKey();
            let text = '';
            if (pk === '__all__') {
                text = exportAllText();
            } else {
                text = exportPageText(pk);
            }
            if (!text) {
                alert('No logs to copy');
                return;
            }

            try {
                navigator.clipboard.writeText(text)
                    .then(() => alert('Logs copied to clipboard!'))
                    .catch(err => {
                        console.warn('Clipboard copy failed', err);
                        alert('Failed to copy logs to clipboard.');
                    });
            } catch (e) {
                console.warn('Clipboard API not supported', e);
                alert('Clipboard API not supported in this browser.');
            }
        });

        // apply saved layout if present, else default bottom-right
        const savedLayout = (typeof getSavedLayout === 'function') ? getSavedLayout(pageKey) : { left: null, top: null, width: null, height: null };
        // if (savedLayout && savedLayout.left !== null && savedLayout.top !== null) {
        //     box.style.left = savedLayout.left + 'px';
        //     box.style.top = savedLayout.top + 'px';
        //     box.style.right = 'auto';
        //     box.style.bottom = 'auto';
        // } else {
        //     box.style.left = 'auto';
        //     box.style.top = 'auto';
        //     box.style.right = '10px';
        //     box.style.bottom = '10px';
        // }
        // if (savedLayout && savedLayout.width !== null) {
        //     box.style.width = Math.max(220, savedLayout.width) + 'px';
        // }
        // if (savedLayout && savedLayout.height !== null) {
        //     box.style.height = Math.max(120, savedLayout.height) + 'px';
        //     box.style.maxHeight = 'none';
        // }

        // compute/adjust initial height dynamically (only if not explicitly saved)
        // try {
        //     if (!savedLayout || savedLayout.height === null) {
        //         if (typeof applyDesiredFlyboxHeight === 'function') {
        //             applyDesiredFlyboxHeight(box, pageKey);
        //         }
        //     } else {
        //         box.style.maxHeight = Math.min(window.innerHeight - 80, 800) + 'px';
        //     }
        // } catch (e) { /* ignore */ }

        // --- collapse/expand behavior ---
        let collapsed = false;

        function setCollapsed(state, skipEmit) {
            collapsed = !!state;
            if (collapsed) {
                // hide extra UI
                headerActions.style.display = 'none';
                selector.style.display = 'none';
                logArea.style.display = 'none';
                resizer.style.display = 'none';

                // shrink height to header and width to fit title + toggle
                const headerHeight = header.offsetHeight || 40;
                box.style.height = headerHeight + 'px';
                box.style.maxHeight = headerHeight + 'px';

                // width: shrink-to-fit but keep a sensible minimum and max limit
                box.style.width = 'fit-content';
                box.style.minWidth = '120px';
                box.style.maxWidth = 'calc(100% - 20px)';

                // adjust padding for collapsed state
                box.style.padding = '2px 6px'; // top/bottom smaller, left/right normal

                btnToggle.textContent = '▼'; // down arrow when expanded (click to collapse)
                btnToggle.setAttribute('aria-expanded', 'false');
            } else {
                // show full UI
                headerActions.style.display = 'flex';
                selector.style.display = 'block';
                logArea.style.display = 'block';
                resizer.style.display = 'block';

                // restore width: prefer saved width, else use default
                const defaultWidth = 420;
                if (savedLayout && savedLayout.width !== null) {
                    box.style.width = Math.max(220, savedLayout.width) + 'px';
                } else {
                    box.style.width = defaultWidth + 'px'; // default expanded width
                }

                // restore height
                const savedH = (savedLayout && savedLayout.height !== null) ? savedLayout.height : null;
                if (savedH !== null) {
                    box.style.height = Math.max(120, savedH) + 'px';
                    box.style.maxHeight = Math.min(window.innerHeight - 80, 800) + 'px';
                } else {
                    box.style.height = '';
                    box.style.maxHeight = Math.min(window.innerHeight - 80, 800) + 'px';
                }

                // restore normal padding for expanded state
                box.style.padding = '6px';

                btnToggle.textContent = '▲'; // up arrow when collapsed (click to expand)
                btnToggle.setAttribute('aria-expanded', 'true');
            }

            if (!skipEmit) {
                try {
                    document.dispatchEvent(new CustomEvent('wpdevruntimelogs:ui-state-change', {
                        detail: { pageKey: pageKey, collapsed: !!collapsed }
                    }));
                } catch (e) { /* ignore */ }
            }
        }

        // apply collapsed/expanded state *after* layout applied
        (function applyInitialCollapsedOnce() {
            const g = (typeof loadGlobalUIState === 'function') ? loadGlobalUIState() : null;
            if (g && g.mode === 'global') {
                if (typeof applyUIState === 'function') applyUIState(g, pageKey, true);
                setCollapsed(!!(g && g.collapsed), true);
            } else {
                const st = (typeof getUIStateFor === 'function') ? getUIStateFor(pageKey) : { collapsed: false };
                if (typeof applyUIState === 'function') applyUIState(st, pageKey, false);
                setCollapsed(!!(st && st.collapsed), true);
            }
        })();

        // click handlers: clear / clearAll / export (unchanged)
        btnClear.addEventListener('click', function () {
            const pk = selector.value || pageKey;
            if (!pk) return;
            const isAll = (pk === '__all__');
            const confirmMsg = isAll
                ? 'Clear ALL stored page logs? This cannot be undone.'
                : ('Clear logs for "' + pk + '"? This cannot be undone.');
            if (!confirm(confirmMsg)) return;

            if (isAll) {
                clearAll();
                try { console.clear(); } catch (e) { /* ignore */ }
                try { document.dispatchEvent(new CustomEvent('wpdevruntimelogs:cleared', { detail: { pageKey: '__all__' } })); } catch (e) { }
                refreshPageSelector();
                renderLogs('__all__');
            } else {
                clearPage(pk);
                try { console.clear(); } catch (e) { /* ignore */ }
                try { document.dispatchEvent(new CustomEvent('wpdevruntimelogs:cleared', { detail: { pageKey: pk } })); } catch (e) { }
                refreshPageSelector();
                renderLogs(pk);
            }
        });

        btnClearAll.addEventListener('click', function () {
            if (!confirm('Clear ALL stored page logs across all pages? This cannot be undone.')) return;
            clearAll();
            try { console.clear(); } catch (e) { /* ignore */ }
            try { document.dispatchEvent(new CustomEvent('wpdevruntimelogs:cleared', { detail: { pageKey: '__all__' } })); } catch (e) { }
            refreshPageSelector();
            renderLogs('__all__');
        });

        window.addEventListener('keydown', function (ev) {
            if (ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === 'l') {
                ev.preventDefault();
                const pk = (document.getElementById('wpdevruntimelogs-page-select') || {}).value || getPageKey();
                if (window.wpDevRuntimeLogs && typeof wpDevRuntimeLogs.clearLogsFor === 'function') {
                    wpDevRuntimeLogs.clearLogsFor(pk);
                }
            }
        });

        btnExport.addEventListener('click', function () {
            const pk = selector.value || pageKey;
            let text = '';
            let filename = 'wpdevruntimelogs_logs.txt';
            if (pk === '__all__') {
                text = exportAllText();
            } else {
                text = exportPageText(pk);
                filename = 'wpdevruntimelogs_logs_' + encodeURIComponent(pk.replace(/[/?&=]/g, '_')) + '.txt';
            }
            const blob = new Blob([text || ''], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.documentElement.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        });

        // Min/Max logic (respects mode) - keep backward-compatible applyUIState
        function applyUIState(stateObj, pk, globalMode) {
            const stateCollapsed = !!(stateObj && stateObj.collapsed);
            if (stateCollapsed) {
                setCollapsed(true, true);
            } else {
                setCollapsed(false, true);
                if (stateObj && typeof stateObj.height === 'number') {
                    box.style.height = Math.max(120, stateObj.height) + 'px';
                    box.style.maxHeight = 'none';
                } else {
                    box.style.height = '';
                    box.style.maxHeight = '360px';
                }
            }
        }

        // Mode button text update
        function updateModeButtonText() {
            const g = (typeof loadGlobalUIState === 'function') ? loadGlobalUIState() : { mode: 'per-page' };
            modeBtn.textContent = (g.mode === 'global') ? 'Mode: Global' : 'Mode: Per-page';
        }

        // init selector and logs
        if (typeof refreshPageSelector === 'function') refreshPageSelector();
        if (typeof renderLogs === 'function') renderLogs(pageKey);

        // set initial mode button text
        updateModeButtonText();

        // --- Storage key helpers ---
        function savedLayoutKey(pageKey) { return `flybox:layout:${pageKey}`; }
        function lastNormalKey(pageKey) { return `flybox:lastNormal:${pageKey}`; }
        function stateKey(pageKey) { return `flybox:state:${pageKey}`; }

        // --- Storage helpers ---
        function saveLayout(pageKey, layout) {
            try { localStorage.setItem(savedLayoutKey(pageKey), JSON.stringify(layout)); } catch (e) { }
        }
        function loadSavedLayout(pageKey) {
            try { const v = localStorage.getItem(savedLayoutKey(pageKey)); return v ? JSON.parse(v) : null; } catch (e) { return null; }
        }
        function saveLastNormalLayout(pageKey, layout) {
            try { localStorage.setItem(lastNormalKey(pageKey), JSON.stringify(layout)); } catch (e) { }
        }
        function loadLastNormalLayout(pageKey) {
            try { const v = localStorage.getItem(lastNormalKey(pageKey)); return v ? JSON.parse(v) : null; } catch (e) { return null; }
        }
        // function removeLastNormalLayout(pageKey) {
        //     try { localStorage.removeItem(lastNormalKey(pageKey)); } catch (e) { }
        // }
        function saveState(pageKey, state) {
            try { localStorage.setItem(stateKey(pageKey), state); } catch (e) { }
        }
        function loadState(pageKey) {
            try { return localStorage.getItem(stateKey(pageKey)); } catch (e) { return null; }
        }
        // function removeState(pageKey) {
        //     try { localStorage.removeItem(stateKey(pageKey)); } catch (e) { }
        // }

        // --- Validation helper (ensure layout looks like a normal size) ---
        function isValidNormalLayout(layout) {
            if (!layout || typeof layout !== 'object') return false;
            const w = Number(layout.width || 0), h = Number(layout.height || 0);
            if (!isFinite(w) || !isFinite(h)) return false;
            return w >= MIN_NORMAL_WIDTH && h >= MIN_NORMAL_HEIGHT;
        }

        // --- Apply layout to DOM element (assumes box exists) ---
        function applyLayout(layout) {
            if (!box || !layout) return;
            if (typeof layout.left !== 'undefined') box.style.left = layout.left + 'px';
            if (typeof layout.top !== 'undefined') box.style.top = layout.top + 'px';
            if (typeof layout.width !== 'undefined') box.style.width = layout.width + 'px';
            if (typeof layout.height !== 'undefined') box.style.height = layout.height + 'px';
        }

        // --- Minimize: save last normal BEFORE applying minimized size ---
        function minimizeFlybox() {
            if (!box) return;

            // Only save last normal if we are currently in normal mode
            const currentState = box.dataset.flyboxState || loadState(pageKey) || 'normal';
            if (currentState !== 'minimized') {
                // capture current layout (try style then offset)
                const current = {
                    left: parseInt(box.style.left || box.offsetLeft || 20, 10),
                    top: parseInt(box.style.top || box.offsetTop || 20, 10),
                    width: parseInt(box.style.width || box.offsetWidth || 760, 10),
                    height: parseInt(box.style.height || box.offsetHeight || 320, 10)
                };
                // Only save if it looks like a real normal layout
                if (isValidNormalLayout(current)) {
                    saveLastNormalLayout(pageKey, current);
                }
            }

            // Apply minimized visuals / classes
            box.classList.add('flybox-minimized');
            box.dataset.flyboxState = 'minimized';
            saveState(pageKey, 'minimized');

            // Set minimized dimensions (do NOT call saveLayout with these values)
            box.style.width = MINIMIZED_WIDTH + 'px';
            box.style.height = MINIMIZED_HEIGHT + 'px';
        }

        // --- Maximize / Restore: prefer lastNormal, else saved, else fallback ---

        function maximizeFlybox() {
            if (!box) return;

            box.classList.remove('flybox-minimized');
            box.dataset.flyboxState = 'normal';
            saveState(pageKey, 'normal');

            let last = loadLastNormalLayout(pageKey);
            const saved = loadSavedLayout(pageKey);

            if (!isValidNormalLayout(last)) last = null;
            const goodSaved = isValidNormalLayout(saved) ? saved : null;

            const layoutToUse = last || goodSaved || { left: 20, top: 20, width: 760, height: 320 };

            applyLayout(layoutToUse);

            // Persist this as the main saved layout (only store normal sizes)
            saveLayout(pageKey, {
                left: layoutToUse.left,
                top: layoutToUse.top,
                width: layoutToUse.width,
                height: layoutToUse.height
            });

            // DON'T remove last normal — keep it so future restores still work.
            // removeLastNormalLayout(pageKey);
        }



        // --- Initialization that runs on page load and restores layout/state ---
        function initFlyboxOnLoad(pageKey, opts = {}) {
            //opts = { debug: true, waitForMs: 50, maxWaitMs: 3000 };
            const debug = !!opts.debug;
            const waitForMs = opts.waitForMs || 50;
            const maxWaitMs = opts.maxWaitMs || 3000;
            const start = Date.now();

            function log(...args) { if (debug) console.log('[flybox:init]', ...args); }

            function tryInit() {
                // stop if exceeded max wait
                if (Date.now() - start > maxWaitMs) {
                    log('timed out waiting for flybox element.');
                    return;
                }

                // find the box element (your variable "box" is used elsewhere; we will attempt to get it too)
                const el = document.getElementById('wpdevruntimelogs-flybox') || box;
                if (!el) {
                    // wait a bit for DOM or JS that constructs the box
                    return setTimeout(tryInit, waitForMs);
                }

                // ensure we reference the same global box variable if used elsewhere
                window.box = el;

                // load state and layouts (use your helpers if available)
                let state = null;
                try { state = loadState ? loadState(pageKey) : localStorage.getItem(`flybox:state:${pageKey}`); } catch (e) { state = null; }
                const lastNormal = (typeof loadLastNormalLayout === 'function') ? loadLastNormalLayout(pageKey) : (function () { try { return JSON.parse(localStorage.getItem(`flybox:lastNormal:${pageKey}`)) } catch (e) { return null } })();
                const saved = (typeof loadSavedLayout === 'function') ? loadSavedLayout(pageKey) : (function () { try { return JSON.parse(localStorage.getItem(`flybox:layout:${pageKey}`)) } catch (e) { return null } })();

                log('loaded state', state, 'lastNormal', lastNormal, 'saved', saved);

                // Helper validation: reuse `isValidNormalLayout` if present, else fallback simple checks
                const validNormal = (layout) => {
                    if (typeof isValidNormalLayout === 'function') return isValidNormalLayout(layout);
                    if (!layout || typeof layout !== 'object') return false;
                    const w = Number(layout.width || 0), h = Number(layout.height || 0);
                    return isFinite(w) && isFinite(h) && w >= 100 && h >= 40;
                };

                // Decide what to do based on persisted state
                if (state === 'minimized') {
                    // If saved normal layout exists, keep it stored but show minimized
                    log('restoring minimized state');
                    // Use your minimize function so it saves lastNormal properly, or just apply minimized visuals:
                    if (typeof minimizeFlybox === 'function') {
                        minimizeFlybox();
                    } else {
                        el.classList.add('flybox-minimized');
                        el.dataset.flyboxState = 'minimized';
                        el.style.width = (typeof MINIMIZED_WIDTH !== 'undefined' ? MINIMIZED_WIDTH : 120) + 'px';
                        el.style.height = (typeof MINIMIZED_HEIGHT !== 'undefined' ? MINIMIZED_HEIGHT : 34) + 'px';
                    }
                    return;
                }

                // Otherwise restore normal
                // Prefer lastNormal if valid; else use saved; else default
                const layoutToUse = validNormal(lastNormal) ? lastNormal : (validNormal(saved) ? saved : { left: 20, top: 20, width: 760, height: 320 });
                log('restoring normal layout', layoutToUse);

                // Use maximizeFlybox if available so it persists correctly
                if (typeof maximizeFlybox === 'function') {
                    // ensure maximizeFlybox uses the layout saved values (our maximize implementation prefers lastNormal then saved)
                    maximizeFlybox();
                    // There is a small chance maximizeFlybox disregards our layoutToUse if load keys are corrupted.
                    // So also force-apply if box size is still invalid afterwards:
                    setTimeout(() => {
                        const w = el.offsetWidth, h = el.offsetHeight;
                        if (!validNormal({ width: w, height: h })) {
                            log('post-maximize size invalid, forcing layout apply');
                            applyLayout(layoutToUse);
                            if (typeof saveLayout === 'function') saveLayout(pageKey, layoutToUse);
                        }
                    }, 30);
                } else {
                    applyLayout(layoutToUse);
                    if (typeof saveLayout === 'function') saveLayout(pageKey, layoutToUse);
                    el.classList.remove('flybox-minimized');
                    el.dataset.flyboxState = 'normal';
                }
            }

            tryInit();
        }


        // --- Auto-run on DOM ready (call with your pageKey) ---
        document.addEventListener('DOMContentLoaded', function () {
            initFlyboxOnLoad(pageKey, { debug: true, waitForMs: 50, maxWaitMs: 3000 });
        });

        // --- Optional: clear everything (for debugging / reset) ---
        function clearAllFlyboxState() {
            try {
                Object.keys(localStorage).forEach(k => {
                    if (k.startsWith('flybox:')) localStorage.removeItem(k);
                });
            } catch (e) { }
        }

        // Read last normal layout
        // function loadLastNormalLayout(pageKey) {
        //     return readRaw(storageKey(pageKey, 'lastNormal'));
        // }

        /* ---------------- Persist helpers ---------------- */
        // If you already have loadLayout/saveLayout functions, these wrappers will use them.
        // Otherwise we fallback to localStorage under keys prefixed with 'flybox:'

        function storageKey(pageKey, suffix) {
            return 'flybox:' + (pageKey || 'global') + ':' + suffix;
        }

        function persistRaw(key, value) {
            try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
        }
        function readRaw(key) {
            try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
        }

        // Returns an object { left, top, width, height } or null
        // function loadSavedLayout(pageKey) {
        //     // Try your app's loadLayout function if present
        //     if (typeof loadLayout === 'function') {
        //         try {
        //             const found = loadLayout(pageKey); // adapt signature if needed
        //             if (found && typeof found === 'object') return found;
        //         } catch (e) { /* fallback */ }
        //     }
        //     // fallback to localStorage
        //     return readRaw(storageKey(pageKey, 'layout'));
        // }

        // Save canonical layout (used by resize/drag/explicit save)
        function persistSavedLayout(pageKey, layout) {
            // Try your app's saveLayout if present (keep its semantics).
            if (typeof saveLayout === 'function') {
                try {
                    saveLayout(pageKey, layout, false);
                } catch (e) {
                    // ignore and fallback to localStorage
                    persistRaw(storageKey(pageKey, 'layout'), layout);
                }
            } else {
                persistRaw(storageKey(pageKey, 'layout'), layout);
            }
        }

        // function lastNormalKey(pageKey) {
        //     return `flybox:lastNormal:${pageKey}`;
        // }

        // function loadLastNormalLayout(pageKey) {
        //     try {
        //         const v = localStorage.getItem(lastNormalKey(pageKey));
        //         return v ? JSON.parse(v) : null;
        //     } catch (e) {
        //         return null;
        //     }
        // }


        // Toggle handler: switch collapse state on current mode
        // improved toggle: preserves last normal layout when minimizing and restores on un-minimize
        btnToggle.addEventListener('click', function (ev) {
            ev.stopPropagation();

            // helper to apply collapse change (keeps original persistence behavior)
            function persistAndApply(isGlobal, key, state) {
                if (isGlobal) {
                    if (typeof saveGlobalUIState === 'function') saveGlobalUIState(state);
                    applyUIState(state, pageKey, true);
                    setCollapsed(!!state.collapsed);
                } else {
                    if (typeof setUIStateFor === 'function') setUIStateFor(key, state);
                    applyUIState(state, pageKey, false);
                    setCollapsed(!!state.collapsed);
                }
            }

            const g = (typeof loadGlobalUIState === 'function') ? loadGlobalUIState() : null;
            if (g && g.mode === 'global') {
                // global mode
                const newCollapsed = !g.collapsed;

                if (newCollapsed) {
                    minimizeFlybox();
                } else {
                    maximizeFlybox();
                }

                g.collapsed = newCollapsed;
                persistAndApply(true, null, g);
            } else {
                // per-page mode
                const pk = selector.value || pageKey;
                const pstate = (typeof getUIStateFor === 'function') ? getUIStateFor(pk) : { collapsed: false };
                const newCollapsed = !pstate.collapsed;


                if (newCollapsed) {
                    minimizeFlybox();
                } else {
                    maximizeFlybox();
                }

                pstate.collapsed = newCollapsed;
                persistAndApply(false, pk, pstate);
            }
        });

        /* ---------------- Apply layout helper ---------------- */
        function applyLayout(layout) {
            if (!layout || !box) return;
            // Defensive: ensure numeric values
            if (typeof layout.left === 'number') {
                box.style.left = Math.round(layout.left) + 'px';
                box.style.right = 'auto';
            }
            if (typeof layout.top === 'number') {
                box.style.top = Math.round(layout.top) + 'px';
                box.style.bottom = 'auto';
            }
            if (typeof layout.width === 'number') {
                box.style.width = Math.round(layout.width) + 'px';
            }
            if (typeof layout.height === 'number') {
                box.style.height = Math.round(layout.height) + 'px';
            }

            // Remove CSS constraints that might block applying sizes
            box.style.maxWidth = 'none';
            box.style.maxHeight = 'none';
            box.style.boxSizing = 'border-box';
        }

        /* ---------------- Minimize / Maximize helpers ---------------- */
        function isMinimized() {
            // Change this if you use a class or attribute for minimized state.
            // We check both a class and a data attribute to be flexible.
            if (!box) return false;
            return box.classList.contains('flybox-minimized') || box.dataset.flyboxState === 'minimized';
        }


        // Mode toggle handler: swap between per-page and global
        modeBtn.addEventListener('click', function () {
            const g = (typeof loadGlobalUIState === 'function') ? loadGlobalUIState() : { mode: 'per-page' };
            g.mode = (g.mode === 'global') ? 'per-page' : 'global';
            if (typeof g.collapsed === 'undefined') g.collapsed = false;
            if (typeof saveGlobalUIState === 'function') saveGlobalUIState(g);
            updateModeButtonText();
            if (g.mode === 'global') {
                applyUIState(g, pageKey, true);
            } else {
                const p = (typeof getUIStateFor === 'function') ? getUIStateFor(pageKey) : { collapsed: false };
                applyUIState(p, pageKey, false);
            }
        });

        // When selector changes, render and apply per-page state (or global if that mode is set)
        selector.addEventListener('change', function () {
            const pk = selector.value;
            if (typeof refreshPageSelector === 'function') refreshPageSelector();
            if (typeof renderLogs === 'function') renderLogs(pk);
            const g = (typeof loadGlobalUIState === 'function') ? loadGlobalUIState() : null;
            if (g && g.mode === 'global') {
                applyUIState(g, pk, true);
            } else {
                const p = (typeof getUIStateFor === 'function') ? getUIStateFor(pk) : { collapsed: false };
                applyUIState(p, pk, false);
            }
        });

        // helper used for saving left/top with sensible fallbacks
        function getSavedLeftTop() {
            // prefer existing helper if you have one elsewhere
            if (typeof getBoxLeftTop === 'function') {
                try {
                    const pos = getBoxLeftTop();
                    if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') return pos;
                } catch (e) {
                    // fall through to computed rect
                }
            }
            // fallback: computed bounding rect
            const rect = box.getBoundingClientRect();
            // Use parseInt on computed style if available (to respect explicit styles)
            const leftStyle = box.style.left ? parseInt(box.style.left, 10) : null;
            const topStyle = box.style.top ? parseInt(box.style.top, 10) : null;
            return {
                left: (leftStyle !== null && !Number.isNaN(leftStyle)) ? leftStyle : Math.round(rect.left),
                top: (topStyle !== null && !Number.isNaN(topStyle)) ? topStyle : Math.round(rect.top)
            };
        }

        /**
         * Return { left, top } in pixels (numbers).
         * Prefers inline styles if present, then computed style, then bounding rect fallback.
         * Put this above the draggable / resizer code.
         */
        function getBoxLeftTop() {
            // 1) Prefer inline style (explicitly set via box.style.left/top)
            if (box && box.style) {
                const inlineLeft = box.style.left;
                const inlineTop = box.style.top;
                if (inlineLeft && inlineLeft !== 'auto' && inlineTop && inlineTop !== 'auto') {
                    const left = parseInt(inlineLeft, 10);
                    const top = parseInt(inlineTop, 10);
                    if (!Number.isNaN(left) && !Number.isNaN(top)) {
                        return { left, top };
                    }
                }
            }

            // 2) Try computed style (may be useful if CSS set left/top)
            try {
                const computed = window.getComputedStyle(box);
                if (computed) {
                    const compLeft = computed.left;
                    const compTop = computed.top;
                    if (compLeft && compLeft !== 'auto' && compTop && compTop !== 'auto') {
                        const left = parseInt(compLeft, 10);
                        const top = parseInt(compTop, 10);
                        if (!Number.isNaN(left) && !Number.isNaN(top)) {
                            return { left, top };
                        }
                    }
                }
            } catch (e) {
                // ignore and fallback to rect
            }

            // 3) Fallback to boundingClientRect (viewport coords)
            const rect = box.getBoundingClientRect();
            return {
                left: Math.round(rect.left),
                top: Math.round(rect.top)
            };
        }

        // // make header draggable (saves layout to global and per-page)
        // (function makeDraggable() {
        //     let dragging = false;
        //     let startX = 0, startY = 0, startLeft = 0, startTop = 0;
        //     header.addEventListener('mousedown', function (ev) {
        //         if (ev.button !== 0) return;
        //         dragging = true;
        //         startX = ev.clientX;
        //         startY = ev.clientY;
        //         const rect = box.getBoundingClientRect();
        //         // ensure explicit left/top so subsequent reads are reliable
        //         box.style.left = (rect.left) + 'px';
        //         box.style.top = (rect.top) + 'px';
        //         box.style.right = 'auto';
        //         box.style.bottom = 'auto';
        //         startLeft = rect.left;
        //         startTop = rect.top;
        //         document.body.style.userSelect = 'none';
        //         box.style.boxShadow = '0 10px 30px rgba(0,0,0,0.7)';
        //         ev.preventDefault();
        //     });

        //     window.addEventListener('mousemove', function (ev) {
        //         if (!dragging) return;
        //         const dx = ev.clientX - startX;
        //         const dy = ev.clientY - startY;
        //         const newLeft = Math.max(6, Math.min(window.innerWidth - 80, startLeft + dx));
        //         const newTop = Math.max(6, Math.min(window.innerHeight - 40, startTop + dy));
        //         box.style.left = newLeft + 'px';
        //         box.style.top = newTop + 'px';
        //         box.style.right = 'auto';
        //         box.style.bottom = 'auto';
        //     });

        //     window.addEventListener('mouseup', function () {
        //         if (!dragging) return;
        //         dragging = false;
        //         document.body.style.userSelect = '';
        //         box.style.boxShadow = '0 6px 24px rgba(0,0,0,0.6)';
        //         // persist layout (save to global and per-page) using robust position getter
        //         const pos = getSavedLeftTop();
        //         const width = box.offsetWidth;
        //         const height = box.offsetHeight;
        //         if (typeof saveLayout === 'function') saveLayout(pageKey, { left: pos.left, top: pos.top, width: width, height: height }, false);
        //     });
        // })();

        // --- Save position when dragging ends
        (function makeDraggable() {
            let dragging = false;
            let startX = 0, startY = 0, startLeft = 0, startTop = 0;

            header.addEventListener('mousedown', function (ev) {
                if (ev.button !== 0) return;
                dragging = true;
                startX = ev.clientX;
                startY = ev.clientY;
                startLeft = box.offsetLeft;
                startTop = box.offsetTop;
                document.body.style.userSelect = 'none';
            });

            document.addEventListener('mousemove', function (ev) {
                if (!dragging) return;
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                box.style.left = (startLeft + dx) + 'px';
                box.style.top = (startTop + dy) + 'px';
            });

            document.addEventListener('mouseup', function () {
                if (!dragging) return;
                dragging = false;
                document.body.style.userSelect = '';

                // --- Persist position
                const state = {
                    left: box.style.left,
                    top: box.style.top
                };
                localStorage.setItem('flybox-position', JSON.stringify(state));
            });
        })();


        // Key used for localStorage
        const FLYBOX_POS_KEY = 'wpdevruntimelogs-flybox-position';

        // Make header draggable and persist position on drag end
        (function makeDraggableAndSave() {
            if (!box || !header) return;
            let dragging = false;
            let startX = 0, startY = 0, startLeft = 0, startTop = 0;

            header.addEventListener('mousedown', function (ev) {
                if (ev.button !== 0) return;
                dragging = true;
                startX = ev.clientX;
                startY = ev.clientY;
                // use offsetLeft/Top (numbers) so we save numeric px values
                startLeft = box.offsetLeft;
                startTop = box.offsetTop;
                document.body.style.userSelect = 'none';
                box.style.transition = 'none'; // turn off transitions while dragging
            });

            document.addEventListener('mousemove', function (ev) {
                if (!dragging) return;
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                box.style.left = (startLeft + dx) + 'px';
                box.style.top = (startTop + dy) + 'px';
            });

            // document.addEventListener('mouseup', function () {
            //     if (!dragging) return;
            //     dragging = false;
            //     document.body.style.userSelect = '';
            //     box.style.boxShadow = ''; // optional cleanup
            //     // Persist position (use numeric px strings)
            //     try {
            //         const pos = {
            //             left: box.style.left || box.offsetLeft + 'px',
            //             top: box.style.top || box.offsetTop + 'px',
            //             // optionally save width/height or mode if you want
            //             timestamp: Date.now()
            //         };
            //         localStorage.setItem(FLYBOX_POS_KEY, JSON.stringify(pos));
            //         // If you have an existing layout persistence helper, call it too
            //         if (typeof saveLastNormalLayout === 'function') {
            //             try { saveLastNormalLayout(); } catch (e) { /* ignore */ }
            //         }
            //     } catch (e) {
            //         console.error('Failed to save flybox position', e);
            //     }
            //     // restore any transitions
            //     box.style.transition = '';
            // });

            document.addEventListener('mouseup', function () {
                if (!dragging) return;
                dragging = false;
                document.body.style.userSelect = '';
                box.style.boxShadow = ''; // optional cleanup

                // normalize left/top into "NNNpx" strings
                function toPx(value, fallback) {
                    if (!value && value !== 0) return fallback;
                    if (typeof value === 'number') return value + 'px';
                    if (/^\d+$/.test(String(value))) return value + 'px';
                    return String(value);
                }

                // compute current left/top (prefer inline style if present, else offset)
                const computedLeft = (box.style.left && box.style.left !== '') ? box.style.left : (box.offsetLeft + 'px');
                const computedTop = (box.style.top && box.style.top !== '') ? box.style.top : (box.offsetTop + 'px');

                const pos = {
                    left: toPx(computedLeft, box.offsetLeft + 'px'),
                    top: toPx(computedTop, box.offsetTop + 'px'),
                    timestamp: Date.now()
                };

                try {
                    // save to localStorage (your fallback/local source of truth)
                    localStorage.setItem(FLYBOX_POS_KEY, JSON.stringify(pos));
                } catch (e) {
                    console.error('Failed to save flybox position to localStorage', e);
                }

                // ALSO update your global UI state object if available so other layout code uses it
                try {
                    if (typeof loadGlobalUIState === 'function' && typeof saveGlobalUIState === 'function') {
                        try {
                            const state = loadGlobalUIState() || {};
                            state.lastNormalLayout = state.lastNormalLayout || {};
                            state.lastNormalLayout.flybox = state.lastNormalLayout.flybox || {};
                            // store left/top in the structure your restore code expects
                            state.lastNormalLayout.flybox.left = pos.left;
                            state.lastNormalLayout.flybox.top = pos.top;
                            saveGlobalUIState(state);
                        } catch (e) {
                            // don't fail the whole flow if global state helpers misbehave
                            console.warn('Could not update global UI state for flybox position', e);
                        }
                    }
                } catch (e) {
                    console.warn('Global UI state helpers unavailable or error', e);
                }

                // Try calling saveLastNormalLayout in a tolerant way:
                if (typeof saveLastNormalLayout === 'function') {
                    try {
                        // If saveLastNormalLayout accepts a payload, pass the flybox part;
                        // if not, calling with the arg will likely be ignored, but catch errors.
                        saveLastNormalLayout({ flybox: { left: pos.left, top: pos.top } });
                    } catch (err) {
                        try {
                            // fallback: call without args
                            saveLastNormalLayout();
                        } catch (err2) {
                            console.warn('saveLastNormalLayout failed both with and without args', err2);
                        }
                    }
                }

                // restore any transitions
                box.style.transition = '';
            });

        })();

        // Try to restore position. Wait until box exists and re-try a few times if needed.
        (function restoreFlyboxPositionWithRetries() {
            function applyPos(pos) {
                if (!pos) return;
                // Only apply if flybox not minimized or if you want to always restore regardless:
                // if (box.classList.contains('flybox-minimized')) return;
                // ensure CSS position supports left/top
                const cs = getComputedStyle(box);
                if (cs.position !== 'absolute' && cs.position !== 'fixed' && cs.position !== 'relative') {
                    box.style.position = 'fixed'; // prefer fixed so it doesn't flow
                }
                // apply values
                if (pos.left) box.style.left = pos.left;
                if (pos.top) box.style.top = pos.top;
            }

            function tryOnce(attempt) {
                if (!box) {
                    // box might not be initialized yet; try again shortly
                    if (attempt <= 10) {
                        setTimeout(() => tryOnce(attempt + 1), 80);
                    }
                    return;
                }

                // 1) Prefer your global saved state if present (so this respects your other logic)
                if (typeof loadGlobalUIState === 'function') {
                    try {
                        const g = loadGlobalUIState();
                        if (g && g.lastNormalLayout && g.lastNormalLayout.flybox && g.lastNormalLayout.flybox.left) {
                            // adjust field names to match how you store them in your global state
                            applyPos(g.lastNormalLayout.flybox);
                            return;
                        }
                    } catch (e) {
                        // ignore and fallback to localStorage
                    }
                }

                // 2) Fallback to localStorage
                const raw = localStorage.getItem(FLYBOX_POS_KEY);
                if (raw) {
                    try {
                        const pos = JSON.parse(raw);
                        applyPos(pos);
                        return;
                    } catch (e) {
                        console.warn('Invalid flybox position in localStorage', e);
                    }
                }

                // 3) If nothing saved yet, do nothing
            }

            // run on DOM ready plus a few retries covering late initialization
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => tryOnce(1));
            } else {
                tryOnce(1);
            }
            // extra safety: re-run after 300ms and 800ms (covers other inits that run after DOM ready)
            setTimeout(() => tryOnce(1), 300);
            setTimeout(() => tryOnce(1), 800);
        })();



        // --- Restore position on load
        (function restoreFlyboxPosition() {
            const state = localStorage.getItem('flybox-position');
            if (state) {
                try {
                    const pos = JSON.parse(state);
                    if (pos.left) box.style.left = pos.left;
                    if (pos.top) box.style.top = pos.top;
                } catch (e) { }
            }
        })();

        // resizer logic
        (function makeResizable() {
            let resizing = false;
            let startX = 0, startY = 0, startW = 0, startH = 0;
            resizer.addEventListener('mousedown', function (ev) {
                if (ev.button !== 0) return;
                resizing = true;
                startX = ev.clientX;
                startY = ev.clientY;

                // Get computed width/height to be safer than offsetWidth in some layouts
                const computed = window.getComputedStyle(box);
                // ensure an explicit inline width/height exist (so style.width changes take effect)
                startW = Math.round(parseFloat(computed.width) || box.offsetWidth || 300);
                startH = Math.round(parseFloat(computed.height) || box.offsetHeight || 200);
                box.style.boxSizing = 'border-box';
                box.style.width = startW + 'px';
                box.style.height = startH + 'px';

                // make position explicit while resizing (so constraints are calculated from left)
                const rect = box.getBoundingClientRect();
                box.style.left = rect.left + 'px';
                box.style.top = rect.top + 'px';
                box.style.right = 'auto';
                box.style.bottom = 'auto';

                // remove any CSS max constraints that might block expansion
                box.style.maxWidth = 'none';
                box.style.maxHeight = 'none';
                box.style.minWidth = '0';
                box.style.minHeight = '0';

                document.body.style.userSelect = 'none';
                ev.preventDefault();
            });

            window.addEventListener('mousemove', function (ev) {
                if (!resizing) return;
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;

                // compute new size, respect reasonable minimums
                const minW = 220;
                const minH = 100;
                let newW = Math.max(minW, Math.round(startW + dx));
                let newH = Math.max(minH, Math.round(startH + dy));

                // clamp width so box doesn't overflow the viewport (respecting left position)
                const pos = getBoxLeftTop();
                const maxAvailableW = Math.max(100, window.innerWidth - pos.left - 6);
                if (newW > maxAvailableW) newW = maxAvailableW;

                // apply sizes as px (inline styles)
                box.style.width = newW + 'px';
                box.style.height = newH + 'px';

                // keep layout explicit while dragging
                box.style.right = 'auto';
                box.style.bottom = 'auto';
            });

            window.addEventListener('mouseup', function () {
                if (!resizing) return;
                resizing = false;
                document.body.style.userSelect = '';

                // Persist the layout
                const pos = getBoxLeftTop();
                const width = box.offsetWidth;
                const height = box.offsetHeight;

                if (typeof saveLayout === 'function') {
                    saveLayout(pageKey, { left: pos.left, top: pos.top, width: width, height: height }, false);
                }
            });


            // helper: read left/top from bounding rect (handles transforms & layout)
            function getBoxLeftTop() {
                const rect = box.getBoundingClientRect();
                // If the box is positioned with fixed/absolute relative to document,
                // compute left/top relative to document scroll
                const left = Math.round(rect.left + window.pageXOffset);
                const top = Math.round(rect.top + window.pageYOffset);
                return { left, top };
            }

            // call this when resizing ends
            function finishResizeAndSave() {
                if (!resizing) return;
                resizing = false;
                document.body.style.userSelect = '';

                // compute final layout using bounding rect for reliability
                const pos = getBoxLeftTop();
                const width = Math.round(box.offsetWidth);
                const height = Math.round(box.offsetHeight);

                const layout = { left: pos.left, top: pos.top, width, height };

                // Save per-page layout if saveLayout exists
                if (typeof saveLayout === 'function') {
                    try {
                        // keep the third param consistent with your API (false = not "last normal" ?)
                        // use `false` to keep current behaviour, and rely on saveLastNormalLayout below
                        saveLayout(pageKey, layout, false);
                    } catch (err) {
                        console.error('saveLayout failed', err);
                    }
                }

                // ALSO update the "last normal" layout that restore uses.
                // Two possibilities depending on your codebase:
                // - If you have a function saveLastNormalLayout(layout) use it.
                // - Otherwise call saveLayout(pageKey, layout, true) if third param `true` means last-normal.
                // Pick whichever matches your project. We'll support both patterns safely:

                // If the box is currently in the 'normal' state (not minimized/maximized), update last-normal.
                const state = box.dataset && box.dataset.flyboxState ? box.dataset.flyboxState : null;

                if (state === 'normal') {
                    if (typeof saveLastNormalLayout === 'function') {
                        try {
                            saveLastNormalLayout(pageKey, layout);
                        } catch (err) {
                            console.error('saveLastNormalLayout failed', err);
                        }
                    } else if (typeof saveLayout === 'function') {
                        try {
                            // If your saveLayout's 3rd param means "isLastNormal", pass true
                            saveLayout(pageKey, layout, true);
                        } catch (err) {
                            console.error('saveLayout(last-normal) failed', err);
                        }
                    } else if (typeof saveGlobalUIState === 'function') {
                        // fallback: if you store global UI state directly
                        try {
                            const g = (typeof loadGlobalUIState === 'function') ? loadGlobalUIState() : {};
                            g.lastNormalLayouts = g.lastNormalLayouts || {};
                            g.lastNormalLayouts[pageKey] = layout;
                            saveGlobalUIState(g);
                        } catch (err) {
                            console.error('saveGlobalUIState failed', err);
                        }
                    }
                } else {
                    // Optionally: If you want resizing while minimized to still update last-normal,
                    // uncomment the block below to always update the last-normal record.
                    /*
                    if (typeof saveLastNormalLayout === 'function') {
                        try { saveLastNormalLayout(pageKey, layout); } catch(e) { console.error(e); }
                    } else if (typeof saveLayout === 'function') {
                        try { saveLayout(pageKey, layout, true); } catch(e) { console.error(e); }
                    }
                    */
                }
            }

            // wire up both mouseup and pointerup so touch devices work reliably
            window.addEventListener('mouseup', finishResizeAndSave, { passive: true });
            window.addEventListener('pointerup', finishResizeAndSave, { passive: true });

        })();


        // finally append box to DOM
        document.body.appendChild(box);

        // ensure mode button text is accurate
        updateModeButtonText();

        // return node
        return box;
    }


    function refreshPageSelector() {
        // get selector element — **do not** create the flybox here (avoids recursion)
        let sel = document.getElementById('wpdevruntimelogs-page-select');
        if (!sel) {
            // selector not present yet; caller should create the flybox first.
            return;
        }

        // clear options
        sel.innerHTML = '';

        // add current page first
        const currentKey = getPageKey();
        const optCurrent = document.createElement('option');
        optCurrent.value = currentKey;
        optCurrent.textContent = '(This page) ' + currentKey;
        sel.appendChild(optCurrent);

        // option all
        const optAll = document.createElement('option');
        optAll.value = '__all__';
        optAll.textContent = 'All pages';
        sel.appendChild(optAll);

        // other pages
        const pages = loadAllPages();
        pages.forEach(p => {
            if (p === currentKey) return;
            const o = document.createElement('option');
            o.value = p;
            o.textContent = p;
            sel.appendChild(o);
        });

        // default select current page (or keep existing if it still exists)
        if (!Array.prototype.slice.call(sel.options).some(o => o.value === sel.value)) {
            sel.value = currentKey;
        }
    }


    // ---------- safe renderLogs (no recursive createFlyBox()) ----------
    function renderLogs(pageKey) {
        // ensure final CSS exists (same rule used by addLogToFlyBox)
        if (!document.getElementById('wpdevruntimelogs-styles')) {
            const s = document.createElement('style');
            s.id = 'wpdevruntimelogs-styles';
            s.textContent = `
            /* final (stop) log style — easily change color here */
            .wpdevruntimelogs-log-final {
                color: orange !important;
                font-weight: 700;
            }
        `;
            document.head.appendChild(s);
        }

        // don't create the flybox here to avoid recursion; caller must ensure it exists
        const area = document.getElementById('wpdevruntimelogs-log-area');
        if (!area) return;

        area.innerHTML = '';
        if (!pageKey) pageKey = getPageKey();

        // helper to detect final/stop logs (same logic as addLogToFlyBox)
        function isFinalLog(l) {
            const txt = (l && l.text) ? String(l.text).trim().toLowerCase() : '';
            const isFinalByTag = l && l._tag && String(l._tag).toLowerCase() === 'stop';
            return isFinalByTag;
        }

        if (pageKey === '__all__') {
            const pages = loadAllPages();
            if (!pages || pages.length === 0) {
                area.textContent = '(no logs)';
                return;
            }
            pages.forEach(p => {
                const header = document.createElement('div');
                header.textContent = '--- PAGE: ' + p + ' ---';
                header.style.color = 'lightgray';
                header.style.fontWeight = '700';
                header.style.marginTop = '6px';
                area.appendChild(header);

                const logs = loadPageLogs(p) || [];
                logs.forEach(l => {
                    const line = document.createElement('div');
                    line.style.whiteSpace = 'pre-wrap';

                    const dtPart = l && l.datetime ? ('[' + l.datetime + '] ') : '';
                    const display = (l && (!l.text || l.text === '')) ?
                        (dtPart + '[' + (l.time || '')) + '] ' :
                        (dtPart + '[' + (l.time || '') + '] ' + (l.text || ''));

                    // Always set the text
                    line.textContent = display;

                    // Decide if this is a final/stop log
                    if (isFinalLog(l)) {
                        line.classList.add('wpdevruntimelogs-log-final');
                        line.dataset.logTag = 'stop';
                    } else {
                        try {
                            const c = typeof getLogColor === 'function' ? getLogColor(l, true) : null;
                            if (c) line.style.color = c;
                        } catch (e) { /* ignore */ }
                    }

                    area.appendChild(line);
                });
            });
            area.scrollTop = area.scrollHeight;
            return;
        }

        // single page
        const logs = loadPageLogs(pageKey) || [];
        if (!logs || logs.length === 0) {
            area.textContent = '(no logs)';
            return;
        }

        logs.forEach(l => {
            const line = document.createElement('div');
            line.style.whiteSpace = 'pre-wrap';

            const dtPart = l && l.datetime ? ('[' + l.datetime + '] ') : '';
            const display = (l && (!l.text || l.text === '')) ?
                (dtPart + '[' + (l.time || '') + '] ') :
                (dtPart + '[' + (l.time || '') + '] ' + (l.text || ''));

            line.textContent = display;

            // l is an old/saved log when rendering from storage
            if (isFinalLog(l)) {
                line.classList.add('wpdevruntimelogs-log-final');
                line.dataset.logTag = 'stop';
            } else {
                try {
                    const c = typeof getLogColor === 'function' ? getLogColor(l, true) : null;
                    if (c) line.style.color = c;
                } catch (e) { /* ignore */ }
            }

            area.appendChild(line);
        });

        area.scrollTop = area.scrollHeight;
    }


    // ---------- safe addLogToFlyBox (creates flybox only if safe) ----------

    function addLogToFlyBox(entry, isOld, pageKeyOfLog) {
        try {
            // ensure flybox exists
            if (!document.getElementById('wpdevruntimelogs-flybox')) {
                try { createFlyBox(); } catch (e) { return; }
            }

            entry = entry || { time: '', text: '' };
            pageKeyOfLog = pageKeyOfLog || getPageKey();

            // normalize keys
            function normalizeKey(k) {
                if (!k) return '';
                try {
                    k = String(k).trim();
                    try { k = decodeURIComponent(k); } catch (e) { }
                    if (k.length > 1 && k.endsWith('/')) k = k.slice(0, -1);
                    return k;
                } catch (e) {
                    return String(k || '');
                }
            }

            // ensure CSS for final log exists (only once)
            if (!document.getElementById('wpdevruntimelogs-styles')) {
                const s = document.createElement('style');
                s.id = 'wpdevruntimelogs-styles';
                s.textContent = `
                /* final (stop) log style — easily change color here */
                .wpdevruntimelogs-log-final {
                    color: orange !important;
                    font-weight: 700;
                }
            `;
                document.head.appendChild(s);
            }

            const selEl = document.getElementById('wpdevruntimelogs-page-select');
            const selValue = selEl && selEl.value ? String(selEl.value) : null;
            const normalizedSel = normalizeKey(selValue);
            const normalizedLogKey = normalizeKey(pageKeyOfLog);
            const normalizedCurrent = normalizeKey(getPageKey());

            // decide whether to append
            const shouldAppend =
                !selEl ||
                selValue === '__all__' ||
                (normalizedSel && normalizedSel === normalizedLogKey) ||
                (normalizedSel === normalizedCurrent && normalizedLogKey === normalizedCurrent);

            if (!shouldAppend) return;

            // ensure log area exists
            let area = document.getElementById('wpdevruntimelogs-log-area');
            if (!area) {
                const box = document.getElementById('wpdevruntimelogs-flybox');
                if (!box) return;
                area = document.createElement('div');
                area.id = 'wpdevruntimelogs-log-area';
                Object.assign(area.style, {
                    overflowY: 'auto',
                    background: '#050507',
                    padding: '8px',
                    borderRadius: '6px',
                    flex: '1 1 auto'
                });
                box.appendChild(area);
            }

            // build line
            const dtPart = entry && entry.datetime ? ('[' + entry.datetime + '] ') : '';
            let displayText;
            if (!entry.text || entry.text === '') {
                displayText = dtPart + '[' + (entry.time || '') + '] ....'; // <<< Option A suffix
            } else {
                displayText = dtPart + '[' + (entry.time || '') + '] ' + (entry.text || '');
            }

            const line = document.createElement('div');
            line.textContent = displayText;
            line.style.whiteSpace = 'pre-wrap';

            // Decide if this is a final/stop log (match tag or text case-insensitively)
            const txt = (entry.text || '').trim().toLowerCase();
            const isFinalByTag = entry && entry._tag && String(entry._tag).toLowerCase() === 'stop';
            const isFinal = isFinalByTag;

            if (isFinal) {
                // use CSS class for final logs so it's easy to restyle globally
                line.classList.add('wpdevruntimelogs-log-final');
                // also add a data attribute in case you want JS hooks
                line.dataset.logTag = 'stop';
            } else {
                // fallback to existing color logic
                try {
                    const c = getLogColor ? getLogColor(entry, isOld) : null;
                    if (c) line.style.color = c;
                } catch (e) {
                    // ignore and leave default color
                }
            }

            area.appendChild(line);
            area.scrollTop = area.scrollHeight;

            // gently expand flybox if needed (but do not override explicit saved layout)
            try {
                const box = document.getElementById('wpdevruntimelogs-flybox');
                if (box) {
                    // compute desired height but only apply if it increases current height
                    const desired = computeDesiredFlyboxHeight(pageKeyOfLog);
                    const cur = parseInt(box.style.height, 10) || box.offsetHeight || 0;
                    if (desired > cur && (!getSavedLayout(pageKeyOfLog) || getSavedLayout(pageKeyOfLog).height === null)) {
                        // animate a smoother change
                        box.style.transition = 'height 0.18s ease';
                        box.style.height = Math.min(desired, Math.min(window.innerHeight - 80, 800)) + 'px';
                    }
                }
            } catch (e) { /* ignore */ }

        } catch (err) {
            console.warn('wpDevRuntimeLogs.addLogToFlyBox error', err);
        }
    }

    // --- helpers ---
    function sanitizeText(input) {
        if (input === undefined || input === null) return '';
        // stringify non-strings so we can inspect objects/arrays (but the result will be filtered out if empty)
        let s = (typeof input === 'string') ? input : (typeof input === 'object' ? JSON.stringify(input) : String(input));

        // replace common HTML entity for NBSP and NBSP unicode
        s = s.replace(/&nbsp;/gi, ' ').replace(/\u00A0/g, ' ');

        // Try to remove entire Unicode "Other" category (control/format/invisible). If engine doesn't support \p{}, fallback.
        try {
            s = s.replace(/\p{C}/gu, ''); // removes control/format/invisible characters
        } catch (e) {
            // fallback - remove common invisible/control ranges
            s = s.replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u0600-\u0605\u061C\u06DD\u070F\u17B4-\u17B5\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, '');
        }

        // collapse whitespace, trim
        s = s.replace(/\s+/g, ' ').trim();

        return s;
    }

    function isMeaningful(sanitizedOrRaw) {
        // accepts raw or sanitized; sanitize again is harmless
        const s = sanitizeText(sanitizedOrRaw);
        if (!s) return false;

        // If the string is only punctuation/symbols (e.g. "..." or "—" or "!!!"), treat as non-meaningful.
        try {
            if (/^[\p{P}\p{S}]+$/u.test(s)) return false;
        } catch (e) {
            // fallback: approximate punctuation-only check (ASCII-heavy)
            if (/^[\W_]+$/.test(s)) return false;
        }

        // everything else counts as meaningful
        return true;
    }


    // --- debug helper: run this if blanks still appear ---
    function debugSkippedEntries(logs) {
        const skipped = [];
        for (let i = 0; i < logs.length; i++) {
            const l = logs[i];
            if (!l) continue;
            const raw = l.text;
            const sanitized = sanitizeText(raw);
            const meaningful = isMeaningful(sanitized);
            if (!meaningful) {
                // only include ones where raw had something (so we can inspect weird invisible chars / objects)
                // include also entries where sanitized is empty but raw looked non-empty
                if (raw !== undefined && raw !== null && String(raw).length > 0) {
                    skipped.push({
                        index: i,
                        datetime: l.datetime,
                        time: l.time,
                        rawPreview: String(raw).slice(0, 200),
                        rawType: Object.prototype.toString.call(raw),
                        sanitizedPreview: sanitized.slice(0, 200)
                    });
                }
            }
        }
        console.table(skipped);
        return skipped;
    }


    // ---------- WPDevRuntimeLogs class (per-page) ----------
    class WPDevRuntimeLogs {
        constructor() {
            this.startTime = null;
            this.elapsed = 0;
            this.running = false;
            this.pageKey = getPageKey();
            this.logs = loadPageLogs(this.pageKey); // restore logs for this page
            this.timerId = null;

            // register page in index
            addPageToIndex(this.pageKey);

            // create fly box UI and populate selector
            try {
                createFlyBox();
                refreshPageSelector();
                renderLogs(this.pageKey);
                // debugSkippedEntries(this.logs);
            } catch (e) { }
        }

        start() {
            if (this.running) return;
            this.startTime = Date.now();
            this.running = true;

            // create and dispatch initial tick (UI update happens via event handler)
            this._saveTick();

            // start repeating console ticker and save each tick
            this.timerId = setInterval(() => {
                try {
                    const entry = this._saveTick(); // this dispatches the event
                } catch (e) { }
            }, 1000 * 30);
        }


        stop() {
            if (!this.running) return;

            // update elapsed and stop running
            this.elapsed += Date.now() - this.startTime;
            this.running = false;
            this.startTime = null;

            // clear repeating timer
            if (this.timerId) {
                clearInterval(this.timerId);
                this.timerId = null;
            }

            // log final runtime with text
            const entry = this.log('[FINISHED]', { dispatch: false, tag: 'stop' });
            addLogToFlyBox(entry, false, this.pageKey);
        }


        reset() {
            this.elapsed = 0;
            this.startTime = this.running ? Date.now() : null;
            this.log('reset');
        }

        getTimeMs() {
            let total = this.elapsed || 0;
            if (this.running && this.startTime) total += Date.now() - this.startTime;
            return total;
        }

        getTime() {
            return msToHMS(this.getTimeMs());
        }


        // internal: create a tick log (no text, just time) and persist
        // now accepts options: { dispatch: true|false, tag: 'tick'|'stop' }
        _saveTick(options = {}) {
            const { dispatch = true, tag = 'tick' } = options;
            try {
                const nowTs = Date.now();
                const entry = {
                    ts: nowTs,
                    datetime: formatDateTime(nowTs),
                    time: this.getTime(), // elapsed HH:MM:SS
                    text: '',
                    _fromTC: true,
                    _tag: tag // optional marker so UI can show "stopped" differently
                };
                this.logs.push(entry);
                savePageLogs(this.pageKey, this.logs);

                // optionally dispatch event — UI will be updated by the single global listener
                if (dispatch) {
                    try {
                        var ev = new CustomEvent('wpdevruntimelogs:log', { detail: { entry: entry, pageKey: this.pageKey } });
                        document.dispatchEvent(ev);
                    } catch (e) { /* ignore */ }
                }

                return entry;
            } catch (e) {
                try { console.log('[wpDevRuntimeLogs._saveTick error]', e); } catch (er) { }
                return null;
            }
        }


        // public manual log
        log(text, options = {}) {
            try {
                const nowTs = Date.now();
                const entry = {
                    ts: nowTs,
                    datetime: formatDateTime(nowTs),
                    time: this.getTime(),
                    text: (typeof text === 'undefined' || text === null) ? '' : String(text),
                    _fromTC: true
                };
                this.logs.push(entry);
                savePageLogs(this.pageKey, this.logs);

                // dispatch event — DO NOT call addLogToFlyBox() here to avoid duplication
                try {
                    if (!options || options.dispatch !== false) {
                        var ev = new CustomEvent('wpdevruntimelogs:log', { detail: { entry: entry, pageKey: this.pageKey } });
                        document.dispatchEvent(ev);
                    }
                } catch (e) { }

                return entry;
            } catch (e) {
                try { console.log('[wpDevRuntimeLogs.log error]', e); } catch (er) { }
            }
        }



        getLogs() {
            // return a copy of current page logs
            return this.logs.slice();
        }

        // get logs for any page
        getLogsFor(pageKey) {
            return loadPageLogs(pageKey);
        }

        clearLogs() {
            this.logs = [];
            savePageLogs(this.pageKey, this.logs);
            // update UI
            refreshPageSelector();
            renderLogs(this.pageKey);
        }

        clearLogsFor(pageKey) {
            clearPage(pageKey);
            refreshPageSelector();
            if (pageKey === this.pageKey) {
                this.logs = [];
                renderLogs(this.pageKey);
            }
        }


        // --- exports ---
        exportText() {
            const lines = [];
            for (let i = 0; i < this.logs.length; i++) {
                const l = this.logs[i];
                if (!l) continue;

                const txt = sanitizeText(l.text);
                if (!isMeaningful(txt)) continue; // skip entries with no visible meaningful text

                const dt = l.datetime ? `[${l.datetime}] ` : '';
                const tm = `[${l.time || ''}] `;
                lines.push(dt + tm + txt);
            }
            return lines.join('\n');
        }

        exportCSV() {
            function quote(val) {
                const s = String(val === null || typeof val === 'undefined' ? '' : val);
                return '"' + s.replace(/"/g, '""') + '"';
            }

            const rows = [['datetime', 'time', 'text', 'timestamp'].map(quote).join(',')];

            for (let i = 0; i < this.logs.length; i++) {
                const l = this.logs[i];
                if (!l) continue;

                const txt = sanitizeText(l.text);
                if (!isMeaningful(txt)) continue;

                const dt = l.datetime || '';
                const t = l.time || '';
                const ts = (typeof l.ts !== 'undefined' && l.ts !== null) ? l.ts : '';

                rows.push([quote(dt), quote(t), quote(txt), quote(ts)].join(','));
            }

            return rows.join('\n');
        }

        download(filename, mime) {
            var content = (mime && mime.indexOf('csv') !== -1) ? this.exportCSV() : this.exportText();
            var blob = new Blob([content], { type: mime || 'text/plain' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = filename || 'wpdevruntimelogs_logs.txt';
            document.documentElement.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        }
    }

    // ---------- instantiate ----------
    var instance = new WPDevRuntimeLogs();

    Object.defineProperty(window, 'wpDevRuntimeLogs', {
        configurable: true,
        enumerable: true,
        value: instance,
        writable: false
    });

    // convenience shims (same as before, plus page-level functions)
    window.wpDevRuntimeLogsLog = function (t) { return instance.log(t); };
    window.wpDevRuntimeLogsStart = function () { return instance.start(); };
    window.wpDevRuntimeLogsStop = function () { return instance.stop(); };
    window.wpDevRuntimeLogsReset = function () { return instance.reset(); };
    window.wpDevRuntimeLogsGetLogs = function () { return instance.getLogs(); };
    window.wpDevRuntimeLogsClear = function () { return instance.clearLogs(); };
    window.wpDevRuntimeLogsExportText = function () { return instance.exportText(); };
    window.wpDevRuntimeLogsExportCSV = function () { return instance.exportCSV(); };
    window.wpDevRuntimeLogsDownload = function (fn, mime) { return instance.download(fn, mime); };

    // additional helpers for multi-page control
    window.wpDevRuntimeLogsGetPages = function () { return loadAllPages(); };
    window.wpDevRuntimeLogsGetLogsFor = function (p) { return instance.getLogsFor(p); };
    window.wpDevRuntimeLogsClearFor = function (p) { return instance.clearLogsFor(p); };
    window.wpDevRuntimeLogsClearAll = function () { clearAll(); refreshPageSelector(); renderLogs('__all__'); };
    window.wpDevRuntimeLogsExportAllText = function () { return exportAllText(); };

    window.wpDevRuntimeLogsHelper = function (action, t, m) {
        switch (action) {
            case 'log':
                return instance.log(t);
            case 'start':
                return instance.start();
            case 'stop':
                return instance.stop();
            case 'reset':
                return instance.reset();
            case 'get':
                return instance.getLogs();
            case 'clear':
                return instance.clearLogs();
            default:
        }
    };

    try { console.info('wpDevRuntimeLogs injected (window.wpDevRuntimeLogs) on admin — per-page storage enabled'); } catch (e) { }

})(window, document);
