import math
from dataclasses import dataclass


@dataclass
class Point:
    x: float
    y: float

    def distance_to(self, other):
        return math.hypot(self.x - other.x, self.y - other.y)
