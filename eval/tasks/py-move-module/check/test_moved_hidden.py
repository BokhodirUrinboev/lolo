import unittest

from billing.money.format import fmt_money
from billing.report import line


class MovedTest(unittest.TestCase):
    def test_moved(self):
        self.assertEqual(fmt_money(5), "$0.05")
        self.assertEqual(line("ink", 1000), "ink: $10.00")


if __name__ == "__main__":
    unittest.main()
