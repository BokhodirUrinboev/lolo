class Stack {
  constructor() {
    this.items = [];
  }

  push(x) {
    this.items.push(x);
    return this.items.length;
  }

  pop() {
    return this.items.shift();
  }

  peek() {
    return this.items[0];
  }

  get size() {
    return this.items.length;
  }
}

module.exports = { Stack };
