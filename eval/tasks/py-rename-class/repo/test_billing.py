import unittest

from billing import Invoice, summarize
from billing.report import merge


class BillingTest(unittest.TestCase):
    def test_total(self):
        self.assertEqual(Invoice([(2.5, 2), (1, 3)]).total(), 8)

    def test_merge(self):
        self.assertEqual(summarize(merge(Invoice([(1, 1)]), Invoice([(2, 1)]))), "2 lines, total 3.00")


if __name__ == "__main__":
    unittest.main()
