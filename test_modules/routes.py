from __future__ import annotations

from flask import render_template, request


def register_test_routes(app) -> None:
    """Register /test.html routes.

    Keep all test modules routes isolated here.
    """

    @app.route('/test.html')
    def test_home():
        # Import from app.py at call time to avoid circular imports.
        from app import (
            TestReport,
            db,
            get_current_shift_from_calendar,
            get_latest_test_report_ids_for_shift_and_page,
            get_recent_test_database_shifts_for_page,
            test_report_to_dict,
            TEST_OPERATION_GROUPS,
            json_error,
        )

        # For now, only show tabs that currently have data populated.
        # (Requested: hide LCBI, V8, PHVI, OLB, STHI.)
        tabs = ['HDMx']

        page_name = (request.args.get('page') or (tabs[0] if tabs else '')).strip()
        if page_name not in tabs:
            page_name = tabs[0] if tabs else page_name

        requested_shift = (request.args.get('shift') or '').strip()

        current_shift = get_current_shift_from_calendar()
        available_shifts = get_recent_test_database_shifts_for_page(page_name, limit=5)
        latest_db_shift = available_shifts[0] if available_shifts else None

        if requested_shift and requested_shift in available_shifts:
            selected_shift = requested_shift
        else:
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
                latest_db_shift=None,
                shift_mismatch=False,
            )

        try:
            latest_ids = get_latest_test_report_ids_for_shift_and_page(selected_shift, page_name)
            rows = (
                db.session.query(TestReport)
                .filter(TestReport.id.in_(latest_ids))
                .order_by(TestReport.prodgroup3.asc(), TestReport.operation.asc())
                .all()
            )
        except Exception as e:
            return json_error(str(e))

        row_dicts = [test_report_to_dict(r) for r in rows]
        shift_mismatch = bool(selected_shift and current_shift and selected_shift != current_shift)

        return render_template(
            'test.html',
            tabs=tabs,
            current_page=page_name,
            rows=row_dicts,
            available_shifts=available_shifts,
            selected_shift=selected_shift,
            current_shift=current_shift,
            latest_db_shift=latest_db_shift,
            shift_mismatch=shift_mismatch,
        )
