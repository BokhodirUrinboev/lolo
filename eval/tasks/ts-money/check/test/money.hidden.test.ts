import test from "node:test";
import assert from "node:assert";
import { add, money } from "../src/money.ts";

test("refuses to mix currencies", () => {
  assert.throws(() => add(money(1, "EUR"), money(1, "USD")), /currency mismatch/);
  assert.deepStrictEqual(add(money(1, "USD"), money(2, "USD")), money(3, "USD"));
});
