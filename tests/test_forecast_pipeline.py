import importlib.util
import pathlib
import sys
import types
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class FakeFrame:
    def __init__(self, rows):
        self.rows = rows

    def iterrows(self):
        return enumerate(self.rows)


def load_refresh_module():
    pandas = types.ModuleType("pandas")
    pandas.notna = lambda value: value is not None
    sys.modules.setdefault("pandas", pandas)
    dbx = types.ModuleType("dbx")
    dbx.DBX = object
    sys.modules.setdefault("dbx", dbx)
    spec = importlib.util.spec_from_file_location(
        "refresh_data_for_test", ROOT / "scripts" / "refresh_data.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CampHistoryTests(unittest.TestCase):
    def test_writer_emits_campaign_orders_and_redemption(self):
        refresh = load_refresh_module()
        history_rows = FakeFrame([
            {
                "provider_id": 42,
                "camp_cat": "md",
                "name": "20% Menu Discount",
                "yr": 2026,
                "iso_week": 30,
                "bolt": 30,
                "prov": 70,
                "total": 100,
                "order_count": 10,
                "avg_disc": 10,
            },
            {
                "provider_id": 42,
                "camp_cat": "md",
                "name": "20% Menu Discount",
                "yr": 2026,
                "iso_week": 31,
                "bolt": 36,
                "prov": 84,
                "total": 120,
                "order_count": 10,
                "avg_disc": 12,
            },
        ])
        provider_orders = FakeFrame([
            {"provider_id": 42, "total_orders": 160, "active_weeks": 8}
        ])

        tier = refresh.build_camp_history(history_rows, provider_orders)["42"]["md_20"]

        self.assertEqual(len(tier), 9)
        self.assertEqual(tier[7], 10)
        self.assertEqual(tier[8], 0.5)


class LearnedCorrectionTests(unittest.TestCase):
    def test_bolt_and_total_ratios_are_learned_separately(self):
        from scripts.learn_from_snapshots import build_corrections

        snapshots = [{
            "date": "2026-03-02",
            "isoWeek": 10,
            "campaigns": [{
                "pid": "42",
                "type": "Menu Discount",
                "estTotal": 100,
                "estBolt": 50,
                "estProv": 50,
            }],
        }]
        actuals = {
            "2026-W10": {"42": {"md": [60, 40, 100]}}
        }

        corrections = build_corrections("mt", snapshots, actuals)

        self.assertEqual(corrections["portfolio"]["bolt_ratio"], 1.2)
        self.assertEqual(corrections["portfolio"]["total_ratio"], 1.0)
        self.assertEqual(corrections["by_provider"]["42"]["bolt_ratio"], 1.2)
        self.assertEqual(corrections["by_provider"]["42"]["total_ratio"], 1.0)
        self.assertEqual(corrections["by_category"]["md"]["bolt_ratio"], 1.2)
        self.assertEqual(corrections["by_category"]["md"]["total_ratio"], 1.0)


if __name__ == "__main__":
    unittest.main()
