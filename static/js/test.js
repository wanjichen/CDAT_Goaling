// Test Modules page script (isolated).
// Intentionally does not depend on index.js to avoid coupling.

const TEST_DATA_ROW_SELECTOR = '#testTable tbody tr:not(.empty-state-row)';

// --- Autosave (in-place) helpers ---
// Debounce per-row+field so typing doesn't spam the server.
const _testAutoSaveTimers = new Map();

function _testAutoSaveKey(rowId, type) {
  return `${rowId}|${type}`;
}

function scheduleTestAutoSave(row, type, delayMs = 650) {
  if (!row) return;
  const rowId = row.getAttribute('data-id');
  if (!rowId) return;

  const key = _testAutoSaveKey(rowId, type);
  if (_testAutoSaveTimers.has(key)) {
    clearTimeout(_testAutoSaveTimers.get(key));
  }

  _testAutoSaveTimers.set(key, setTimeout(async () => {
    const input = (type === 'goal')
      ? row.querySelector('.goal-input')
      : (type === 'comment')
        ? row.querySelector('.comment-input')
        : row.querySelector('.cellqty-input');
    if (!input) return;

    const current = String(input.value ?? '');
    const original = String(input.getAttribute('data-original') ?? '');
    if (current === original) return;

    await saveTestRowInternal(row, type, { silent: true });
  }, delayMs));
}

function getAppBasePath() {
  const match = window.location.pathname.match(/^(.*)\/(index\.html|test\.html)$/i);
  if (match && match[1]) return match[1];
  // Also handle /CDAT_Goaling/test.html?...
  const idx = window.location.pathname.toLowerCase().lastIndexOf('/test.html');
  if (idx > 0) return window.location.pathname.substring(0, idx);
  return '';
}

function apiUrl(path) {
  return `${getAppBasePath()}${path}`;
}

function getCurrentTestPageFromUrl() {
  const u = new URL(window.location.href);
  return (u.searchParams.get('page') || 'HDMx').trim();
}

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

function getVisibleTestRows() {
  return getTestDataRows().filter(r => r.style.display !== 'none');
}

function getCellTextForCsv(cell) {
  if (!cell) return '';
  const input = cell.querySelector('input, textarea');
  if (input) return String(input.value ?? '').trim();
  return String(cell.textContent ?? '').trim();
}

function escapeCsv(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

window.exportTestToCSV = function exportTestToCSV() {
  const table = document.getElementById('testTable');
  if (!table) return;

  const headers = Array.from(table.querySelectorAll('thead tr th')).map(th => (th.textContent || '').trim());
  const rows = getVisibleTestRows().map(tr => {
    const cells = Array.from(tr.querySelectorAll('td'));
    return cells.map(getCellTextForCsv);
  });

  const lines = [];
  lines.push(headers.map(escapeCsv).join(','));
  rows.forEach(r => lines.push(r.map(escapeCsv).join(',')));

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const page = getCurrentTestPageFromUrl();
  a.href = url;
  a.download = `test_${page}_export.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

window.copyTestTableToClipboard = async function copyTestTableToClipboard() {
  const table = document.getElementById('testTable');
  if (!table) return;

  const headers = Array.from(table.querySelectorAll('thead tr th')).map(th => (th.textContent || '').trim());
  const lines = [headers.join('\t')];
  getVisibleTestRows().forEach(tr => {
    const values = Array.from(tr.querySelectorAll('td')).map(getCellTextForCsv);
    lines.push(values.join('\t'));
  });

  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    showToast('Copied table to clipboard.', 'success');
  } catch {
    showToast('Copy failed (browser blocked clipboard).', 'error');
  }
};

// Save-all batch editing is intentionally removed: edits auto-save in-place now.

window.openTestModal = function openTestModal() {
  const overlay = document.getElementById('testModalOverlay');
  if (overlay) overlay.classList.add('active');
};

window.closeTestModal = function closeTestModal() {
  const overlay = document.getElementById('testModalOverlay');
  if (overlay) overlay.classList.remove('active');
};

window.submitNewTestGoal = async function submitNewTestGoal() {
  const btn = document.getElementById('btn-test-modal-submit');
  const originalText = btn ? btn.innerText : '';

  const pg3 = (document.getElementById('t_pg3')?.value || '').trim();
  const oper = (document.getElementById('t_oper')?.value || '').trim();
  const goal = (document.getElementById('t_goal')?.value || '').trim();
  const cellQtyRaw = (document.getElementById('t_cellqty')?.value || '').trim();
  const page = getCurrentTestPageFromUrl();

  if (!pg3 || !oper || !goal || cellQtyRaw === '') {
    showToast('Please fill in all required fields (*)', 'error');
    return;
  }

  // integer-only (>= 0)
  if (!/^\d+$/.test(cellQtyRaw)) {
    showToast('Cell Qty must be an integer >= 0', 'error');
    return;
  }

  if (btn) { btn.innerText = '...'; btn.disabled = true; }
  try {
    const res = await fetch(apiUrl('/api/test/add-new-goal'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prodgroup3: pg3, operation: oper, goal: goal, cell_qty: cellQtyRaw, page: page })
    });
    const json = await res.json();
    if (!res.ok || json.status !== 'success') {
      throw new Error(json.message || `HTTP ${res.status}`);
    }
    showToast('New goal added. Refreshing...', 'success');
    closeTestModal();
    // Simple + safe: reload the page so the row appears and grouping logic applies.
    window.location.reload();
  } catch (e) {
    showToast(String(e.message || e), 'error');
  } finally {
    if (btn) { btn.innerText = originalText; btn.disabled = false; }
  }
};

function setInputDirtyState(input, isDirty) {
  if (!input) return;
  if (isDirty) input.classList.add('input-dirty');
  else input.classList.remove('input-dirty');
}

function showActions(actionGroup) {
  if (!actionGroup) return;
  actionGroup.classList.add('show-actions');
}

function hideActions(actionGroup) {
  if (!actionGroup) return;
  actionGroup.classList.remove('show-actions');
}

function getTestDataRows() {
  return Array.from(document.querySelectorAll(TEST_DATA_ROW_SELECTOR));
}

function getTestCellValue(td, toLower = true) {
  if (!td) return '';
  const input = td.querySelector('input.table-input, textarea.table-input');
  let val = input ? String(input.value ?? '').trim() : String(td.textContent ?? '').trim();
  return toLower ? val.toLowerCase() : val;
}

function parseTestNumber(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

function setTotalText(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value === 0 ? '' : String(Number(value.toFixed(3)));
}

function calculateTestTotals() {
  const rows = getTestDataRows();

  let totalShiftStartWip = 0;
  let totalShiftStartWipOnhold = 0;
  let totalCommit1 = 0;
  let totalCommit2 = 0;
  // QPS totals intentionally not displayed.
  let totalMor = 0;
  let totalTr = 0;
  let totalCellQty = 0;
  let totalCapacity = 0;
  let totalGoal = 0;
  let totalOutput = 0;

  rows.forEach(row => {
    if (row.style.display === 'none') return;

    const getVal = (col) => {
      const td = row.querySelector(`td[data-col="${col}"]`);
      if (!td) return 0;
      return parseTestNumber(getTestCellValue(td, false));
    };

    totalShiftStartWip += getVal('shift_start_wip');
    totalShiftStartWipOnhold += getVal('shift_start_wip_onhold');
    totalCommit1 += getVal('commit1');
    totalCommit2 += getVal('commit2');
  // QPS totals intentionally not displayed.
    totalMor += getVal('mor');
  totalTr += getVal('tr');
    totalCellQty += getVal('link_cell_qty');
    totalCapacity += getVal('capacity');

    // Goal is editable: read from the input if present.
    const goalTd = row.querySelector('td[data-col="goal"]');
    if (goalTd) {
      totalGoal += parseTestNumber(getTestCellValue(goalTd, false));
    }

    totalOutput += getVal('output');
  });

  setTotalText('test-total-shift_start_wip', totalShiftStartWip);
  setTotalText('test-total-shift_start_wip_onhold', totalShiftStartWipOnhold);
  setTotalText('test-total-commit1', totalCommit1);
  setTotalText('test-total-commit2', totalCommit2);
  // No MOR total in footer.
  setTotalText('test-total-tr', totalTr);
  setTotalText('test-total-link_cell_qty', totalCellQty);
  setTotalText('test-total-capacity', totalCapacity);
  setTotalText('test-total-goal', totalGoal);
  setTotalText('test-total-output', totalOutput);
}

window.sortTestTable = function sortTestTable(thElement, colName) {
  const table = document.getElementById('testTable');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  const rows = Array.from(tbody.querySelectorAll('tr:not(.empty-state-row)'));
  if (rows.length === 0) return;

  let dir = 'asc';
  if (thElement.getAttribute('data-sort') === 'asc') dir = 'desc';

  table.querySelectorAll('th.sortable').forEach(el => {
    el.setAttribute('data-sort', '');
    const icon = el.querySelector('.sort-icon');
    if (icon) icon.innerText = '⇕';
  });

  thElement.setAttribute('data-sort', dir);
  const icon = thElement.querySelector('.sort-icon');
  if (icon) icon.innerText = dir === 'asc' ? '⇑' : '⇓';

  const numericCols = [
    'shift_start_wip',
    'shift_start_wip_onhold',
    'commit1',
    'commit2',
    'qps1',
    'qps2',
    'mor',
    'tr',
    'link_cell_qty',
    'capacity',
    'goal',
    'output',
  ];
  const isNumeric = numericCols.includes(colName);

  rows.sort((a, b) => {
    const tdA = a.querySelector(`td[data-col="${colName}"]`);
    const tdB = b.querySelector(`td[data-col="${colName}"]`);

    let valA = getTestCellValue(tdA);
    let valB = getTestCellValue(tdB);

    if (isNumeric) {
      const nA = parseTestNumber(valA);
      const nB = parseTestNumber(valB);
      return dir === 'asc' ? (nA - nB) : (nB - nA);
    }

    return dir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
  });

  rows.forEach(r => tbody.appendChild(r));
  calculateTestTotals();
  // Columns can reflow slightly after DOM operations; keep pinned offsets correct.
  const tableEl = document.getElementById('testTable');
  if (tableEl) {
    const evt = new Event('resize');
    window.dispatchEvent(evt);
  }
};

window.applyTestFilters = function applyTestFilters() {
  const table = document.getElementById('testTable');
  if (!table) return;

  const filterInputs = Array.from(table.querySelectorAll('thead tr.filter-row input.filter-input-field'));
  const filters = filterInputs
    .map(inp => ({
      col: inp.getAttribute('data-filter-col'),
      val: String(inp.value ?? '').trim().toLowerCase(),
    }))
    .filter(f => f.col && f.val !== '');

  const rows = getTestDataRows();
  rows.forEach(row => {
    let isMatch = true;

    for (const f of filters) {
      const td = row.querySelector(`td[data-col="${f.col}"]`);
      const cellVal = getTestCellValue(td, true);
      if (!cellVal.includes(f.val)) {
        isMatch = false;
        break;
      }
    }

    row.style.display = isMatch ? '' : 'none';
  });

  calculateTestTotals();
  // Filtering can change scrollbar presence and widths.
  const evt = new Event('resize');
  window.dispatchEvent(evt);
};

// Shift View dropdown uses a GET form submit (same as assembly), so no JS is needed.

window.handleTestInput = function handleTestInput(input, type) {
  const row = input.closest('tr');
  const rowId = row.getAttribute('data-id');
  // Enforce integer-only for Cell Qty at the UI level.
  if (type === 'cellqty') {
    const raw = String(input.value ?? '');
    // Keep only digits (no decimals or negatives). Empty is allowed (means NULL).
    const sanitized = raw.replace(/[^0-9]/g, '');
    if (sanitized !== raw) input.value = sanitized;
  }

  const val = input.value;
  const original = input.getAttribute('data-original');
  setInputDirtyState(input, String(val) !== String(original));

  let actionGroup;
  if (type === 'goal') {
    actionGroup = document.getElementById(`group-goal-${rowId}`);
    const goalInput = row.querySelector('.goal-input');
    const isGoalDirty = String(goalInput.value) !== String(goalInput.getAttribute('data-original'));
  if (isGoalDirty) showActions(actionGroup);
    else hideActions(actionGroup);

  // Keep totals live as the user types.
  calculateTestTotals();
  scheduleTestAutoSave(row, 'goal');
  } else if (type === 'comment') {
    actionGroup = document.getElementById(`group-comment-${rowId}`);
    const commentInput = row.querySelector('.comment-input');
    const isDirty = String(commentInput.value) !== String(commentInput.getAttribute('data-original'));
    if (isDirty) showActions(actionGroup);
    else hideActions(actionGroup);

  scheduleTestAutoSave(row, 'comment', 900);
  } else if (type === 'cellqty') {
    actionGroup = document.getElementById(`group-cellqty-${rowId}`);
    const qtyInput = row.querySelector('.cellqty-input');
    const isDirty = String(qtyInput.value) !== String(qtyInput.getAttribute('data-original'));
    if (isDirty) showActions(actionGroup);
    else hideActions(actionGroup);

    calculateTestTotals();
  scheduleTestAutoSave(row, 'cellqty');
  }
};

window.cancelTestRow = function cancelTestRow(btn, type) {
  const row = btn.closest('tr');
  if (type === 'goal') {
    const goalInput = row.querySelector('.goal-input');
    goalInput.value = goalInput.getAttribute('data-original') || '';
    setInputDirtyState(goalInput, false);
    hideActions(document.getElementById(`group-goal-${row.getAttribute('data-id')}`));
  calculateTestTotals();
  } else if (type === 'comment') {
    const c = row.querySelector('.comment-input');
    c.value = c.getAttribute('data-original') || '';
    setInputDirtyState(c, false);
    hideActions(document.getElementById(`group-comment-${row.getAttribute('data-id')}`));
  } else if (type === 'cellqty') {
    const qty = row.querySelector('.cellqty-input');
    qty.value = qty.getAttribute('data-original') || '';
    setInputDirtyState(qty, false);
    hideActions(document.getElementById(`group-cellqty-${row.getAttribute('data-id')}`));
    calculateTestTotals();
  }
};

async function saveTestRowInternal(row, type, options = {}) {
  const { silent = false } = options;
  const id = row.getAttribute('data-id');

  const url = (type === 'goal')
    ? apiUrl('/api/test/update-goal')
    : (type === 'cellqty')
      ? apiUrl('/api/test/update-cellqty')
    : apiUrl('/api/test/update-comment');

  const payload = { id: id };

  if (type === 'goal') {
    const rawGoal = row.querySelector('.goal-input').value;

    // Keep semantics: empty means NULL.
    payload.manual_goal = rawGoal === '' ? null : rawGoal;
  } else if (type === 'cellqty') {
    const rawQty = String(row.querySelector('.cellqty-input').value ?? '').trim();
    payload.cell_qty = rawQty === '' ? null : rawQty;
  } else if (type === 'comment') {
    payload.comment = row.querySelector('.comment-input').value;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok || data.status !== 'success') {
      throw new Error(data.message || `HTTP ${res.status}`);
    }

    const newId = data.new_id;
    if (newId) row.setAttribute('data-id', newId);

    if (type === 'goal') {
      const goalInput = row.querySelector('.goal-input');
      // Sync from server (supports fallback-to-original behavior when input is blank).
      if (data && typeof data.goal !== 'undefined') {
        goalInput.value = (data.goal === null || data.goal === undefined) ? '' : String(data.goal);
      }
      goalInput.setAttribute('data-original', goalInput.value);
      setInputDirtyState(goalInput, false);
      hideActions(document.getElementById(`group-goal-${id}`));

      // Update TR cell from server response.
      const trTd = row.querySelector('td[data-col="tr"]');
      if (trTd && data && typeof data.tr !== 'undefined') {
        const n = Number(data.tr);
        trTd.textContent = Number.isFinite(n) ? n.toFixed(1) : String(data.tr ?? '');
      }

  if (!silent) showToast('Saved.', 'success');
  calculateTestTotals();
    } else if (type === 'cellqty') {
      const qtyInput = row.querySelector('.cellqty-input');
      // Sync from server in case the backend coerces/normalizes the value.
      if (data && typeof data.link_cell_qty !== 'undefined') {
        qtyInput.value = (data.link_cell_qty === null || data.link_cell_qty === undefined) ? '' : String(data.link_cell_qty);
      }
      qtyInput.setAttribute('data-original', String(qtyInput.value ?? ''));
      setInputDirtyState(qtyInput, false);
      hideActions(document.getElementById(`group-cellqty-${id}`));

      // Cell Qty also drives Goal immediately (Goal remains editable; user can overwrite afterwards).
      const goalInput = row.querySelector('.goal-input');
      if (goalInput && data && typeof data.goal !== 'undefined') {
        goalInput.value = (data.goal === null || data.goal === undefined) ? '' : String(data.goal);
        goalInput.setAttribute('data-original', goalInput.value);
        setInputDirtyState(goalInput, false);
        hideActions(document.getElementById(`group-goal-${id}`));
      }

      // Update TR cell from server response.
      const trTd = row.querySelector('td[data-col="tr"]');
      if (trTd && data && typeof data.tr !== 'undefined') {
        const n = Number(data.tr);
        trTd.textContent = Number.isFinite(n) ? n.toFixed(1) : String(data.tr ?? '');
      }

      // Update capacity cell from server response.
      const capTd = row.querySelector('td[data-col="capacity"]');
      if (capTd && data && typeof data.capacity !== 'undefined') {
        if (data.capacity === null || data.capacity === undefined || data.capacity === '') {
          capTd.textContent = '';
        } else {
          const n = Number(data.capacity);
          capTd.textContent = Number.isFinite(n) ? n.toFixed(1) : String(data.capacity);
        }
      }

  if (!silent) showToast('Saved.', 'success');
      calculateTestTotals();
    } else {
      const c = row.querySelector('.comment-input');
      c.setAttribute('data-original', c.value);
      setInputDirtyState(c, false);
      hideActions(document.getElementById(`group-comment-${id}`));
      if (!silent) showToast('Saved.', 'success');
    }
  } catch (e) {
    showToast(String(e.message || e), 'error');
  }
}

window.saveTestRow = async function saveTestRow(btn, type) {
  const row = btn.closest('tr');
  try {
    btn.disabled = true;
    await saveTestRowInternal(row, type, { silent: false });
  } finally {
    btn.disabled = false;
  }
};

document.addEventListener('DOMContentLoaded', () => {
  // Cell Qty: enforce integer-only even while typing.
  // Some browsers allow '.', 'e', '+', '-' temporarily on <input type="number">.
  document.querySelectorAll('#testTable input.cellqty-input').forEach((el) => {
    el.addEventListener('keydown', (ev) => {
      const blocked = ['.', ',', 'e', 'E', '+', '-'];
      if (blocked.includes(ev.key)) ev.preventDefault();
    });
  });

  function updateTestPinnedOffsets() {
    const table = document.getElementById('testTable');
    if (!table) return;

    const headerRow = table.querySelector('thead tr:first-child');
    if (!headerRow) return;

    const getWidth = (colName) => {
      const th = headerRow.querySelector(`th[data-col="${colName}"]`);
      if (!th) return 0;
      if (th.style.display === 'none') return 0;
      return th.offsetWidth || 0;
    };

    const w1 = getWidth('prodgroup3');
    const w2 = getWidth('operation');

    const left1 = 0;
    const left2 = left1 + w1;

    table.style.setProperty('--test-pinned-left-1', `${left1}px`);
    table.style.setProperty('--test-pinned-left-2', `${left2}px`);
  table.style.setProperty('--test-pinned-left-3', `${left2}px`);

  // (No pinned-total-width var needed; keep behavior aligned with Assembly.)

    updateTestPinnedLastDivider(table);
  }

  function updateTestPinnedLastDivider(table) {
    if (!table) return;

    table.querySelectorAll('.pinned-last').forEach(el => el.classList.remove('pinned-last'));

    // Test table pins only first two columns. Divider should always be after Operation (pinned-2).
    table.querySelectorAll('.pinned-col.pinned-2').forEach(el => {
      el.classList.add('pinned-last');
    });
  }

  // Highlight active tab in the nav-tabs (same behavior as assembly).
  const currentPage = getCurrentTestPageFromUrl();
  const links = document.querySelectorAll('.nav-tabs a.tab-link[href]');
  links.forEach(link => {
    const href = link.getAttribute('href') || '';
    if (href.includes(`page=${encodeURIComponent(currentPage)}`) || href.endsWith(`page=${currentPage}`)) {
      link.classList.add('active');
    }
  });

  // Ensure action buttons start hidden.
  getTestDataRows().forEach(row => {
    hideActions(document.getElementById(`group-goal-${row.getAttribute('data-id')}`));
    hideActions(document.getElementById(`group-comment-${row.getAttribute('data-id')}`));
  hideActions(document.getElementById(`group-cellqty-${row.getAttribute('data-id')}`));
  });

  // Initial totals.
  calculateTestTotals();

  // Defer so table-layout: fixed / fonts settle before measuring.
  setTimeout(updateTestPinnedOffsets, 0);
  setTimeout(updateTestPinnedOffsets, 200);

  window.addEventListener('resize', () => {
  window.requestAnimationFrame(updateTestPinnedOffsets);
  });
});
