class Queue {
  constructor() {
    this.items = [];
  }

  enqueue(x) {
    this.items.push(x);
  }

  dequeue() {
    return this.items.shift();
  }

  peek() {
    return this.items[0];
  }

  get size() {
    return this.items.length;
  }
}

module.exports = { Queue };
