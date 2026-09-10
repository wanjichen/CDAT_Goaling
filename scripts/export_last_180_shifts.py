"""
One-time script: export goal vs output data for the last 180 shifts to a CSV file.

This mirrors the logic used by the `/api/download-goal-output` route in app.py,
but with the shift limit raised from 14 to 180, and writes directly to a local
CSV file instead of returning an HTTP response.

Usage (from the project root, with the same Python env used to run the app):
    python scripts/export_last_180_shifts.py [output_path]

If output_path is not given, the file is written to:
    data/goal_output_last_180_shifts_<timestamp>.csv
"""
import csv
import math
import os
import sys
from datetime import datetime

# Make sure the project root is on sys.path so we can import app.py's models.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app, db, Report, TestReport, get_latest_test_report_ids_for_shift_and_page  # noqa: E402

SHIFT_LIMIT = 180


def format_number(val):
    if isinstance(val, (int, float)) and math.isfinite(val):
        if val == int(val):
            return str(int(val))
        else:
            return f"{val:.3f}"
    return ''


def format_achievement(val):
    if isinstance(val, (int, float)) and math.isfinite(val):
        if val == int(val):
            return str(int(val))
        else:
            return f"{val:.2f}"
    return ''


def main(output_path=None):
    with app.app_context():
        # Get the most recent SHIFT_LIMIT shifts.
        latest_id = db.func.max(Report.id).label('latest_id')
        shift_rows = db.session.query(Report.shift, latest_id).filter(
            Report.shift.isnot(None),
            db.func.trim(db.cast(Report.shift, db.String)) != ''
        ).group_by(Report.shift).order_by(db.desc(latest_id)).limit(SHIFT_LIMIT).all()

        shifts = [row.shift for row in shift_rows if row.shift]
        if not shifts:
            print("No data available.")
            return

        # Ascending order (oldest first)
        shifts = sorted(shifts, reverse=False)

        rows_data = []

        test_modules = ['HDMx', 'PHVI', 'V8',
                        'OLB', 'BI', 'STHI', 'MARK', 'DVI']

        # Assembly modules (exclude test modules)
        assembly_query = db.session.query(
            Report.shift,
            Report.module,
            Report.prodgroup3,
            Report.entity,
            db.func.sum(
                db.func.coalesce(Report.manual_adjusted_goal,
                                 Report.system_suggested_goal, 0)
            ).label('total_goal'),
            db.func.sum(db.func.coalesce(Report.output, 0)
                        ).label('total_output'),
            db.func.sum(db.func.coalesce(Report.qps1, 0)).label('total_qps1'),
            db.func.sum(db.func.coalesce(Report.qps2, 0)).label('total_qps2')
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

        # Test modules: latest row(s) per (shift, module), same rule as UI.
        distinct_shift_modules = db.session.query(
            TestReport.shift, TestReport.module
        ).filter(
            TestReport.shift.in_(shifts),
            (TestReport.is_deleted.is_(None)) | (
                TestReport.is_deleted.is_(False))
        ).distinct().all()

        test_ids = []
        for shift_val, module_val in distinct_shift_modules:
            if not shift_val or not module_val:
                continue
            ids_subq = get_latest_test_report_ids_for_shift_and_page(
                shift_val, module_val)
            test_ids.extend(
                row.id for row in db.session.query(ids_subq.c.id).all()
            )

        test_query = db.session.query(
            TestReport.shift,
            TestReport.module,
            TestReport.prodgroup3,
            db.literal(None).label('entity'),
            TestReport.goal.label('total_goal'),
            TestReport.output.label('total_output'),
            TestReport.qps1.label('total_qps1'),
            TestReport.qps2.label('total_qps2')
        ).filter(
            TestReport.id.in_(test_ids)
        ).all() if test_ids else []

        # Process assembly rows
        for row in assembly_query:
            goal = row.total_goal or 0
            output = row.total_output or 0
            qps1 = row.total_qps1 or 0
            qps2 = row.total_qps2 or 0
            if goal == 0:
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
                'qps2': qps2,
                'achievement': round(achievement, 1),
            })

        # Process test rows
        for row in test_query:
            goal = row.total_goal or 0
            output = row.total_output or 0
            qps1 = row.total_qps1 or 0
            qps2 = row.total_qps2 or 0
            if goal == 0:
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
                'qps2': qps2,
                'achievement': round(achievement, 1),
            })

        rows_data.sort(key=lambda x: (
            x['shift'], x['module'], x['prodgroup3'], x['entity']))

        if not output_path:
            ts = datetime.now().strftime('%Y%m%d_%H%M%S')
            output_path = os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                'data',
                f'goal_output_last_180_shifts_{ts}.csv'
            )

        with open(output_path, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f)
            writer.writerow(['Shift', 'Module', 'Prodgroup3',
                             'Entity', 'Goal', 'Output', 'QPS1', 'QPS2', 'Achievement %'])
            for row in rows_data:
                writer.writerow([
                    row['shift'],
                    row['module'],
                    row['prodgroup3'],
                    row['entity'],
                    format_number(row['goal']),
                    format_number(row['output']),
                    format_number(row['qps1']),
                    format_number(row['qps2']),
                    format_achievement(row['achievement']),
                ])

        print(
            f"Exported {len(rows_data)} rows across {len(shifts)} shifts to: {output_path}")


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else None
    main(out)
