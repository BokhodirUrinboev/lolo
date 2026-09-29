import unittest

from billing.report import line


class ReportTest(unittest.TestCase):
    def test_line(self):
        self.assertEqual(line("pen", 250), "pen: $2.50")


if __name__ == "__main__":
    unittest.main()
