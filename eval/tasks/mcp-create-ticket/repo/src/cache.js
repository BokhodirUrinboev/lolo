// TODO: expire entries after their ttl instead of keeping them forever
class Cache {
  constructor() {
    this.map = new Map();
  }

  set(key, value, ttlMs) {
    this.map.set(key, { value, ttlMs, at: Date.now() });
  }

  get(key) {
    return this.map.get(key)?.value;
  }
}

module.exports = { Cache };
