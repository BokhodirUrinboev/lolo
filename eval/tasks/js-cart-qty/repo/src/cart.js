class Cart {
  constructor() {
    this.items = [];
  }

  add(name, price, qty = 1) {
    this.items.push({ name, price, qty });
  }

  total() {
    return this.items.reduce((sum, i) => sum + i.price, 0);
  }
}

module.exports = { Cart };
