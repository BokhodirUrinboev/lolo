import unittest

from inventory import Item, cheapest


class InventoryHiddenTest(unittest.TestCase):
    def test_hidden(self):
        Item("p", 1).tag("x")
        self.assertEqual(Item("q", 1).tags, [])
        self.assertIsNone(cheapest([]))
        self.assertEqual(cheapest([Item("m", 3), Item("n", 3.5)]).name, "m")
        own = ["keep"]
        self.assertEqual(Item("r", 1, own).tags, ["keep"])


if __name__ == "__main__":
    unittest.main()
