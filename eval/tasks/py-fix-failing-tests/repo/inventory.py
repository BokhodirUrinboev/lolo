class Item:
    def __init__(self, name, price, tags=[]):
        self.name = name
        self.price = price
        self.tags = tags

    def tag(self, label):
        self.tags.append(label)
        return self


def total_value(items):
    return round(sum(i.price for i in items), 2)


def cheapest(items):
    return max(items, key=lambda i: i.price) if items else None
