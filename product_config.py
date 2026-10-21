"""Product family configuration.

Central place to define which prodgroup3 values belong to the DT (Desktop)
product family vs. the Mobile (non-DT) family, along with any factors/values
that depend on that classification.

To add or remove a product, edit DT_PRODUCTS below.
"""

# prodgroup3 values that belong to the DT (Desktop) product family.
# All other prodgroup3 values are treated as Mobile (non-DT).
DT_PRODUCTS: set[str] = {
    'ARLS816L',
    'ARLR816L',
    'ARLS681',
    'RPLS881',
    'RPRS881',
    'RPLS601',
    'RPRS601',
    'MEV',
    'ARLR816LK',
    'RPLPS2',
    'RPLPS6',
    'M4G',
    'BTLS601'
}

# prodgroup3 values that belong to the PCH product family.
# These also use OLB_GOAL_FACTOR_DT (0.8), same as DT_PRODUCTS.
PCH_PRODUCTS: set[str] = {
    'ADP',
    'ADPIOT',
    'MTP',
    'NVP'
}

# prodgroup3 values that belong to the Server product family.
# These also use OLB_GOAL_FACTOR_DT (0.8), same as DT_PRODUCTS.
SERVER_PRODUCTS: set[str] = {
    'SPRXCS',
    'SPRXCC',
}

# ---------------------------------------------------------------------------
# OLB goal-factor configuration
# ---------------------------------------------------------------------------
# DT, PCH, and Server products use OLB_GOAL_FACTOR_DT (0.8).
# All other (Mobile / non-DT / non-PCH / non-Server) products use OLB_GOAL_FACTOR_NON_DT (0.8 * 0.8 = 0.64).
# prodgroup3 IN DT_PRODUCTS, PCH_PRODUCTS, or SERVER_PRODUCTS
OLB_GOAL_FACTOR_DT: float = 0.8
# prodgroup3 NOT IN DT_PRODUCTS, PCH_PRODUCTS, or SERVER_PRODUCTS (0.64)
OLB_GOAL_FACTOR_NON_DT: float = 0.8 * 0.8


def is_dt_product(prodgroup3: str) -> bool:
    """Return True if the given prodgroup3 belongs to the DT product family."""
    return prodgroup3 in DT_PRODUCTS


def is_pch_product(prodgroup3: str) -> bool:
    """Return True if the given prodgroup3 belongs to the PCH product family."""
    return prodgroup3 in PCH_PRODUCTS


def is_server_product(prodgroup3: str) -> bool:
    """Return True if the given prodgroup3 belongs to the Server product family."""
    return prodgroup3 in SERVER_PRODUCTS


# prodgroup3 values that should be fully excluded from OLB goal syncing.
# No OLB goal is calculated, created, or updated for these products.
# NOTE: this exclusion applies only to the Test Modules (test.html) OLB tab
# (see sync_olb_goal / /api/test/add-new-goal in app.py). Assembly (index.html)
# and Finish (finish.html) have no OLB module, so they are unaffected.
EXCLUDE_PRODUCTS: set[str] = {
    'MTP',
}


def is_excluded_product(prodgroup3: str) -> bool:
    """Return True if the given prodgroup3 should be excluded from OLB goal sync."""
    return prodgroup3 in EXCLUDE_PRODUCTS


def get_olb_goal_factor(prodgroup3: str) -> float:
    """Return the OLB goal factor for a given prodgroup3.

    DT, PCH, and Server products use OLB_GOAL_FACTOR_DT; everything else
    uses OLB_GOAL_FACTOR_NON_DT.
    """
    if is_dt_product(prodgroup3) or is_pch_product(prodgroup3) or is_server_product(prodgroup3):
        return OLB_GOAL_FACTOR_DT
    return OLB_GOAL_FACTOR_NON_DT


# ---------------------------------------------------------------------------
# Product family classification (for grouping/reporting purposes)
# ---------------------------------------------------------------------------
FAMILY_DT = 'DT Products'
FAMILY_PCH = 'PCH Products'
FAMILY_SERVER = 'Server Products'
FAMILY_MOBILE = 'Mobile Products'

# Display order used by any UI that groups rows by product family.
PRODUCT_FAMILY_ORDER = [FAMILY_DT, FAMILY_PCH, FAMILY_SERVER, FAMILY_MOBILE]


def get_product_family(prodgroup3: str) -> str:
    """Return the product family label for a given prodgroup3.

    - DT_PRODUCTS -> 'DT Products'
    - PCH_PRODUCTS -> 'PCH Products'
    - SERVER_PRODUCTS -> 'Server Products'
    - everything else -> 'Mobile Products'
    """
    if is_dt_product(prodgroup3):
        return FAMILY_DT
    if is_pch_product(prodgroup3):
        return FAMILY_PCH
    if is_server_product(prodgroup3):
        return FAMILY_SERVER
    return FAMILY_MOBILE


# ---------------------------------------------------------------------------
# Shared Sspec page: Prodgroup3 group dropdown configuration
# ---------------------------------------------------------------------------
# Each entry defines one option in the "Prodgroup3 group" dropdown on the
# Shared Sspec page (templates/shared_sspec.html). Selecting a group filters
# every table on that page (Detail QTG/QPS Analysis, Shipout Summary, and
# Shipout by Sspec) down to just the prodgroup3 values listed in "members".
#
# "sspec_filter" additionally restricts the "Shipout by Sspec" table to only
# the given Sspec values for that group. Set it to None to show all Sspecs
# for that group (no restriction).
#
# To add, remove, or change a group: just edit the list below. The first
# entry is the default selection when the page loads with no group chosen.
SHARED_SSPEC_PG3_GROUPS = [
    {
        'label': 'ARLS816L/ARLR816L',
        'members': ['ARLS816L', 'ARLR816L'],
        'sspec_filter': None,  # show all Sspecs
        # Extra prodgroup3 values shown only in the "Shipout by Sspec"
        # side table for this group (does not affect the main report
        # table or BP Summary table).
        'shipout_extra_members': ['ARLR816LK'],
        # Dlcp codes that should always appear in the BP Summary table for
        # every member of this group, even if MI_Configured_BP.csv has no
        # row for that (prodgroup3, dlcp) in the current/next work-week.
        # Missing combinations are shown with blank/zero values.
        'bp_summary_dlcps': ['FF', 'UV', 'UX'],
    },
    {
        'label': 'RPLP682/RPRP682',
        'members': ['RPLP682', 'RPRP682'],
        'sspec_filter': {'RMHX'},
        'bp_summary_dlcps': ['FF', 'UV', 'UX', 'UL'],
    },
    {
        'label': 'BTLS601/RPNS601/RPRS601',
        'members': ['BTLS601', 'RPNS601', 'RPRS601'],
        'sspec_filter': {'RN3J', 'RN3K', 'RMX0'},
        'bp_summary_dlcps': ['FF', 'UV', 'UX'],
    },
]

# ---------------------------------------------------------------------------
# M4G / PP-M4G operation group hover labels
# ---------------------------------------------------------------------------
# For prodgroup3 values M4G or PP-M4G, the Operation column on the main
# Assembly table (index.html) shows a hover tooltip identifying which
# assembly line the operation code belongs to. Operation codes are matched
# as strings with any trailing ".0" stripped (to match how they're displayed).
M4G_ASSEMBLY1_OPS: set[str] = {
    '1209', '1204', '5651', '2004', '1225', '1987', '2135', '730', '1429',
    '970', '1430', '1237', '1299', '5653', '2036', '1895', '2150', '2090',
    '1264', '1501', '2977', '1366', '2978', '4992', '265', '2171', '7666',
    '5001', '11', '6261', '6262', '6212', '7571', '3777', '7290', '5006',
}

M4G_ASSEMBLY2_OPS: set[str] = {
    '488', '2035', '700', '6445', '1867', '1525', '2975', '1031', '2976',
    '1975', '1535', '1976', '1286', '2237', '6437', '2037', '1545', '2139',
    '2133', '2633', '565', '2634', '6197', '6245', '9585', '8585', '6511',
    '7297', '7899', '7300', '1007', '6547', '1991', '8792', '7226', '7356',
    '7354', '7475', '7345', '7399',
}
