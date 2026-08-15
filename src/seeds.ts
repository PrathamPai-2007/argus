import { insertLabel, loadLabels } from "./db.ts";
import { log } from "./logger.ts";

/**
 * Starter label set (PLAN.md §6): known CEX hot wallets, batch senders, routers.
 * Extend at runtime via the `labels` table — seeds only fill gaps.
 * chainId 1 = Ethereum mainnet.
 */
const SEEDS: Array<{ address: string; chainId: number; label: string; kind: string }> = [
  // Batch-sender / disperse contracts
  { address: "0xd152f549545093347a162dce210e7293f1452150", chainId: 1, label: "Disperse.app", kind: "disperse" },
  // Uniswap infrastructure
  { address: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f", chainId: 1, label: "Uniswap V2 Factory", kind: "router" },
  { address: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d", chainId: 1, label: "Uniswap V2 Router", kind: "router" },
  { address: "0x1f98431c8ad98523631ae4a59f267346ea31f984", chainId: 1, label: "Uniswap V3 Factory", kind: "router" },
  { address: "0xe592427a0aece92de3edee1f18e0157c05861564", chainId: 1, label: "Uniswap V3 Router", kind: "router" },
  // Binance hot wallets
  { address: "0x28c6c06298d514db089934071355e5743bf21d60", chainId: 1, label: "Binance 14", kind: "cex" },
  { address: "0x21a31ee1afc51d94c2efccaa2092ad1028285549", chainId: 1, label: "Binance 15", kind: "cex" },
  { address: "0xdfd5293d8e347dfe59e90efd55b2956a1343963d", chainId: 1, label: "Binance 16", kind: "cex" },
  { address: "0x56eddb7aa875093c78448023cf57956b7838df74", chainId: 1, label: "Binance 8", kind: "cex" },
  { address: "0x9696e0d4f6d7e70e91a5f1f72be7e4d0cfb9a56b", chainId: 1, label: "Binance 7", kind: "cex" },
  // Coinbase
  { address: "0x71660c4005ba85c37ccec55d0c4493e66fe775d3", chainId: 1, label: "Coinbase 1", kind: "cex" },
  { address: "0x503828976d22510aad0201ac7ec88293211d23da", chainId: 1, label: "Coinbase 2", kind: "cex" },
  { address: "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43", chainId: 1, label: "Coinbase 10", kind: "cex" },
  // Kraken
  { address: "0x2910543af39aba0cd09dbb2d50200b3e800a63d2", chainId: 1, label: "Kraken 6", kind: "cex" },
  { address: "0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13", chainId: 1, label: "Kraken 13", kind: "cex" },
  // OKX
  { address: "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b", chainId: 1, label: "OKX 1", kind: "cex" },
  // Bitfinex
  { address: "0x77134cbc06cb00b66f4c7e623d5fdbf6777635ec", chainId: 1, label: "Bitfinex 1", kind: "cex" },
  // ---- BNB Chain (chainId 56) ----
  { address: "0xca143ce32fe78f1f7019d7d551a6402fc5350c73", chainId: 56, label: "PancakeSwap V2 Factory", kind: "router" },
  { address: "0x10ed43c718714eb63d5aa57b78b54704e256024e", chainId: 56, label: "PancakeSwap V2 Router", kind: "router" },
  { address: "0xd152f549545093347a162dce210e7293f1452150", chainId: 56, label: "Disperse.app", kind: "disperse" },
  { address: "0x8894e0a0c962cb723c1976a4421c95949be2d4e3", chainId: 56, label: "Binance (BNB chain)", kind: "cex" },
  { address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", chainId: 56, label: "BNB USDC", kind: "generic" },
  // ---- Base (chainId 8453) ----
  { address: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6", chainId: 8453, label: "Uniswap V2 Factory (Base)", kind: "router" },
  { address: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24", chainId: 8453, label: "Uniswap V2 Router (Base)", kind: "router" },
  { address: "0xd152f549545093347a162dce210e7293f1452150", chainId: 8453, label: "Disperse.app", kind: "disperse" },
  { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", chainId: 8453, label: "Base USDC", kind: "generic" },
];

export function seedLabels(chainIds: number[]): void {
  const existing = new Set(chainIds.flatMap((id) => [...loadLabels(id).keys()].map((a) => `${id}:${a}`)));
  let added = 0;
  for (const s of SEEDS) {
    if (existing.has(`${s.chainId}:${s.address}`)) continue;
    insertLabel(s.address, s.chainId, s.label, s.kind);
    added++;
  }
  if (added > 0) log.info("seeded labels", { added });
}
