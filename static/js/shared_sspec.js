// Shared Sspec (QTGQPS_Report.csv) page: simple sortable/filterable read-only table.

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
    'sdd_sequence', 'wip', 'yield', 'shipout', 'commit1', 'commit2',
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

  const filterInputs = Array.from(table.querySelectorAll('thead tr.filter-row select.filter-input-field'));
  const filters = filterInputs
    .map(inp => ({
      col: inp.getAttribute('data-filter-col'),
      val: String(inp.value ?? '').trim().toLowerCase(),
    }))
    .filter(f => f.col && f.val !== '');

  const rows = Array.from(table.querySelectorAll('tbody tr:not(.empty-state-row)'));
  rows.forEach(row => {
    let isMatch = true;

    for (const f of filters) {
      const td = row.querySelector(`td[data-col="${f.col}"]`);
      const cellVal = (td ? td.textContent : '').trim().toLowerCase();
      if (cellVal !== f.val) {
        isMatch = false;
        break;
      }
    }

    row.style.display = isMatch ? '' : 'none';
  });
};

