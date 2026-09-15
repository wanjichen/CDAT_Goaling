// Shared Sspec (QTGQPS_Report.csv) page: simple sortable/filterable read-only table.

// Recompute a table's <tfoot> "Total" row by summing the currently visible
// (non-filtered-out) rows for each numeric column. Non-numeric columns are
// left blank. Formatting matches the backend's _fmt3: whole numbers show
// with no decimals, otherwise 3 decimal places.
function updateSharedSspecTotals(tableId, numericCols) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const tfoot = table.querySelector('tfoot');
  if (!tfoot) return;

  const rows = Array.from(table.querySelectorAll('tbody tr:not(.empty-state-row)'))
    .filter(row => row.style.display !== 'none');

  numericCols.forEach(col => {
    const totalCell = tfoot.querySelector(`td[data-col="${col}"]`);
    if (!totalCell) return;
    let sum = 0;
    let hasValue = false;
    rows.forEach(row => {
      const td = row.querySelector(`td[data-col="${col}"]`);
      if (!td) return;
      const raw = td.textContent.trim();
      if (raw === '') return;
      const n = parseFloat(raw);
      if (!Number.isNaN(n)) {
        sum += n;
        hasValue = true;
      }
    });
    if (!hasValue) {
      totalCell.textContent = '';
      return;
    }
    const rounded = Math.round(sum * 1000) / 1000;
    totalCell.textContent = Number.isInteger(rounded)
      ? String(rounded)
      : rounded.toFixed(3);
  });
}

window.sortSharedSspecTable = function sortSharedSspecTable(thElement, colName) {
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
    'wip', 'yield', 'shipout', 'commit1', 'commit2',
    'qtg1', 'qtg2', 'qps1', 'qps2', 'stg1', 'stg2',
  ];
  const isNumeric = numericCols.includes(colName);

  const getCellValue = (row) => {
    const td = row.querySelector(`td[data-col="${colName}"]`);
    return td ? td.textContent.trim() : '';
  };

  rows.sort((a, b) => {
    const valA = getCellValue(a);
    const valB = getCellValue(b);

    if (isNumeric) {
      const nA = parseFloat(valA) || 0;
      const nB = parseFloat(valB) || 0;
      return dir === 'asc' ? (nA - nB) : (nB - nA);
    }

    return dir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
  });

  rows.forEach(r => tbody.appendChild(r));
};

window.applySharedSspecFilters = function applySharedSspecFilters() {
  const table = document.getElementById('testTable');
  if (!table) return;

  const cellFilters = [];
  const filterInputs = Array.from(table.querySelectorAll('thead tr.filter-row select.filter-input-field'));
  filterInputs
    .map(inp => ({
      col: inp.getAttribute('data-filter-col'),
      val: String(inp.value ?? '').trim().toLowerCase(),
    }))
    .filter(f => f.col && f.val !== '')
    .forEach(f => cellFilters.push(f));

  const rows = Array.from(table.querySelectorAll('tbody tr:not(.empty-state-row)'));
  let visibleCount = 0;
  rows.forEach(row => {
    let isMatch = true;

    for (const f of cellFilters) {
      const td = row.querySelector(`td[data-col="${f.col}"]`);
      const cellVal = (td ? td.textContent : '').trim().toLowerCase();
      if (cellVal !== f.val) {
        isMatch = false;
        break;
      }
    }

    row.style.display = isMatch ? '' : 'none';
    if (isMatch) visibleCount += 1;
  });

  const countEl = document.getElementById('ss-row-count');
  if (countEl) {
    countEl.textContent = `Filter: ${visibleCount} of ${rows.length}`;
  }

  updateSharedSspecTotals('testTable', [
    'wip', 'commit1', 'commit2', 'shipout', 'qtg1', 'qtg2', 'qps1', 'qps2',
  ]);
};

document.addEventListener('DOMContentLoaded', function () {
  applySharedSspecFilters();
  applyShipoutBySspecFilters();
  applyBpSummaryFilters();
});

// Simple per-column filter (Prod / Sspec) for the small "Shared Sspec
// Shipout" summary table. Same pattern as applySharedSspecFilters() above,
// just scoped to the #shipoutBySspecTable table.
window.applyShipoutBySspecFilters = function applyShipoutBySspecFilters() {
  const table = document.getElementById('shipoutBySspecTable');
  if (!table) return;

  const cellFilters = [];
  const filterInputs = Array.from(table.querySelectorAll('thead tr.filter-row select.filter-input-field'));
  filterInputs
    .map(inp => ({
      col: inp.getAttribute('data-filter-col'),
      val: String(inp.value ?? '').trim().toLowerCase(),
    }))
    .filter(f => f.col && f.val !== '')
    .forEach(f => cellFilters.push(f));

  const rows = Array.from(table.querySelectorAll('tbody tr:not(.empty-state-row)'));
  rows.forEach(row => {
    let isMatch = true;

    for (const f of cellFilters) {
      const td = row.querySelector(`td[data-col="${f.col}"]`);
      const cellVal = (td ? td.textContent : '').trim().toLowerCase();
      if (cellVal !== f.val) {
        isMatch = false;
        break;
      }
    }

    row.style.display = isMatch ? '' : 'none';
  });

  updateSharedSspecTotals('shipoutBySspecTable', ['shipout', 'l15wip']);
};

// Collapse/expand for the three Shared Sspec sections (BP Summary / Shared
// Sspec Shipout / Detail QTG/QPS), now displayed vertically stacked instead
// of as tabs. All three start expanded.
window.toggleSharedSspecSection = function toggleSharedSspecSection(sectionName) {
  const section = document.getElementById(
    'ssSection' + sectionName.charAt(0).toUpperCase() + sectionName.slice(1));
  if (!section) return;
  const header = section.querySelector('.shared-sspec-section-header');
  const isCollapsed = section.classList.toggle('collapsed');
  if (header) header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
};

// Simple per-column filter (Prodgroup3 / DLCP / Commit1 / Commit2 / Shipout)
// for the "BP Summary" table. Same pattern as the other filter functions.
window.applyBpSummaryFilters = function applyBpSummaryFilters() {
  const table = document.getElementById('bpSummaryTable');
  if (!table) return;

  const cellFilters = [];
  const filterInputs = Array.from(table.querySelectorAll('thead tr.filter-row select.filter-input-field'));
  filterInputs
    .map(inp => ({
      col: inp.getAttribute('data-filter-col'),
      val: String(inp.value ?? '').trim().toLowerCase(),
    }))
    .filter(f => f.col && f.val !== '')
    .forEach(f => cellFilters.push(f));

  const rows = Array.from(table.querySelectorAll('tbody tr:not(.empty-state-row)'));
  rows.forEach(row => {
    let isMatch = true;

    for (const f of cellFilters) {
      const td = row.querySelector(`td[data-col="${f.col}"]`);
      const cellVal = (td ? td.textContent : '').trim().toLowerCase();
      if (cellVal !== f.val) {
        isMatch = false;
        break;
      }
    }

    row.style.display = isMatch ? '' : 'none';
  });

  updateSharedSspecTotals('bpSummaryTable', ['commit1', 'commit2', 'shipout', 'lastww_shipout']);
};

