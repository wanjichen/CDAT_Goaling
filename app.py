import urllib.parse
import csv
import os
import re
import time
import logging
from pathlib import Path
from threading import Lock
from datetime import datetime
from flask import Flask, render_template, request, jsonify, redirect, url_for, send_file, Response
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import desc, inspect, text

from test_modules.routes import register_test_routes

app = Flask(__name__)

# --- IIS / wfastcgi logging ---
# Ensure unhandled exceptions end up in the WSGI_LOG file (web.config sets it).
try:
    _wsgi_log_path = os.getenv('WSGI_LOG')
    if _wsgi_log_path:
        _handler = logging.FileHandler(_wsgi_log_path)
        _handler.setLevel(logging.INFO)
        _handler.setFormatter(logging.Formatter(
            '%(asctime)s %(levelname)s %(name)s: %(message)s'))
        # Attach to both Flask app logger and root logger.
        app.logger.addHandler(_handler)
        logging.getLogger().addHandler(_handler)
except Exception:
    # Never fail app import due to logging config.
    pass


class PrefixMiddleware:
    """Make the Flask app behave correctly behind an IIS Application path.

    Example: when hosted as an IIS Application named /CDAT_Goaling, set
    environment variable URL_PREFIX=/CDAT_Goaling.
    """

    def __init__(self, app, prefix: str):
        self.app = app
        self.prefix = (prefix or "").rstrip("/")

    def __call__(self, environ, start_response):
        path_info = environ.get("PATH_INFO", "")
        if self.prefix and path_info.startswith(self.prefix):
            environ["SCRIPT_NAME"] = self.prefix
            remaining = path_info[len(self.prefix):]
            environ["PATH_INFO"] = remaining if remaining else "/"
        return self.app(environ, start_response)


# Supports hosting under an IIS URL prefix like /CDAT_Goaling.
URL_PREFIX = os.getenv("URL_PREFIX", "").strip()
if URL_PREFIX:
    app.wsgi_app = PrefixMiddleware(app.wsgi_app, URL_PREFIX)


def env_flag(name, default='false'):
    return os.getenv(name, default).lower() in {'1', 'true', 'yes', 'on'}


# --- Database configuration ---
db_user = os.getenv("GOALING_DB_USER", "atmoperationdatastor_rw")
db_password = urllib.parse.quote_plus(
    os.getenv("GOALING_DB_PASSWORD", "")
)
db_host = os.getenv("GOALING_DB_HOST", "zy0mp6zl4jrhc0bqfrjx.iglb.intel.com")
db_port = os.getenv("GOALING_DB_PORT", "5432")
db_name = os.getenv("GOALING_DB_NAME", "atmoperationdatastore")
db_schema = os.getenv("GOALING_DB_SCHEMA", "cdat_mfg")

app.config['SQLALCHEMY_DATABASE_URI'] = (
    f"postgresql+psycopg2://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}"
    "?sslmode=require"
)
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# cache static assets for 1 hour
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 3600

engine_connect_args = {}
if db_schema:
    engine_connect_args["options"] = f"-c search_path={db_schema}"

_engine_opts = {
    "pool_pre_ping": True,
    "pool_size": 5,
    "max_overflow": 10,
}
if engine_connect_args:
    _engine_opts["connect_args"] = engine_connect_args
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = _engine_opts


db = SQLAlchemy(app)


# Register isolated areas (kept separate from production assembly modules).
register_test_routes(app)


@app.route('/download/wip-goal-reckon-raw')
def download_wip_goal_reckon_raw():
    """Download the raw validation CSV used for data checking."""
    csv_path = os.path.join(app.root_path, 'data', 'wip_goal_reckon_raw.csv')
    if not os.path.exists(csv_path):
        return json_error('CSV file not found', 404)

    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    download_filename = f'goal_raw_data_{ts}.csv'

    # Use conditional=False to avoid IIS/proxy caching oddities for a frequently-updated file.
    return send_file(
        csv_path,
        as_attachment=True,
        download_name=download_filename,
        mimetype='text/csv',
        conditional=False,
        max_age=0,
    )


@app.route('/api/download-goal-output')
def download_goal_output():
    """Download goal vs output table data as CSV (all recent shifts, all modules)."""
    user = get_current_user()

    # Get the most recent 14 shifts
    latest_id = db.func.max(Report.id).label('latest_id')
    shift_rows = db.session.query(Report.shift, latest_id).filter(
        Report.shift.isnot(None),
        db.func.trim(db.cast(Report.shift, db.String)) != ''
    ).group_by(Report.shift).order_by(desc(latest_id)).limit(14).all()

    shifts = [row.shift for row in shift_rows if row.shift]
    if not shifts:
        return json_error('No data available', 404)

    shifts = sorted(shifts, reverse=False)  # Ascending order (oldest first)

    # Build data: query assembly and test modules
    rows_data = []

    # Test modules (should only come from TestReport table, not Report)
    test_modules = ['HDMx', 'PHVI', 'V8', 'OLB', 'BI', 'STHI']

    # Query assembly modules (exclude test modules)
    assembly_query = db.session.query(
        Report.shift,
        Report.module,
        Report.prodgroup3,
        Report.entity,
        db.func.sum(
            db.func.coalesce(Report.manual_adjusted_goal,
                             Report.system_suggested_goal, 0)
        ).label('total_goal'),
        db.func.sum(db.func.coalesce(Report.output, 0)).label('total_output'),
        db.func.sum(db.func.coalesce(Report.qps1, 0)).label('total_qps1')
    ).filter(
        Report.shift.in_(shifts),
        Report.module.notin_(test_modules),
        (Report.is_deleted.is_(None)) | (Report.is_deleted.is_(False))
    ).group_by(
        Report.shift,
        Report.module,
        Report.prodgroup3,
        Report.entity
    ).all()

    # Query test modules: get the LATEST row per (shift, module, prodgroup3) using MAX(id)
    # First, get the max IDs for each group
    test_max_ids_query = db.session.query(
        db.func.max(TestReport.id).label('max_id')
    ).filter(
        TestReport.shift.in_(shifts),
        (TestReport.is_deleted.is_(None)) | (TestReport.is_deleted.is_(False))
    ).group_by(
        TestReport.shift,
        TestReport.module,
        TestReport.prodgroup3
    ).subquery()

    # Now get the actual rows using those max IDs
    test_query = db.session.query(
        TestReport.shift,
        TestReport.module,
        TestReport.prodgroup3,
        db.literal(None).label('entity'),
        TestReport.goal.label('total_goal'),
        TestReport.output.label('total_output'),
        TestReport.qps1.label('total_qps1')
    ).filter(
        TestReport.id.in_(
            db.session.query(test_max_ids_query.c.max_id)
        )
    ).all()

    # Process assembly rows
    for row in assembly_query:
        goal = row.total_goal or 0
        output = row.total_output or 0
        qps1 = row.total_qps1 or 0
        if goal == 0:  # Skip rows with no goal
            continue
        achievement = (output / goal * 100) if goal > 0 else 0
        rows_data.append({
            'shift': row.shift or '',
            'module': row.module or '',
            'prodgroup3': row.prodgroup3 or '',
            'entity': row.entity or '',
            'goal': goal,
            'output': output,
            'qps1': qps1,
            'achievement': round(achievement, 1),
        })

    # Process test rows
    for row in test_query:
        goal = row.total_goal or 0
        output = row.total_output or 0
        qps1 = row.total_qps1 or 0
        if goal == 0:  # Skip rows with no goal
            continue
        achievement = (output / goal * 100) if goal > 0 else 0
        rows_data.append({
            'shift': row.shift or '',
            'module': row.module or '',
            'prodgroup3': row.prodgroup3 or '',
            'entity': '',
            'goal': goal,
            'output': output,
            'qps1': qps1,
            'achievement': round(achievement, 1),
        })

    # Sort by shift, module, prodgroup3, entity
    rows_data.sort(key=lambda x: (
        x['shift'], x['module'], x['prodgroup3'], x['entity']))

    # Build CSV in memory
    import io
    csv_buffer = io.StringIO()
    writer = csv.writer(csv_buffer)

    # Write header
    writer.writerow(['Shift', 'Module', 'Prodgroup3',
                    'Entity', 'Goal', 'Output', 'QPS1', 'Achievement %'])

    # Helper function to format numbers: integer if whole, else 3 decimals
    def format_number(val):
        if isinstance(val, (int, float)):
            if val == int(val):
                return str(int(val))
            else:
                return f"{val:.3f}"
        return str(val)

    # Helper function to format achievement %: integer if whole, else 2 decimals
    def format_achievement(val):
        if isinstance(val, (int, float)):
            if val == int(val):
                return str(int(val))
            else:
                return f"{val:.2f}"
        return str(val)

    # Write data rows
    for row in rows_data:
        writer.writerow([
            row['shift'],
            row['module'],
            row['prodgroup3'],
            row['entity'],
            format_number(row['goal']),
            format_number(row['output']),
            format_number(row['qps1']),
            format_achievement(row['achievement']),
        ])

    # Create response
    csv_str = csv_buffer.getvalue()
    csv_bytes = csv_str.encode('utf-8-sig')  # BOM for Excel compatibility

    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    filename = f'goal_output_{ts}.csv'

    return Response(
        csv_bytes,
        mimetype='text/csv',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'}
    )


_CALENDAR_CACHE = {"mtime": None, "shift": None, "year": None}
_CALENDAR_CACHE_LOCK = Lock()

_SHIFTS_CACHE: dict = {}
_SHIFTS_CACHE_LOCK = Lock()
_SHIFTS_CACHE_TTL = 60  # seconds

IDENTITY_HEADER_KEYS = [
    'X-Forwarded-User',
    'X-Auth-User',
    'X-Logon-User',
    'X-Remote-User',
    'X-MS-CLIENT-PRINCIPAL-NAME'
]

IDENTITY_ENV_KEYS = [
    'REMOTE_USER',
    'AUTH_USER',
    'LOGON_USER',
    'HTTP_X_FORWARDED_USER',
    'HTTP_X_AUTH_USER',
    'HTTP_X_LOGON_USER'
]

# Explicit opt-in for the temporary identity debug endpoint.
ENABLE_IDENTITY_DEBUG_ENDPOINT = os.getenv(
    'ENABLE_IDENTITY_DEBUG_ENDPOINT', 'false'
)
ENABLE_IDENTITY_DEBUG_ENDPOINT = env_flag(
    'ENABLE_IDENTITY_DEBUG_ENDPOINT', ENABLE_IDENTITY_DEBUG_ENDPOINT)


class Report(db.Model):
    __tablename__ = 'cdat_goaling'
    __table_args__ = {'schema': db_schema} if db_schema else {}

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    year = db.Column(db.Integer)
    shift = db.Column(db.String(10))
    prodgroup3 = db.Column(db.String(50))
    operation = db.Column(db.String(50))
    module = db.Column(db.String(50))
    qtg1 = db.Column(db.Float, default=0.0)
    qps1 = db.Column(db.Float, default=0.0)
    stg1 = db.Column(db.Float, default=0.0)
    qtg2 = db.Column(db.Float, default=0.0)
    qps2 = db.Column(db.Float, default=0.0)
    stg2 = db.Column(db.Float, default=0.0)
    entity = db.Column(db.String(50))
    mor = db.Column(db.Float, default=0.0)
    tr = db.Column(db.Float, default=0.0)
    output = db.Column(db.Float, default=0.0)
    shift_start_wip = db.Column(db.Float, default=0.0)
    system_suggested_goal = db.Column(db.Float, default=0.0)
    system_suggested_goal_created_at = db.Column(db.DateTime)
    subcell_info = db.Column(db.String(100))

    # Manual override; keep NULL distinct from 0 so versioning/comment-only updates don't turn NULL into 0.
    manual_adjusted_goal = db.Column(db.Float, nullable=True)
    goal_adjusted_reason = db.Column(db.String(255))
    goal_adjusted_at = db.Column(db.DateTime)
    goal_adjusted_by = db.Column(db.String(100))

    miss_goal_comment = db.Column(db.String(255))
    miss_goal_comment_updated_at = db.Column(db.DateTime)
    miss_goal_comment_updated_by = db.Column(db.String(100))

    # Soft-delete marker (DB column added manually).
    is_deleted = db.Column(db.Boolean, default=False)


class TestReport(db.Model):
    """Model for Test Modules.

    Now reads/writes from the shared production table `cdat_goaling`.
    Test rows are separated by `module` (e.g., HDMx/LCBI/etc.).
    """

    __tablename__ = 'cdat_goaling'
    # This table is also mapped by Report; extend the existing mapping.
    __table_args__ = ({'schema': db_schema, 'extend_existing': True}
                      if db_schema else {'extend_existing': True})

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    year = db.Column(db.Integer)
    shift = db.Column(db.String(10))
    prodgroup3 = db.Column(db.String(50))
    operation = db.Column(db.String(50))
    operation_desc = db.Column(db.String(255))

    # Shared base columns
    module = db.Column(db.String(50))
    qtg1 = db.Column(db.Float)
    qps1 = db.Column(db.Float)
    stg1 = db.Column(db.Float)
    qtg2 = db.Column(db.Float)
    mor = db.Column(db.Float)
    tr = db.Column(db.Float)
    output = db.Column(db.Float)
    shift_start_wip = db.Column(db.Float)
    system_suggested_goal = db.Column(db.Float)
    system_suggested_goal_created_at = db.Column(db.DateTime)

    # Test-only columns (now added to cdat_goaling)
    shift_start_wip_onhold = db.Column(db.Float)
    sfgi_wip = db.Column(db.Float)
    link_cell_qty = db.Column(db.Float)
    capacity = db.Column(db.Float)
    goal = db.Column(db.Float)
    commit1 = db.Column(db.Float)
    commit2 = db.Column(db.Float)
    qps2 = db.Column(db.Float)
    stg2 = db.Column(db.Float)
    prebuild1 = db.Column(db.Float)
    dlcp = db.Column(db.String(50))  # STHI-specific column (text)

    # NOTE: Test modules use in-place edits directly on `goal`.
    # The legacy `manual_adjusted_goal` column may not exist in the DB.
    goal_adjusted_at = db.Column(db.DateTime)
    goal_adjusted_by = db.Column(db.String(100))

    miss_goal_comment = db.Column(db.String(255))
    miss_goal_comment_updated_at = db.Column(db.DateTime)
    miss_goal_comment_updated_by = db.Column(db.String(100))

    # Soft-delete marker (DB column added manually).
    is_deleted = db.Column(db.Boolean, default=False)


def apply_test_report_updates_in_place(old_report: TestReport, **updates) -> None:
    """Apply updates directly to the existing test row.

    Test pages do NOT use full version/audit rows; keep edits in-place.
    """

    for k, v in updates.items():
        setattr(old_report, k, v)

    # Module is already set correctly in the database; no need to derive/overwrite it.

    db.session.commit()


def get_latest_test_report_ids_for_shift_and_page(latest_shift, page_name):
    """Mirror the assembly latest-per-group logic for the test table.

    For STHI and HDMx, rows are uniquely identified by (prodgroup3, operation, dlcp).
    For BI, V8, and other modules, rows are uniquely identified by (prodgroup3, operation).
    """
    filtered = db.session.query(
        TestReport.id,
        TestReport.prodgroup3,
        TestReport.operation,
    ).filter(
        TestReport.shift == latest_shift
    )
    filtered = apply_test_operation_group_filter(filtered, page_name)

    # STHI and HDMx use dlcp as an additional grouping key to distinguish rows
    # (e.g., same prodgroup3+operation but different dlcp values like UX vs FF)
    # BI and V8 do not use dlcp
    if page_name in ('STHI', 'HDMx'):
        latest_ids = filtered.with_entities(
            db.func.max(TestReport.id).label('id')
        ).group_by(
            TestReport.prodgroup3,
            TestReport.operation,
            TestReport.dlcp,
        ).subquery()
    else:
        latest_ids = filtered.with_entities(
            db.func.max(TestReport.id).label('id')
        ).group_by(
            TestReport.prodgroup3,
            TestReport.operation,
        ).subquery()

    return latest_ids


def get_recent_test_database_shifts_for_page(page_name, limit=5):
    latest_id = db.func.max(TestReport.id).label('latest_id')
    query = db.session.query(TestReport.shift, latest_id).filter(
        TestReport.shift.isnot(None),
        db.func.trim(db.cast(TestReport.shift, db.String)) != ''
    )
    query = apply_test_operation_group_filter(query, page_name)
    rows = query.group_by(TestReport.shift).order_by(
        desc(latest_id)).limit(limit).all()
    shifts = [row.shift for row in rows if row.shift]
    return sorted(shifts, reverse=True)


def test_report_to_dict(r: TestReport):
    return {
        'id': r.id,
        'year': r.year,
        'shift': r.shift,
        'prodgroup3': r.prodgroup3,
        'operation': r.operation,
        'operation_desc': r.operation_desc,
        'module': r.module,
        'mor': r.mor,
        'tr': r.tr,
        'shift_start_wip': r.shift_start_wip,
        'shift_start_wip_onhold': r.shift_start_wip_onhold,
        'sfgi_wip': r.sfgi_wip,
        'link_cell_qty': r.link_cell_qty,
        'capacity': r.capacity,
        'system_suggested_goal': r.system_suggested_goal,
        'system_suggested_goal_created_at': r.system_suggested_goal_created_at.strftime('%Y-%m-%d %H:%M:%S') if r.system_suggested_goal_created_at else None,
        'goal': r.goal,
        'output': r.output,
        'qtg1': r.qtg1,
        'qps1': r.qps1,
        'stg1': r.stg1,
        'qtg2': r.qtg2,
        'qps2': r.qps2,
        'stg2': r.stg2,
        'goal_adjusted_at': r.goal_adjusted_at.strftime('%Y-%m-%d %H:%M:%S') if r.goal_adjusted_at else None,
        'goal_adjusted_by': r.goal_adjusted_by,
        'miss_goal_comment': r.miss_goal_comment,
        'miss_goal_comment_updated_at': r.miss_goal_comment_updated_at.strftime('%Y-%m-%d %H:%M:%S') if r.miss_goal_comment_updated_at else None,
        'miss_goal_comment_updated_by': r.miss_goal_comment_updated_by,
        'commit1': r.commit1,
        'commit2': r.commit2,
        'prebuild1': r.prebuild1,
        'dlcp': r.dlcp,
    }


def get_current_user():
    # In IIS-native FastCGI mode, REMOTE_USER/AUTH_USER are the primary identity sources.
    direct_env_user = request.environ.get(
        'REMOTE_USER') or request.environ.get('AUTH_USER')
    normalized_direct_user = normalize_identity(direct_env_user)
    if normalized_direct_user:
        return normalized_direct_user

    for candidate in iter_identity_candidates():
        normalized = normalize_identity(candidate)
        if normalized:
            return normalized

    return 'N/A'


def iter_identity_candidates():
    for key in IDENTITY_HEADER_KEYS:
        yield request.headers.get(key)

    for key in IDENTITY_ENV_KEYS:
        yield request.environ.get(key)


def normalize_identity(raw_value):
    if not raw_value:
        return None

    value = str(raw_value).strip()
    if not value:
        return None

    # Handle values like DOMAIN\\alias or alias@domain.
    if '\\' in value:
        value = value.split('\\')[-1]
    elif '@' in value:
        value = value.split('@')[0]

    # Drop obvious service accounts (often ending with $ in AD).
    if value.endswith('$'):
        return None

    # Keep display stable and safe for UI.
    if not re.match(r'^[A-Za-z0-9._-]+$', value):
        return None

    return value


def debug_identity():
    """Temporary endpoint to verify which identity fields arrive from IIS/proxy."""
    header_values = {k: request.headers.get(k) for k in IDENTITY_HEADER_KEYS}
    env_values = {k: request.environ.get(k) for k in IDENTITY_ENV_KEYS}

    return jsonify({
        'resolved_user': get_current_user(),
        'headers': header_values,
        'environ': env_values
    })


if ENABLE_IDENTITY_DEBUG_ENDPOINT:
    app.add_url_rule('/api/debug-identity', view_func=debug_identity)


def get_request_payload():
    return request.get_json(silent=True) or {}


def clone_report_with_updates(old_report, **updates):
    columns = [c.key for c in inspect(
        old_report).mapper.column_attrs if c.key != 'id']
    data = {c: getattr(old_report, c) for c in columns}
    data.update(updates)

    # Module is already set in the database; just copy it from the old row.
    # No need to derive from operation codes.

    return Report(**data)


def json_success(**payload):
    body = {"status": "success"}
    body.update(payload)
    return jsonify(body)


def json_error(message, status_code=400):
    return jsonify({"status": "error", "message": message}), status_code


def report_to_dict(r: Report):
    return {
        "id": r.id,
        "year": r.year,
        "shift": r.shift,
        "prodgroup3": r.prodgroup3,
        "operation": r.operation,
        "module": r.module,
        "entity": r.entity,
        "qtg1": r.qtg1,
        "qps1": r.qps1,
        "mor": r.mor,
        "tr": r.tr,
        "output": r.output,
        "shift_start_wip": r.shift_start_wip,
        "system_suggested_goal": r.system_suggested_goal,
        "subcell_info": r.subcell_info,
        "manual_adjusted_goal": r.manual_adjusted_goal,
        "goal_adjusted_reason": r.goal_adjusted_reason,
        "miss_goal_comment": r.miss_goal_comment,
        "goal_adjusted_by": r.goal_adjusted_by,
        "goal_adjusted_at": r.goal_adjusted_at.strftime('%Y-%m-%d %H:%M:%S') if r.goal_adjusted_at else None,
        "miss_goal_comment_updated_by": r.miss_goal_comment_updated_by,
        "miss_goal_comment_updated_at": r.miss_goal_comment_updated_at.strftime('%Y-%m-%d %H:%M:%S') if r.miss_goal_comment_updated_at else None,
    }


@app.route('/api/report/<int:report_id>')
def get_report(report_id: int):
    r = db.session.get(Report, report_id)
    if not r:
        return json_error('Record not found', 404)
    return json_success(report=report_to_dict(r))


def _read_calendar_file():
    """Read calendar.csv with mtime-based caching to avoid disk I/O on every request."""
    calendar_path = os.path.join(
        os.path.dirname(__file__), 'data', 'calendar.csv')
    try:
        current_mtime = os.path.getmtime(calendar_path)
    except OSError:
        return datetime.now().year, None

    with _CALENDAR_CACHE_LOCK:
        if _CALENDAR_CACHE["mtime"] == current_mtime:
            return _CALENDAR_CACHE["year"], _CALENDAR_CACHE["shift"]

    year = datetime.now().year
    shift = None
    try:
        with open(calendar_path, newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                if str(row.get('SEQUENCE', '')).strip() == '0':
                    year = int(row.get('YEAR', datetime.now().year))
                    shift = row.get('SHIFT', '').strip()
                    break
    except Exception:
        pass

    with _CALENDAR_CACHE_LOCK:
        _CALENDAR_CACHE["mtime"] = current_mtime
        _CALENDAR_CACHE["year"] = year
        _CALENDAR_CACHE["shift"] = shift
    return year, shift


def get_current_year_and_shift_from_calendar():
    return _read_calendar_file()


def get_current_shift_from_calendar():
    _, shift = _read_calendar_file()
    return shift


def get_latest_report_ids_for_shift_and_page(latest_shift, page_name):
    filtered = db.session.query(
        Report.id,
        Report.prodgroup3,
        Report.operation,
        Report.entity
    ).filter(
        Report.shift == latest_shift
    )
    filtered = apply_operation_group_filter(filtered, page_name)

    # 1) Latest id per (prodgroup3, operation, entity)
    latest_ids_per_entity = filtered.with_entities(
        db.func.max(Report.id).label('id'),
        Report.prodgroup3.label('prodgroup3'),
        Report.operation.label('operation'),
        Report.entity.label('entity')
    ).group_by(
        Report.prodgroup3,
        Report.operation,
        Report.entity
    ).subquery()

    # 2) For each (prodgroup3, operation), check if any non-NULL entity exists.
    non_null_entity_exists = filtered.filter(
        Report.entity.isnot(None)
    ).with_entities(
        Report.prodgroup3.label('prodgroup3'),
        Report.operation.label('operation'),
        db.literal(1).label('has_entity')
    ).group_by(
        Report.prodgroup3,
        Report.operation
    ).subquery()

    # 3) Hide the NULL-entity latest row when a non-NULL entity exists for the same (prodgroup3, operation).
    latest_ids_filtered = db.session.query(
        latest_ids_per_entity.c.id.label('id')
    ).outerjoin(
        non_null_entity_exists,
        db.and_(
            non_null_entity_exists.c.prodgroup3 == latest_ids_per_entity.c.prodgroup3,
            non_null_entity_exists.c.operation == latest_ids_per_entity.c.operation
        )
    ).filter(
        db.or_(
            latest_ids_per_entity.c.entity.isnot(None),
            non_null_entity_exists.c.has_entity.is_(None)
        )
    ).subquery()

    return latest_ids_filtered


def get_recent_database_shifts_for_page(page_name, limit=5):
    now = time.monotonic()
    with _SHIFTS_CACHE_LOCK:
        cached = _SHIFTS_CACHE.get(page_name)
        if cached and (now - cached["ts"]) < _SHIFTS_CACHE_TTL:
            return cached["shifts"]

    latest_id = db.func.max(Report.id).label('latest_id')
    query = db.session.query(Report.shift, latest_id).filter(
        Report.shift.isnot(None),
        db.func.trim(db.cast(Report.shift, db.String)) != ''
    )
    query = apply_operation_group_filter(query, page_name)
    rows = query.group_by(Report.shift).order_by(
        desc(latest_id)).limit(limit).all()
    shifts = [row.shift for row in rows if row.shift]

    with _SHIFTS_CACHE_LOCK:
        _SHIFTS_CACHE[page_name] = {"ts": now, "shifts": shifts}
    return shifts


def apply_operation_group_filter(query, page_name):
    """Filter Report queries by module name.

    The database already has the correct 'module' column values,
    so we simply filter by module. No operation mapping needed.
    """
    if page_name:
        return query.filter(Report.module == page_name)
    return query


def apply_test_operation_group_filter(query, page_name):
    """Filter TestReport queries by module name.

    The database already has the correct 'module' column values (BI, V8, HDMx, STHI),
    so we simply filter by module. No operation mapping needed.
    """
    if page_name:
        return query.filter(TestReport.module == page_name)
    return query


def compute_tr_from_goal_and_mor(goal_value, mor_value):
    mor = mor_value if (mor_value and mor_value != 0) else 0
    if mor == 0:
        return 0.0
    # TR formula: TR = Goal / MOR
    # Display/precision requirement: keep 1 decimal.
    # Business rule: TR should never be negative.
    return max(0.0, round(goal_value / mor, 1))


def sync_phvi_goal(year: int, shift: str, prodgroup3: str, user: str):
    """Sync PHVI goal when HDMx goal changes.

    Formula: PHVI goal = HDMx goal * 0.9 + PHVI.shift_start_wip

    - HDMx needs to be summed across all DLCPs for the same prodgroup3
    - If PHVI row doesn't exist, create it with defaults
    - If HDMx is deleted AND PHVI shift_start_wip = 0, soft-delete PHVI row
    - Certain prodgroup3 values are excluded from PHVI calculation
    - Uses MAX(id) to find PHVI row, matching how UI fetches the latest row
    """
    # Prodgroup3 values excluded from PHVI goal calculation
    exclude_prod_list = ['ADP', 'ADPIOT', 'MTP', 'ARLS816L', 'ARLR816L',
                         'ARLS681', 'RPLS881', 'RPRS881', 'RPLS601', 'RPRS601']

    if prodgroup3 in exclude_prod_list:
        return

    try:
        # Check if any active HDMx rows exist for this prodgroup3
        hdmx_exists = db.session.query(TestReport.id).filter(
            TestReport.year == year,
            TestReport.shift == shift,
            TestReport.prodgroup3 == prodgroup3,
            TestReport.module == 'HDMx',
            (TestReport.is_deleted.is_(None)) | (
                TestReport.is_deleted == False)
        ).first() is not None

        # Find existing PHVI row using MAX(id) to match UI's latest-row logic
        phvi_max_id = db.session.query(
            db.func.max(TestReport.id)
        ).filter(
            TestReport.year == year,
            TestReport.shift == shift,
            TestReport.prodgroup3 == prodgroup3,
            TestReport.module == 'PHVI',
            (TestReport.is_deleted.is_(None)) | (
                TestReport.is_deleted == False)
        ).scalar()

        phvi_row = db.session.get(
            TestReport, phvi_max_id) if phvi_max_id else None

        # If HDMx doesn't exist, handle PHVI deletion or WIP-only update
        if not hdmx_exists:
            if phvi_row:
                shift_start_wip = float(phvi_row.shift_start_wip or 0)
                if shift_start_wip == 0:
                    # No HDMx and no WIP - soft delete PHVI
                    phvi_row.is_deleted = True
                    phvi_row.goal_adjusted_at = datetime.now()
                    phvi_row.goal_adjusted_by = user
                    db.session.commit()
                else:
                    # No HDMx but has WIP - set PHVI goal = shift_start_wip
                    phvi_goal = round(shift_start_wip, 1)
                    mor_val = float(phvi_row.mor or 30)
                    phvi_row.goal = phvi_goal
                    phvi_row.tr = compute_tr_from_goal_and_mor(
                        phvi_goal, mor_val)
                    phvi_row.goal_adjusted_at = datetime.now()
                    phvi_row.goal_adjusted_by = user
                    db.session.commit()
            return

        # Get HDMx goal sum for this shift + prodgroup3 (across all DLCPs)
        hdmx_goal = db.session.query(
            db.func.sum(db.func.coalesce(TestReport.goal, 0))
        ).filter(
            TestReport.year == year,
            TestReport.shift == shift,
            TestReport.prodgroup3 == prodgroup3,
            TestReport.module == 'HDMx',
            (TestReport.is_deleted.is_(None)) | (
                TestReport.is_deleted == False)
        ).scalar() or 0

        # Calculate PHVI goal: HDMx * 0.9 + shift_start_wip
        shift_start_wip = float(
            phvi_row.shift_start_wip or 0) if phvi_row else 0
        phvi_goal = round(float(hdmx_goal) * 0.9 + shift_start_wip, 1)

        # Calculate TR (MOR default is 30 for PHVI)
        mor_val = float(phvi_row.mor or 30) if phvi_row else 30
        calculated_tr = compute_tr_from_goal_and_mor(phvi_goal, mor_val)

        if phvi_row:
            # Update existing PHVI row
            phvi_row.goal = phvi_goal
            phvi_row.tr = calculated_tr
            phvi_row.goal_adjusted_at = datetime.now()
            phvi_row.goal_adjusted_by = user
            db.session.commit()
        else:
            # Create new PHVI row with defaults
            new_phvi = TestReport(
                year=year,
                shift=shift,
                prodgroup3=prodgroup3,
                operation='8832',
                module='PHVI',
                mor=30,
                goal=phvi_goal,
                tr=calculated_tr,
                dlcp=None,
                capacity=0,
                link_cell_qty=0,
                shift_start_wip=0,
                goal_adjusted_at=datetime.now(),
                goal_adjusted_by=user,
            )
            db.session.add(new_phvi)
            db.session.commit()

    except Exception as e:
        app.logger.warning(f"PHVI sync failed for {shift}/{prodgroup3}: {e}")
        db.session.rollback()


def sync_mark_goal(year: int, shift: str, prodgroup3: str, user: str):
    """Sync MARK goal when STHI goal changes.

    Formula: MARK goal = STHI_goal_sum * 0.9 + MARK.shift_start_wip

    - STHI is summed across ALL rows (all operations + all dlcp) for the same prodgroup3
    - MARK is matched at the prodgroup3 level only (operation is ignored)
    - If MARK row doesn't exist, create it with all-zero defaults
    - If STHI is deleted/absent AND MARK.shift_start_wip = 0, soft-delete MARK row
    - No prodgroup3 exclusions
    - Uses MAX(id) to find the MARK row, matching how the UI fetches the latest row
    """
    try:
        # Check if any active STHI rows exist for this prodgroup3
        sthi_exists = db.session.query(TestReport.id).filter(
            TestReport.year == year,
            TestReport.shift == shift,
            TestReport.prodgroup3 == prodgroup3,
            TestReport.module == 'STHI',
            (TestReport.is_deleted.is_(None)) | (
                TestReport.is_deleted == False)
        ).first() is not None

        # Find existing MARK row using MAX(id) to match UI's latest-row logic
        mark_max_id = db.session.query(
            db.func.max(TestReport.id)
        ).filter(
            TestReport.year == year,
            TestReport.shift == shift,
            TestReport.prodgroup3 == prodgroup3,
            TestReport.module == 'MARK',
            (TestReport.is_deleted.is_(None)) | (
                TestReport.is_deleted == False)
        ).scalar()

        mark_row = db.session.get(
            TestReport, mark_max_id) if mark_max_id else None

        # If STHI doesn't exist, handle MARK deletion or WIP-only update
        if not sthi_exists:
            if mark_row:
                shift_start_wip = float(mark_row.shift_start_wip or 0)
                if shift_start_wip == 0:
                    # No STHI and no WIP - soft delete MARK
                    mark_row.is_deleted = True
                    mark_row.goal_adjusted_at = datetime.now()
                    mark_row.goal_adjusted_by = user
                    db.session.commit()
                else:
                    # No STHI but has WIP - set MARK goal = shift_start_wip
                    mark_goal = round(shift_start_wip, 1)
                    mor_val = float(mark_row.mor or 0)
                    mark_row.goal = mark_goal
                    mark_row.tr = compute_tr_from_goal_and_mor(
                        mark_goal, mor_val)
                    mark_row.goal_adjusted_at = datetime.now()
                    mark_row.goal_adjusted_by = user
                    db.session.commit()
                # Cascade: MARK changed (deleted or WIP-only goal) - sync DVI too.
                db.session.flush()
                sync_dvi_goal(year, shift, prodgroup3, user)
            return

        # Get STHI goal sum for this shift + prodgroup3 (across all operations/dlcp)
        sthi_goal = db.session.query(
            db.func.sum(db.func.coalesce(TestReport.goal, 0))
        ).filter(
            TestReport.year == year,
            TestReport.shift == shift,
            TestReport.prodgroup3 == prodgroup3,
            TestReport.module == 'STHI',
            (TestReport.is_deleted.is_(None)) | (
                TestReport.is_deleted == False)
        ).scalar() or 0

        # Calculate MARK goal: STHI * 0.9 + shift_start_wip
        shift_start_wip = float(
            mark_row.shift_start_wip or 0) if mark_row else 0
        mark_goal = round(float(sthi_goal) * 0.9 + shift_start_wip, 1)

        # Calculate TR (default MOR is 0 for auto-created MARK rows)
        mor_val = float(mark_row.mor or 0) if mark_row else 0
        calculated_tr = compute_tr_from_goal_and_mor(mark_goal, mor_val)

        if mark_row:
            # Update existing MARK row
            mark_row.goal = mark_goal
            mark_row.tr = calculated_tr
            mark_row.goal_adjusted_at = datetime.now()
            mark_row.goal_adjusted_by = user
            db.session.commit()
        else:
            # Create new MARK row with all-zero defaults
            new_mark = TestReport(
                year=year,
                shift=shift,
                prodgroup3=prodgroup3,
                operation='7300',
                module='MARK',
                mor=0,
                goal=mark_goal,
                tr=calculated_tr,
                dlcp=None,
                capacity=0,
                link_cell_qty=0,
                shift_start_wip=0,
                goal_adjusted_at=datetime.now(),
                goal_adjusted_by=user,
            )
            db.session.add(new_mark)
            db.session.commit()

        # Cascade: MARK goal changed - keep DVI in sync too.
        db.session.flush()
        sync_dvi_goal(year, shift, prodgroup3, user)

    except Exception as e:
        app.logger.warning(f"MARK sync failed for {shift}/{prodgroup3}: {e}")
        db.session.rollback()


def sync_dvi_goal(year: int, shift: str, prodgroup3: str, user: str):
    """Sync DVI goal when MARK goal changes.

    Formula: DVI goal = MARK_goal_sum * 0.9 + DVI.shift_start_wip

    - MARK is summed across ALL rows (all operations) for the same prodgroup3
    - DVI is matched at the prodgroup3 level only (operation is ignored)
    - If DVI row doesn't exist, create it with all-zero defaults
    - If MARK is deleted/absent AND DVI.shift_start_wip = 0, soft-delete DVI row
    - No prodgroup3 exclusions
    - Uses MAX(id) to find the DVI row, matching how the UI fetches the latest row
    """
    try:
        # Check if any active MARK rows exist for this prodgroup3
        mark_exists = db.session.query(TestReport.id).filter(
            TestReport.year == year,
            TestReport.shift == shift,
            TestReport.prodgroup3 == prodgroup3,
            TestReport.module == 'MARK',
            (TestReport.is_deleted.is_(None)) | (
                TestReport.is_deleted == False)
        ).first() is not None

        # Find existing DVI row using MAX(id) to match UI's latest-row logic
        dvi_max_id = db.session.query(
            db.func.max(TestReport.id)
        ).filter(
            TestReport.year == year,
            TestReport.shift == shift,
            TestReport.prodgroup3 == prodgroup3,
            TestReport.module == 'DVI',
            (TestReport.is_deleted.is_(None)) | (
                TestReport.is_deleted == False)
        ).scalar()

        dvi_row = db.session.get(
            TestReport, dvi_max_id) if dvi_max_id else None

        # If MARK doesn't exist, handle DVI deletion or WIP-only update
        if not mark_exists:
            if dvi_row:
                shift_start_wip = float(dvi_row.shift_start_wip or 0)
                if shift_start_wip == 0:
                    # No MARK and no WIP - soft delete DVI
                    dvi_row.is_deleted = True
                    dvi_row.goal_adjusted_at = datetime.now()
                    dvi_row.goal_adjusted_by = user
                    db.session.commit()
                else:
                    # No MARK but has WIP - set DVI goal = shift_start_wip
                    dvi_goal = round(shift_start_wip, 1)
                    mor_val = float(dvi_row.mor or 0)
                    dvi_row.goal = dvi_goal
                    dvi_row.tr = compute_tr_from_goal_and_mor(
                        dvi_goal, mor_val)
                    dvi_row.goal_adjusted_at = datetime.now()
                    dvi_row.goal_adjusted_by = user
                    db.session.commit()
            return

        # Get MARK goal sum for this shift + prodgroup3 (across all operations)
        mark_goal_sum = db.session.query(
            db.func.sum(db.func.coalesce(TestReport.goal, 0))
        ).filter(
            TestReport.year == year,
            TestReport.shift == shift,
            TestReport.prodgroup3 == prodgroup3,
            TestReport.module == 'MARK',
            (TestReport.is_deleted.is_(None)) | (
                TestReport.is_deleted == False)
        ).scalar() or 0

        # Calculate DVI goal: MARK * 0.9 + shift_start_wip
        shift_start_wip = float(
            dvi_row.shift_start_wip or 0) if dvi_row else 0
        dvi_goal = round(float(mark_goal_sum) * 0.9 + shift_start_wip, 1)

        # Calculate TR (default MOR is 0 for auto-created DVI rows)
        mor_val = float(dvi_row.mor or 0) if dvi_row else 0
        calculated_tr = compute_tr_from_goal_and_mor(dvi_goal, mor_val)

        if dvi_row:
            # Update existing DVI row
            dvi_row.goal = dvi_goal
            dvi_row.tr = calculated_tr
            dvi_row.goal_adjusted_at = datetime.now()
            dvi_row.goal_adjusted_by = user
            db.session.commit()
        else:
            # Create new DVI row with all-zero defaults
            new_dvi = TestReport(
                year=year,
                shift=shift,
                prodgroup3=prodgroup3,
                operation='1007',
                module='DVI',
                mor=0,
                goal=dvi_goal,
                tr=calculated_tr,
                dlcp=None,
                capacity=0,
                link_cell_qty=0,
                shift_start_wip=0,
                goal_adjusted_at=datetime.now(),
                goal_adjusted_by=user,
            )
            db.session.add(new_dvi)
            db.session.commit()

    except Exception as e:
        app.logger.warning(f"DVI sync failed for {shift}/{prodgroup3}: {e}")
        db.session.rollback()


def sync_olb_goal(year: int, shift: str, prodgroup3: str, user: str):
    """Sync OLB goal when V8 or HDMx goal changes.

    Formula: OLB goal = (V8 goal + HDMx goal) * 0.8 + OLB.shift_start_wip

    - V8 is already at prodgroup3 level
    - HDMx needs to be summed across all DLCPs for the same prodgroup3
    - If OLB row doesn't exist, create it with defaults
    - If both V8 and HDMx are deleted AND OLB shift_start_wip = 0, soft-delete OLB row
    - Uses MAX(id) to find OLB row, matching how UI fetches the latest row
    - Special case: V8 with prodgroup3='CFLH62' and operation='7757' is excluded from OLB calculation
    """
    try:
        # Build V8 base filter
        v8_base_filter = [
            TestReport.year == year,
            TestReport.shift == shift,
            TestReport.prodgroup3 == prodgroup3,
            TestReport.module == 'V8',
            (TestReport.is_deleted.is_(None)) | (
                TestReport.is_deleted == False)
        ]
        # Exclude CFLH62 operation 7757 from V8 calculations
        if prodgroup3 == 'CFLH62':
            v8_base_filter.append(TestReport.operation != '7757')

        # Check if any active V8 rows exist (excluding special case)
        v8_exists = db.session.query(TestReport.id).filter(
            *v8_base_filter
        ).first() is not None

        # Check if any active HDMx rows exist for this prodgroup3
        hdmx_exists = db.session.query(TestReport.id).filter(
            TestReport.year == year,
            TestReport.shift == shift,
            TestReport.prodgroup3 == prodgroup3,
            TestReport.module == 'HDMx',
            (TestReport.is_deleted.is_(None)) | (
                TestReport.is_deleted == False)
        ).first() is not None

        # Find existing OLB row using MAX(id) to match UI's latest-row logic
        olb_max_id = db.session.query(
            db.func.max(TestReport.id)
        ).filter(
            TestReport.year == year,
            TestReport.shift == shift,
            TestReport.prodgroup3 == prodgroup3,
            TestReport.module == 'OLB',
            (TestReport.is_deleted.is_(None)) | (
                TestReport.is_deleted == False)
        ).scalar()

        olb_row = db.session.get(
            TestReport, olb_max_id) if olb_max_id else None

        # If neither V8 nor HDMx exists, handle OLB deletion or WIP-only update
        if not v8_exists and not hdmx_exists:
            if olb_row:
                shift_start_wip = float(olb_row.shift_start_wip or 0)
                if shift_start_wip == 0:
                    # No V8/HDMx and no WIP - soft delete OLB
                    olb_row.is_deleted = True
                    olb_row.goal_adjusted_at = datetime.now()
                    olb_row.goal_adjusted_by = user
                    db.session.commit()
                else:
                    # No V8/HDMx but has WIP - set OLB goal = shift_start_wip
                    olb_goal = round(shift_start_wip, 1)
                    mor_val = float(olb_row.mor) if olb_row.mor else None
                    olb_row.goal = olb_goal
                    olb_row.tr = compute_tr_from_goal_and_mor(
                        olb_goal, mor_val) if mor_val else None
                    olb_row.goal_adjusted_at = datetime.now()
                    olb_row.goal_adjusted_by = user
                    db.session.commit()
            return

        # Get V8 goal sum (excluding special case CFLH62 + 7757)
        v8_goal = db.session.query(
            db.func.sum(db.func.coalesce(TestReport.goal, 0))
        ).filter(
            *v8_base_filter
        ).scalar() or 0

        # Get HDMx goal sum for this shift + prodgroup3 (across all DLCPs)
        hdmx_goal = db.session.query(
            db.func.sum(db.func.coalesce(TestReport.goal, 0))
        ).filter(
            TestReport.year == year,
            TestReport.shift == shift,
            TestReport.prodgroup3 == prodgroup3,
            TestReport.module == 'HDMx',
            (TestReport.is_deleted.is_(None)) | (
                TestReport.is_deleted == False)
        ).scalar() or 0

        # Calculate OLB goal: (V8 + HDMx) * 0.8 + shift_start_wip
        shift_start_wip = float(olb_row.shift_start_wip or 0) if olb_row else 0
        olb_goal = round((float(v8_goal) + float(hdmx_goal))
                         * 0.8 + shift_start_wip, 1)

        # Calculate TR (use existing MOR if available)
        mor_val = float(olb_row.mor) if olb_row and olb_row.mor else None
        calculated_tr = compute_tr_from_goal_and_mor(
            olb_goal, mor_val) if mor_val else None

        if olb_row:
            # Update existing OLB row
            olb_row.goal = olb_goal
            olb_row.tr = calculated_tr
            olb_row.goal_adjusted_at = datetime.now()
            olb_row.goal_adjusted_by = user
            db.session.commit()
        else:
            # Create new OLB row with defaults (no MOR set)
            new_olb = TestReport(
                year=year,
                shift=shift,
                prodgroup3=prodgroup3,
                operation='6379',
                module='OLB',
                mor=None,
                goal=olb_goal,
                tr=None,
                dlcp=None,
                capacity=0,
                link_cell_qty=0,
                shift_start_wip=0,
                goal_adjusted_at=datetime.now(),
                goal_adjusted_by=user,
            )
            db.session.add(new_olb)
            db.session.commit()

    except Exception as e:
        app.logger.warning(f"OLB sync failed for {shift}/{prodgroup3}: {e}")
        db.session.rollback()


def persist_report_version(old_report, **updates):
    new_entry = clone_report_with_updates(old_report, **updates)
    db.session.add(new_entry)
    db.session.commit()
    return new_entry


@app.route('/')
def root_redirect():
    # If this app is hosted under an IIS Application (with URL_PREFIX), the app root is already /CDAT_Goaling.
    # Serve the index directly at the app root to avoid double-prefix URLs like /CDAT_Goaling/CDAT_Goaling.
    return index()


@app.route('/page=<page_name>')
def legacy_page_style_redirect(page_name='TCB'):
    # Canonicalize legacy path-style URLs to query-style URLs at the app root.
    return redirect(url_for('index', page=page_name), code=302)


@app.route('/index/page=<page_name>')
@app.route('/index.html')
def index(page_name='TCB'):
    # Canonicalize legacy path-style URLs to query-style URLs.
    if request.path.startswith('/index/page='):
        return redirect(url_for('index', page=page_name), code=302)

    # 1. Get the friendly page name from URL
    page_name = request.args.get('page') or page_name or 'TCB'
    requested_shift = (request.args.get('shift') or '').strip()
    shift_chosen = (request.args.get('shift_chosen') or '').strip() in {
        '1', 'true', 'yes', 'on'}

    current_user = get_current_user()
    current_shift = get_current_shift_from_calendar()
    available_shifts = get_recent_database_shifts_for_page(page_name, limit=5)
    # Ensure newest shift appears first in the dropdown.
    # Shifts are typically strings like "2026-W11-D"; lexicographic descending works for this format.
    if available_shifts:
        available_shifts = sorted(available_shifts, reverse=True)
    latest_db_shift = available_shifts[0] if available_shifts else None

    # Default to newest/latest on plain refresh.
    # Only honor an older shift when it was explicitly chosen via the dropdown.
    selected_shift = requested_shift if (
        shift_chosen and requested_shift) else latest_db_shift
    if selected_shift and available_shifts and selected_shift not in available_shifts:
        selected_shift = latest_db_shift

    shift_mismatch = bool(
        current_shift and latest_db_shift and current_shift != latest_db_shift)

    # 2. Limit first to current shift, then compute latest version IDs for that scope.
    reports = []
    if selected_shift:
        latest_ids_subquery = get_latest_report_ids_for_shift_and_page(
            selected_shift, page_name)
        reports = Report.query.join(
            latest_ids_subquery,
            Report.id == latest_ids_subquery.c.id
        ).filter(
            (Report.is_deleted.is_(None)) | (Report.is_deleted.is_(False))
        ).order_by(desc(Report.id)).all()
    current_date = datetime.now().strftime('%Y-%m-%d')

    # Last refresh contract (mirrors test.html):
    # - Always use the calendar.csv file mtime as the primary source.
    #   (This reflects when the upstream output/source last refreshed.)
    # - Fall back to the DB timestamp only if the file doesn't exist.
    last_refresh_at = None
    last_refresh_source = None
    try:
        calendar_path = Path(app.root_path) / 'data' / 'calendar.csv'
        if calendar_path.exists():
            last_refresh_at = datetime.fromtimestamp(
                calendar_path.stat().st_mtime)
            last_refresh_source = 'calendar'
    except Exception:
        last_refresh_at = None
        last_refresh_source = None

    if not last_refresh_at and selected_shift:
        try:
            last_refresh_id = db.session.query(db.func.max(Report.id)).filter(
                Report.shift == selected_shift,
                Report.module == page_name,
            ).scalar()
            if last_refresh_id:
                last_refresh_row = db.session.query(Report).filter(
                    Report.id == last_refresh_id).first()
                if last_refresh_row and getattr(last_refresh_row, 'system_suggested_goal_created_at', None):
                    last_refresh_at = last_refresh_row.system_suggested_goal_created_at
                    last_refresh_source = 'db'
        except Exception:
            # Never fail page render due to refresh timestamp lookup.
            last_refresh_at = None
            last_refresh_source = None

    if not last_refresh_at:
        last_refresh_source = 'unavailable'

    return render_template(
        'index.html',
        reports=reports,
        current_user=current_user,
        current_shift=current_shift,
        available_shifts=available_shifts,
        latest_db_shift=latest_db_shift,
        selected_shift=selected_shift,
        shift_mismatch=shift_mismatch,
        current_date=current_date,
        current_page=page_name,
        last_refresh_at=last_refresh_at,
        last_refresh_source=last_refresh_source,
    )


@app.route('/api/add-new-goal', methods=['POST'])
def add_new_goal():
    data = get_request_payload()
    user = get_current_user()
    try:
        default_year, default_shift = get_current_year_and_shift_from_calendar()
        page = (data.get('page') or '').strip()
        entity_required_pages = {'TCB', 'HBC-JDC', 'DIA', 'EPX', 'BA'}
        raw_entity = (data.get('entity') or '').strip()
        if page in entity_required_pages and not raw_entity:
            return json_error('ENTITY is required for this page.', 400)

        entity = raw_entity if raw_entity else None
        # Use page (tab name) directly as module - matches database module values
        module_val = page if page else 'Unknown'
        new_entry = Report(
            year=default_year,
            shift=default_shift,
            prodgroup3=data.get('prodgroup3'),
            operation=data.get('operation'),
            module=module_val,
            entity=entity,
            manual_adjusted_goal=float(data.get('goal') or 0),
            goal_adjusted_reason=data.get('reason'),
            goal_adjusted_at=datetime.now(),
            goal_adjusted_by=user,
            qtg1=0,
            qps1=0,
            mor=0,
            tr=0,
            output=0
        )
        db.session.add(new_entry)
        db.session.commit()
        return json_success(new_id=new_entry.id)
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/update-goal', methods=['POST'])
def update_goal():
    data = get_request_payload()
    user = get_current_user()
    old = db.session.get(Report, data.get('id'))

    if not old:
        return json_error("Record not found", 404)

    try:
        new_goal = float(data.get('manual_goal') or 0)

        new_entry = persist_report_version(
            old,
            manual_adjusted_goal=new_goal,
            goal_adjusted_reason=data.get('reason'),
            goal_adjusted_at=datetime.now(),
            goal_adjusted_by=user
        )

        return json_success(new_id=new_entry.id)
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/update-goal-inplace', methods=['POST'])
def update_goal_inplace():
    """Update Adjusted Goal + Adjusted Reason in-place (no versioned rows).

    Request JSON:
        {"id": 1, "manual_goal": 10, "reason": "..."}

    Behavior:
        - Updates the existing row.
        - Recomputes TR from the adjusted goal + MOR.
        - Sets goal_adjusted_at/by.
    """
    data = get_request_payload()
    user = get_current_user()
    old = db.session.get(Report, data.get('id'))

    if not old:
        return json_error("Record not found", 404)

    try:
        raw_goal = data.get('manual_goal')
        raw_reason = data.get('reason')

        reason_val = ('' if raw_reason is None else str(raw_reason)).strip()
        goal_provided = raw_goal is not None and str(raw_goal).strip() != ''
        reason_provided = reason_val != ''

        # Keep the same rule as the existing versioned endpoint.
        if goal_provided != reason_provided:
            return json_error('Both Manual Goal and Adjust Reason must be filled', 400)

        new_goal = float(raw_goal or 0)
        old.manual_adjusted_goal = new_goal
        old.goal_adjusted_reason = reason_val
        old.goal_adjusted_at = datetime.now()
        old.goal_adjusted_by = user

        # Persist TR when manual_adjusted_goal changes.
        # Rule (align with index.html display):
        #   - If manual_adjusted_goal > 0 -> TR = manual_adjusted_goal / MOR
        #   - Else -> TR = system_suggested_goal / MOR
        # Notes:
        #   - Clamp to non-negative
        #   - Keep 1 decimal
        goal_for_tr = new_goal if new_goal and new_goal > 0 else (
            old.system_suggested_goal or 0)
        old.tr = compute_tr_from_goal_and_mor(goal_for_tr, old.mor)

        db.session.commit()
        return json_success(id=old.id, tr=old.tr)
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/update-goals-batch', methods=['POST'])
def update_goals_batch():
    """Best-effort batch update for adjusted goal + adjusted reason.

    Request JSON:
      {"updates": [{"id": 1, "manual_goal": 10, "reason": "..."}, ...]}

    Response JSON:
      {"status": "success", "results": [{"old_id": 1, "new_id": 2, "status": "success"}, ...]}
    """
    payload = get_request_payload()
    updates = payload.get('updates')
    user = get_current_user()

    if not isinstance(updates, list):
        return json_error('updates must be a list', 400)

    results = []

    for item in updates:
        if not isinstance(item, dict):
            results.append({
                'status': 'error',
                'message': 'Invalid update item'
            })
            continue

        old_id = item.get('id')
        try:
            old_id_int = int(old_id)
        except Exception:
            results.append({
                'old_id': old_id,
                'status': 'error',
                'message': 'Invalid id'
            })
            continue

        old = db.session.get(Report, old_id_int)
        if not old:
            results.append({
                'old_id': old_id_int,
                'status': 'error',
                'message': 'Record not found'
            })
            continue

        raw_goal = item.get('manual_goal')
        raw_reason = item.get('reason')
        reason_val = ('' if raw_reason is None else str(raw_reason)).strip()
        goal_provided = raw_goal is not None and str(raw_goal).strip() != ''
        reason_provided = reason_val != ''

        # Enforce the same rule as the UI: goal and reason must be provided together.
        if goal_provided != reason_provided:
            results.append({
                'old_id': old_id_int,
                'status': 'error',
                'message': 'Both Manual Goal and Adjust Reason must be filled'
            })
            continue

        try:
            new_goal = float(raw_goal or 0)
        except Exception:
            results.append({
                'old_id': old_id_int,
                'status': 'error',
                'message': 'Invalid manual_goal'
            })
            continue

        try:
            calculated_tr = compute_tr_from_goal_and_mor(new_goal, old.mor)
            new_entry = persist_report_version(
                old,
                manual_adjusted_goal=new_goal,
                tr=calculated_tr,
                goal_adjusted_reason=reason_val,
                goal_adjusted_at=datetime.now(),
                goal_adjusted_by=user
            )
            results.append({
                'old_id': old_id_int,
                'new_id': new_entry.id,
                'status': 'success'
            })
        except Exception as e:
            db.session.rollback()
            results.append({
                'old_id': old_id_int,
                'status': 'error',
                'message': str(e)
            })

    return json_success(results=results)


@app.route('/api/update-comment', methods=['POST'])
def update_comment():
    data = get_request_payload()
    user = get_current_user()
    old = db.session.get(Report, data.get('id'))

    if not old:
        return json_error("Record not found", 404)

    try:
        new_entry = persist_report_version(
            old,
            miss_goal_comment=data.get('comment'),
            miss_goal_comment_updated_at=datetime.now(),
            miss_goal_comment_updated_by=user
        )

        return json_success(new_id=new_entry.id)
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/update-comment-inplace', methods=['POST'])
def update_comment_inplace():
    """Update Miss Goal Comment in-place (no versioned rows).

    Request JSON:
      {"id": 1, "comment": "..."}
    """
    data = get_request_payload()
    user = get_current_user()
    old = db.session.get(Report, data.get('id'))

    if not old:
        return json_error("Record not found", 404)

    try:
        old.miss_goal_comment = data.get('comment')
        old.miss_goal_comment_updated_at = datetime.now()
        old.miss_goal_comment_updated_by = user
        db.session.commit()
        return json_success(id=old.id)
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/update-entity', methods=['POST'])
def update_entity():
    """Update ENTITY for a single row by id (in-place update).

    Request JSON:
      {"id": 1, "entity": "ABC123"}

    ENTITY is optional and may be blank (treated as NULL).
    """
    data = get_request_payload()
    old = db.session.get(Report, data.get('id'))

    if not old:
        return json_error("Record not found", 404)

    try:
        raw_entity = '' if data.get(
            'entity') is None else str(data.get('entity'))
        entity_val = raw_entity.strip()
        entity_val = entity_val if entity_val else None

        old.entity = entity_val
        db.session.commit()

        return json_success(id=old.id)
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/delete-row', methods=['POST'])
def delete_row():
    """Soft-delete an assembly/index row in-place by setting is_deleted=True."""
    data = get_request_payload()
    user = get_current_user()
    old = db.session.get(Report, data.get('id'))

    if not old:
        return json_error('Record not found', 404)

    # Safety guard: only allow deleting rows from the current calendar shift.
    current_shift = get_current_shift_from_calendar()
    if current_shift and old.shift and str(old.shift).strip() != str(current_shift).strip():
        return json_error('Delete is only allowed for the current shift', 403)

    try:
        old.is_deleted = True
        db.session.commit()
        return json_success(id=old.id, deleted_by=user)
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/update-comments-batch', methods=['POST'])
def update_comments_batch():
    """Best-effort batch update for miss goal comment."""
    payload = get_request_payload()
    updates = payload.get('updates')
    user = get_current_user()

    if not isinstance(updates, list):
        return json_error('updates must be a list', 400)

    results = []

    for item in updates:
        if not isinstance(item, dict):
            results.append(
                {'status': 'error', 'message': 'Invalid update item'})
            continue

        old_id = item.get('id')
        try:
            old_id_int = int(old_id)
        except Exception:
            results.append(
                {'old_id': old_id, 'status': 'error', 'message': 'Invalid id'})
            continue

        old = db.session.get(Report, old_id_int)
        if not old:
            results.append(
                {'old_id': old_id_int, 'status': 'error', 'message': 'Record not found'})
            continue

        comment_val = '' if item.get(
            'comment') is None else str(item.get('comment'))
        try:
            new_entry = persist_report_version(
                old,
                miss_goal_comment=comment_val,
                miss_goal_comment_updated_at=datetime.now(),
                miss_goal_comment_updated_by=user
            )
            results.append(
                {'old_id': old_id_int, 'new_id': new_entry.id, 'status': 'success'})
        except Exception as e:
            db.session.rollback()
            results.append(
                {'old_id': old_id_int, 'status': 'error', 'message': str(e)})

    return json_success(results=results)


@app.route('/api/test/update-goal', methods=['POST'])
def test_update_goal():
    data = get_request_payload()
    user = get_current_user()
    old = db.session.get(TestReport, data.get('id'))

    if not old:
        return json_error('Record not found', 404)

    raw_goal = data.get('manual_goal')

    try:
        # Test modules: TR is always derived from the `goal` column.
        # If the user clears the goal, treat it as 0.
        if raw_goal is None or str(raw_goal).strip() == '':
            new_goal = 0.0
        else:
            new_goal = float(raw_goal)

        calculated_tr = compute_tr_from_goal_and_mor(new_goal, old.mor)

        apply_test_report_updates_in_place(
            old,
            goal=new_goal,
            tr=calculated_tr,
            goal_adjusted_at=datetime.now(),
            goal_adjusted_by=user
        )

        # Sync PHVI and OLB goals if HDMx goal was updated
        if old.module == 'HDMx':
            db.session.flush()
            sync_phvi_goal(old.year, old.shift, old.prodgroup3, user)
            sync_olb_goal(old.year, old.shift, old.prodgroup3, user)
        # Sync only OLB if V8 goal was updated
        elif old.module == 'V8':
            db.session.flush()
            sync_olb_goal(old.year, old.shift, old.prodgroup3, user)
        # Sync MARK goal if STHI goal was updated
        elif old.module == 'STHI':
            db.session.flush()
            sync_mark_goal(old.year, old.shift, old.prodgroup3, user)

        return json_success(new_id=old.id, tr=calculated_tr, goal=new_goal)
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/test/update-comment', methods=['POST'])
def test_update_comment():
    data = get_request_payload()
    user = get_current_user()
    old = db.session.get(TestReport, data.get('id'))

    if not old:
        return json_error('Record not found', 404)

    try:
        apply_test_report_updates_in_place(
            old,
            miss_goal_comment=data.get('comment'),
            miss_goal_comment_updated_at=datetime.now(),
            miss_goal_comment_updated_by=user
        )
        return json_success(new_id=old.id)
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/test/update-cellqty', methods=['POST'])
def test_update_cellqty():
    """Update Cell Qty (link_cell_qty) in-place.

    Test behavior:
      - capacity = mor * cell_qty / 30  (for HDMx and other modules)
      - capacity = mor * cell_qty       (for STHI)
      - goal     = capacity
      - tr       = goal / mor
    """
    data = get_request_payload()
    old = db.session.get(TestReport, data.get('id'))

    if not old:
        return json_error('Record not found', 404)

    raw_qty = data.get('cell_qty')
    module = data.get('module') or (old.module if old else None)
    try:
        if raw_qty is None or str(raw_qty).strip() == '':
            qty_val = None
        else:
            raw_s = str(raw_qty).strip()
            # STHI allows one decimal place; other modules require integer.
            if module == 'STHI':
                try:
                    qty_val = float(raw_s)
                    if qty_val < 0:
                        return json_error('Link Qty must be >= 0', 400)
                    qty_val = round(qty_val, 1)  # Round to 1 decimal place
                except ValueError:
                    return json_error('Link Qty must be a valid number', 400)
            else:
                # Require an integer (digits only). Client sends string.
                if not raw_s.isdigit():
                    return json_error('Cell Qty must be an integer', 400)
                qty_val = int(raw_s)
                if qty_val < 0:
                    return json_error('Cell Qty must be >= 0', 400)

        mor_val = float(old.mor or 0)
        capacity_val = None

        if qty_val is not None:
            # STHI, BI, V8 use capacity = mor * qty
            # HDMx uses capacity = mor * qty / 30
            # Goal stays unchanged for all - only capacity is auto-calculated
            if old.module in ('STHI', 'BI', 'V8'):
                capacity_val = round(mor_val * float(qty_val), 1)
            else:
                capacity_val = round(mor_val * float(qty_val) / 30.0, 1)

        # Only update link_cell_qty and capacity (goal stays unchanged)
        apply_test_report_updates_in_place(
            old,
            link_cell_qty=qty_val,
            capacity=capacity_val,
        )

        return json_success(
            new_id=old.id,
            link_cell_qty=qty_val,
            capacity=capacity_val,
            debug_module=old.module,
        )
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/test/add-new-goal', methods=['POST'])
def test_add_new_goal():
    """Insert a new Test Modules row.

    Test modules do not use versioning, so inserts are plain inserts.
    """
    data = get_request_payload()
    user = get_current_user()
    try:
        default_year, default_shift = get_current_year_and_shift_from_calendar()

        prodgroup3 = (data.get('prodgroup3') or '').strip()
        # Optional field for STHI; default to 'FF' if not provided
        dlcp_val = (data.get('dlcp') or '').strip() or 'FF'
        operation = (data.get('operation') or '').strip()
        raw_goal = data.get('goal')
        raw_cell_qty = data.get('cell_qty')

        if (not prodgroup3) or (not operation) or (raw_goal in (None, '')) or (raw_cell_qty is None) or (str(raw_cell_qty).strip() == ''):
            return json_error('Please fill in all required fields.', 400)

        goal_val = float(raw_goal)

        raw_s = str(raw_cell_qty).strip()
        if not raw_s.isdigit():
            return json_error('Cell Qty must be an integer >= 0', 400)
        cell_qty_val = int(raw_s)
        if cell_qty_val < 0:
            return json_error('Cell Qty must be >= 0', 400)

        # Use the page (tab) name as the module - this is sent from the frontend
        page_val = (data.get('page') or '').strip()
        module_val = page_val if page_val else 'Unknown'

        # Reuse MOR when possible so Capacity can be calculated immediately.
        # MOR is normally populated by the refresh job; for user-inserted rows,
        # we can look it up from an existing row with the same key.
        mor_val = 0.0
        try:
            existing_mor = db.session.query(TestReport.mor).filter(
                TestReport.year == default_year,
                TestReport.shift == default_shift,
                TestReport.module == module_val,
                TestReport.prodgroup3 == prodgroup3,
                TestReport.operation == operation,
                TestReport.is_deleted.is_(False),
                TestReport.mor.isnot(None),
            ).order_by(TestReport.id.desc()).first()
            if existing_mor and existing_mor[0] not in (None, 0):
                mor_val = float(existing_mor[0])
        except Exception:
            # Don't fail insert if MOR lookup fails; fallback to 0.
            mor_val = 0.0

        # STHI, BI, V8 use capacity = mor * qty; HDMx uses capacity = mor * qty / 30
        if cell_qty_val is not None:
            if module_val in ('STHI', 'BI', 'V8'):
                capacity_val = round(mor_val * float(cell_qty_val), 1)
            else:
                capacity_val = round(mor_val * float(cell_qty_val) / 30.0, 1)
        else:
            capacity_val = None
        calculated_tr = compute_tr_from_goal_and_mor(goal_val, mor_val)

        new_entry = TestReport(
            year=default_year,
            shift=default_shift,
            prodgroup3=prodgroup3,
            dlcp=dlcp_val,
            operation=operation,
            module=module_val,
            mor=mor_val,
            goal=goal_val,
            tr=calculated_tr,
            link_cell_qty=cell_qty_val,
            capacity=capacity_val,
            goal_adjusted_at=datetime.now(),
            goal_adjusted_by=user,
        )
        db.session.add(new_entry)
        db.session.commit()

        # Sync PHVI and OLB goals if V8 or HDMx goal was added
        if module_val in ('V8', 'HDMx'):
            sync_phvi_goal(default_year, default_shift, prodgroup3, user)
            sync_olb_goal(default_year, default_shift, prodgroup3, user)
        # Sync MARK goal if STHI goal was added
        elif module_val == 'STHI':
            sync_mark_goal(default_year, default_shift, prodgroup3, user)

        return json_success(
            new_id=new_entry.id,
            mor=mor_val,
            capacity=capacity_val,
            tr=calculated_tr,
        )
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/test/update-goals-batch', methods=['POST'])
def test_update_goals_batch():
    """Best-effort batch update for test goal (in-place).

    Test table doesn't have manual_adjusted_goal or goal_adjusted_reason.
    """
    payload = get_request_payload()
    updates = payload.get('updates')
    user = get_current_user()

    if not isinstance(updates, list):
        return json_error('updates must be a list', 400)

    results = []
    phvi_sync_contexts = set()  # Track which (year, shift, prodgroup3) need PHVI sync
    olb_sync_contexts = set()  # Track which (year, shift, prodgroup3) need OLB sync

    for item in updates:
        if not isinstance(item, dict):
            results.append(
                {'status': 'error', 'message': 'Invalid update item'})
            continue

        old_id = item.get('id')
        try:
            old_id_int = int(old_id)
        except Exception:
            results.append(
                {'old_id': old_id, 'status': 'error', 'message': 'Invalid id'})
            continue

        old = db.session.get(TestReport, old_id_int)
        if not old:
            results.append(
                {'old_id': old_id_int, 'status': 'error', 'message': 'Record not found'})
            continue

        raw_goal = item.get('manual_goal')

        try:
            if raw_goal is None or str(raw_goal).strip() == '':
                new_goal = None
                calculated_tr = compute_tr_from_goal_and_mor(0, old.mor)
            else:
                new_goal = float(raw_goal)
                calculated_tr = compute_tr_from_goal_and_mor(new_goal, old.mor)
        except Exception:
            results.append(
                {'old_id': old_id_int, 'status': 'error', 'message': 'Invalid goal'})
            continue

        try:
            apply_test_report_updates_in_place(
                old,
                goal=new_goal,
                tr=calculated_tr,
                goal_adjusted_at=datetime.now(),
                goal_adjusted_by=user
            )
            results.append(
                {'old_id': old_id_int, 'new_id': old.id, 'status': 'success'})

            # Track HDMx updates for PHVI sync, V8/HDMx for OLB sync
            if old.module == 'HDMx':
                phvi_sync_contexts.add((old.year, old.shift, old.prodgroup3))
                olb_sync_contexts.add((old.year, old.shift, old.prodgroup3))
            elif old.module == 'V8':
                olb_sync_contexts.add((old.year, old.shift, old.prodgroup3))

        except Exception as e:
            db.session.rollback()
            results.append(
                {'old_id': old_id_int, 'status': 'error', 'message': str(e)})

    # Flush all updates to DB before syncing, so sync queries see new values
    db.session.flush()

    # Sync PHVI goals for HDMx-affected prodgroup3s
    for year, shift, prodgroup3 in phvi_sync_contexts:
        sync_phvi_goal(year, shift, prodgroup3, user)

    # Sync OLB goals for V8/HDMx-affected prodgroup3s
    for year, shift, prodgroup3 in olb_sync_contexts:
        sync_olb_goal(year, shift, prodgroup3, user)

    return json_success(results=results)


@app.route('/api/test/update-comments-batch', methods=['POST'])
def test_update_comments_batch():
    """Best-effort batch update for test miss goal comment (in-place)."""
    payload = get_request_payload()
    updates = payload.get('updates')
    user = get_current_user()

    if not isinstance(updates, list):
        return json_error('updates must be a list', 400)

    results = []

    for item in updates:
        if not isinstance(item, dict):
            results.append(
                {'status': 'error', 'message': 'Invalid update item'})
            continue

        old_id = item.get('id')
        try:
            old_id_int = int(old_id)
        except Exception:
            results.append(
                {'old_id': old_id, 'status': 'error', 'message': 'Invalid id'})
            continue

        old = db.session.get(TestReport, old_id_int)
        if not old:
            results.append(
                {'old_id': old_id_int, 'status': 'error', 'message': 'Record not found'})
            continue

        comment_val = item.get('comment')

        try:
            apply_test_report_updates_in_place(
                old,
                miss_goal_comment=comment_val,
                miss_goal_comment_updated_at=datetime.now(),
                miss_goal_comment_updated_by=user
            )
            results.append(
                {'old_id': old_id_int, 'new_id': old.id, 'status': 'success'})
        except Exception as e:
            db.session.rollback()
            results.append(
                {'old_id': old_id_int, 'status': 'error', 'message': str(e)})

    return json_success(results=results)


@app.route('/api/test/delete-row', methods=['POST'])
def test_delete_row():
    """Soft-delete a test modules row in-place by setting is_deleted=True."""
    data = get_request_payload()
    user = get_current_user()
    old = db.session.get(TestReport, data.get('id'))

    if not old:
        return json_error('Record not found', 404)

    # Safety guard: only allow deleting rows from the current calendar shift.
    current_shift = get_current_shift_from_calendar()
    if current_shift and old.shift and str(old.shift).strip() != str(current_shift).strip():
        return json_error('Delete is only allowed for the current shift', 403)

    # Capture values before deletion for PHVI sync
    module = old.module
    year = old.year
    shift = old.shift
    prodgroup3 = old.prodgroup3

    try:
        old.is_deleted = True
        db.session.commit()

        # Sync PHVI and OLB goals if V8 or HDMx row was deleted
        # This will either:
        # - Recalculate PHVI/OLB goal if other V8/HDMx rows exist
        # - Soft-delete PHVI/OLB if no V8/HDMx remain AND shift_start_wip = 0
        # - Keep PHVI/OLB with goal = shift_start_wip if no V8/HDMx but WIP > 0
        if module in ('V8', 'HDMx'):
            sync_phvi_goal(year, shift, prodgroup3, user)
            sync_olb_goal(year, shift, prodgroup3, user)
        # Sync MARK goal if STHI row was deleted
        elif module == 'STHI':
            sync_mark_goal(year, shift, prodgroup3, user)

        return json_success(id=old.id, deleted_by=user)
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


# ============================================================================
# Finish Modules API Routes (/api/finish/*)
# ============================================================================

@app.route('/api/finish/update-goal', methods=['POST'])
def finish_update_goal():
    """Update goal field for a finish module row."""
    data = get_request_payload()
    user = get_current_user()
    old = db.session.get(TestReport, data.get('id'))

    if not old:
        return json_error('Record not found', 404)

    raw_goal = data.get('goal')

    try:
        # Finish modules: TR is always derived from the goal column.
        if raw_goal is None or str(raw_goal).strip() == '':
            new_goal = 0.0
        else:
            new_goal = float(raw_goal)

        calculated_tr = compute_tr_from_goal_and_mor(new_goal, old.mor)

        apply_test_report_updates_in_place(
            old,
            goal=new_goal,
            tr=calculated_tr,
            goal_adjusted_at=datetime.now(),
            goal_adjusted_by=user
        )

        # Sync DVI goal if MARK goal was updated
        if old.module == 'MARK':
            db.session.flush()
            sync_dvi_goal(old.year, old.shift, old.prodgroup3, user)

        return json_success(new_id=old.id, tr=calculated_tr, goal=new_goal)
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/finish/update-comment', methods=['POST'])
def finish_update_comment():
    """Update comment field for a finish module row."""
    data = get_request_payload()
    user = get_current_user()
    old = db.session.get(TestReport, data.get('id'))

    if not old:
        return json_error('Record not found', 404)

    try:
        apply_test_report_updates_in_place(
            old,
            comment=data.get('comment') or None,
            goal_adjusted_at=datetime.now(),
            goal_adjusted_by=user
        )
        return json_success(new_id=old.id, comment=old.comment)
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/finish/update-cellqty', methods=['POST'])
def finish_update_cellqty():
    """Update link_cell_qty field for a finish module row."""
    data = get_request_payload()
    user = get_current_user()
    old = db.session.get(TestReport, data.get('id'))

    if not old:
        return json_error('Record not found', 404)

    try:
        link_cell_qty = data.get('link_cell_qty')
        apply_test_report_updates_in_place(
            old,
            link_cell_qty=link_cell_qty,
            goal_adjusted_at=datetime.now(),
            goal_adjusted_by=user
        )
        return json_success(new_id=old.id, link_cell_qty=link_cell_qty)
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/finish/add-new-goal', methods=['POST'])
def finish_add_new_goal():
    """Add a new finish module goal row."""
    data = get_request_payload()
    user = get_current_user()

    try:
        default_year, default_shift = get_current_year_and_shift_from_calendar()
        page = (data.get('page') or '').strip()

        # Use page (tab name) directly as module - matches database module values
        module_val = page if page else 'Unknown'

        new_entry = TestReport(
            year=default_year,
            shift=default_shift,
            prodgroup3=data.get('prodgroup3'),
            operation=data.get('operation'),
            module=module_val,
            mor=data.get('mor'),
            goal=data.get('goal'),
            dlcp=None,
            capacity=0,
            link_cell_qty=data.get('link_cell_qty') or 0,
            shift_start_wip=0,
            comment=data.get('comment'),
            goal_adjusted_at=datetime.now(),
            goal_adjusted_by=user,
        )

        # Compute TR if MOR is provided
        if new_entry.mor:
            new_entry.tr = compute_tr_from_goal_and_mor(
                new_entry.goal, new_entry.mor)

        db.session.add(new_entry)
        db.session.commit()

        # Sync DVI goal if a MARK goal was added
        if module_val == 'MARK':
            sync_dvi_goal(default_year, default_shift,
                          new_entry.prodgroup3, user)

        return json_success(
            id=new_entry.id,
            prodgroup3=new_entry.prodgroup3,
            operation=new_entry.operation,
            goal=new_entry.goal
        )
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


@app.route('/api/finish/delete-row', methods=['POST'])
def finish_delete_row():
    """Soft-delete a finish module row in-place by setting is_deleted=True."""
    data = get_request_payload()
    user = get_current_user()
    old = db.session.get(TestReport, data.get('id'))

    if not old:
        return json_error('Record not found', 404)

    # Safety guard: only allow deleting rows from the current calendar shift.
    current_shift = get_current_shift_from_calendar()
    if current_shift and old.shift and str(old.shift).strip() != str(current_shift).strip():
        return json_error('Delete is only allowed for the current shift', 403)

    # Capture values before deletion for DVI sync
    module = old.module
    year = old.year
    shift = old.shift
    prodgroup3 = old.prodgroup3

    try:
        old.is_deleted = True
        db.session.commit()

        # Sync DVI goal if a MARK row was deleted
        if module == 'MARK':
            sync_dvi_goal(year, shift, prodgroup3, user)

        return json_success(id=old.id, deleted_by=user)
    except Exception as e:
        db.session.rollback()
        return json_error(str(e))


if __name__ == '__main__':
    app.run(
        debug=env_flag('FLASK_DEBUG', 'true'),
        host=os.getenv('HOST', '127.0.0.1'),
        port=int(os.getenv('PORT', '5000'))
    )
