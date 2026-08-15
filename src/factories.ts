import type { Address } from "./types.ts";

// Named factory presets for autoWatch.factories (PLAN.md §12). A config entry
// may be either a raw 0x address or a name in this registry — the hybrid
// approach: addresses work verbatim on any chain/fork, names stay portable
// across chains (same factory, different address per chain).

export const KNOWN_FACTORY_NAMES = ["uniswap-v2"] as const;

type FactoryName = (typeof KNOWN_FACTORY_NAMES)[number];

const REGISTRY: Record<FactoryName, Record<number, Address[]>> = {
  "uniswap-v2": {
    1: ["0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f"],
    56: ["0xca143ce32fe78f1f7019d7d551a6402fc5350c73"], // PancakeSwap V2 (same PairCreated ABI)
    8453: ["0x8909dc15e40173ff4699343b6eb8132c65e18ec6"], // Uniswap V2 on Base
  },
};

// Back-compat export: chainId → canonical Uniswap V2 factory addresses.
export const UNIV2_FACTORIES: Record<number, Address[]> = REGISTRY["uniswap-v2"];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isFactoryRef(s: string): boolean {
  return ADDRESS_RE.test(s) || (KNOWN_FACTORY_NAMES as readonly string[]).includes(s);
}

/** Resolve autoWatch.factories entries for one chain: raw addresses pass through
 *  (lowercased), known names expand to that chain's factory addresses. Unknown
 *  names are a config bug — fail loudly instead of silently watching nothing. */
export function resolveFactories(chainId: number, factories: string[]): Address[] {
  const out = new Set<Address>();
  for (const f of factories) {
    if (ADDRESS_RE.test(f)) {
      out.add(f.toLowerCase() as Address);
    } else if ((KNOWN_FACTORY_NAMES as readonly string[]).includes(f)) {
      for (const a of REGISTRY[f as FactoryName][chainId] ?? []) out.add(a);
    } else {
      throw new Error(`autoWatch.factories: unknown factory "${f}" (expected a 0x address or one of: ${KNOWN_FACTORY_NAMES.join(", ")})`);
    }
  }
  return [...out];
}
