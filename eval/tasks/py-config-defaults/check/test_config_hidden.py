import json
import os
import tempfile
import unittest

import config


class HiddenConfigTest(unittest.TestCase):
    def test_merge_and_missing(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "c.json")
            with open(p, "w") as f:
                json.dump({"debug": True}, f)
            self.assertEqual(config.load_config(p), {"debug": True, "port": 8080, "host": "127.0.0.1"})
            self.assertEqual(config.load_config(os.path.join(d, "missing.json")), {"debug": False, "port": 8080, "host": "127.0.0.1"})
            self.assertEqual(config.DEFAULTS["debug"], False)


if __name__ == "__main__":
    unittest.main()
