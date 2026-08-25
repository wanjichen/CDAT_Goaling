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

# ---------------------------------------------------------------------------
# OLB goal-factor configuration
# ---------------------------------------------------------------------------
# DT and PCH products use OLB_GOAL_FACTOR_DT (0.8).
# All other (Mobile / non-DT / non-PCH) products use OLB_GOAL_FACTOR_NON_DT (0.8 * 0.8 = 0.64).
# prodgroup3 IN DT_PRODUCTS or PCH_PRODUCTS
OLB_GOAL_FACTOR_DT: float = 0.8
# prodgroup3 NOT IN DT_PRODUCTS or PCH_PRODUCTS (0.64)
OLB_GOAL_FACTOR_NON_DT: float = 0.8 * 0.8


def is_dt_product(prodgroup3: str) -> bool:
    """Return True if the given prodgroup3 belongs to the DT product family."""
    return prodgroup3 in DT_PRODUCTS


def is_pch_product(prodgroup3: str) -> bool:
    """Return True if the given prodgroup3 belongs to the PCH product family."""
    return prodgroup3 in PCH_PRODUCTS


def get_olb_goal_factor(prodgroup3: str) -> float:
    """Return the OLB goal factor for a given prodgroup3.

    DT and PCH products use OLB_GOAL_FACTOR_DT; everything else uses
    OLB_GOAL_FACTOR_NON_DT.
    """
    if is_dt_product(prodgroup3) or is_pch_product(prodgroup3):
        return OLB_GOAL_FACTOR_DT
    return OLB_GOAL_FACTOR_NON_DT


# ---------------------------------------------------------------------------
# Product family classification (for grouping/reporting purposes)
# ---------------------------------------------------------------------------
FAMILY_DT = 'DT Products'
FAMILY_PCH = 'PCH Products'
FAMILY_MOBILE = 'Mobile Products'

# Display order used by any UI that groups rows by product family.
PRODUCT_FAMILY_ORDER = [FAMILY_DT, FAMILY_PCH, FAMILY_MOBILE]


def get_product_family(prodgroup3: str) -> str:
    """Return the product family label for a given prodgroup3.

    - DT_PRODUCTS -> 'DT Products'
    - PCH_PRODUCTS -> 'PCH Products'
    - everything else -> 'Mobile Products'
    """
    if is_dt_product(prodgroup3):
        return FAMILY_DT
    if is_pch_product(prodgroup3):
        return FAMILY_PCH
    return FAMILY_MOBILE
