// Test Modules page script (isolated).
// Intentionally does not depend on index.js to avoid coupling.

const TEST_DATA_ROW_SELECTOR = '#testTable tbody tr:not(.empty-state-row)';

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

window.saveAllTestGoalChanges = async function saveAllTestGoalChanges() {
  const rows = getTestDataRows();
  const updates = [];
  const commentUpdates = [];
  let hasIncomplete = false;

  rows.forEach(row => {
    if (row.style.display === 'none') return;
    const id = row.getAttribute('data-id');
    if (!id) return;

    const goalInput = row.querySelector('.goal-input');
    const reasonInput = row.querySelector('.reason-input');
    if (!goalInput || !reasonInput) return;

    const goalVal = String(goalInput.value ?? '');
    const goalOrig = String(goalInput.getAttribute('data-original') ?? '');
    const reasonVal = String(reasonInput.value ?? '');
    const reasonOrig = String(reasonInput.getAttribute('data-original') ?? '');

    const goalDirty = goalVal !== goalOrig;
    const reasonDirty = reasonVal !== reasonOrig;
    if (!goalDirty && !reasonDirty) return;

    const trimmedGoal = goalVal.trim();
    const trimmedReason = reasonVal.trim();
    const goalProvided = trimmedGoal !== '';
    const reasonProvided = trimmedReason !== '';
    if (goalProvided !== reasonProvided) {
      hasIncomplete = true;
      return;
    }

    updates.push({
      id: id,
      manual_goal: trimmedGoal === '' ? null : trimmedGoal,
      reason: trimmedReason,
    });

    // --- Comment updates ---
    const commentInput = row.querySelector('.comment-input');
    if (commentInput) {
      const commentVal = String(commentInput.value ?? '');
      const commentOrig = String(commentInput.getAttribute('data-original') ?? '');
      if (commentVal !== commentOrig) {
        commentUpdates.push({ id: id, comment: commentVal });
      }
    }
  });

  if (hasIncomplete) {
    showToast('Some rows are incomplete: both Manual Goal and Adjust Reason must be filled.', 'error');
    return;
  }
  if (updates.length === 0 && commentUpdates.length === 0) {
    showToast('No changes to save.', 'error');
    return;
  }

  const btn = document.querySelector('button[onclick="saveAllTestGoalChanges()"]');
  const originalText = btn ? btn.innerText : '';
  if (btn) { btn.innerText = '...'; btn.disabled = true; }

  try {
    let goalOk = 0, goalErr = 0, commentOk = 0, commentErr = 0;

    if (updates.length > 0) {
      const res = await fetch(apiUrl('/api/test/update-goals-batch'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates })
      });
      const json = await res.json();
      if (!res.ok || json.status !== 'success') {
        throw new Error(json.message || `HTTP ${res.status}`);
      }
      const results = Array.isArray(json.results) ? json.results : [];
      goalOk = results.filter(r => r && r.status === 'success').length;
      goalErr = results.filter(r => r && r.status !== 'success').length;

      // Mark originals clean.
      updates.forEach(u => {
        const row = document.querySelector(`tr[data-id="${u.id}"]`);
        if (!row) return;
        const goalInput = row.querySelector('.goal-input');
        const reasonInput = row.querySelector('.reason-input');
        if (goalInput) {
          goalInput.setAttribute('data-original', String(goalInput.value ?? ''));
          setInputDirtyState(goalInput, false);
        }
        if (reasonInput) {
          reasonInput.setAttribute('data-original', String(reasonInput.value ?? ''));
          setInputDirtyState(reasonInput, false);
        }
        hideActions(document.getElementById(`group-goal-${u.id}`));
      });
    }

    if (commentUpdates.length > 0) {
      const res = await fetch(apiUrl('/api/test/update-comments-batch'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: commentUpdates })
      });
      const json = await res.json();
      if (!res.ok || json.status !== 'success') {
        throw new Error(json.message || `HTTP ${res.status}`);
      }
      const results = Array.isArray(json.results) ? json.results : [];
      commentOk = results.filter(r => r && r.status === 'success').length;
      commentErr = results.filter(r => r && r.status !== 'success').length;

      commentUpdates.forEach(u => {
        const row = document.querySelector(`tr[data-id="${u.id}"]`);
        const input = row ? row.querySelector('.comment-input') : null;
        if (input) {
          input.setAttribute('data-original', String(input.value ?? ''));
          setInputDirtyState(input, false);
        }
        hideActions(document.getElementById(`group-comment-${u.id}`));
      });
    }

    const totalErr = goalErr + commentErr;
    const msg = `Saved goals: ${goalOk}${goalErr ? ` (${goalErr} failed)` : ''}. Saved comments: ${commentOk}${commentErr ? ` (${commentErr} failed)` : ''}.`;
    if (totalErr > 0) showToast(msg, 'error');
    else showToast(msg, 'success');
  } catch (e) {
    showToast(String(e.message || e), 'error');
  } finally {
    if (btn) { btn.innerText = originalText; btn.disabled = false; }
  }
};

window.openTestModal = function openTestModal() {
  const overlay = document.getElementById('testModalOverlay');
  if (overlay) overlay.style.display = 'flex';
};

window.closeTestModal = function closeTestModal() {
  const overlay = document.getElementById('testModalOverlay');
  if (overlay) overlay.style.display = 'none';
};

window.submitNewTestGoal = async function submitNewTestGoal() {
  const btn = document.getElementById('btn-test-modal-submit');
  const originalText = btn ? btn.innerText : '';

  const pg3 = (document.getElementById('t_pg3')?.value || '').trim();
  const oper = (document.getElementById('t_oper')?.value || '').trim();
  const goal = (document.getElementById('t_goal')?.value || '').trim();
  const reason = (document.getElementById('t_reason')?.value || '').trim();
  const page = getCurrentTestPageFromUrl();

  if (!pg3 || !oper || !goal || !reason) {
    showToast('Please fill in all required fields (*)', 'error');
    return;
  }

  if (btn) { btn.innerText = '...'; btn.disabled = true; }
  try {
    const res = await fetch(apiUrl('/api/test/add-new-goal'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prodgroup3: pg3, operation: oper, goal: goal, reason: reason, page: page })
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

// Shift View dropdown uses a GET form submit (same as assembly), so no JS is needed.

window.handleTestInput = function handleTestInput(input, type) {
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
  } else if (type === 'comment') {
    actionGroup = document.getElementById(`group-comment-${rowId}`);
    const commentInput = row.querySelector('.comment-input');
    const isDirty = String(commentInput.value) !== String(commentInput.getAttribute('data-original'));
    if (isDirty) showActions(actionGroup);
    else hideActions(actionGroup);
  }
};

window.cancelTestRow = function cancelTestRow(btn, type) {
  const row = btn.closest('tr');
  if (type === 'goal') {
    const goalInput = row.querySelector('.goal-input');
    const reasonInput = row.querySelector('.reason-input');
    goalInput.value = goalInput.getAttribute('data-original') || '';
    reasonInput.value = reasonInput.getAttribute('data-original') || '';
    setInputDirtyState(goalInput, false);
    setInputDirtyState(reasonInput, false);
    hideActions(document.getElementById(`group-goal-${row.getAttribute('data-id')}`));
  } else if (type === 'comment') {
    const c = row.querySelector('.comment-input');
    c.value = c.getAttribute('data-original') || '';
    setInputDirtyState(c, false);
    hideActions(document.getElementById(`group-comment-${row.getAttribute('data-id')}`));
  }
};

window.saveTestRow = async function saveTestRow(btn, type) {
  const row = btn.closest('tr');
  const id = row.getAttribute('data-id');

  const url = (type === 'goal')
    ? apiUrl('/api/test/update-goal')
    : apiUrl('/api/test/update-comment');

  const payload = { id: id };

  if (type === 'goal') {
    const rawGoal = row.querySelector('.goal-input').value;
    const reasonVal = row.querySelector('.reason-input').value.trim();

    if ((rawGoal !== '' && reasonVal === '') || (rawGoal === '' && reasonVal !== '')) {
      showToast('Both Manual Goal and Adjust Reason must be filled.', 'error');
      if (rawGoal === '') row.querySelector('.goal-input').focus();
      else row.querySelector('.reason-input').focus();
      return;
    }

    // Keep semantics: empty means NULL.
    payload.manual_goal = rawGoal === '' ? null : rawGoal;
    payload.reason = reasonVal;
  } else if (type === 'comment') {
    payload.comment = row.querySelector('.comment-input').value;
  }

  try {
    btn.disabled = true;
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
      const reasonInput = row.querySelector('.reason-input');
      goalInput.setAttribute('data-original', goalInput.value);
      reasonInput.setAttribute('data-original', reasonInput.value);
      setInputDirtyState(goalInput, false);
      setInputDirtyState(reasonInput, false);
      hideActions(document.getElementById(`group-goal-${id}`));
      showToast('Saved manual goal.', 'success');
    } else {
      const c = row.querySelector('.comment-input');
      c.setAttribute('data-original', c.value);
      setInputDirtyState(c, false);
      hideActions(document.getElementById(`group-comment-${id}`));
      showToast('Saved comment.', 'success');
    }
  } catch (e) {
    showToast(String(e.message || e), 'error');
  } finally {
    btn.disabled = false;
  }
};

document.addEventListener('DOMContentLoaded', () => {
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
  });
});
