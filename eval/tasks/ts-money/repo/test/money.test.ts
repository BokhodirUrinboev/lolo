import test from "node:test";
import assert from "node:assert";
import { add, money } from "../src/money.ts";

test("adds amounts of one currency", () => {
  assert.deepStrictEqual(add(money(1.5, "EUR"), money(2, "EUR")), money(3.5, "EUR"));
});
