import { describe, expect, test } from "bun:test";
import { isFactoryRef, resolveFactories } from "../src/factories.ts";

const V2_ETH = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const V2_BASE = "0x8909dc15e40173ff4699343b6eb8132c65e18ec6";

describe("resolveFactories", () => {
  test("resolves a known name per chain", () => {
    expect(resolveFactories(1, ["uniswap-v2"])).toEqual([V2_ETH]);
    expect(resolveFactories(8453, ["uniswap-v2"])).toEqual([V2_BASE]);
  });

  test("passes raw addresses through lowercased", () => {
    expect(resolveFactories(1, ["0x" + "ab".repeat(19) + "CD"])).toEqual(["0x" + "ab".repeat(19) + "cd"]);
  });

  test("combines names and addresses without duplicates", () => {
    const res = resolveFactories(1, ["uniswap-v2", "0x" + V2_ETH.slice(2).toUpperCase()]);
    expect(res).toEqual([V2_ETH]);
  });

  test("known name on a chain without an entry resolves to nothing", () => {
    expect(resolveFactories(999, ["uniswap-v2"])).toEqual([]);
  });

  test("unknown name fails loudly", () => {
    expect(() => resolveFactories(1, ["nope-factory"])).toThrow(/unknown factory/);
  });
});

describe("isFactoryRef", () => {
  test("accepts addresses and known names", () => {
    expect(isFactoryRef(V2_ETH)).toBe(true);
    expect(isFactoryRef("uniswap-v2")).toBe(true);
  });

  test("rejects garbage", () => {
    expect(isFactoryRef("unicorn")).toBe(false);
    expect(isFactoryRef("0xzz")).toBe(false);
    expect(isFactoryRef("")).toBe(false);
  });
});
