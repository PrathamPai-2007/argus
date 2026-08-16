import { describe, expect, test } from "bun:test";
import { formatLogTimestamp } from "../src/logger.ts";

describe("logger timestamps", () => {
  test("formats UTC with zero-padded 24-hour fields", () => {
    expect(formatLogTimestamp(new Date("2026-08-16T00:07:03.000Z"))).toBe("2026-08-16-00-07-03");
    expect(formatLogTimestamp(new Date("2026-08-16T23:59:59.000Z"))).toBe("2026-08-16-23-59-59");
  });
});
