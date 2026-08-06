from __future__ import annotations

from datetime import date, datetime
from pathlib import Path

from flask import render_template, request


def register_test_routes(app) -> None:
    """Register /test.html routes.

    Keep all test modules routes isolated here.
    """

    @app.route('/test.html')
    @app.route('/test')
    def test_home():
        # Import from app.py at call time to avoid circular imports.
        from app import (
            TestReport,
            db,
            get_current_user,
            get_current_shift_from_calendar,
            get_latest_test_report_ids_for_shift_and_page,
            get_recent_test_database_shifts_for_page,
            test_report_to_dict,
            json_error,
        )

        current_user = get_current_user()
        current_date = date.today().isoformat()

        # Test pages are partitioned by module.
        # Only expose enabled modules as tabs.
        all_tabs = ['BI', 'V8', 'HDMx', 'PHVI', 'STHI', 'OLB']
        tabs = all_tabs

        page_name = (request.args.get('page') or (
            tabs[0] if tabs else '')).strip()

        if page_name not in tabs:
            page_name = tabs[0] if tabs else page_name

        requested_shift = (request.args.get('shift') or '').strip()
        shift_chosen = (request.args.get('shift_chosen') or '').strip() in {
            '1', 'true', 'yes', 'on'}

        current_shift = get_current_shift_from_calendar()
        available_shifts = get_recent_test_database_shifts_for_page(
            page_name, limit=5)
        latest_db_shift = available_shifts[0] if available_shifts else None

        # Default to newest/latest on plain refresh.
        # Only honor an older shift when it was explicitly chosen via the dropdown.
        selected_shift = requested_shift if (
            shift_chosen and requested_shift) else latest_db_shift
        if selected_shift and available_shifts and selected_shift not in available_shifts:
            selected_shift = latest_db_shift

        if not selected_shift:
            # No data in DB for this page yet.
            return render_template(
                'test.html',
                tabs=tabs,
                current_page=page_name,
                rows=[],
                available_shifts=available_shifts,
                selected_shift=None,
                current_shift=current_shift,
                current_user=current_user,
                current_date=current_date,
                latest_db_shift=None,
                shift_mismatch=False,
            )

        try:
            latest_ids = get_latest_test_report_ids_for_shift_and_page(
                selected_shift, page_name)

            # STHI sorts by prodgroup3, then dlcp; other modules sort by prodgroup3, then operation
            if page_name == 'STHI':
                rows = (
                    db.session.query(TestReport)
                    .filter(TestReport.id.in_(latest_ids))
                    .filter((TestReport.is_deleted.is_(None)) | (TestReport.is_deleted.is_(False)))
                    .order_by(TestReport.prodgroup3.asc(), TestReport.dlcp.asc())
                    .all()
                )
            else:
                rows = (
                    db.session.query(TestReport)
                    .filter(TestReport.id.in_(latest_ids))
                    .filter((TestReport.is_deleted.is_(None)) | (TestReport.is_deleted.is_(False)))
                    .order_by(TestReport.prodgroup3.asc(), TestReport.operation.asc())
                    .all()
                )
        except Exception as e:
            return json_error(str(e))

        # Last refresh contract:
        # - Always use the calendar.csv file mtime as the primary source.
        #   (This reflects when the upstream output/source last refreshed.)
        # - Fall back to the DB timestamp only if the file doesn't exist.
        last_refresh_at = None
        last_refresh_source = None
        try:
            calendar_path = Path(__file__).resolve(
            ).parents[1] / 'data' / 'calendar.csv'
            if calendar_path.exists():
                last_refresh_at = datetime.fromtimestamp(
                    calendar_path.stat().st_mtime)
                last_refresh_source = 'calendar'
        except Exception:
            last_refresh_at = None
            last_refresh_source = None

        if not last_refresh_at:
            # DB fallback: latest row timestamp for this module + shift.
            last_refresh_id = db.session.query(db.func.max(TestReport.id)).filter(
                TestReport.shift == selected_shift,
                TestReport.module == page_name,
            ).scalar()
            if last_refresh_id:
                last_refresh_row = db.session.query(TestReport).filter(
                    TestReport.id == last_refresh_id).first()
                if last_refresh_row and getattr(last_refresh_row, 'system_suggested_goal_created_at', None):
                    last_refresh_at = last_refresh_row.system_suggested_goal_created_at
                    last_refresh_source = 'db'

        if not last_refresh_at:
            last_refresh_source = 'unavailable'

        row_dicts = [test_report_to_dict(r) for r in rows]

        # Mismatch: the calendar says a different shift than the one the user is viewing.
        shift_mismatch = bool(
            selected_shift and current_shift and selected_shift != current_shift)

        return render_template(
            'test.html',
            tabs=tabs,
            current_page=page_name,
            rows=row_dicts,
            available_shifts=available_shifts,
            selected_shift=selected_shift,
            current_shift=current_shift,
            current_user=current_user,
            current_date=current_date,
            latest_db_shift=latest_db_shift,
            shift_mismatch=shift_mismatch,
            last_refresh_at=last_refresh_at,
            last_refresh_source=last_refresh_source,
        )

    @app.route('/finish.html')
    @app.route('/finish')
    def finish_home():
        # Import from app.py at call time to avoid circular imports.
        from app import (
            TestReport,
            db,
            get_current_user,
            get_current_shift_from_calendar,
            get_latest_test_report_ids_for_shift_and_page,
            get_recent_test_database_shifts_for_page,
            test_report_to_dict,
            json_error,
        )

        current_user = get_current_user()
        current_date = date.today().isoformat()

        # Finish pages are partitioned by module.
        # Only expose enabled modules as tabs.
        all_tabs = ['MARK', 'DVI']
        tabs = all_tabs

        page_name = (request.args.get('page') or (
            tabs[0] if tabs else '')).strip()

        if page_name not in tabs:
            page_name = tabs[0] if tabs else page_name

        requested_shift = (request.args.get('shift') or '').strip()
        shift_chosen = (request.args.get('shift_chosen') or '').strip() in {
            '1', 'true', 'yes', 'on'}

        current_shift = get_current_shift_from_calendar()
        available_shifts = get_recent_test_database_shifts_for_page(
            page_name, limit=5)
        latest_db_shift = available_shifts[0] if available_shifts else None

        # Default to newest/latest on plain refresh.
        # Only honor an older shift when it was explicitly chosen via the dropdown.
        selected_shift = requested_shift if (
            shift_chosen and requested_shift) else latest_db_shift
        if selected_shift and available_shifts and selected_shift not in available_shifts:
            selected_shift = latest_db_shift

        if not selected_shift:
            # No data in DB for this page yet.
            return render_template(
                'finish.html',
                tabs=tabs,
                current_page=page_name,
                rows=[],
                available_shifts=available_shifts,
                selected_shift=None,
                current_shift=current_shift,
                current_user=current_user,
                current_date=current_date,
                latest_db_shift=None,
                shift_mismatch=False,
            )

        try:
            latest_ids = get_latest_test_report_ids_for_shift_and_page(
                selected_shift, page_name)

            # Finish modules sort by prodgroup3, then operation (no DLCP)
            rows = (
                db.session.query(TestReport)
                .filter(TestReport.id.in_(latest_ids))
                .filter((TestReport.is_deleted.is_(None)) | (TestReport.is_deleted.is_(False)))
                .order_by(TestReport.prodgroup3.asc(), TestReport.operation.asc())
                .all()
            )
        except Exception as e:
            return json_error(str(e))

        # Last refresh contract:
        # - Always use the calendar.csv file mtime as the primary source.
        #   (This reflects when the upstream output/source last refreshed.)
        # - Fall back to the DB timestamp only if the file doesn't exist.
        last_refresh_at = None
        last_refresh_source = None
        try:
            calendar_path = Path(__file__).resolve(
            ).parents[1] / 'data' / 'calendar.csv'
            if calendar_path.exists():
                last_refresh_at = datetime.fromtimestamp(
                    calendar_path.stat().st_mtime)
                last_refresh_source = 'calendar'
        except Exception:
            last_refresh_at = None
            last_refresh_source = None

        if not last_refresh_at:
            # DB fallback: latest row timestamp for this module + shift.
            last_refresh_id = db.session.query(db.func.max(TestReport.id)).filter(
                TestReport.shift == selected_shift,
                TestReport.module == page_name,
            ).scalar()
            if last_refresh_id:
                last_refresh_row = db.session.query(TestReport).filter(
                    TestReport.id == last_refresh_id).first()
                if last_refresh_row and getattr(last_refresh_row, 'system_suggested_goal_created_at', None):
                    last_refresh_at = last_refresh_row.system_suggested_goal_created_at
                    last_refresh_source = 'db'

        if not last_refresh_at:
            last_refresh_source = 'unavailable'

        row_dicts = [test_report_to_dict(r) for r in rows]

        # Mismatch: the calendar says a different shift than the one the user is viewing.
        shift_mismatch = bool(
            selected_shift and current_shift and selected_shift != current_shift)

        return render_template(
            'finish.html',
            tabs=tabs,
            current_page=page_name,
            rows=row_dicts,
            available_shifts=available_shifts,
            selected_shift=selected_shift,
            current_shift=current_shift,
            current_user=current_user,
            current_date=current_date,
            latest_db_shift=latest_db_shift,
            shift_mismatch=shift_mismatch,
            last_refresh_at=last_refresh_at,
            last_refresh_source=last_refresh_source,
        )
