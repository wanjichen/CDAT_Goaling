// Expand/collapse grouping for Finish modules (MARK / DVI).
//
// Unlike static/js/test_expand_collapse.js (which groups STHI/HDMx rows by
// their own prodgroup3), this groups finish rows by PRODUCT FAMILY:
//   - DT Products   (product_config.DT_PRODUCTS)
//   - PCH Products  (product_config.PCH_PRODUCTS)
//   - Mobile Products (everything else)
//
// The classification lists are rendered server-side (single source of truth
// in product_config.py) into window.DT_PRODUCTS / window.PCH_PRODUCTS /
// window.PRODUCT_FAMILY_ORDER by finish.html. This script only reads them.
//
// Call initFinishGrouping() after the page loads.

function getFinishProductFamily(prodgroup3) {
  const pg3 = (prodgroup3 || '').trim();
  const dtList = window.DT_PRODUCTS || [];
  const pchList = window.PCH_PRODUCTS || [];
  if (dtList.includes(pg3)) return 'DT Products';
  if (pchList.includes(pg3)) return 'PCH Products';
  return 'Mobile Products';
}

function initFinishGrouping() {
  const tbody = document.querySelector('#testTable tbody');
  if (!tbody) return;

  const dataRows = Array.from(tbody.querySelectorAll('tr[data-id]'));
  if (dataRows.length === 0) return;

  // Group rows by product family.
  const groups = {};
  dataRows.forEach(row => {
    const prodgroup3 = row.querySelector('td[data-col="prodgroup3"]')?.textContent.trim();
    const family = getFinishProductFamily(prodgroup3);
    if (!groups[family]) groups[family] = [];
    groups[family].push(row);
  });

  // Clear tbody
  tbody.innerHTML = '';

  const order = (window.PRODUCT_FAMILY_ORDER && window.PRODUCT_FAMILY_ORDER.length)
    ? window.PRODUCT_FAMILY_ORDER
    : ['DT Products', 'PCH Products', 'Mobile Products'];

  order.forEach(family => {
    const childRows = groups[family];
    if (!childRows || childRows.length === 0) return;

    const isExpanded = false; // Start collapsed by default

    const headerRow = createFinishGroupHeaderRow(family, childRows, isExpanded);
    tbody.appendChild(headerRow);

    childRows.forEach(childRow => {
      childRow.classList.add('child-row');
      if (!isExpanded) childRow.classList.add('collapsed');
      childRow.setAttribute('data-group', family);
      // Note: prodgroup3 stays visible on child rows (unlike STHI/HDMx),
      // since a family group contains many distinct prodgroup3 values.
      tbody.appendChild(childRow);
    });
  });

  if (typeof calculateFinishTotals === 'function') {
    calculateFinishTotals();
  }

  drawFinishGroupHeaderProgressBars();
  applyFinishRowStriping();
}

function createFinishGroupHeaderRow(family, childRows, isExpanded) {
  const headerRow = document.createElement('tr');
  headerRow.classList.add('group-header-row');
  headerRow.setAttribute('data-group', family);
  headerRow.setAttribute('data-expanded', isExpanded ? 'true' : 'false');

  const firstChild = childRows[0];
  const cells = firstChild.querySelectorAll('td');
  const aggregatedData = calculateFinishAggregatedData(childRows);

  cells.forEach((cell, index) => {
    const dataCol = cell.getAttribute('data-col');
    const headerCell = document.createElement('td');
    headerCell.className = cell.className;
    headerCell.setAttribute('data-col', dataCol);

    if (index === 0) {
      // First cell: family name with expand/collapse icon
      const icon = document.createElement('span');
      icon.className = 'expand-collapse-icon' + (isExpanded ? ' expanded' : '');
      icon.innerHTML = '▶';
      icon.setAttribute('aria-label', isExpanded ? 'Collapse' : 'Expand');

      headerCell.appendChild(icon);
      headerCell.appendChild(document.createTextNode(family));
    } else if (index === 1) {
      // Second cell (operation): show row count instead
      headerCell.textContent = `(${childRows.length} ${childRows.length === 1 ? 'row' : 'rows'})`;
    } else if (dataCol === 'progress') {
      const goal = aggregatedData.goal || 0;
      const output = aggregatedData.output || 0;
      const progressPercent = goal > 0 ? Math.round((output / goal) * 100) : 0;
      headerCell.setAttribute('data-progress', progressPercent);
      headerCell.setAttribute('data-output', output);
      headerCell.setAttribute('data-goal', goal);
      headerCell.textContent = progressPercent + '%';
    } else if (aggregatedData[dataCol] !== undefined) {
      const span = document.createElement('span');
      span.className = 'summary-value';
      span.textContent = formatFinishGroupNumber(aggregatedData[dataCol]);
      headerCell.appendChild(span);
    } else {
      headerCell.textContent = '';
    }

    headerRow.appendChild(headerCell);
  });

  headerRow.addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'TEXTAREA') {
      return;
    }
    toggleFinishGroup(family);
  });

  return headerRow;
}

function calculateFinishAggregatedData(childRows) {
  const aggregated = {
    shift_start_wip: 0,
    start_wip_onhold: 0,
    commit1: 0,
    commit2: 0,
    qtg1: 0,
    qtg2: 0,
    qps1: 0,
    qps2: 0,
    tr: 0,
    link_cell_qty: 0,
    capacity: 0,
    goal: 0,
    output: 0,
    stg1: null,
    stg2: null
  };

  const firstRow = childRows[0];
  const stg1Cell = firstRow.querySelector('td[data-col="stg1"]');
  const stg2Cell = firstRow.querySelector('td[data-col="stg2"]');
  if (stg1Cell) aggregated.stg1 = parseFloat(stg1Cell.textContent) || 0;
  if (stg2Cell) aggregated.stg2 = parseFloat(stg2Cell.textContent) || 0;

  childRows.forEach(row => {
    Object.keys(aggregated).forEach(col => {
      if (col === 'stg1' || col === 'stg2') return;

      const cell = row.querySelector(`td[data-col="${col}"]`);
      if (!cell) return;

      const input = cell.querySelector('input, textarea');
      let value = 0;
      if (input) {
        value = parseFloat(input.value) || 0;
      } else {
        value = parseFloat(cell.textContent) || 0;
      }

      if (col === 'commit1' || col === 'commit2') {
        aggregated[col] = Math.max(aggregated[col], value);
      } else {
        aggregated[col] += value;
      }
    });
  });

  return aggregated;
}

function toggleFinishGroup(family) {
  const headerRow = document.querySelector(`tr.group-header-row[data-group="${family}"]`);
  if (!headerRow) return;

  const isExpanded = headerRow.getAttribute('data-expanded') === 'true';
  const newState = !isExpanded;
  headerRow.setAttribute('data-expanded', newState ? 'true' : 'false');

  const icon = headerRow.querySelector('.expand-collapse-icon');
  if (icon) {
    if (newState) icon.classList.add('expanded');
    else icon.classList.remove('expanded');
  }

  const childRows = document.querySelectorAll(`tr.child-row[data-group="${family}"]`);
  childRows.forEach(row => {
    if (newState) row.classList.remove('collapsed');
    else row.classList.add('collapsed');
  });

  if (typeof calculateFinishTotals === 'function') {
    calculateFinishTotals();
  }

  applyFinishRowStriping();
}

function formatFinishGroupNumber(num) {
  if (num === 0) return '0';
  if (num === Math.floor(num)) return num.toString();
  return num.toFixed(1);
}

function expandAllFinishGroups() {
  document.querySelectorAll('tr.group-header-row').forEach(headerRow => {
    const family = headerRow.getAttribute('data-group');
    if (headerRow.getAttribute('data-expanded') === 'false') {
      toggleFinishGroup(family);
    }
  });
}

function collapseAllFinishGroups() {
  document.querySelectorAll('tr.group-header-row').forEach(headerRow => {
    const family = headerRow.getAttribute('data-group');
    if (headerRow.getAttribute('data-expanded') === 'true') {
      toggleFinishGroup(family);
    }
  });
}

function drawFinishGroupHeaderProgressBars() {
  document.querySelectorAll('tr.group-header-row').forEach(headerRow => {
    const progressCell = headerRow.querySelector('td[data-col="progress"]');
    if (!progressCell) return;

    const goal = parseFloat(progressCell.getAttribute('data-goal')) || 0;
    const output = parseFloat(progressCell.getAttribute('data-output')) || 0;
    const progressPercent = parseFloat(progressCell.getAttribute('data-progress')) || 0;

    if (!progressCell.querySelector('.progress-wrap')) {
      const wrap = document.createElement('div');
      wrap.className = 'progress-wrap';

      const track = document.createElement('div');
      track.className = 'progress-track';

      const fill = document.createElement('div');
      fill.className = 'progress-fill';

      track.appendChild(fill);
      wrap.appendChild(track);

      const label = document.createElement('div');
      label.className = 'progress-label';

      progressCell.innerHTML = '';
      progressCell.appendChild(wrap);
      progressCell.appendChild(label);
    }

    const fill = progressCell.querySelector('.progress-fill');
    const label = progressCell.querySelector('.progress-label');

    if (fill && label) {
      const pctClamped = Math.min(100, Math.max(0, progressPercent));
      fill.style.width = pctClamped + '%';

      if (window.ProgressScale && window.ProgressScale.fillGradientCss) {
        fill.style.background = window.ProgressScale.fillGradientCss(progressPercent);
      }

      fill.classList.remove('is-ok', 'is-warn', 'is-bad');
      if (goal > 0) {
        if (progressPercent >= 100) fill.classList.add('is-ok');
        else if (progressPercent >= 50) fill.classList.add('is-warn');
        else fill.classList.add('is-bad');
      }

      label.textContent = goal > 0 ? Math.round(progressPercent) + '%' : '';
      progressCell.title = goal > 0 ? `${output} / ${goal} (${progressPercent.toFixed(1)}%)` : `${output} / ${goal}`;
    }
  });
}

// Refresh a single group header's aggregates after an inline edit
// (goal / link qty) inside one of its child rows.
function refreshFinishGroupAggregatesForRow(row) {
  if (!row) return;
  const family = row.getAttribute('data-group');
  if (!family) return;

  const headerRow = document.querySelector(`tr.group-header-row[data-group="${family}"]`);
  if (!headerRow) return;

  const childRows = Array.from(document.querySelectorAll(`tr.child-row[data-group="${family}"]`));
  if (childRows.length === 0) {
    // No rows left in this family (e.g. the last row was deleted) - remove
    // the now-empty group header entirely.
    headerRow.remove();
    return;
  }

  const aggregatedData = calculateFinishAggregatedData(childRows);

  headerRow.querySelectorAll('td[data-col]').forEach(headerCell => {
    const dataCol = headerCell.getAttribute('data-col');
    if (dataCol === 'prodgroup3' || dataCol === 'operation') return;

    if (dataCol === 'progress') {
      const goal = aggregatedData.goal || 0;
      const output = aggregatedData.output || 0;
      const progressPercent = goal > 0 ? Math.round((output / goal) * 100) : 0;
      headerCell.setAttribute('data-progress', progressPercent);
      headerCell.setAttribute('data-output', output);
      headerCell.setAttribute('data-goal', goal);
      return;
    }

    if (aggregatedData[dataCol] !== undefined) {
      let span = headerCell.querySelector('.summary-value');
      if (!span) {
        span = document.createElement('span');
        span.className = 'summary-value';
        headerCell.innerHTML = '';
        headerCell.appendChild(span);
      }
      span.textContent = formatFinishGroupNumber(aggregatedData[dataCol]);
    }
  });

  drawFinishGroupHeaderProgressBars();
}

// Zebra striping for visible child rows only, per group.
function applyFinishRowStriping() {
  const tbody = document.querySelector('#testTable tbody');
  if (!tbody) return;

  const visibleChildRows = Array.from(tbody.querySelectorAll('tr.child-row:not(.collapsed)'));

  tbody.querySelectorAll('tr.child-row').forEach(row => {
    row.classList.remove('stripe-even', 'stripe-odd');
  });

  const groupedRows = {};
  visibleChildRows.forEach(row => {
    const group = row.getAttribute('data-group');
    if (!groupedRows[group]) groupedRows[group] = [];
    groupedRows[group].push(row);
  });

  Object.keys(groupedRows).forEach(group => {
    groupedRows[group].forEach((row, index) => {
      if (index % 2 === 0) row.classList.add('stripe-odd');
      else row.classList.add('stripe-even');
    });
  });
}

window.initFinishGrouping = initFinishGrouping;
window.expandAllFinishGroups = expandAllFinishGroups;
window.collapseAllFinishGroups = collapseAllFinishGroups;
window.refreshFinishGroupAggregatesForRow = refreshFinishGroupAggregatesForRow;
window.applyFinishRowStriping = applyFinishRowStriping;
