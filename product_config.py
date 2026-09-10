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
}

# prodgroup3 values that belong to the PCH product family.
# These also use OLB_GOAL_FACTOR_DT (0.8), same as DT_PRODUCTS.
PCH_PRODUCTS: set[str] = {
    'ADP',
    'ADPIOT',
    'MTP',
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
