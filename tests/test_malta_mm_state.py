import copy
import importlib.util
import unittest
from pathlib import Path

SERVER_PATH = Path(__file__).parents[1] / "boltable-backend" / "server.py"
SPEC = importlib.util.spec_from_file_location("malta_mm_server", SERVER_PATH)
server = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(server)


class StateMergeTests(unittest.TestCase):
    def setUp(self):
        self.state = copy.deepcopy(server.EMPTY_STATE)

    def test_merges_fields_without_overwriting_other_fields(self):
        server.apply_deltas(
            self.state,
            {"entries": {"Alena||Bolt Plus": {"notes": "First", "forecast": "Green"}}},
        )
        server.apply_deltas(
            self.state,
            {"entries": {"Alena||Bolt Plus": {"notes": "Updated"}}},
        )

        self.assertEqual(
            self.state["entries"]["Alena||Bolt Plus"],
            {"notes": "Updated", "forecast": "Green"},
        )

    def test_supports_provider_next_steps_and_deletions(self):
        key = "next||Sponsored Listings||123"
        server.apply_deltas(self.state, {"next_steps": {key: "Call Friday"}})
        self.assertEqual(self.state["next_steps"][key], "Call Friday")

        server.apply_deltas(self.state, {"next_steps": {key: None}})
        self.assertNotIn(key, self.state["next_steps"])

    def test_local_migration_never_overwrites_shared_values(self):
        self.state["entries"]["Rico||Smart Promotions"] = {"notes": "Shared"}
        applied = server.apply_deltas(
            self.state,
            {
                "entries": {
                    "Rico||Smart Promotions": {"notes": "Old browser"},
                    "Fiona||Smart Promotions": {"notes": "Local only"},
                }
            },
            missing_only=True,
        )

        self.assertEqual(applied, 1)
        self.assertEqual(self.state["entries"]["Rico||Smart Promotions"]["notes"], "Shared")
        self.assertEqual(self.state["entries"]["Fiona||Smart Promotions"]["notes"], "Local only")


if __name__ == "__main__":
    unittest.main()
