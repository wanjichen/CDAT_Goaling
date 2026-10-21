// Client-side filtering and CSV export for the Goaling Raw Data page.
(function () {
    function getTable() {
        return document.getElementById('rawDataTable');
    }

    function stripPpPrefix(value) {
        const s = String(value == null ? '' : value).trim();
        return /^PP-/i.test(s) ? s.slice(3) : s;
    }

    function applyRawDataFilters() {
        const table = getTable();
        if (!table) return;

        const prodgroup3Col = table.getAttribute('data-prodgroup3-col') || '';

        const filterSelects = table.querySelectorAll('thead tr.filter-row select.filter-input-field');
        const activeFilters = {};
        filterSelects.forEach(function (sel) {
            const col = sel.getAttribute('data-filter-col');
            const val = sel.value;
            if (val) activeFilters[col] = val;
        });

        const bodyRows = table.querySelectorAll('tbody tr');
        bodyRows.forEach(function (row) {
            if (row.classList.contains('empty-state-row')) return;
            let visible = true;
            for (const col in activeFilters) {
                const cell = row.querySelector('td[data-col="' + cssEscape(col) + '"]');
                let cellVal = cell ? cell.textContent.trim() : '';
                // For the Prodgroup3 column, match "PP-M4G" and "M4G" as
                // the same value by comparing with the "PP-" prefix removed.
                if (prodgroup3Col && col === prodgroup3Col) {
                    cellVal = stripPpPrefix(cellVal);
                }
                if (cellVal !== activeFilters[col]) {
                    visible = false;
                    break;
                }
            }
            row.style.display = visible ? '' : 'none';
        });
    }

    function clearRawDataFilters() {
        const table = getTable();
        if (!table) return;
        const filterSelects = table.querySelectorAll('thead tr.filter-row select.filter-input-field');
        filterSelects.forEach(function (sel) {
            sel.value = '';
        });
        applyRawDataFilters();
    }

    function cssEscape(value) {
        if (window.CSS && CSS.escape) return CSS.escape(value);
        return String(value).replace(/["\\]/g, '\\$&');
    }

    function exportRawDataToCSV() {
        const table = getTable();
        if (!table) return;

        const headerCells = table.querySelectorAll('thead tr:first-child th');
        const headers = Array.from(headerCells).map(function (th) {
            return th.getAttribute('data-col') || th.textContent.trim();
        });

        const rows = [headers];
        const bodyRows = table.querySelectorAll('tbody tr');
        bodyRows.forEach(function (row) {
            if (row.classList.contains('empty-state-row')) return;
            if (row.style.display === 'none') return;
            const cells = row.querySelectorAll('td');
            rows.push(Array.from(cells).map(function (td) { return td.textContent.trim(); }));
        });

        const csvContent = rows.map(function (r) {
            return r.map(function (val) {
                const s = String(val == null ? '' : val);
                if (/[",\n]/.test(s)) {
                    return '"' + s.replace(/"/g, '""') + '"';
                }
                return s;
            }).join(',');
        }).join('\r\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        link.href = URL.createObjectURL(blob);
        link.download = 'goaling_raw_data_' + ts + '.csv';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    window.applyRawDataFilters = applyRawDataFilters;
    window.clearRawDataFilters = clearRawDataFilters;
    window.exportRawDataToCSV = exportRawDataToCSV;
})();
