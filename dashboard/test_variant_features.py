import unittest
from variant_features import features, route_allowed

class VariantMatrix(unittest.TestCase):
    def test_all_four_variants(self):
        for n in (1, 2, 3, 4):
            f = features(n, native_windows=True)
            expected = n in (2, 4)
            self.assertFalse(f["features"]["ghost"])
            self.assertEqual(f["features"]["office"], expected)
            for key in ("memory", "repoql_dashboard", "kanban", "agent_chat", "tencent_connector", "repoql_mcp"):
                self.assertTrue(f["features"][key], (n, key))
            for path in ("/api/embed/office/handshake", "/embed/office/index.html", "/api/harness/office"):
                self.assertEqual(route_allowed(path,f), expected, (n, path))
            for path in ("/api/agentchat/feed", "/embed/kanzo/index.html", "/api/embed/kanzo/handshake", "/api/embed/repoql/handshake", "/api/connectors"):
                self.assertTrue(route_allowed(path, f), (n, path))
    def test_windows_requires_variant(self):
        with self.assertRaises(ValueError): features("", native_windows=True)
    def test_invalid_variant_refused(self):
        for value in ("0", "5", "garbage"):
            with self.assertRaises(ValueError): features(value, native_windows=True)
    def test_legacy_unchanged(self):
        self.assertTrue(features("", native_windows=False)["features"]["office"])
        self.assertFalse(features("", native_windows=False)["features"]["ghost"])

if __name__ == "__main__": unittest.main()
