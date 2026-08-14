// Demo JavaScript for expand/collapse functionality on Prodgroup3 level

// This script will group rows by prodgroup3 and add expand/collapse functionality
// Call initGrouping() after the page loads

function initGrouping() {
  const tbody = document.querySelector('#testTable tbody');
  if (!tbody) return;
  
  const dataRows = Array.from(tbody.querySelectorAll('tr:not(.empty-state-row)'));
  if (dataRows.length === 0) return;
  
  // Group rows by prodgroup3
  const groups = {};
  dataRows.forEach(row => {
    const prodgroup3 = row.querySelector('td[data-col="prodgroup3"]')?.textContent.trim();
    if (!prodgroup3) return;
    
    if (!groups[prodgroup3]) {
      groups[prodgroup3] = [];
    }
    groups[prodgroup3].push(row);
  });
  
  // Clear tbody
  tbody.innerHTML = '';
  
  // For each group, create a header row and child rows
  Object.keys(groups).sort().forEach((prodgroup3, index) => {
    const childRows = groups[prodgroup3];
    const isExpanded = false; // Start collapsed by default
    
    // Create group header row with aggregated data
    const headerRow = createGroupHeaderRow(prodgroup3, childRows, isExpanded);
    tbody.appendChild(headerRow);
    
    // Add all child rows
    childRows.forEach(childRow => {
      childRow.classList.add('child-row');
      if (!isExpanded) {
        childRow.classList.add('collapsed');
      }
      childRow.setAttribute('data-group', prodgroup3);
      
      // Hide Prodgroup3 value in child rows (only show in header)
      const prodgroup3Cell = childRow.querySelector('td[data-col="prodgroup3"]');
      if (prodgroup3Cell) {
        prodgroup3Cell.textContent = '';
      }
      
      tbody.appendChild(childRow);
    });
  });
  
  // Recalculate totals and progress after grouping
  if (typeof recalcTestTotals === 'function') {
    recalcTestTotals();
  }
  if (typeof drawTestProgressBars === 'function') {
    drawTestProgressBars();
  }
  
  // Draw progress bars for group header rows manually
  drawGroupHeaderProgressBars();
  
  // Apply striping to child rows
  applyRowStriping();
}

function createGroupHeaderRow(prodgroup3, childRows, isExpanded) {
  const headerRow = document.createElement('tr');
  headerRow.classList.add('group-header-row');
  headerRow.setAttribute('data-group', prodgroup3);
  headerRow.setAttribute('data-expanded', isExpanded ? 'true' : 'false');
  
  // Get the first child row to determine column structure
  const firstChild = childRows[0];
  const cells = firstChild.querySelectorAll('td');
  
  // Calculate aggregated values
  const aggregatedData = calculateAggregatedData(childRows);
  
  // Create cells for header row
  cells.forEach((cell, index) => {
    const dataCol = cell.getAttribute('data-col');
    const headerCell = document.createElement('td');
    headerCell.className = cell.className;
    headerCell.setAttribute('data-col', dataCol);
    
    if (index === 0) {
      // First cell: Prodgroup3 with expand/collapse icon
      const icon = document.createElement('span');
      icon.className = 'expand-collapse-icon' + (isExpanded ? ' expanded' : '');
      icon.innerHTML = '▶';
      icon.setAttribute('aria-label', isExpanded ? 'Collapse' : 'Expand');
      
      headerCell.appendChild(icon);
      headerCell.appendChild(document.createTextNode(prodgroup3));
    } else if (index === 1) {
      // Second cell: Show count of DLCPs
      headerCell.textContent = `(${childRows.length} ${childRows.length === 1 ? 'row' : 'rows'})`;
    } else if (dataCol === 'progress') {
      // Progress column: Calculate aggregated progress (output / goal)
      const goal = aggregatedData.goal || 0;
      const output = aggregatedData.output || 0;
      const progressPercent = goal > 0 ? Math.round((output / goal) * 100) : 0;
      
      // Add a data attribute so progress bar drawing can find this
      headerCell.setAttribute('data-progress', progressPercent);
      headerCell.setAttribute('data-output', output);
      headerCell.setAttribute('data-goal', goal);
      
      // The progress bar will be drawn by the existing drawTestProgressBars function
      // Just set the text for now
      headerCell.textContent = progressPercent + '%';
    } else if (aggregatedData[dataCol] !== undefined) {
      // Show aggregated values for specific columns
      const span = document.createElement('span');
      span.className = 'summary-value';
      span.textContent = formatNumber(aggregatedData[dataCol]);
      headerCell.appendChild(span);
    } else {
      // Empty cell for other columns
      headerCell.textContent = '';
    }
    
    headerRow.appendChild(headerCell);
  });
  
  // Add click handler to toggle expand/collapse
  headerRow.addEventListener('click', (e) => {
    // Don't toggle if clicking on an input or button
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'TEXTAREA') {
      return;
    }
    toggleGroup(prodgroup3);
  });
  
  return headerRow;
}

function calculateAggregatedData(childRows) {
  const aggregated = {
    shift_start_wip: 0,
    sfgi_wip: 0,
    commit1: 0,
    commit2: 0,
    start_wip_onhold: 0,
    qtg1: 0,
    qtg2: 0,
    qps1: 0,
    qps2: 0,
    tr: 0,
    link_cell_qty: 0,
    capacity: 0,
    goal: 0,
    output: 0,
    stg1: null,  // Will be set from FF or first row
    stg2: null   // Will be set from FF or first row
  };
  
  // First, try to find the FF row for STG values
  let ffRow = null;
  let firstRow = childRows[0];
  
  for (const row of childRows) {
    const dlcpCell = row.querySelector('td[data-col="dlcp"]');
    if (dlcpCell && dlcpCell.textContent.trim().toUpperCase() === 'FF') {
      ffRow = row;
      break;
    }
  }
  
  // Use FF row if found, otherwise use first row for STG values
  const stgSourceRow = ffRow || firstRow;
  
  if (stgSourceRow) {
    const stg1Cell = stgSourceRow.querySelector('td[data-col="stg1"]');
    const stg2Cell = stgSourceRow.querySelector('td[data-col="stg2"]');
    
    if (stg1Cell) {
      aggregated.stg1 = parseFloat(stg1Cell.textContent) || 0;
    }
    if (stg2Cell) {
      aggregated.stg2 = parseFloat(stg2Cell.textContent) || 0;
    }
  }
  
  // Sum all other columns
  childRows.forEach(row => {
    Object.keys(aggregated).forEach(col => {
      // Skip STG1 and STG2 as they're already set
      if (col === 'stg1' || col === 'stg2') return;
      
      const cell = row.querySelector(`td[data-col="${col}"]`);
      if (cell) {
        // Check if it has an input
        const input = cell.querySelector('input');
        let value = 0;
        if (input) {
          value = parseFloat(input.value) || 0;
        } else {
          value = parseFloat(cell.textContent) || 0;
        }
        aggregated[col] += value;
      }
    });
  });
  
  return aggregated;
}

function toggleGroup(prodgroup3) {
  const headerRow = document.querySelector(`tr.group-header-row[data-group="${prodgroup3}"]`);
  if (!headerRow) return;
  
  const isExpanded = headerRow.getAttribute('data-expanded') === 'true';
  const newState = !isExpanded;
  
  // Update header row state
  headerRow.setAttribute('data-expanded', newState ? 'true' : 'false');
  
  // Update icon
  const icon = headerRow.querySelector('.expand-collapse-icon');
  if (icon) {
    if (newState) {
      icon.classList.add('expanded');
    } else {
      icon.classList.remove('expanded');
    }
  }
  
  // Toggle child rows
  const childRows = document.querySelectorAll(`tr.child-row[data-group="${prodgroup3}"]`);
  childRows.forEach(row => {
    if (newState) {
      row.classList.remove('collapsed');
    } else {
      row.classList.add('collapsed');
    }
  });
  
  // Recalculate totals if needed (collapsed rows should still be counted)
  if (typeof recalcTestTotals === 'function') {
    recalcTestTotals();
  }
  
  // Reapply striping after toggle
  applyRowStriping();
}

function formatNumber(num) {
  if (num === 0) return '0';
  if (num === Math.floor(num)) return num.toString();
  return num.toFixed(1);
}

// Add expand/collapse all functionality
function expandAllGroups() {
  document.querySelectorAll('tr.group-header-row').forEach(headerRow => {
    const prodgroup3 = headerRow.getAttribute('data-group');
    if (headerRow.getAttribute('data-expanded') === 'false') {
      toggleGroup(prodgroup3);
    }
  });
}

function collapseAllGroups() {
  document.querySelectorAll('tr.group-header-row').forEach(headerRow => {
    const prodgroup3 = headerRow.getAttribute('data-group');
    if (headerRow.getAttribute('data-expanded') === 'true') {
      toggleGroup(prodgroup3);
    }
  });
}

function drawGroupHeaderProgressBars() {
  // Draw progress bars for all group header rows
  document.querySelectorAll('tr.group-header-row').forEach(headerRow => {
    const progressCell = headerRow.querySelector('td[data-col="progress"]');
    if (!progressCell) return;
    
    const goal = parseFloat(progressCell.getAttribute('data-goal')) || 0;
    const output = parseFloat(progressCell.getAttribute('data-output')) || 0;
    const progressPercent = parseFloat(progressCell.getAttribute('data-progress')) || 0;
    
    // Create progress bar structure if it doesn't exist
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
    
    // Update progress bar
    const fill = progressCell.querySelector('.progress-fill');
    const label = progressCell.querySelector('.progress-label');
    
    if (fill && label) {
      const pctClamped = Math.min(100, Math.max(0, progressPercent));
      fill.style.width = pctClamped + '%';
      
      // Use gradient if available
      if (window.ProgressScale && window.ProgressScale.fillGradientCss) {
        fill.style.background = window.ProgressScale.fillGradientCss(progressPercent);
      }
      
      // Set color class
      fill.classList.remove('is-ok', 'is-warn', 'is-bad');
      if (goal > 0) {
        if (progressPercent >= 100) {
          fill.classList.add('is-ok');
        } else if (progressPercent >= 50) {
          fill.classList.add('is-warn');
        } else {
          fill.classList.add('is-bad');
        }
      }
      
      label.textContent = goal > 0 ? Math.round(progressPercent) + '%' : '';
      progressCell.title = goal > 0 ? `${output} / ${goal} (${progressPercent.toFixed(1)}%)` : `${output} / ${goal}`;
    }
  });
}

// Recalculate and refresh a single group header row's aggregated values
// (summary values + progress) from its current child rows. Call this
// whenever an editable value inside a child row (goal, cell qty, etc.)
// changes, so the group header stays in sync without a full re-group.
function updateGroupHeaderRow(prodgroup3) {
  if (!prodgroup3) return;
  const headerRow = document.querySelector(`tr.group-header-row[data-group="${prodgroup3}"]`);
  if (!headerRow) return;

  const childRows = Array.from(document.querySelectorAll(`tr.child-row[data-group="${prodgroup3}"]`));
  if (childRows.length === 0) return;

  const aggregatedData = calculateAggregatedData(childRows);

  headerRow.querySelectorAll('td[data-col]').forEach(headerCell => {
    const dataCol = headerCell.getAttribute('data-col');

    // First column (prodgroup3 name/icon) and second column (row count) are not sums.
    if (dataCol === 'prodgroup3' || dataCol === 'operation') {
      return;
    }

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
      span.textContent = formatNumber(aggregatedData[dataCol]);
    }
  });

  // Redraw progress bars so the new goal/output percentage is reflected visually.
  drawGroupHeaderProgressBars();
}

// Convenience helper: given a child row that was just edited, find its
// group and refresh that group's header aggregates.
function refreshGroupAggregatesForRow(row) {
  if (!row) return;
  const prodgroup3 = row.getAttribute('data-group');
  if (!prodgroup3) return;
  updateGroupHeaderRow(prodgroup3);
}

window.updateGroupHeaderRow = updateGroupHeaderRow;
window.refreshGroupAggregatesForRow = refreshGroupAggregatesForRow;

// Apply zebra striping to visible child rows only
function applyRowStriping() {
  const tbody = document.querySelector('#testTable tbody');
  if (!tbody) return;
  
  // Get all visible child rows (not collapsed, not group headers)
  const visibleChildRows = Array.from(tbody.querySelectorAll('tr.child-row:not(.collapsed)'));
  
  // Remove existing stripe classes from ALL child rows (including collapsed ones)
  tbody.querySelectorAll('tr.child-row').forEach(row => {
    row.classList.remove('stripe-even', 'stripe-odd');
  });
  
  // Apply striping based on visible position within each group
  let groupedRows = {};
  
  // Group visible rows by their data-group attribute
  visibleChildRows.forEach(row => {
    const group = row.getAttribute('data-group');
    if (!groupedRows[group]) {
      groupedRows[group] = [];
    }
    groupedRows[group].push(row);
  });
  
  // Apply striping within each group independently
  Object.keys(groupedRows).forEach(group => {
    groupedRows[group].forEach((row, index) => {
      if (index % 2 === 0) {
        row.classList.add('stripe-odd');  // First row (index 0) is odd
      } else {
        row.classList.add('stripe-even'); // Second row (index 1) is even
      }
    });
  });
}

// Export functions to window for easy access
window.initGrouping = initGrouping;
window.expandAllGroups = expandAllGroups;
window.collapseAllGroups = collapseAllGroups;
window.applyRowStriping = applyRowStriping;

// Helper function to check if current page should have grouping
function shouldEnableGrouping() {
  // Only enable grouping on STHI and HDMx tabs (they have DLCP column)
  const url = new URL(window.location.href);
  const page = url.searchParams.get('page') || '';
  return page === 'STHI' || page === 'HDMx';
}

// Auto-initialize when DOM is ready, but only on STHI and HDMx
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    if (shouldEnableGrouping()) {
      initGrouping();
    }
  });
} else {
  // DOM already loaded, but wait a bit for test.js to finish
  setTimeout(function() {
    if (shouldEnableGrouping()) {
      initGrouping();
    }
  }, 500);
}
