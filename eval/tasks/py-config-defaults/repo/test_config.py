import json
import os
import tempfile
import unittest

from config import load_config


class ConfigTest(unittest.TestCase):
    def test_reads_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "c.json")
            with open(p, "w") as f:
                json.dump({"port": 9000}, f)
            self.assertEqual(load_config(p)["port"], 9000)


if __name__ == "__main__":
    unittest.main()
