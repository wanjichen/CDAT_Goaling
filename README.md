# CDAT Goaling

Flask + Jinja web app for viewing and maintaining CDAT MFG goaling data, designed to run under IIS FastCGI (wfastcgi) and also usable locally.

## What this app does

- Shows goaling tables by **subpage** (TCB, HBC-JDC, DIA, TACS23, TPX, DFLX, EPX, CURE, PXVI, CTC, 2D-Xray, BA).
- Supports **shift selection** (defaults to the latest available DB shift).
- Allows editing:
  - Manual adjusted goal + adjust reason (versioned updates)
  - Miss goal comment (versioned updates)
  - Entity (in-place update on supported pages)
- Provides downloads:
  - Export current visible table to CSV
  - Download raw validation CSV (`/download/wip-goal-reckon-raw`) with a timestamped filename

## Subpage mapping (operations)

Subpages map to operation codes in `app.py` via `OPERATION_GROUPS`:

- Edit `OPERATION_GROUPS` to change which operations belong to each page.
- Filtering is applied in `apply_operation_group_filter()`.

## How rows are chosen (latest-per-group logic)

For a selected shift and page, the UI is populated from `index()` which uses `get_latest_report_ids_for_shift_and_page()`.

Current selection rules:

- Data is scoped to the selected `shift`.
- The table displays the **latest row (`max(id)`) per (prodgroup3, operation, entity)**.
- Special-case for `entity IS NULL` rows:
  - If any non-NULL entity exists for the same `(shift, prodgroup3, operation)`, the NULL-entity row is hidden.
  - Otherwise the latest NULL-entity row is shown.

## Add New Goal modal rules

The **ENTITY** field in the Add New Goal modal is:

- Shown and **required** only on these pages:
  - `TCB`, `HBC-JDC`, `DIA`, `EPX`, `BA`
- Hidden (and optional) on other pages.

This is enforced both:

- Client-side in `static/js/index.js` (`submitNewGoal()`), and
- Server-side in `app.py` (`/api/add-new-goal`) using the submitted `page` value.

## Project layout

- `app.py` — Flask app and API endpoints
- `templates/index.html` — main page template (table, modal form)
- `static/css/` — styles
- `static/js/index.js` — client logic (sorting/filtering/export/save, sticky columns)
- `data/` — input CSV files (calendar and raw validation)
- `web.config` — IIS + wfastcgi hosting config

## Local development (basic)

1. Create/activate a Python environment.
2. Install dependencies from `requirements.txt`.
3. Run the app (example):

```pwsh
$env:FLASK_APP = "app.py"
python -m flask run --host 0.0.0.0 --port 5000
```

> Note: The production deployment uses IIS + wfastcgi.

## Hosting notes (IIS)

- The app supports an IIS application path prefix using `URL_PREFIX`.
- API requests in the frontend are built with `apiUrl()` to work under `/CDAT_Goaling`.

## Git hygiene

Runtime artifacts are ignored via `.gitignore`, including:

- `__pycache__/`, `*.pyc`
- `logs/`, `*.log`
- common Python caches and virtualenv folders

If a file was previously committed, `.gitignore` won’t stop it from being tracked. Use:

```pwsh
git rm --cached <path>
```

## Troubleshooting

- If sticky/pinned columns don’t work, check that later CSS isn’t overriding `position: sticky`.
- If you see unexpected duplicates, review `get_latest_report_ids_for_shift_and_page()` and the grouping strategy.

## License

Internal tool / no public license specified.
