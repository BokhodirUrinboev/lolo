class Invoice:
    def __init__(self, lines):
        self.lines = list(lines)

    def total(self):
        return sum(price * qty for price, qty in self.lines)
