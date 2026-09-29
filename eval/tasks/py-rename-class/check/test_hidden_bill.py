import unittest

import billing
from billing.report import merge


class HiddenBillTest(unittest.TestCase):
    def test_renamed(self):
        self.assertTrue(hasattr(billing, "Bill"))
        self.assertFalse(hasattr(billing, "Invoice"))
        self.assertEqual(merge(billing.Bill([(1, 2)]), billing.Bill([(3, 1)])).total(), 5)


if __name__ == "__main__":
    unittest.main()
