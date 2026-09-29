class Cart {
  constructor() {
    this.items = [];
  }

  add(name, price, qty = 1) {
    this.items.push({ name, price, qty });
  }

  total() {
    return this.items.reduce((sum, i) => sum + i.price * i.qty, 0);
  }

  applyDiscount(percent) {
    return this.total() - (this.total() * percent) / 100;
  }
}

module.exports = { Cart };
