import unittest

from inventory import Item, cheapest, total_value


class InventoryTest(unittest.TestCase):
    def test_tags_are_per_item(self):
        a = Item("a", 1).tag("new")
        b = Item("b", 2)
        self.assertEqual(a.tags, ["new"])
        self.assertEqual(b.tags, [])

    def test_cheapest(self):
        self.assertEqual(cheapest([Item("x", 5), Item("y", 2), Item("z", 9)]).name, "y")

    def test_total(self):
        self.assertEqual(total_value([Item("x", 0.1), Item("y", 0.2)]), 0.3)


if __name__ == "__main__":
    unittest.main()
