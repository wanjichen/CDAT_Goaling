from __future__ import annotations

import argparse
import os
from typing import Optional, Tuple

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

# ----------------------------
# Config / inputs
# ----------------------------
SCHEMA_NAME = "cdat_mfg"
TABLE_NAME = "cdat_goaling"

CALENDAR_PATH = "calendar.csv"
ENTITY_OP_CEID_PATH = "EntityOperationsCEID.csv"
EUPH_OVERRIDE_PATH = "EUPH_Override.csv"
MCS_DATA_PATH = "MCS_Data_Updated.csv"

# Known missing (ENTITY, OPERATION) -> CEID mappings.
CEID_PATCH_MAP: dict[tuple[str, str], str] = {
    ("TCB708", "1204"): "TCBB",
}


def pg_dsn() -> str:
    required = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        raise RuntimeError(
            "Missing required environment variable(s): " + ", ".join(missing)
        )
    return (
        f"host={os.environ['PGHOST']} "
        f"port={os.environ['PGPORT']} "
        f"dbname={os.environ['PGDATABASE']} "
        f"user={os.environ['PGUSER']} "
        f"password={os.environ['PGPASSWORD']}"
    )


# ----------------------------
# Normalization helpers
# ----------------------------
def _norm_str(x: object) -> Optional[str]:
    if x is None:
        return None
    s = str(x).strip()
    if s == "" or s.lower() in {"nan", "none", "null"}:
        return None
    return s.upper()


def _norm_int_str(x: object) -> Optional[str]:
    s = _norm_str(x)
    if s is None:
        return None
    n = pd.to_numeric([s], errors="coerce")[0]
    if pd.isna(n):
        return None
    return str(int(n))


def _norm_float(x: object) -> Optional[float]:
    n = pd.to_numeric(x, errors="coerce")
    if pd.isna(n):
        return None
    return float(n)


def _norm_ceid_from_resource(x: object) -> Optional[str]:
    s = _norm_str(x)
    if s is None:
        return None
    return s if len(s) == 1 else (s[:-1] + s[-1].upper())


# ----------------------------
# CSV readers
# ----------------------------
def _read_csv(path: str) -> pd.DataFrame:
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    return pd.read_csv(path, sep=None, engine="python", dtype=str)


def read_target_shift(path: str) -> Tuple[str, str]:
    df = _read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]
    required = {"year", "shift", "sequence"}
    missing = required - set(df.columns)
    if missing:
        raise RuntimeError(f"calendar.csv missing columns: {sorted(missing)}")

    seq_num = pd.to_numeric(df["sequence"].astype(
        str).str.strip(), errors="coerce")
    rows = df.loc[seq_num == 0]
    if len(rows) != 1:
        raise RuntimeError(
            f"Expected exactly 1 row with SEQUENCE=0, found {len(rows)}"
        )

    year = str(rows.iloc[0]["year"]).strip()
    shift = str(rows.iloc[0]["shift"]).strip()
    if not year or not shift:
        raise RuntimeError(
            "calendar.csv SEQUENCE=0 row has empty YEAR or SHIFT")

    return year, shift


def read_entity_operation_ceid(path: str) -> pd.DataFrame:
    df = _read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]

    required = {"entity", "operation", "ceid"}
    missing = required - set(df.columns)
    if missing:
        raise RuntimeError(
            f"EntityOperationsCEID.csv missing columns: {sorted(missing)}"
        )

    out = pd.DataFrame(
        {
            "entity": df["entity"].map(_norm_str),
            "operation": df["operation"].map(_norm_int_str),
            "ceid": df["ceid"].map(_norm_str),
        }
    )

    out = (
        out.dropna(subset=["entity", "operation", "ceid"])
        .drop_duplicates(subset=["entity", "operation"], keep="last")
        .copy()
    )

    if CEID_PATCH_MAP:
        patch_rows = [
            {
                "entity": _norm_str(ent),
                "operation": _norm_int_str(op),
                "ceid": _norm_str(ceid),
            }
            for (ent, op), ceid in CEID_PATCH_MAP.items()
        ]
        patch_df = pd.DataFrame(patch_rows).dropna()
        if not patch_df.empty:
            out = pd.concat([out, patch_df], ignore_index=True)
            out = out.drop_duplicates(
                subset=["entity", "operation"], keep="last")

    return out


def read_override(path: str) -> pd.DataFrame:
    df = _read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]

    required = {"product_group", "operation", "ceid", "mor"}
    missing = required - set(df.columns)
    if missing:
        raise RuntimeError(
            f"EUPH_Override.csv missing columns: {sorted(missing)}")

    out = pd.DataFrame(
        {
            "prodgroup3": df["product_group"].map(_norm_str),
            "operation": df["operation"].map(_norm_int_str),
            "ceid": df["ceid"].map(_norm_str),
            "mor": df["mor"].map(_norm_float),
        }
    )

    return (
        out.dropna(subset=["prodgroup3", "operation", "ceid", "mor"])
        .drop_duplicates(subset=["prodgroup3", "operation", "ceid"], keep="last")
        .copy()
    )


def read_mcs(path: str) -> pd.DataFrame:
    df = _read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]

    required = {"prodgroup3", "operation", "resource_", "mor"}
    missing = required - set(df.columns)
    if missing:
        raise RuntimeError(
            f"MCS_Data_Updated.csv missing columns: {sorted(missing)}")

    out = pd.DataFrame(
        {
            "prodgroup3": df["prodgroup3"].map(_norm_str),
            "operation": df["operation"].map(_norm_int_str),
            "ceid": df["resource_"].map(_norm_ceid_from_resource),
            "mor": df["mor"].map(_norm_float),
        }
    )

    return (
        out.dropna(subset=["prodgroup3", "operation", "ceid", "mor"])
        .drop_duplicates(subset=["prodgroup3", "operation", "ceid"], keep="last")
        .copy()
    )


# ----------------------------
# DB reads
# ----------------------------
def fetch_target_keys_from_db(dsn: str, year: str, shift: str) -> pd.DataFrame:
    sql = f"""
    SELECT
      BTRIM(prodgroup3::text) AS prodgroup3,
      operation::bigint AS operation,
      BTRIM(entity::text) AS entity
    FROM {SCHEMA_NAME}.{TABLE_NAME}
    WHERE year::bigint = %s
      AND UPPER(BTRIM(shift::text)) = UPPER(BTRIM(%s))
      AND entity IS NOT NULL
      AND BTRIM(entity::text) <> ''
    """

    with psycopg2.connect(dsn) as conn:
        df = pd.read_sql_query(sql, conn, params=[year, shift])

    df["prodgroup3"] = df["prodgroup3"].map(_norm_str)
    df["entity"] = df["entity"].map(_norm_str)
    df["operation"] = df["operation"].map(_norm_int_str)

    return (
        df.dropna(subset=["prodgroup3", "operation", "entity"])
        .drop_duplicates(subset=["prodgroup3", "operation", "entity"], keep="last")
        .copy()
    )


# ----------------------------
# Update preparation
# ----------------------------
def prepare_updates(
    target_keys: pd.DataFrame,
    eoc: pd.DataFrame,
    override: pd.DataFrame,
    mcs: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    key_ceid = target_keys.merge(eoc, how="left", on=["entity", "operation"])
    key_ceid = key_ceid.dropna(subset=["ceid"]).copy()

    ov = key_ceid.merge(override, how="inner", on=[
                        "prodgroup3", "operation", "ceid"])
    ov = (
        ov[["prodgroup3", "operation", "entity", "mor"]]
        .dropna()
        .drop_duplicates(subset=["prodgroup3", "operation", "entity"], keep="last")
        .copy()
    )

    # MCS for entity rows: prefix3 match + MAX MOR.
    mc = pd.DataFrame(columns=["prodgroup3", "operation", "entity", "mor"])
    if not key_ceid.empty and not mcs.empty:
        keys3 = key_ceid[["prodgroup3", "operation",
                          "entity", "ceid"]].dropna().copy()
        keys3["ceid_prefix3"] = keys3["ceid"].astype(str).str[:3]

        mcs3 = mcs[["prodgroup3", "operation", "ceid", "mor"]].dropna().copy()
        mcs3["ceid_prefix3"] = mcs3["ceid"].astype(str).str[:3]
        mcs3 = (
            mcs3.groupby(["prodgroup3", "operation", "ceid_prefix3"], as_index=False)[
                "mor"
            ]
            .max()
            .copy()
        )

        mc = keys3.merge(
            mcs3,
            how="inner",
            on=["prodgroup3", "operation", "ceid_prefix3"],
        )
        mc = (
            mc[["prodgroup3", "operation", "entity", "mor"]]
            .dropna()
            .drop_duplicates(subset=["prodgroup3", "operation", "entity"], keep="last")
            .copy()
        )

    # Enforce override priority (override wins).
    if not ov.empty and not mc.empty:
        mc = mc.merge(
            ov[["prodgroup3", "operation", "entity"]],
            how="left",
            on=["prodgroup3", "operation", "entity"],
            indicator=True,
        )
        mc = mc.loc[mc["_merge"] == "left_only"].drop(
            columns=["_merge"]).copy()

    # Aggregate MOR for entity-missing rows (kept for parity with legacy behavior).
    miss = (
        mcs[["prodgroup3", "operation", "mor"]]
        .dropna(subset=["prodgroup3", "operation", "mor"])
        .groupby(["prodgroup3", "operation"], as_index=False)["mor"]
        .min()
        .copy()
    )

    return ov, mc, miss


# ----------------------------
# DB updates
# ----------------------------
def _apply_update(
    cur,
    year: str,
    shift: str,
    stage: pd.DataFrame,
    stage_cols: list[str],
    where_sql: str,
    *,
    dry_run: bool,
) -> int:
    if stage.empty:
        return 0

    if dry_run:
        return int(len(stage))

    stage = stage.copy()
    stage["year"] = year
    stage["shift"] = shift

    records = [tuple(r)
               for r in stage[stage_cols].itertuples(index=False, name=None)]

    execute_values(
        cur,
        f"""
        WITH s({', '.join(stage_cols)}) AS (VALUES %s)
        UPDATE {SCHEMA_NAME}.{TABLE_NAME} t
        SET mor = s.mor,
            tr = (
                CASE
                    WHEN s.mor IS NULL OR NULLIF(s.mor::numeric, 0) IS NULL THEN t.tr
                    WHEN COALESCE(t.qps1::numeric, 0) < 0 THEN
                        GREATEST(0, (COALESCE(t.qps2::numeric, 0) / NULLIF(s.mor::numeric, 0)))
                    ELSE
                        GREATEST(0, (COALESCE(t.qps1::numeric, 0) / NULLIF(s.mor::numeric, 0)))
                END
            ),
            capacity = (
                CASE
                    WHEN s.mor IS NOT NULL AND t.link_cell_qty IS NOT NULL THEN
                        (s.mor::numeric * t.link_cell_qty::numeric / 30)
                    ELSE
                        t.capacity
                END
            )
        FROM s
        WHERE {where_sql}
        """,
        records,
        page_size=2000,
    )

    return cur.rowcount


def sync_to_db(
    dsn: str,
    year: str,
    shift: str,
    ov_u: pd.DataFrame,
    mc_u: pd.DataFrame,
    miss_u: pd.DataFrame,
    *,
    dry_run: bool,
) -> tuple[int, int, int]:
    where_entity = (
        "t.year::bigint = s.year::bigint "
        "AND UPPER(BTRIM(t.shift::text)) = UPPER(BTRIM(s.shift)) "
        "AND UPPER(BTRIM(t.prodgroup3::text)) = UPPER(BTRIM(s.prodgroup3)) "
        "AND t.operation::bigint = s.operation::bigint "
        "AND UPPER(BTRIM(t.entity::text)) = UPPER(BTRIM(s.entity))"
    )

    where_missing = (
        "t.year::bigint = s.year::bigint "
        "AND UPPER(BTRIM(t.shift::text)) = UPPER(BTRIM(s.shift)) "
        "AND (t.entity IS NULL OR BTRIM(t.entity::text) = '') "
        "AND UPPER(BTRIM(t.prodgroup3::text)) = UPPER(BTRIM(s.prodgroup3)) "
        "AND t.operation::bigint = s.operation::bigint"
    )

    if dry_run:
        u1 = _apply_update(
            None,
            year,
            shift,
            ov_u,
            ["year", "shift", "prodgroup3", "operation", "entity", "mor"],
            where_entity,
            dry_run=True,
        )
        u2 = _apply_update(
            None,
            year,
            shift,
            mc_u,
            ["year", "shift", "prodgroup3", "operation", "entity", "mor"],
            where_entity,
            dry_run=True,
        )
        u3 = _apply_update(
            None,
            year,
            shift,
            miss_u,
            ["year", "shift", "prodgroup3", "operation", "mor"],
            where_missing,
            dry_run=True,
        )
        return u1, u2, u3

    with psycopg2.connect(dsn) as conn:
        with conn.cursor() as cur:
            u1 = _apply_update(
                cur,
                year,
                shift,
                ov_u,
                ["year", "shift", "prodgroup3", "operation", "entity", "mor"],
                where_entity,
                dry_run=False,
            )
            u2 = _apply_update(
                cur,
                year,
                shift,
                mc_u,
                ["year", "shift", "prodgroup3", "operation", "entity", "mor"],
                where_entity,
                dry_run=False,
            )
            u3 = _apply_update(
                cur,
                year,
                shift,
                miss_u,
                ["year", "shift", "prodgroup3", "operation", "mor"],
                where_missing,
                dry_run=False,
            )
        conn.commit()

    return u1, u2, u3


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "Update cdat_mfg.cdat_goaling.mor (and capacity) for a target year/shift. "
            "Does NOT recompute TR; TR stays as-is in the database."
        )
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Compute input sets and report counts, but don't write to DB.",
    )
    p.add_argument(
        "--year",
        type=str,
        default=None,
        help="Override the target YEAR (otherwise read from calendar.csv where sequence=0).",
    )
    p.add_argument(
        "--shift",
        type=str,
        default=None,
        help="Override the target SHIFT (otherwise read from calendar.csv where sequence=0).",
    )
    return p


def main(argv: Optional[list[str]] = None) -> int:
    # In notebooks, argv is polluted with kernel args; default to [] for safety.
    args = build_arg_parser().parse_args(argv or [])

    dsn = pg_dsn()

    if args.year and args.shift:
        year, shift = args.year.strip(), args.shift.strip()
    elif args.year or args.shift:
        raise SystemExit("Provide both --year and --shift, or neither.")
    else:
        year, shift = read_target_shift(CALENDAR_PATH)

    target_keys = fetch_target_keys_from_db(dsn, year, shift)
    eoc = read_entity_operation_ceid(ENTITY_OP_CEID_PATH)
    override = read_override(EUPH_OVERRIDE_PATH)
    mcs = read_mcs(MCS_DATA_PATH)

    ov_u, mc_u, miss_u = prepare_updates(target_keys, eoc, override, mcs)

    if ov_u.empty and mc_u.empty and miss_u.empty:
        print("[update_mor_db] No usable input rows.")
        return 0

    u1, u2, u3 = sync_to_db(
        dsn,
        year,
        shift,
        ov_u,
        mc_u,
        miss_u,
        dry_run=bool(args.dry_run),
    )

    print(f"[update_mor_db] Target year={year}, shift={shift}")
    if args.dry_run:
        print("[update_mor_db] DRY-RUN: no database writes were performed")

    print(
        f"[update_mor_db] Updated rows: override={u1}, mcsPrefix3Max={u2}, entityMissingAgg={u3}, total={u1 + u2 + u3}"  # noqa: E501
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
