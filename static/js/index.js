const DEFAULT_PAGE = 'TCB';
const DATA_ROW_SELECTOR = '#mainTable tbody tr:not(.empty-state-row)';

// Build API URLs that work when hosted under an IIS Application path (e.g. /CDAT_Goaling).
// This avoids calling /api/... at the site root (which returns 404 when the app is mounted under /CDAT_Goaling).
function getAppBasePath() {
    const segs = window.location.pathname.split('/').filter(Boolean);
    // If hosted under /CDAT_Goaling, the first path segment will be CDAT_Goaling.
    return (segs.length > 0 && segs[0].toLowerCase() === 'cdat_goaling') ? `/${segs[0]}` : '';
}

function apiUrl(path) {
    const base = getAppBasePath();
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalized}`;
}

function getCurrentPageFromUrl() {
    // Canonical style: query-string page selector.
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('page') || DEFAULT_PAGE;
}

function getDataRows() {
    return document.querySelectorAll(DATA_ROW_SELECTOR);
}

function stripSortGlyphs(label) {
    return (label || '').replace(/[⇕⇑⇓]/g, '').trim();
}

function calculateTrFromGoalAndMor(goalVal, morVal) {
    if (!morVal) return '';
    const trVal = Number((goalVal / morVal).toFixed(1));
    return trVal === 0 ? '' : trVal;
}

function setInputDirtyState(input, isDirty) {
    input.classList.toggle('input-dirty', isDirty);
}

// --- Toasts (lightweight) ---
function showToast(message, type = 'info', timeoutMs = 2800) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);

    setTimeout(() => {
        el.classList.add('toast-hide');
        setTimeout(() => el.remove(), 250);
    }, timeoutMs);
}

async function safeReadJsonResponse(res) {
    // IIS/proxy can return HTML on errors; don't explode on res.json().
    const raw = await res.text();
    if (!raw) return { raw: '', json: null };
    try {
        return { raw, json: JSON.parse(raw) };
    } catch {
        return { raw, json: null };
    }
}

    // --- Add New Goal modal (Index page) ---
    // index.html calls openModal()/closeModal()/submitNewGoal() from inline onclick handlers.
    // These must be global (window.*) so the HTML can find them.
    window.openModal = function openModal() {
        const overlay = document.getElementById('modalOverlay');
        if (!overlay) return;
        overlay.classList.add('active');

        // Optional: focus first input for faster entry.
        const first = overlay.querySelector('input, textarea, select, button');
        if (first) setTimeout(() => first.focus(), 0);
    };

    window.closeModal = function closeModal() {
        const overlay = document.getElementById('modalOverlay');
        if (!overlay) return;
        overlay.classList.remove('active');
    };

    window.submitNewGoal = async function submitNewGoal() {
        const overlay = document.getElementById('modalOverlay');
        if (!overlay) return;

        const btn = document.getElementById('btn-modal-submit');
        if (btn) btn.disabled = true;

        try {
            // Collect fields by IDs if present; otherwise fallback to common name patterns.
            const pickVal = (id, selector) => {
                const el = (id ? document.getElementById(id) : null) || overlay.querySelector(selector);
                return el ? (el.value ?? '').toString().trim() : '';
            };

            // Index modal uses explicit IDs (n_pg3, n_oper, n_goal, n_reason, n_entity).
            const prodgroup3 = pickVal('n_pg3', '#n_pg3');
            const operation = pickVal('n_oper', '#n_oper');
            const entity = pickVal('n_entity', '#n_entity');
            const goal = pickVal('n_goal', '#n_goal');
            const reason = pickVal('n_reason', '#n_reason');

            // Optional legacy fields (not currently present in the index modal UI).
            const shiftStartWip = pickVal('modal-shift_start_wip', 'input[name="shift_start_wip"], input[data-field="shift_start_wip"], #shift_start_wip');

            // Minimal validation.
            if (!prodgroup3 || !operation) {
                showToast('Prodgroup3 and Operation are required.', 'error');
                return;
            }

            const payload = {
                prodgroup3,
                operation,
                // Only include entity when present in the UI.
                ...(entity ? { entity } : {}),
                shift_start_wip: shiftStartWip === '' ? 0 : shiftStartWip,
                goal: goal === '' ? 0 : goal,
                goal_adjusted_reason: reason,
                page: getCurrentPageFromUrl(),
            };

            const res = await fetch(apiUrl('/api/add-new-goal'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            const { json, raw } = await safeReadJsonResponse(res);
            if (!res.ok) {
                const msg = (json && (json.error || json.message)) ? (json.error || json.message) : (raw || `HTTP ${res.status}`);
                showToast(`Add failed: ${msg}`, 'error');
                return;
            }

            // Easiest + safest in production: refresh the page so server renders the new row consistently.
            window.closeModal();
            window.location.reload();
        } catch (err) {
            showToast(`Add failed: ${err?.message || err}`, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    };

// --- In-place editing (no version history) ---
// Mirror the Test page behavior: debounce saves and update the existing row.
const _indexAutoSaveTimers = new Map();

function _indexAutoSaveKey(rowId, type) {
    return `${rowId}|${type}`;
}

function scheduleIndexAutoSave(row, type, delayMs = 650) {
    if (!row) return;
    const rowId = row.getAttribute('data-id');
    if (!rowId) return;

    const key = _indexAutoSaveKey(rowId, type);
    if (_indexAutoSaveTimers.has(key)) {
        clearTimeout(_indexAutoSaveTimers.get(key));
    }

    _indexAutoSaveTimers.set(key, setTimeout(async () => {
        await saveIndexRowInPlace(row, type, { silent: true });
    }, delayMs));
}

async function saveIndexRowInPlace(row, type, { silent = false } = {}) {
    if (!row) return;
    const id = row.getAttribute('data-id');
    if (!id) return;

    let url = '';
    let payload = { id: id };

    if (type === 'goal') {
        const rawGoal = row.querySelector('.goal-input')?.value ?? '';
        const reasonVal = (row.querySelector('.reason-input')?.value ?? '').trim();

        if ((rawGoal !== '' && reasonVal === '') || (rawGoal === '' && reasonVal !== '')) {
            if (!silent) showToast('Both Manual Goal and Adjust Reason must be filled.', 'error');
            return;
        }

        url = apiUrl('/api/update-goal-inplace');
        payload.manual_goal = rawGoal === '' ? 0 : rawGoal;
        payload.reason = reasonVal;
    } else if (type === 'comment') {
        url = apiUrl('/api/update-comment-inplace');
        payload.comment = row.querySelector('.comment-input')?.value ?? '';
    } else {
        return;
    }

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || data.status !== 'success') {
            if (!silent) showToast('Server Error: ' + (data.message || 'Unknown'), 'error');
            return;
        }

        if (!silent) showToast('Saved successfully', 'success');

        // Mark inputs clean.
        if (type === 'goal') {
            const goalInput = row.querySelector('.goal-input');
            const reasonInput = row.querySelector('.reason-input');
            if (goalInput) {
                goalInput.setAttribute('data-original', String(goalInput.value ?? ''));
                goalInput.classList.remove('input-dirty');
            }
            if (reasonInput) {
                reasonInput.setAttribute('data-original', String(reasonInput.value ?? ''));
                reasonInput.classList.remove('input-dirty');
            }

            // Update TR cell from server response.
            const trTd = row.querySelector('td[data-col="tr"]');
            if (trTd && data && typeof data.tr !== 'undefined') {
                const n = Number(data.tr);
                trTd.textContent = Number.isFinite(n) ? n.toFixed(1) : String(data.tr ?? '');
            }
        } else if (type === 'comment') {
            const commentInput = row.querySelector('.comment-input');
            if (commentInput) {
                commentInput.setAttribute('data-original', String(commentInput.value ?? ''));
                commentInput.classList.remove('input-dirty');
            }
        }

        // Keep totals/progress current.
        calculateTotals();
    } catch (e) {
        if (!silent) showToast('Network error, please try again.', 'error');
    }
}

document.addEventListener("DOMContentLoaded", function () {
    // --- Highlight Active Tab ---
    const currentPage = getCurrentPageFromUrl();
    const links = document.querySelectorAll('.nav-tabs a.tab-link[href]');

    let found = false;
    links.forEach(link => {
        const href = link.getAttribute('href') || '';
        if (href.includes(`page=${currentPage}`)) {
            link.classList.add('active');
            found = true;
        } else {
            link.classList.remove('active');
        }
    });

    if (!found) {
        const defaultLink = document.querySelector('.nav-tabs .tab-link[href*="page=TCB"]');
        if (defaultLink) defaultLink.classList.add('active');
    }

    // --- FLEXIBLE COLUMN VISIBILITY ---
    const columnVisibilityConfig = {
        'entity': ['TCB', 'HBC-JDC', 'DIA', 'BA', 'EPX'],
        'subcell_info': ['TCB', 'DIA', 'BA']
    };

    const activePage = currentPage;

    for (const [colName, allowedPages] of Object.entries(columnVisibilityConfig)) {
        if (!allowedPages.includes(activePage)) {
            const columnElements = document.querySelectorAll(`[data-col="${colName}"]`);
            columnElements.forEach(el => { el.style.display = 'none'; });
        }
    }

    // --- PINNED COLUMN OFFSETS ---
    // Compute sticky `left` offsets from the real rendered widths to prevent overlap
    // across browsers/zoom and when columns are hidden (e.g., Entity).
    updatePinnedColumnOffsets();
    window.addEventListener('resize', () => {
        // Use rAF to coalesce rapid resize events.
        window.requestAnimationFrame(updatePinnedColumnOffsets);
    });

    // --- DEFAULT SORT (ASC): ENTITY if visible, otherwise PRODGROUP3 ---
    applyDefaultSort();

    // Calculate totals on initial page load
    calculateTotals();
});

function updatePinnedColumnOffsets() {
    const table = document.getElementById('mainTable');
    if (!table) return;

    const headerRow = table.querySelector('thead tr:first-child');
    if (!headerRow) return;

    const getWidthIfVisible = (colName) => {
        const th = headerRow.querySelector(`th[data-col="${colName}"]`);
        if (!th) return 0;
        if (th.style.display === 'none') return 0;
        // offsetWidth includes padding and borders - exactly what sticky needs.
        return th.offsetWidth || 0;
    };

    const w1 = getWidthIfVisible('prodgroup3');
    const w2 = getWidthIfVisible('operation');
    const w3 = getWidthIfVisible('shift_start_wip');

    // Entity might be hidden on some pages.
    const left1 = 0;
    const left2 = left1 + w1;
    const left3 = left2 + w2;
    const left4 = left3 + w3;

    table.style.setProperty('--pinned-left-1', `${left1}px`);
    table.style.setProperty('--pinned-left-2', `${left2}px`);
    table.style.setProperty('--pinned-left-3', `${left3}px`);
    table.style.setProperty('--pinned-left-4', `${left4}px`);

    // Ensure the divider after the pinned columns always exists, even when Entity is hidden.
    updatePinnedLastDivider(table);
}

function updatePinnedLastDivider(table) {
    if (!table) return;

    // Clear any previous marker.
    table.querySelectorAll('.pinned-last').forEach(el => el.classList.remove('pinned-last'));

    const headerRow = table.querySelector('thead tr:first-child');
    if (!headerRow) return;

    const isVisible = (el) => {
        if (!el) return false;
        if (el.style && el.style.display === 'none') return false;
        return el.getClientRects && el.getClientRects().length > 0;
    };

    // Determine which pinned index is the last visible one.
    const lastPinnedIdx = ['pinned-4', 'pinned-3', 'pinned-2', 'pinned-1']
        .find(cls => isVisible(headerRow.querySelector(`th.${cls}`)));
    if (!lastPinnedIdx) return;

    // Apply pinned-last to all cells (thead/tbody/tfoot) belonging to that pinned column.
    table.querySelectorAll(`.${lastPinnedIdx}`).forEach(el => {
        if (!isVisible(el)) return;
        if (el.classList.contains('pinned-col')) {
            el.classList.add('pinned-last');
        }
    });
}

function applyDefaultSort() {
    const table = document.getElementById('mainTable');
    if (!table) return;

    const thead = table.querySelector('thead tr:first-child');
    if (!thead) return;

    const entityTh = thead.querySelector('th[data-col="entity"]');
    const pg3Th = thead.querySelector('th[data-col="prodgroup3"]');
    const hasEntity = !!(entityTh && entityTh.style.display !== 'none');

    // Default sort contract:
    // - If ENTITY visible: sort by ENTITY ASC, then PRODGROUP3 ASC.
    // - Else: sort by PRODGROUP3 ASC.
    if (hasEntity) {
        sortByMultipleAsc(['entity', 'prodgroup3']);
    } else if (pg3Th) {
        sortByMultipleAsc(['prodgroup3']);
    }
}

function sortByMultipleAsc(colNames) {
    const table = document.getElementById('mainTable');
    if (!table) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll('tr:not(.empty-state-row)'));
    if (rows.length === 0) return;

    // Clear any sort glyphs/state.
    table.querySelectorAll('th.sortable').forEach(el => {
        el.setAttribute('data-sort', '');
        const icon = el.querySelector('.sort-icon');
        if (icon) icon.innerText = '⇕';
    });

    // Set the first sort column glyph to ASC.
    const first = colNames && colNames.length ? colNames[0] : null;
    if (first) {
        const th = table.querySelector(`thead tr:first-child th.sortable[data-col="${first}"]`);
        if (th) {
            th.setAttribute('data-sort', 'asc');
            const icon = th.querySelector('.sort-icon');
            if (icon) icon.innerText = '⇑';
        }
    }

    rows.sort((a, b) => {
        for (const col of colNames) {
            const tdA = a.querySelector(`td[data-col="${col}"]`);
            const tdB = b.querySelector(`td[data-col="${col}"]`);
            const valA = getCellValue(tdA);
            const valB = getCellValue(tdB);
            const cmp = valA.localeCompare(valB);
            if (cmp !== 0) return cmp;
        }
        return 0;
    });

    rows.forEach(row => tbody.appendChild(row));
}

function forceSortAscending(thElement, colName) {
    // sortTable() toggles based on data-sort, so clear state first to guarantee ASC.
    thElement.setAttribute('data-sort', '');
    sortTable(thElement, colName);
    if (thElement.getAttribute('data-sort') !== 'asc') {
        // Safety: if anything weird happened, click-sort one more time.
        sortTable(thElement, colName);
    }
}

// --- Calculate Totals Function ---
function calculateTotals() {
    const rows = getDataRows();
    let totalShiftStartWip = 0, totalTr = 0, totalOutput = 0, totalSystem = 0, totalManual = 0;
    const seenProdgroup3ForShiftStartWip = new Set();

    rows.forEach(row => {
        if (row.style.display === 'none') return; // Skip filtered rows

        const parseNumberOrNull = (rawVal) => {
            const strVal = String(rawVal ?? '').trim();
            if (!strVal || strVal.toLowerCase() === 'na') return null;
            const parsed = parseFloat(strVal);
            return Number.isNaN(parsed) ? null : parsed;
        };

        const getVal = (col) => {
            const td = row.querySelector(`td[data-col="${col}"]`);
            if (!td) return 0;
            const input = td.querySelector('input');
            const val = input ? input.value : td.textContent;
            return parseFloat(val) || 0;
        };

        const getAdjustedGoalForTotal = () => {
            const adjustedTd = row.querySelector('td[data-col="manual_goal"]');
            const goalTd = row.querySelector('td[data-col="system_goal"]');

            const adjustedInput = adjustedTd ? adjustedTd.querySelector('input') : null;
            const adjustedRaw = adjustedInput ? adjustedInput.value : (adjustedTd ? adjustedTd.textContent : '');
            const adjustedVal = parseNumberOrNull(adjustedRaw);
            if (adjustedVal !== null) return adjustedVal;

            const goalRaw = goalTd ? goalTd.textContent : '';
            return parseNumberOrNull(goalRaw) ?? 0;
        };

        const prodgroup3Td = row.querySelector('td[data-col="prodgroup3"]');
        const prodgroup3Key = getCellValue(prodgroup3Td).trim();
        if (!seenProdgroup3ForShiftStartWip.has(prodgroup3Key)) {
            totalShiftStartWip += getVal('shift_start_wip');
            seenProdgroup3ForShiftStartWip.add(prodgroup3Key);
        }

        totalTr += getVal('tr');
        totalOutput += getVal('output');
        totalSystem += getVal('system_goal');
        totalManual += getAdjustedGoalForTotal();
    });

    document.getElementById('total-shift_start_wip').textContent = totalShiftStartWip === 0 ? '' : parseFloat(totalShiftStartWip.toFixed(3));
    document.getElementById('total-tr').textContent = totalTr === 0 ? '' : parseFloat(totalTr.toFixed(1));
    document.getElementById('total-output').textContent = totalOutput === 0 ? '' : parseFloat(totalOutput.toFixed(3));
    document.getElementById('total-system_goal').textContent = totalSystem === 0 ? '' : parseFloat(totalSystem.toFixed(3));
    document.getElementById('total-manual_goal').textContent = totalManual === 0 ? '' : parseFloat(totalManual.toFixed(3));

    updateMainProgressBars();
}

// --- Progress column (Output / Goal) ---
function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

function formatPercent(pct) {
    if (!Number.isFinite(pct)) return '';
    return `${Math.round(pct)}%`;
}

function parseNumber(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return 0;
    const n = parseFloat(s);
    return Number.isNaN(n) ? 0 : n;
}

function ensureProgressCell(td) {
    if (!td) return null;
    if (td.querySelector('.progress-wrap')) return td;

    td.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'progress-wrap';

    const track = document.createElement('div');
    track.className = 'progress-track';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    track.appendChild(fill);

    const label = document.createElement('span');
    label.className = 'progress-label';
    label.textContent = '';

    wrap.appendChild(track);
    wrap.appendChild(label);
    td.appendChild(wrap);
    return td;
}

function setProgress(td, outputVal, goalVal) {
    if (!td) return;
    ensureProgressCell(td);

    const fill = td.querySelector('.progress-fill');
    const label = td.querySelector('.progress-label');
    if (!fill || !label) return;

    const outN = parseNumber(outputVal);
    const goalN = parseNumber(goalVal);

    let pct = 0;
    if (goalN > 0) pct = (outN / goalN) * 100;

    const pctClamped = (window.ProgressScale && window.ProgressScale.clamp)
        ? window.ProgressScale.clamp(pct, 0, 200)
        : clamp(pct, 0, 200);

    const pctForWidth = (window.ProgressScale && window.ProgressScale.clamp)
        ? window.ProgressScale.clamp(pctClamped, 0, 100)
        : clamp(pctClamped, 0, 100);
    fill.style.width = `${pctForWidth}%`;

    fill.classList.remove('is-ok', 'is-warn', 'is-bad');
    const cls = (window.ProgressScale && window.ProgressScale.classifyProgress)
        ? window.ProgressScale.classifyProgress(pct, outN, goalN)
        : (goalN <= 0 && outN <= 0 ? '' : (pct >= 100 ? 'is-ok' : (pct >= 70 ? 'is-warn' : 'is-bad')));
    if (cls) fill.classList.add(cls);

    label.textContent = goalN > 0 ? formatPercent(pct) : '';
    td.title = goalN > 0 ? `${outN} / ${goalN} (${pct.toFixed(1)}%)` : `${outN} / ${goalN}`;
}

function getAdjustedGoalTextForRow(row) {
    if (!row) return '';
    const adjustedTd = row.querySelector('td[data-col="manual_goal"]');
    const adjustedInput = adjustedTd ? adjustedTd.querySelector('input') : null;
    const adjustedRaw = adjustedInput ? adjustedInput.value : (adjustedTd ? adjustedTd.textContent : '');
    const adjustedNum = parseFloat(String(adjustedRaw ?? '').trim());
    if (Number.isFinite(adjustedNum)) return String(adjustedNum);

    const goalTd = row.querySelector('td[data-col="system_goal"]');
    return goalTd ? goalTd.textContent : '';
}

function updateMainProgressBars() {
    const table = document.getElementById('mainTable');
    if (!table) return;

    // Per-row progress
    getDataRows().forEach(row => {
        const tdProgress = row.querySelector('td[data-col="progress"]');
        if (!tdProgress) return;

        const tdOut = row.querySelector('td[data-col="output"]');
        const outVal = getCellValue(tdOut, false);
        const goalVal = getAdjustedGoalTextForRow(row);
        setProgress(tdProgress, outVal, goalVal);
    });

    // Footer total progress
    const footerProgress = document.getElementById('total-progress');
    const footerOut = document.getElementById('total-output');
    const footerGoal = document.getElementById('total-manual_goal');
    if (footerProgress && footerOut && footerGoal) {
        setProgress(footerProgress, footerOut.textContent, footerGoal.textContent);
    }
}

// --- Helper: Get cell value (handles standard text and input fields) ---
// toLower boolean handles lowercase for sorting/filtering vs exact casing for CSV export
function getCellValue(td, toLower = true) {
    if (!td) return "";
    const input = td.querySelector('input.table-input');
    let val = input ? input.value.trim() : td.textContent.trim();
    return toLower ? val.toLowerCase() : val;
}

// --- EXPORT CSV LOGIC ---
function exportToCSV() {
    const visibleCols = getVisibleColumns();
    const visibleRows = getVisibleDataRows();

    if (visibleCols.length === 0) {
        showToast('No table data to export.', 'error');
        return;
    }

    const csvContent = [];

    // 2. Extract and format Headers
    const headerData = visibleCols.map(th => {
        const text = stripSortGlyphs(th.textContent); // Remove sort arrows
        return `"${text.replace(/"/g, '""')}"`;
    });
    csvContent.push(headerData.join(','));

    // 3. Extract Row Data (Only rows that are NOT filtered out)
    visibleRows.forEach(row => {
        const rowData = visibleCols.map(th => {
            const colName = th.getAttribute('data-col');
            const td = row.querySelector(`td[data-col="${colName}"]`);
            const val = getCellValue(td, false); // false = keep original casing for CSV
            return `"${val.replace(/"/g, '""')}"`;
        });
        csvContent.push(rowData.join(','));
    });

    // 4. Create and trigger download
    const csvString = csvContent.join('\n');
    const blob = new Blob(["\uFEFF" + csvString], { type: 'text/csv;charset=utf-8;' }); // \uFEFF = Excel BOM
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);

    const dateStr = new Date().toISOString().split('T')[0];
    link.setAttribute("href", url);
    const pageName = getCurrentPageFromUrl();
    link.setAttribute("download", `CDAT_Goaling_${pageName}_${dateStr}.csv`);
    link.style.visibility = 'hidden';

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function getVisibleColumns() {
    const table = document.getElementById("mainTable");
    if (!table) return [];

    const thead = table.querySelector("thead tr:first-child");
    if (!thead) return [];

    return Array.from(thead.querySelectorAll("th")).filter(th => th.style.display !== 'none');
}

function getVisibleDataRows() {
    const table = document.getElementById("mainTable");
    if (!table) return [];

    const tbody = table.querySelector("tbody");
    if (!tbody) return [];

    return Array.from(tbody.querySelectorAll("tr:not(.empty-state-row)")).filter(row => row.style.display !== 'none');
}

function buildTableClipboardText() {
    const visibleCols = getVisibleColumns();
    const visibleRows = getVisibleDataRows();

    if (visibleCols.length === 0) {
        return '';
    }

    const headerLine = visibleCols
        .map(th => stripSortGlyphs(th.textContent))
        .join('\t');

    const bodyLines = visibleRows.map(row => {
        const rowCells = visibleCols.map(th => {
            const colName = th.getAttribute('data-col');
            const td = row.querySelector(`td[data-col="${colName}"]`);
            return getCellValue(td, false).replace(/[\t\r\n]+/g, ' ').trim();
        });
        return rowCells.join('\t');
    });

    return [headerLine, ...bodyLines].join('\n');
}

async function copyTableToClipboard() {
    const clipboardText = buildTableClipboardText();

    if (!clipboardText) {
        showToast('No table data to copy.', 'error');
        return;
    }

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(clipboardText);
            showToast('Table copied to clipboard.', 'success');
            return;
        }

        const textArea = document.createElement('textarea');
        textArea.value = clipboardText;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        const copied = document.execCommand('copy');
        document.body.removeChild(textArea);

        if (!copied) {
            throw new Error('Copy command was rejected');
        }

        showToast('Table copied to clipboard.', 'success');
    } catch (error) {
        showToast('Copy failed. Please try again.', 'error');
    }
}

// --- FILTERING LOGIC ---
function applyFilters() {
    const filterInputs = document.querySelectorAll('.filter-input-field');
    const filters = Array.from(filterInputs).map(inp => ({
        col: inp.getAttribute('data-filter-col'),
        val: inp.value.trim().toLowerCase()
    })).filter(f => f.val !== "");

    const rows = getDataRows();

    rows.forEach(row => {
        let isMatch = true;
        for (let f of filters) {
            const td = row.querySelector(`td[data-col="${f.col}"]`);
            const cellVal = getCellValue(td);
            if (!cellVal.includes(f.val)) {
                isMatch = false;
                break;
            }
        }
        row.style.display = isMatch ? '' : 'none';
    });

    // Recalculate totals after filtering
    calculateTotals();
}

// --- SORTING LOGIC ---
function sortTable(thElement, colName) {
    const table = document.getElementById("mainTable");
    const tbody = table.querySelector("tbody");
    const rows = Array.from(tbody.querySelectorAll("tr:not(.empty-state-row)"));

    if (rows.length === 0) return;

    let dir = 'asc';
    if (thElement.getAttribute('data-sort') === 'asc') dir = 'desc';

    table.querySelectorAll('th.sortable').forEach(el => {
        el.setAttribute('data-sort', '');
        el.querySelector('.sort-icon').innerText = '⇕';
    });

    thElement.setAttribute('data-sort', dir);
    thElement.querySelector('.sort-icon').innerText = dir === 'asc' ? '⇑' : '⇓';

    const numericCols = ['shift_start_wip', 'qtg1', 'qps1', 'stg1', 'qtg2', 'qps2', 'stg2', 'mor', 'tr', 'output', 'system_goal', 'manual_goal', 'progress'];
    const isNumeric = numericCols.includes(colName);

    rows.sort((a, b) => {
        const tdA = a.querySelector(`td[data-col="${colName}"]`);
        const tdB = b.querySelector(`td[data-col="${colName}"]`);

    // Progress is computed: output / effective goal.
    if (colName === 'progress') {
        const outA = getCellValue(a.querySelector('td[data-col="output"]'), false);
        const outB = getCellValue(b.querySelector('td[data-col="output"]'), false);
        const goalA = getAdjustedGoalTextForRow(a);
        const goalB = getAdjustedGoalTextForRow(b);
        const goalAN = parseNumber(goalA);
        const goalBN = parseNumber(goalB);
        const pctA = goalAN > 0 ? (parseNumber(outA) / goalAN) * 100 : -1;
        const pctB = goalBN > 0 ? (parseNumber(outB) / goalBN) * 100 : -1;
        return dir === 'asc' ? pctA - pctB : pctB - pctA;
    }

    let valA = getCellValue(tdA);
    let valB = getCellValue(tdB);

        if (isNumeric) {
            valA = parseFloat(valA) || 0;
            valB = parseFloat(valB) || 0;
            return dir === 'asc' ? valA - valB : valB - valA;
        } else {
            return dir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
    });

    rows.forEach(row => tbody.appendChild(row));
}

// --- Interaction Logic (Save/Cancel/Input) ---
function handleInput(input, type) {
    const row = input.closest('tr');
    const rowId = row.getAttribute('data-id');
    const val = input.value;
    const original = input.getAttribute('data-original');

    setInputDirtyState(input, String(val) !== String(original));

    let actionGroup;
    if (type === 'goal') {
        actionGroup = document.getElementById(`group-goal-${rowId}`);
        const goalInput = row.querySelector('.goal-input');
        const reasonInput = row.querySelector('.reason-input');

        const isGoalDirty = String(goalInput.value) !== String(goalInput.getAttribute('data-original'));
        const isReasonDirty = String(reasonInput.value) !== String(reasonInput.getAttribute('data-original'));

    // No Save/Cancel UX: save in-place (debounced) like test.html.
    if (isGoalDirty || isReasonDirty) scheduleIndexAutoSave(row, 'goal');

        const goalVal = parseFloat(goalInput.value) || 0;
        const mor = parseFloat(row.querySelector('.mor-val').innerText) || 0;
        row.querySelector('.tr-val').innerText = calculateTrFromGoalAndMor(goalVal, mor);

        // Recalculate totals dynamically as the user types
    calculateTotals();
    } else if (type === 'comment') {
        actionGroup = document.getElementById(`group-comment-${rowId}`);
    if (String(val) !== String(original)) scheduleIndexAutoSave(row, 'comment');
    } else if (type === 'entity') {
        actionGroup = document.getElementById(`group-entity-${rowId}`);
        if (String(val).trim() !== String(original).trim()) showActions(actionGroup);
        else hideActions(actionGroup);
    }
}

function showActions(group) { if (group) group.querySelectorAll('.btn-mini').forEach(b => b.style.display = 'block'); }
function hideActions(group) { if (group) group.querySelectorAll('.btn-mini').forEach(b => b.style.display = 'none'); }

function cancelRow(btn, type) {
    const row = btn.closest('tr');
    const actionGroup = btn.closest('.action-group');

    if (type === 'goal') {
        const goalInput = row.querySelector('.goal-input');
        const reasonInput = row.querySelector('.reason-input');

        goalInput.value = goalInput.getAttribute('data-original');
        reasonInput.value = reasonInput.getAttribute('data-original');
        goalInput.classList.remove('input-dirty');
        reasonInput.classList.remove('input-dirty');

        const goalVal = parseFloat(goalInput.value) || 0;
        const mor = parseFloat(row.querySelector('.mor-val').innerText) || 0;
        row.querySelector('.tr-val').innerText = calculateTrFromGoalAndMor(goalVal, mor);

        // Recalculate totals back to original
        calculateTotals();
    } else if (type === 'comment') {
        const commentInput = row.querySelector('.comment-input');
        commentInput.value = commentInput.getAttribute('data-original');
        commentInput.classList.remove('input-dirty');
    } else if (type === 'entity') {
        const entityInput = row.querySelector('.entity-input');
        entityInput.value = entityInput.getAttribute('data-original') || '';
        entityInput.classList.remove('input-dirty');
    }
    hideActions(actionGroup);
}

// --- EPX ENTITY inline edit (no Save/Cancel buttons) ---
function entityStartEdit(input) {
    if (!input) return;
    // Ensure original is captured (template sets data-original already).
    if (input.getAttribute('data-original') === null) {
        input.setAttribute('data-original', String(input.value ?? ''));
    }
}

function entityHandleKeydown(evt, input) {
    if (!evt || !input) return;
    if (evt.key === 'Enter') {
        evt.preventDefault();
        entityCommitEdit(input);
        input.blur();
    } else if (evt.key === 'Escape') {
        evt.preventDefault();
        entityRevertEdit(input);
        input.blur();
    }
}

function entityRevertEdit(input) {
    const row = input.closest('tr');
    if (!row) return;
    const original = input.getAttribute('data-original') ?? '';
    input.value = original;
    input.classList.remove('input-dirty');
}

async function entityCommitEdit(input) {
    const row = input.closest('tr');
    if (!row) return;

    const id = row.getAttribute('data-id');
    if (!id) return;

    const original = String(input.getAttribute('data-original') ?? '');
    const current = String(input.value ?? '');
    if (current.trim() === original.trim()) {
        input.classList.remove('input-dirty');
        return;
    }

    // Optimistic UI state.
    input.disabled = true;

    try {
        const res = await fetch(apiUrl('/api/update-entity'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, entity: current })
        });
        const data = await res.json();
        if (!res.ok || data.status !== 'success') {
            showToast('Server Error: ' + (data.message || 'Unknown'), 'error');
            entityRevertEdit(input);
        } else {
            showToast('Saved successfully', 'success');
            input.setAttribute('data-original', current);
            input.classList.remove('input-dirty');
        }
    } catch (e) {
        showToast('Network error, please try again.', 'error');
        entityRevertEdit(input);
    } finally {
        input.disabled = false;
    }
}

async function saveRow(btn, type) {
    const row = btn.closest('tr');
    const id = row.getAttribute('data-id');

    // Legacy entrypoint (old Save buttons). Index page is now test-style (auto-save, latest-only).
    // Keep this function as a safe shim in case cached HTML still calls it.
    try {
        if (!row || !id) return;

        if (type === 'goal' || type === 'comment') {
            await saveIndexRowInPlace(row);
        } else if (type === 'entity') {
            const input = row.querySelector('.entity-input');
            if (input) await saveEntityInPlace(input);
        }
    } catch (e) {
        // saveIndexRowInPlace/saveEntityInPlace already toast.
    }
}


async function saveAllGoalChanges() {
    // Legacy bulk-save button. Keep it working, but perform latest-only in-place saves.
    const rows = getDataRows();
    const dirtyRows = rows.filter(r => r && r.style.display !== 'none' && rowIsDirty(r));
    if (dirtyRows.length === 0) {
        showToast('No changes to save.', 'error');
        return;
    }

    const btn = document.querySelector('button[onclick="saveAllGoalChanges()"]');
    const originalText = btn ? btn.innerText : '';
    if (btn) {
        btn.innerText = '...';
        btn.disabled = true;
    }

    let ok = 0;
    let err = 0;
    for (const row of dirtyRows) {
        try {
            const res = await saveIndexRowInPlace(row);
            if (res && res.ok) ok++;
            else err++;
        } catch (e) {
            err++;
        }
    }

    if (err === 0) {
        showToast(`Saved ${ok} change(s).`, 'success');
    } else {
        showToast(`Saved ${ok} change(s), ${err} failed.`, 'error');
    }

    if (btn) { btn.innerText = originalText; btn.disabled = false; }

    // Edit these template strings when you want to change the draft format.
    const recipient = 'wanji.chen@intel.com';
    const subject = 'Goaling UI Issue';

    const params = new URLSearchParams(window.location.search);
    const pageFromQuery = params.get('page') || 'N/A';
    const pageUrl = window.location.href;
    const reportedAt = new Date().toLocaleString();

    const bodyLines = [
        'Hi Team,',
        '',
        'I found an issue in the Goaling Report.',
        '',
        `Page: ${pageFromQuery}`,
        `URL: ${pageUrl}`,
        `Reported at: ${reportedAt}`,
        'Details: ',
        'Screenshot: '
    ];

    const encodedSubject = encodeURIComponent(subject);
    const encodedBody = encodeURIComponent(bodyLines.join('\r\n'));
    link.href = `mailto:${recipient}?subject=${encodedSubject}&body=${encodedBody}`;

    return ok;
}

// --- Row deletion (soft-delete) ---
window.confirmDeleteIndexRow = async function confirmDeleteIndexRow(btnEl) {
    const row = btnEl && btnEl.closest ? btnEl.closest('tr') : null;
    const id = row ? row.getAttribute('data-id') : null;
    if (!row || !id) return;

    const pg3 = (row.querySelector('td[data-col="prodgroup3"]')?.textContent || '').trim();
    const oper = (row.querySelector('td[data-col="operation"]')?.textContent || '').trim();
    const entity = (row.querySelector('td[data-col="entity"] input')?.value || row.querySelector('td[data-col="entity"]')?.textContent || '').trim();

    const msg = `Delete this row?\n\nProdgroup3: ${pg3}\nOperation: ${oper}${entity ? `\nEntity: ${entity}` : ''}\n\nThis will delete the record.`;
    if (!window.confirm(msg)) return;

    // Prevent double-click.
    btnEl.disabled = true;
    try {
        const res = await fetch(apiUrl('/api/delete-row'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id })
        });

        const { raw, json } = await safeReadJsonResponse(res);
        if (!res.ok || !json || json.status !== 'success') {
            const msg = (json && json.message) ? json.message : (raw ? raw.slice(0, 240) : `HTTP ${res.status}`);
            throw new Error(msg);
        }

        row.remove();
        calculateTotals();
        showToast('Row deleted.', 'success');
    } catch (e) {
        showToast(String(e.message || e), 'error');
    } finally {
        btnEl.disabled = false;
    }
};
