(function () {
    const rows = Array.isArray(window.__WIP_ROWS__) ? window.__WIP_ROWS__ : [];
    const operationList = document.getElementById('operationList');
    const allOperationsCheckbox = document.getElementById('op-all');
    const selectAllBtn = document.getElementById('btn-select-all');
    const clearAllBtn = document.getElementById('btn-clear-all');
    const productList = document.getElementById('productList');
    const allProductsCheckbox = document.getElementById('prod-all');
    const productSelectAllBtn = document.getElementById('btn-product-select-all');
    const productClearAllBtn = document.getElementById('btn-product-clear-all');

    // If the page has no chart/filter controls (empty-state render), exit safely.
    if (!rows.length || !operationList || !allOperationsCheckbox || !selectAllBtn || !clearAllBtn ||
        !productList || !allProductsCheckbox || !productSelectAllBtn || !productClearAllBtn) {
        return;
    }

    function fillOperationFilter() {
        const operationCodes = Array.from(new Set(rows.map(r => (r.operation || '(blank)')))).sort((a, b) => a.localeCompare(b));
        operationCodes.forEach((code) => {
            const label = document.createElement('label');
            label.className = 'checkbox-item';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'op-checkbox';
            checkbox.value = code;

            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(code));
            operationList.appendChild(label);
        });
    }

    function fillProductFilter() {
        const products = Array.from(new Set(rows.map(r => (r.prodgroup3 || '(blank)')))).sort((a, b) => a.localeCompare(b));
        products.forEach((product) => {
            const label = document.createElement('label');
            label.className = 'checkbox-item';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'prod-checkbox';
            checkbox.value = product;

            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(product));
            productList.appendChild(label);
        });
    }

    function getFilteredRows() {
        let filtered = rows;

        if (!allOperationsCheckbox.checked) {
            const selectedOps = Array.from(document.querySelectorAll('.op-checkbox:checked')).map((cb) => cb.value);
            if (selectedOps.length > 0) {
                const selectedSet = new Set(selectedOps);
                filtered = filtered.filter((row) => selectedSet.has(row.operation || '(blank)'));
            }
        }

        if (!allProductsCheckbox.checked) {
            const selectedProds = Array.from(document.querySelectorAll('.prod-checkbox:checked')).map((cb) => cb.value);
            if (selectedProds.length > 0) {
                const selectedSet = new Set(selectedProds);
                filtered = filtered.filter((row) => selectedSet.has(row.prodgroup3 || '(blank)'));
            }
        }

        return filtered;
    }

    function buildTraces(sourceRows) {
        const opSet = new Set();
        const productSet = new Set();
        const agg = {};
        const opDescToCode = {};

        sourceRows.forEach((row) => {
            const opDesc = row.oper_short_desc || '(blank)';
            const opCode = row.operation || '(blank)';
            const product = row.prodgroup3 || '(blank)';
            const wip = Number(row.current_wip) || 0;

            opSet.add(opDesc);
            productSet.add(product);
            opDescToCode[opDesc] = opCode;

            if (!agg[opDesc]) {
                agg[opDesc] = {};
            }
            agg[opDesc][product] = (agg[opDesc][product] || 0) + wip;
        });

        const operationLabels = Array.from(opSet).sort((a, b) => a.localeCompare(b));
        const products = Array.from(productSet).sort((a, b) => a.localeCompare(b));
        const operationCodes = operationLabels.map((opDesc) => opDescToCode[opDesc] || '');

        return products.map((product) => {
            const yRaw = operationLabels.map((opDesc) => (agg[opDesc] && agg[opDesc][product]) ? agg[opDesc][product] : 0);
            const yScaled = yRaw.map((value) => value / 1000);

            return {
                type: 'bar',
                name: product,
                x: operationLabels,
                y: yScaled,
                customdata: operationCodes,
                hovertemplate:
                    'Product: %{fullData.name}<br>' +
                    'Operation: %{customdata}<br>' +
                    'Operation Desc: %{x}<br>' +
                    'Current_WIP (k): %{y:.3f}<br>'
            };
        });
    }

    const layout = {
        margin: { l: 70, r: 20, t: 48, b: 120 },
        plot_bgcolor: '#ffffff',
        paper_bgcolor: '#ffffff',
        barmode: 'stack',
        xaxis: {
            title: 'OPER_SHORT_DESC',
            zeroline: false,
            gridcolor: '#eceff3',
            tickangle: -45
        },
        yaxis: {
            title: 'CURRENT_WIP',
            zeroline: false,
            gridcolor: '#eceff3'
        },
        bargap: 0.12,
        hoverlabel: {
            bgcolor: '#161616',
            bordercolor: '#161616',
            font: { color: '#ffffff' }
        },
        legend: {
            title: { text: 'Product' },
            orientation: 'h',
            yanchor: 'bottom',
            y: 1.02,
            xanchor: 'left',
            x: 0
        }
    };

    const config = {
        responsive: true,
        displayModeBar: true
    };

    function renderChart() {
        const traces = buildTraces(getFilteredRows());
        Plotly.react('wip-chart', traces, layout, config);
    }

    function getOperationCheckboxes() {
        return Array.from(document.querySelectorAll('.op-checkbox'));
    }

    function setAllOperationCheckboxes(checked) {
        getOperationCheckboxes().forEach((cb) => { cb.checked = checked; });
    }

    function syncAllCheckboxState() {
        const anyChecked = getOperationCheckboxes().some((cb) => cb.checked);
        allOperationsCheckbox.checked = !anyChecked;
    }

    function getProductCheckboxes() {
        return Array.from(document.querySelectorAll('.prod-checkbox'));
    }

    function setAllProductCheckboxes(checked) {
        getProductCheckboxes().forEach((cb) => { cb.checked = checked; });
    }

    function syncAllProductsCheckboxState() {
        const anyChecked = getProductCheckboxes().some((cb) => cb.checked);
        allProductsCheckbox.checked = !anyChecked;
    }

    fillOperationFilter();
    fillProductFilter();

    allOperationsCheckbox.addEventListener('change', () => {
        if (allOperationsCheckbox.checked) {
            setAllOperationCheckboxes(false);
        }
        renderChart();
    });

    operationList.addEventListener('change', (event) => {
        if (event.target.classList.contains('op-checkbox')) {
            syncAllCheckboxState();
            renderChart();
        }
    });

    selectAllBtn.addEventListener('click', () => {
        setAllOperationCheckboxes(true);
        allOperationsCheckbox.checked = false;
        renderChart();
    });

    clearAllBtn.addEventListener('click', () => {
        setAllOperationCheckboxes(false);
        allOperationsCheckbox.checked = true;
        renderChart();
    });

    allProductsCheckbox.addEventListener('change', () => {
        if (allProductsCheckbox.checked) {
            setAllProductCheckboxes(false);
        }
        renderChart();
    });

    productList.addEventListener('change', (event) => {
        if (event.target.classList.contains('prod-checkbox')) {
            syncAllProductsCheckboxState();
            renderChart();
        }
    });

    productSelectAllBtn.addEventListener('click', () => {
        setAllProductCheckboxes(true);
        allProductsCheckbox.checked = false;
        renderChart();
    });

    productClearAllBtn.addEventListener('click', () => {
        setAllProductCheckboxes(false);
        allProductsCheckbox.checked = true;
        renderChart();
    });

    renderChart();
})();
