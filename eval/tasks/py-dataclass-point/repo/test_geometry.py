import unittest

from geometry import Point


class PointTest(unittest.TestCase):
    def test_distance(self):
        self.assertEqual(Point(0, 0).distance_to(Point(3, 4)), 5)


if __name__ == "__main__":
    unittest.main()
