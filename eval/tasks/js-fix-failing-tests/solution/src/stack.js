class Stack {
  constructor() {
    this.items = [];
  }

  push(x) {
    this.items.push(x);
    return this.items.length;
  }

  pop() {
    return this.items.pop();
  }

  peek() {
    return this.items[this.items.length - 1];
  }

  get size() {
    return this.items.length;
  }
}

module.exports = { Stack };
