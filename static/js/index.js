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
    const trVal = Number((goalVal / morVal).toFixed(3));
    return trVal === 0 ? '' : trVal;
}

function setInputDirtyState(input, isDirty) {
    input.classList.toggle('input-dirty', isDirty);
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
    document.getElementById('total-tr').textContent = totalTr === 0 ? '' : parseFloat(totalTr.toFixed(3));
    document.getElementById('total-output').textContent = totalOutput === 0 ? '' : parseFloat(totalOutput.toFixed(3));
    document.getElementById('total-system_goal').textContent = totalSystem === 0 ? '' : parseFloat(totalSystem.toFixed(3));
    document.getElementById('total-manual_goal').textContent = totalManual === 0 ? '' : parseFloat(totalManual.toFixed(3));
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

    const numericCols = ['shift_start_wip', 'qtg1', 'qps1', 'mor', 'tr', 'output', 'system_goal', 'manual_goal'];
    const isNumeric = numericCols.includes(colName);

    rows.sort((a, b) => {
        const tdA = a.querySelector(`td[data-col="${colName}"]`);
        const tdB = b.querySelector(`td[data-col="${colName}"]`);

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

        if (isGoalDirty || isReasonDirty) showActions(actionGroup);
        else hideActions(actionGroup);

        const goalVal = parseFloat(goalInput.value) || 0;
        const mor = parseFloat(row.querySelector('.mor-val').innerText) || 0;
        row.querySelector('.tr-val').innerText = calculateTrFromGoalAndMor(goalVal, mor);

        // Recalculate totals dynamically as the user types
        calculateTotals();
    } else if (type === 'comment') {
        actionGroup = document.getElementById(`group-comment-${rowId}`);
        if (String(val) !== String(original)) showActions(actionGroup);
        else hideActions(actionGroup);
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

    const url = (type === 'goal')
        ? apiUrl('/api/update-goal')
        : (type === 'comment')
            ? apiUrl('/api/update-comment')
            : apiUrl('/api/update-entity');
    let payload = { id: id };

    if (type === 'goal') {
        const rawGoal = row.querySelector('.goal-input').value;
        const reasonVal = row.querySelector('.reason-input').value.trim();

        if ((rawGoal !== '' && reasonVal === '') || (rawGoal === '' && reasonVal !== '')) {
            showToast('Both Manual Goal and Adjust Reason must be filled.', 'error');
            if (rawGoal === '') row.querySelector('.goal-input').focus();
            else row.querySelector('.reason-input').focus();
            return;
        }

        payload.manual_goal = rawGoal === '' ? 0 : rawGoal;
        payload.reason = reasonVal;
    } else if (type === 'comment') {
        payload.comment = row.querySelector('.comment-input').value;
    } else if (type === 'entity') {
        payload.entity = row.querySelector('.entity-input').value;
    }

    const originalText = btn.innerText;
    btn.innerText = '...';
    btn.disabled = true;

    try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (data.status === 'success') {
            showToast('Saved successfully', 'success');

            // Keep current sort order: do NOT reload the page.
            // Instead, update the inputs' original values and hide action buttons.
            const row = btn.closest('tr');
            const rowId = row ? row.getAttribute('data-id') : null;

            if (type === 'goal' && row) {
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
                hideActions(rowId ? document.getElementById(`group-goal-${rowId}`) : null);
            } else if (type === 'comment' && row) {
                const commentInput = row.querySelector('.comment-input');
                if (commentInput) {
                    commentInput.setAttribute('data-original', String(commentInput.value ?? ''));
                    commentInput.classList.remove('input-dirty');
                }
                hideActions(rowId ? document.getElementById(`group-comment-${rowId}`) : null);
            } else if (type === 'entity' && row) {
                const entityInput = row.querySelector('.entity-input');
                if (entityInput) {
                    entityInput.setAttribute('data-original', String(entityInput.value ?? ''));
                    entityInput.classList.remove('input-dirty');
                }
                hideActions(rowId ? document.getElementById(`group-entity-${rowId}`) : null);
            }

            btn.innerText = originalText;
            btn.disabled = false;
        } else {
            showToast('Server Error: ' + (data.message || 'Unknown'), 'error');
            btn.innerText = originalText; btn.disabled = false;
        }
    } catch (e) {
        showToast('Network error, please try again.', 'error');
        btn.innerText = originalText; btn.disabled = false;
    }
}


async function saveAllGoalChanges() {
    const rows = getDataRows();
    const goalUpdates = [];
    const commentUpdates = [];
    const entityUpdates = [];

    let hasIncompleteGoalRow = false;

    rows.forEach(row => {
        if (row.style.display === 'none') return;

        const id = row.getAttribute('data-id');
        if (!id) return;

        // --- Goal+Reason updates ---
        const goalInput = row.querySelector('.goal-input');
        const reasonInput = row.querySelector('.reason-input');
        if (goalInput && reasonInput) {
            const goalVal = String(goalInput.value ?? '');
            const goalOrig = String(goalInput.getAttribute('data-original') ?? '');
            const reasonVal = String(reasonInput.value ?? '');
            const reasonOrig = String(reasonInput.getAttribute('data-original') ?? '');

            const goalDirty = goalVal !== goalOrig;
            const reasonDirty = reasonVal !== reasonOrig;
            if (goalDirty || reasonDirty) {
                const trimmedGoal = goalVal.trim();
                const trimmedReason = reasonVal.trim();
                const goalProvided = trimmedGoal !== '';
                const reasonProvided = trimmedReason !== '';

                if (goalProvided !== reasonProvided) {
                    hasIncompleteGoalRow = true;
                } else {
                    goalUpdates.push({
                        id: id,
                        manual_goal: trimmedGoal === '' ? 0 : trimmedGoal,
                        reason: trimmedReason,
                    });
                }
            }
        }

        // --- Comment updates ---
        const commentInput = row.querySelector('.comment-input');
        if (commentInput) {
            const commentVal = String(commentInput.value ?? '');
            const commentOrig = String(commentInput.getAttribute('data-original') ?? '');
            if (commentVal !== commentOrig) {
                commentUpdates.push({
                    id: id,
                    comment: commentVal,
                });
            }
        }

        // --- EPX Entity updates (only if an editable entity input exists in the row) ---
        const entityInput = row.querySelector('.entity-input');
        if (entityInput) {
            const entityVal = String(entityInput.value ?? '');
            const entityOrig = String(entityInput.getAttribute('data-original') ?? '');
            if (entityVal.trim() !== entityOrig.trim()) {
                entityUpdates.push({
                    id: id,
                    entity: entityVal,
                });
            }
        }
    });

    if (hasIncompleteGoalRow) {
        showToast('Some rows are incomplete: both Manual Goal and Adjust Reason must be filled.', 'error');
        return;
    }

    if (goalUpdates.length === 0 && commentUpdates.length === 0 && entityUpdates.length === 0) {
        showToast('No changes to save.', 'error');
        return;
    }

    // Disable the button to prevent double-submit.
    const btn = document.querySelector('button[onclick="saveAllGoalChanges()"]');
    const originalText = btn ? btn.innerText : '';
    if (btn) {
        btn.innerText = '...';
        btn.disabled = true;
    }

    try {
    let goalOk = 0, goalErr = 0, commentOk = 0, commentErr = 0, entityOk = 0, entityErr = 0;

        if (goalUpdates.length > 0) {
            const resGoals = await fetch(apiUrl('/api/update-goals-batch'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ updates: goalUpdates })
            });
            const jsonGoals = await resGoals.json();
            if (!resGoals.ok || jsonGoals.status !== 'success') {
                showToast('Goal batch save failed: ' + (jsonGoals.message || 'Unknown'), 'error');
                if (btn) { btn.innerText = originalText; btn.disabled = false; }
                return;
            }
            const results = Array.isArray(jsonGoals.results) ? jsonGoals.results : [];
            goalOk = results.filter(r => r && r.status === 'success').length;
            goalErr = results.filter(r => r && r.status !== 'success').length;
        }

        if (commentUpdates.length > 0) {
            const resComments = await fetch(apiUrl('/api/update-comments-batch'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ updates: commentUpdates })
            });
            const jsonComments = await resComments.json();
            if (!resComments.ok || jsonComments.status !== 'success') {
                showToast('Comment batch save failed: ' + (jsonComments.message || 'Unknown'), 'error');
                if (btn) { btn.innerText = originalText; btn.disabled = false; }
                return;
            }
            const results = Array.isArray(jsonComments.results) ? jsonComments.results : [];
            commentOk = results.filter(r => r && r.status === 'success').length;
            commentErr = results.filter(r => r && r.status !== 'success').length;
        }

        // Entity changes are saved via the existing single-row endpoint.
        // Keep it low-risk: batch calls with Promise.all, but don't fail the whole save if one row fails.
        if (entityUpdates.length > 0) {
            const results = await Promise.all(entityUpdates.map(async (u) => {
                try {
                    const res = await fetch(apiUrl('/api/update-entity'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: u.id, entity: u.entity })
                    });
                    const json = await res.json();
                    if (!res.ok || json.status !== 'success') {
                        return { status: 'error', message: json.message || 'Unknown' };
                    }
                    return { status: 'success' };
                } catch (e) {
                    return { status: 'error', message: 'Network error' };
                }
            }));

            entityOk = results.filter(r => r && r.status === 'success').length;
            entityErr = results.filter(r => r && r.status !== 'success').length;

            // If successful, update originals so the UI is clean without reload.
            if (entityOk > 0) {
                entityUpdates.forEach(u => {
                    const row = document.querySelector(`tr[data-id="${u.id}"]`);
                    const input = row ? row.querySelector('.entity-input') : null;
                    if (input) {
                        input.setAttribute('data-original', String(input.value ?? ''));
                        input.classList.remove('input-dirty');
                    }
                });
            }
        }

        const totalOk = goalOk + commentOk + entityOk;
        const totalErr = goalErr + commentErr + entityErr;
        if (totalErr === 0) {
            showToast(`Saved ${totalOk} change(s).`, 'success');
        } else {
            showToast(`Saved ${totalOk} change(s), ${totalErr} failed.`, 'error');
        }

    // Keep current sort order: do NOT reload automatically.
    // Users can refresh manually if they want to pull the latest server-side values.
    if (btn) { btn.innerText = originalText; btn.disabled = false; }
    return;
    } catch (e) {
        showToast('Batch save failed. Please try again.', 'error');
        if (btn) { btn.innerText = originalText; btn.disabled = false; }
    }
}

// --- Modal Logic ---
function openModal() { document.getElementById('modalOverlay').classList.add('active'); setTimeout(() => document.getElementById('n_pg3').focus(), 100); }
function closeModal() { document.getElementById('modalOverlay').classList.remove('active'); }

async function submitNewGoal() {
    const btn = document.getElementById('btn-modal-submit');
    const originalText = btn.innerText;
    const pg3 = document.getElementById('n_pg3').value;
    const oper = document.getElementById('n_oper').value;
    const entity = (document.getElementById('n_entity')?.value || '').trim();
    const goal = document.getElementById('n_goal').value;

    if (!pg3 || !oper || !goal) { showToast('Please fill in all required fields (*)', 'error'); return; }

    btn.innerText = '...'; btn.disabled = true;

    const data = { prodgroup3: pg3, operation: oper, goal: goal, reason: document.getElementById('n_reason').value };
    if (entity) {
        data.entity = entity;
    }

    try {
    const res = await fetch(apiUrl('/api/add-new-goal'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        const json = await res.json();
        if (json.status === 'success') {
            showToast('New Goal Added!', 'success');
            closeModal();
            if (json.new_id) {
                await insertNewGoalRowIntoTable(json.new_id);
            }
        } else {
            showToast('Error: ' + json.message, 'error');
            btn.innerText = originalText; btn.disabled = false;
        }
    } catch (e) {
        showToast('Submission failed', 'error');
        btn.innerText = originalText; btn.disabled = false;
    }
}

async function insertNewGoalRowIntoTable(newId) {
    const table = document.getElementById('mainTable');
    const tbody = table ? table.querySelector('tbody') : null;
    if (!tbody) return;

    try {
        const res = await fetch(apiUrl(`/api/report/${newId}`));
        const json = await res.json();
        if (!res.ok || json.status !== 'success' || !json.report) {
            return;
        }

        const r = json.report;
        const tr = document.createElement('tr');
        tr.setAttribute('data-id', r.id);

        const cell = (col, html, extraClass = '') => {
            const td = document.createElement('td');
            if (extraClass) td.className = extraClass;
            td.setAttribute('data-col', col);
            td.innerHTML = html;
            return td;
        };

        // Keep styling consistent with existing rows.
    tr.appendChild(cell('shift', escapeHtml(r.shift || ''), 'col-1'));
    tr.appendChild(cell('prodgroup3', escapeHtml(r.prodgroup3 || ''), 'col-2'));
    tr.appendChild(cell('operation', escapeHtml(r.operation || ''), 'col-3'));
    tr.appendChild(cell('shift_start_wip', formatNum(r.shift_start_wip), 'col-4'));
        tr.appendChild(cell('entity', escapeHtml(r.entity || '')));
        tr.appendChild(cell('qtg1', formatNum(r.qtg1)));
        tr.appendChild(cell('qps1', formatNum(r.qps1)));
        tr.appendChild(cell('mor', formatNum(r.mor), 'mor-val'));
        tr.appendChild(cell('tr', formatNum(r.tr), 'tr-val'));
        tr.appendChild(cell('output', formatNum(r.output)));
        tr.appendChild(cell('system_goal', formatNum(r.system_suggested_goal), 'highlight-col'));

        // subcell_info column changes header text based on page, but underlying data-col stays subcell_info.
        tr.appendChild(cell('subcell_info', escapeHtml(r.subcell_info || '')));

        // manual_goal: use the same input class so existing JS handlers work.
        tr.appendChild(cell(
            'manual_goal',
            `<input type="number" class="table-input goal-input" value="" data-original="" oninput="handleInput(this, 'goal')">`,
            'cell-pad-4'
        ));

        tr.appendChild(cell(
            'adjust_reason',
            `<div class="action-group" id="group-goal-${r.id}">
                <input type="text" class="table-input reason-input" value="" data-original="" oninput="handleInput(this, 'goal')">
                <button class="btn-mini btn-save" onclick="saveRow(this, 'goal')">Save</button>
                <button class="btn-mini btn-cancel" onclick="cancelRow(this, 'goal')">✖</button>
            </div>`,
            'cell-pad-4'
        ));

        tr.appendChild(cell(
            'miss_comment',
            `<div class="action-group" id="group-comment-${r.id}">
                <textarea class="table-input comment-input comment-textarea" rows="2" data-original="" oninput="handleInput(this, 'comment')"></textarea>
                <button class="btn-mini btn-save" onclick="saveRow(this, 'comment')">Save</button>
                <button class="btn-mini btn-cancel" onclick="cancelRow(this, 'comment')">✖</button>
            </div>`,
            'cell-pad-4'
        ));

        // Remove empty-state row if present.
        const emptyRow = tbody.querySelector('tr.empty-state-row');
        if (emptyRow) emptyRow.remove();

        tbody.prepend(tr);

        // Respect column visibility rules (hide entity / subcell columns depending on page).
        const activePage = getCurrentPageFromUrl();
        const columnVisibilityConfig = {
            'entity': ['TCB', 'HBC-JDC', 'DIA', 'BA'],
            'subcell_info': ['TCB', 'DIA', 'BA']
        };
        for (const [colName, allowedPages] of Object.entries(columnVisibilityConfig)) {
            if (!allowedPages.includes(activePage)) {
                const els = tr.querySelectorAll(`[data-col="${colName}"]`);
                els.forEach(el => el.style.display = 'none');
            }
        }

        // Recalculate totals.
        calculateTotals();
    } catch (e) {
        // If anything fails, we just leave the UI as-is (goal is already saved server-side).
    }
}

function formatNum(v) {
    if (v === null || v === undefined || v === '') return '';
    const n = Number(v);
    if (Number.isNaN(n)) return '';
    // Match server-side rounding in template (3 decimals).
    return parseFloat(n.toFixed(3)).toString();
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function showToast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${type === 'success' ? '✓' : '⚠'}</span><span>${msg}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(-10px)'; setTimeout(() => toast.remove(), 300); }, 3000);
}

function confirmReportIssue(event) {
    const ok = window.confirm('Open Outlook email draft to report an issue?');
    if (!ok && event) {
        event.preventDefault();
        return false;
    }

    const link = event && event.currentTarget ? event.currentTarget : null;
    if (!link) return ok;

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
