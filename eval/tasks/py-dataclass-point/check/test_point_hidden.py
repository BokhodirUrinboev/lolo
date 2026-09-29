import dataclasses
import unittest

from geometry import Point


class PointHiddenTest(unittest.TestCase):
    def test_dataclass(self):
        self.assertTrue(dataclasses.is_dataclass(Point))
        self.assertEqual(Point(1, 2), Point(1, 2))
        self.assertNotEqual(Point(1, 2), Point(2, 1))
        self.assertEqual(repr(Point(1, 2)), "Point(x=1, y=2)")
        self.assertEqual(Point(1, 1).distance_to(Point(4, 5)), 5)


if __name__ == "__main__":
    unittest.main()
