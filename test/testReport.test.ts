import { describe, expect, it } from "vitest";
import { failureReport, formatTestFailures, parseTestFailures } from "../src/tools/testReport";

describe("parseTestFailures", () => {
  it("node:test", () => {
    const out = `✖ adds (0.9ms)
✔ ok (0.1ms)
ℹ fail 1

✖ failing tests:

test at a.test.js:3:1
✖ adds (0.910372ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  2 !== 3
  
      at TestContext.<anonymous> (/ws/a.test.js:3:29)
      at Test.runInAsyncScope (node:async_hooks:227:14)
`;
    expect(parseTestFailures(out, "/ws")).toEqual([
      { name: "adds", file: "a.test.js", line: 3, message: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 2 !== 3" },
    ]);
  });

  it("unittest", () => {
    const out = `======================================================================
ERROR: test_b (test_t.T.test_b)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/ws/test_t.py", line 6, in test_b
    raise ValueError("boom")
ValueError: boom

======================================================================
FAIL: test_a (test_t.T.test_a)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/ws/test_t.py", line 4, in test_a
    self.assertEqual(1, 2)
AssertionError: 1 != 2

----------------------------------------------------------------------
Ran 2 tests in 0.001s

FAILED (failures=1, errors=1)`;
    expect(parseTestFailures(out, "/ws")).toEqual([
      { name: "test_b", file: "test_t.py", line: 6, message: "ValueError: boom" },
      { name: "test_a", file: "test_t.py", line: 4, message: "AssertionError: 1 != 2" },
    ]);
  });

  it("vitest", () => {
    const out = ` FAIL  test/cart.test.ts > Cart > applies discount
AssertionError: expected 90 to be 80 // Object.is equality
 ❯ test/cart.test.ts:12:25
     10|   const c = new Cart();
`;
    expect(parseTestFailures(out)).toEqual([
      { name: "Cart > applies discount", file: "test/cart.test.ts", line: 12, message: "AssertionError: expected 90 to be 80 // Object.is equality" },
    ]);
  });

  it("jest", () => {
    const out = `  ● Cart › applies discount

    expect(received).toBe(expected) // Object.is equality

    Expected: 80
    Received: 90

      at Object.<anonymous> (src/cart.test.js:12:25)
`;
    expect(parseTestFailures(out)).toEqual([{ name: "Cart › applies discount", file: "src/cart.test.js", line: 12, message: "expect(received).toBe(expected) // Object.is equality" }]);
  });

  it("pytest", () => {
    const out = `_______________________ test_median_even _______________________

    def test_median_even():
>       assert median([1, 2, 3, 4]) == 2.5
E       assert 2 == 2.5

tests/test_stats.py:8: AssertionError
=========================== short test summary info ============================
FAILED tests/test_stats.py::test_median_even - assert 2 == 2.5
`;
    expect(parseTestFailures(out)).toEqual([{ name: "test_median_even", file: "tests/test_stats.py", line: 8, message: "assert 2 == 2.5" }]);
  });

  it("dotnet test", () => {
    const out = `  Failed Shop.Tests.CartTests.Total [12 ms]
  Error Message:
   Assert.Equal() Failure
  Expected: 80
  Actual:   90
  Stack Trace:
     at Shop.Tests.CartTests.Total() in /ws/tests/CartTests.cs:line 42
`;
    expect(parseTestFailures(out, "/ws")).toEqual([
      { name: "Shop.Tests.CartTests.Total", file: "tests/CartTests.cs", line: 42, message: "Assert.Equal() Failure Expected: 80 Actual: 90" },
    ]);
  });

  it("cargo test", () => {
    const out = `---- tests::adds stdout ----
thread 'tests::adds' panicked at src/lib.rs:12:9:
assertion \`left == right\` failed
  left: 2
`;
    expect(parseTestFailures(out)).toEqual([{ name: "tests::adds", file: "src/lib.rs", line: 12, message: "assertion `left == right` failed" }]);
  });

  it("returns nothing for unrelated output", () => {
    expect(parseTestFailures("error CS1002: ; expected")).toEqual([]);
  });
});

describe("failureReport", () => {
  it("lists failures before a short log", () => {
    const report = failureReport("---- t stdout ----\nthread 't' panicked at src/a.rs:1:1:\nboom\n");
    expect(report).toMatch(/^Failing tests \(1\):\n1\. src\/a\.rs:1 t: boom/);
  });
  it("caps the list", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, message: "x" }));
    expect(formatTestFailures(many)).toContain("... and 2 more");
  });
});
