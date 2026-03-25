import urllib.parse
import csv
import os
import re
import time
from threading import Lock
from datetime import datetime
from flask import Flask, render_template, request, jsonify, redirect, url_for, send_file
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import desc, inspect

app = Flask(__name__)


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
db_host = os.getenv("GOALING_DB_HOST", "postgres5109-lb-pg-in.iglb.intel.com")
db_port = os.getenv("GOALING_DB_PORT", "5433")
db_name = os.getenv("GOALING_DB_NAME", "atmoperationdatastore")
db_schema = os.getenv("GOALING_DB_SCHEMA", "cdat_mfg")

app.config['SQLALCHEMY_DATABASE_URI'] = f"postgresql+psycopg2://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}"
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


@app.route('/download/wip-goal-reckon-raw')
def download_wip_goal_reckon_raw():
    """Download the raw validation CSV used for data checking."""
    csv_path = os.path.join(app.root_path, 'data', 'wip_goal_reckon_raw.csv')
    if not os.path.exists(csv_path):
        return json_error('CSV file not found', 404)

    # Use conditional=False to avoid IIS/proxy caching oddities for a frequently-updated file.
    return send_file(
        csv_path,
        as_attachment=True,
        download_name='wip_goal_reckon_raw.csv',
        mimetype='text/csv',
        conditional=False,
        max_age=0,
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


# --- Configuration: Map Page Names to Operation Codes ---
OPERATION_GROUPS = {
    'TCB':      [1204],
    'HBC-JDC':  [510, 971],
    'DIA':      [1171, 2090],
    'TACS23':   [2171, 2172, 2174],
    'TPX':      [1501, 4992, 5651, 5652, 5653, 5654],
    'DFLX':     [2004, 2053],
    'EPX':      [1225],
    'CURE':     [970, 1173, 1235, 1266, 1366, 2135],
    'PXVI':     [1025, 1175, 1245, 1863, 1892, 1895, 2436, 9668],
    'CTC':      [2150, 2151, 2152, 2161],
    '2D-Xray':  [265],
    'BA':       [2133]
}


class Report(db.Model):
    __tablename__ = 'cdat_goaling'
    __table_args__ = {'schema': db_schema} if db_schema else {}

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    year = db.Column(db.Integer)
    shift = db.Column(db.String(10))
    prodgroup3 = db.Column(db.String(50))
    operation = db.Column(db.String(50))
    qtg1 = db.Column(db.Float, default=0.0)
    qps1 = db.Column(db.Float, default=0.0)
    entity = db.Column(db.String(50))
    mor = db.Column(db.Float, default=0.0)
    tr = db.Column(db.Float, default=0.0)
    output = db.Column(db.Float, default=0.0)
    shift_start_wip = db.Column(db.Float, default=0.0)
    system_suggested_goal = db.Column(db.Float, default=0.0)
    system_suggested_goal_created_at = db.Column(db.DateTime)
    subcell_info = db.Column(db.String(100))

    manual_adjusted_goal = db.Column(db.Float, default=0.0)
    goal_adjusted_reason = db.Column(db.String(255))
    goal_adjusted_at = db.Column(db.DateTime)
    goal_adjusted_by = db.Column(db.String(100))

    miss_goal_comment = db.Column(db.String(255))
    miss_goal_comment_updated_at = db.Column(db.DateTime)
    miss_goal_comment_updated_by = db.Column(db.String(100))


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
    filtered = db.session.query(Report.id, Report.prodgroup3, Report.operation, Report.entity).filter(
        Report.shift == latest_shift
    )
    filtered = apply_operation_group_filter(filtered, page_name)

    latest_ids_subquery = filtered.with_entities(
        db.func.max(Report.id).label('id')
    ).group_by(
        Report.prodgroup3,
        Report.operation,
        Report.entity
    ).subquery()

    return latest_ids_subquery


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
    if page_name not in OPERATION_GROUPS:
        return query

    target_ops = OPERATION_GROUPS[page_name]
    # Precompute common float-string variants (e.g. '1204', '1204.0', '1204.00')
    # so the DB can use a simple IN filter instead of per-row regexp_replace.
    op_variants = []
    for op in target_ops:
        op_variants.append(str(op))
        op_variants.append(f"{op}.0")
        op_variants.append(f"{op}.00")

    trimmed_operation = db.func.trim(db.cast(Report.operation, db.String))
    return query.filter(trimmed_operation.in_(op_variants))


def compute_tr_from_goal_and_mor(goal_value, mor_value):
    mor = mor_value if (mor_value and mor_value != 0) else 0
    if mor == 0:
        return 0.0
    return round(goal_value / mor, 3)


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

    current_user = get_current_user()
    current_shift = get_current_shift_from_calendar()
    available_shifts = get_recent_database_shifts_for_page(page_name, limit=5)
    # Ensure newest shift appears first in the dropdown.
    # Shifts are typically strings like "2026-W11-D"; lexicographic descending works for this format.
    if available_shifts:
        available_shifts = sorted(available_shifts, reverse=True)
    latest_db_shift = available_shifts[0] if available_shifts else None

    # Only honor shifts that exist in the DB list.
    # Default behavior: always show the latest DB shift unless the user explicitly requests another valid shift.
    if requested_shift and requested_shift in available_shifts:
        selected_shift = requested_shift
    else:
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
        ).order_by(desc(Report.id)).all()
    current_date = datetime.now().strftime('%Y-%m-%d')

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
        current_page=page_name
    )


@app.route('/api/add-new-goal', methods=['POST'])
def add_new_goal():
    data = get_request_payload()
    user = get_current_user()
    try:
        default_year, default_shift = get_current_year_and_shift_from_calendar()
        raw_entity = (data.get('entity') or '').strip()
        entity = raw_entity if raw_entity else None
        new_entry = Report(
            year=default_year,            # 使用最新记录的年份
            shift=default_shift,          # 使用最新记录的班次
            prodgroup3=data.get('prodgroup3'),
            operation=data.get('operation'),
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
        calculated_tr = compute_tr_from_goal_and_mor(new_goal, old.mor)

        new_entry = persist_report_version(
            old,
            manual_adjusted_goal=new_goal,
            tr=calculated_tr,
            goal_adjusted_reason=data.get('reason'),
            goal_adjusted_at=datetime.now(),
            goal_adjusted_by=user
        )

        return json_success(new_id=new_entry.id)
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
        raw_entity = '' if data.get('entity') is None else str(data.get('entity'))
        entity_val = raw_entity.strip()
        entity_val = entity_val if entity_val else None

        old.entity = entity_val
        db.session.commit()

        return json_success(id=old.id)
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
            results.append({'status': 'error', 'message': 'Invalid update item'})
            continue

        old_id = item.get('id')
        try:
            old_id_int = int(old_id)
        except Exception:
            results.append({'old_id': old_id, 'status': 'error', 'message': 'Invalid id'})
            continue

        old = db.session.get(Report, old_id_int)
        if not old:
            results.append({'old_id': old_id_int, 'status': 'error', 'message': 'Record not found'})
            continue

        comment_val = '' if item.get('comment') is None else str(item.get('comment'))
        try:
            new_entry = persist_report_version(
                old,
                miss_goal_comment=comment_val,
                miss_goal_comment_updated_at=datetime.now(),
                miss_goal_comment_updated_by=user
            )
            results.append({'old_id': old_id_int, 'new_id': new_entry.id, 'status': 'success'})
        except Exception as e:
            db.session.rollback()
            results.append({'old_id': old_id_int, 'status': 'error', 'message': str(e)})

    return json_success(results=results)

if __name__ == '__main__':
    app.run(
        debug=env_flag('FLASK_DEBUG', 'true'),
        host=os.getenv('HOST', '127.0.0.1'),
        port=int(os.getenv('PORT', '5000'))
    )
