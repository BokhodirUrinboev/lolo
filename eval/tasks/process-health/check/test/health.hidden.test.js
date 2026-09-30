const test = require("node:test");
const assert = require("node:assert");
const { createServer } = require("../server");

async function get(path) {
  const s = createServer().listen(0);
  await new Promise((r) => s.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}${path}`);
    return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
  } finally {
    s.close();
  }
}

test("health", async () => {
  const r = await get("/health");
  assert.strictEqual(r.status, 200);
  assert.match(r.type ?? "", /application\/json/);
  assert.deepStrictEqual(JSON.parse(r.body), { status: "ok" });
  assert.strictEqual((await get("/hello")).body, "hello");
});
