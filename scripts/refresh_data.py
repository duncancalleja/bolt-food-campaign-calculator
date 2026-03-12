#!/usr/bin/env python3
"""
Refresh Calculator Data from Databricks
Pulls 12 months of Malta food provider + campaign data and updates
campaign-cost-calculator.html with fresh embedded data.

Usage:
    python3 refresh_calculator.py

Requires:
    - databricks-sql-connector (pip install databricks-sql-connector)
    - pandas
    - ~/.databricks_token or DATABRICKS_TOKEN env var
"""

import sys, os, re
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'databricks-setup'))
from dbx import DBX
import pandas as pd

CALC_FILE = os.path.join(os.path.dirname(__file__), 'campaign-cost-calculator.html')
DASH_FILE = os.path.join(os.path.dirname(__file__), 'am-spend-dashboard.html')
TODAY = date.today().isoformat()


def pull_providers(dbx):
    print("  Pulling provider dimension...")
    return dbx.query("""
        SELECT provider_id, provider_name, vendor_id, vendor_name, brand_name, group_name,
               account_manager_name, business_segment_v2, business_subsegment_v2,
               provider_status, provider_rating, is_bolt_plus_enrolled_provider,
               regular_commission_rate
        FROM ng_delivery_spark.dim_provider_v2
        WHERE country_code = 'mt' AND delivery_vertical = 'food'
    """)


def pull_order_stats(dbx):
    print("  Pulling 12-month order stats...")
    return dbx.query("""
        SELECT
            provider_id,
            COUNT(order_id) AS total_orders,
            ROUND(SUM(gmv_eur), 2) AS total_gmv,
            ROUND(AVG(gmv_eur), 2) AS avg_aov
        FROM ng_public_spark.etl_delivery_order_monetary_metrics
        WHERE country = 'mt'
          AND order_created_date >= DATE_FORMAT(DATE_SUB(CURRENT_DATE(), 365), 'yyyy-MM-dd')
          AND is_bolt_market = false
        GROUP BY provider_id
    """)


def pull_campaign_spend(dbx):
    print("  Pulling 12-month campaign spend...")
    return dbx.query("""
        SELECT
            provider_id,
            ROUND(SUM(CAST(bolt_spend AS DOUBLE)), 2) AS bolt_spend,
            ROUND(SUM(CAST(provider_spend AS DOUBLE)), 2) AS provider_spend
        FROM ng_public_spark.etl_delivery_campaign_order_metrics
        WHERE country = 'mt'
          AND order_created_date >= DATE_SUB(CURRENT_DATE(), 365)
        GROUP BY provider_id
    """)


def seg_code(s):
    if pd.isna(s):
        return 'S'
    s = str(s).lower()
    if 'enterprise' in s:
        return 'E'
    if 'mid' in s:
        return 'M'
    return 'S'


def generate_embedded_js(providers, orders, camp_spend):
    merged = providers.merge(orders, on='provider_id', how='left')
    merged = merged.merge(camp_spend, on='provider_id', how='left')
    merged['bolt_spend'] = merged['bolt_spend'].fillna(0)
    merged['provider_spend'] = merged['provider_spend'].fillna(0)
    merged['total_orders'] = merged['total_orders'].fillna(0).astype(int)
    merged['total_gmv'] = merged['total_gmv'].fillna(0)
    merged['avg_aov'] = merged['avg_aov'].fillna(0)
    merged['seg_code'] = merged['business_segment_v2'].apply(seg_code)

    active = merged[(merged['total_orders'] > 0) | (merged['provider_status'] == 'active')].copy()
    active = active.sort_values('total_gmv', ascending=False)

    lines = []
    for _, r in active.iterrows():
        name = str(r['provider_name']).replace("'", "\\'")
        pid = int(r['provider_id'])
        seg = r['seg_code']
        ords = int(r['total_orders'])
        gmv = round(float(r['total_gmv']), 2)
        aov = round(float(r['avg_aov']), 2)
        comm = round(float(r['regular_commission_rate']), 1) if pd.notna(r['regular_commission_rate']) else 0
        cb = int(round(float(r['bolt_spend']), 0))
        cm = int(round(float(r['provider_spend']), 0))
        vid = int(r['vendor_id']) if pd.notna(r['vendor_id']) else pid
        vname = str(r['vendor_name']).replace("'", "\\'") if pd.notna(r['vendor_name']) else ''
        lines.append(f"['{name}',{pid},'{seg}',{ords},{gmv},{aov},{comm},{cb},{cm},{vid},'{vname}']")

    js = "const _EMBEDDED_DATA = [\n" + ",\n".join(lines) + "\n];\nconst _EMBEDDED_WEEKS = 52;"
    return js, len(lines)


def update_html(new_js):
    with open(CALC_FILE, 'r') as f:
        html = f.read()

    pattern = r'// ─── Embedded Provider Data.*?\n(const _EMBEDDED_DATA = \[.*?\];)\nconst _EMBEDDED_WEEKS = \d+;'
    replacement = f'// ─── Embedded Provider Data (from Databricks — 12 months, refreshed {TODAY}) ───\n' + new_js
    new_html, count = re.subn(pattern, replacement, html, flags=re.DOTALL)

    if count == 0:
        pattern2 = r'const _EMBEDDED_DATA = \[.*?\];\nconst _EMBEDDED_WEEKS = \d+;'
        new_html, count = re.subn(pattern2, new_js, html, flags=re.DOTALL)

    if count == 0:
        raise RuntimeError("Could not find _EMBEDDED_DATA block in calculator HTML")

    date_pattern = r"const _DATA_REFRESHED = '[^']*';"
    if re.search(date_pattern, new_html):
        new_html = re.sub(date_pattern, f"const _DATA_REFRESHED = '{TODAY}';", new_html)
    else:
        new_html = new_html.replace(
            'const _EMBEDDED_WEEKS = 52;',
            f"const _EMBEDDED_WEEKS = 52;\nconst _DATA_REFRESHED = '{TODAY}';"
        )

    with open(CALC_FILE, 'w') as f:
        f.write(new_html)
    return count


def pull_weekly_actuals(dbx, weeks=8):
    print(f"  Pulling {weeks}-week actuals for accuracy tracker...")
    return dbx.query(f"""
        SELECT
            provider_id,
            WEEKOFYEAR(order_created_date) AS iso_week,
            YEAR(order_created_date) AS yr,
            ROUND(SUM(CAST(bolt_spend AS DOUBLE)), 2) AS bolt,
            ROUND(SUM(CAST(provider_spend AS DOUBLE)), 2) AS prov,
            ROUND(SUM(CAST(discount_value AS DOUBLE)), 2) AS total
        FROM ng_public_spark.etl_delivery_campaign_order_metrics
        WHERE country = 'mt'
          AND order_created_date >= DATE_SUB(CURRENT_DATE(), {weeks * 7})
          AND order_created_date < DATE_TRUNC('WEEK', CURRENT_DATE())
        GROUP BY provider_id, WEEKOFYEAR(order_created_date), YEAR(order_created_date)
    """)


def generate_actuals_js(actuals_df):
    data = {}
    for _, r in actuals_df.iterrows():
        wk = f"{int(r['yr'])}-W{int(r['iso_week'])}"
        pid = str(int(r['provider_id']))
        if wk not in data:
            data[wk] = {}
        data[wk][pid] = [round(r['bolt'], 2), round(r['prov'], 2), round(r['total'], 2)]

    lines = ["const _DBX_ACTUALS = {"]
    for wk in sorted(data.keys()):
        entries = ",".join(
            f"'{pid}':[{v[0]},{v[1]},{v[2]}]"
            for pid, v in sorted(data[wk].items(), key=lambda x: -x[1][2])
        )
        lines.append(f"'{wk}':{{{entries}}},")
    lines.append("};")
    return "\n".join(lines), len(data)


def generate_provider_lookup_js(providers, orders):
    merged = providers.merge(orders, on='provider_id', how='left')
    merged['total_orders'] = merged['total_orders'].fillna(0).astype(int)
    merged['total_gmv'] = merged['total_gmv'].fillna(0)
    merged['avg_aov'] = merged['avg_aov'].fillna(0)

    lines = []
    for _, r in merged.iterrows():
        pid = int(r['provider_id'])
        am = str(r['account_manager_name']).replace("'", "\\'") if pd.notna(r['account_manager_name']) else 'Unknown'
        ords = int(r['total_orders'])
        gmv = round(float(r['total_gmv']), 2)
        aov = round(float(r['avg_aov']), 2)
        seg = str(r['business_segment_v2']) if pd.notna(r['business_segment_v2']) else 'SMB'
        lines.append(f"'{pid}':['{am}',{ords},{gmv},{aov},'{seg}']")

    js = "const _PROVIDER_LOOKUP = {\n" + ",\n".join(lines) + "\n};"
    return js, len(lines)


def update_dashboard(actuals_js, provider_lookup_js=None):
    with open(DASH_FILE, 'r') as f:
        html = f.read()

    date_pat = r"const _DBX_ACTUALS_REFRESHED = '[^']*';"
    html = re.sub(date_pat, f"const _DBX_ACTUALS_REFRESHED = '{TODAY}';", html)

    actuals_pat = r'const _DBX_ACTUALS = \{.*?\};'
    new_html, count = re.subn(actuals_pat, actuals_js, html, flags=re.DOTALL)

    if count == 0:
        raise RuntimeError("Could not find _DBX_ACTUALS block in dashboard HTML")

    if provider_lookup_js:
        lookup_pat = r'const _PROVIDER_LOOKUP = \{.*?\};'
        new_html, lcount = re.subn(lookup_pat, provider_lookup_js, new_html, flags=re.DOTALL)
        if lcount == 0:
            raise RuntimeError("Could not find _PROVIDER_LOOKUP block in dashboard HTML")

        weeks_pat = r'const WEEKS_IN_DATA = \d+;'
        new_html = re.sub(weeks_pat, 'const WEEKS_IN_DATA = 52;', new_html)

    with open(DASH_FILE, 'w') as f:
        f.write(new_html)
    return count


def main():
    print(f"Refreshing data from Databricks ({TODAY})...")
    print("Connecting to Databricks...")

    with DBX() as dbx:
        providers = pull_providers(dbx)
        orders = pull_order_stats(dbx)
        camp_spend = pull_campaign_spend(dbx)
        weekly_actuals = pull_weekly_actuals(dbx)

    print(f"  Providers: {len(providers)}, With orders: {len(orders)}, Campaign records: {len(camp_spend)}")

    new_js, n_providers = generate_embedded_js(providers, orders, camp_spend)
    print(f"  Generated calculator data for {n_providers} providers")
    count = update_html(new_js)
    print(f"  Updated calculator ({count} replacement)")

    actuals_js, n_weeks = generate_actuals_js(weekly_actuals)
    print(f"  Generated actuals for {n_weeks} weeks")

    lookup_js, n_lookup = generate_provider_lookup_js(providers, orders)
    print(f"  Generated provider lookup for {n_lookup} providers (12-month data, WEEKS_IN_DATA=52)")

    count2 = update_dashboard(actuals_js, lookup_js)
    print(f"  Updated AM dashboard ({count2} replacement)")

    print(f"\nDone! Calculator: {n_providers} providers. Dashboard: {n_lookup} providers + {n_weeks} weeks of actuals.")
    print(f"Next step: push to GitHub")


if __name__ == '__main__':
    main()
