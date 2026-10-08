import assert from "node:assert/strict";
import test from "node:test";
import { mean, median } from "../src/stats.js";

test("mean averages the values", () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(mean([5]), 5);
});

test("median returns the middle value of an odd-length array", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([7]), 7);
});
