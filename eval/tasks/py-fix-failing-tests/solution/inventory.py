class Item:
    def __init__(self, name, price, tags=None):
        self.name = name
        self.price = price
        self.tags = list(tags) if tags is not None else []

    def tag(self, label):
        self.tags.append(label)
        return self


def total_value(items):
    return round(sum(i.price for i in items), 2)


def cheapest(items):
    return min(items, key=lambda i: i.price) if items else None
