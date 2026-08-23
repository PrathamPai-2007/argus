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
  { address: "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad", chainId: 1, label: "Uniswap Universal Router 1", kind: "router" },
  { address: "0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b", chainId: 1, label: "Uniswap Universal Router 2", kind: "router" },
  { address: "0x66a9893cc07d91d95644aedd05d03f95e1dba9cf", chainId: 1, label: "Uniswap Universal Router 3", kind: "router" },
  // Seaport
  { address: "0x0000000000001ff3684f28c67538d4d072c22734", chainId: 1, label: "Seaport 1.5", kind: "router" },
  { address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", chainId: 1, label: "Seaport 1.1", kind: "router" },
  { address: "0x00000000000001ad428e4906ae43d8f9852d0dd6", chainId: 1, label: "Seaport 1.4", kind: "router" },
  { address: "0x0000000000000068f116a894984e2db1123eb395", chainId: 1, label: "Seaport 1.6", kind: "router" },
  // WETH
  { address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", chainId: 1, label: "WETH", kind: "generic" },
  // MEV Builders
  { address: "0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97", chainId: 1, label: "Titan Builder", kind: "router" },
  { address: "0x95222290dd7278aa3ddd389cc1e1d165cc4bafe5", chainId: 1, label: "BeaverBuilder", kind: "router" },
  { address: "0xdafea492d9c6733ae3d56b7ed1adb60692c98bc5", chainId: 1, label: "Flashbots Builder", kind: "router" },
  { address: "0x690b9a9e9aa1c9db991c7721a92d351db4fac990", chainId: 1, label: "Builder0x69", kind: "router" },
  // Binance hot wallets
  { address: "0x28c6c06298d514db089934071355e5743bf21d60", chainId: 1, label: "Binance 14", kind: "cex" },
  { address: "0x21a31ee1afc51d94c2efccaa2092ad1028285549", chainId: 1, label: "Binance 15", kind: "cex" },
  { address: "0xdfd5293d8e347dfe59e90efd55b2956a1343963d", chainId: 1, label: "Binance 16", kind: "cex" },
  { address: "0x56eddb7aa875093c78448023cf57956b7838df74", chainId: 1, label: "Binance 8", kind: "cex" },
  { address: "0x9696e0d4f6d7e70e91a5f1f72be7e4d0cfb9a56b", chainId: 1, label: "Binance 7", kind: "cex" },
  { address: "0xf977814e90da44bfa03b6295a0616a897441acec", chainId: 1, label: "Binance 8", kind: "cex" },
  { address: "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be", chainId: 1, label: "Binance 1", kind: "cex" },
  { address: "0xd551234ae421e3bcba99a0da6d736074f22192ff", chainId: 1, label: "Binance", kind: "cex" },
  { address: "0x5a52e96bacdabb82fd05763e25335261b921ef3e", chainId: 1, label: "Binance 17", kind: "cex" },
  // Coinbase
  { address: "0x71660c4005ba85c37ccec55d0c4493e66fe775d3", chainId: 1, label: "Coinbase 1", kind: "cex" },
  { address: "0x503828976d22510aad0201ac7ec88293211d23da", chainId: 1, label: "Coinbase 2", kind: "cex" },
  { address: "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43", chainId: 1, label: "Coinbase 10", kind: "cex" },
  { address: "0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740", chainId: 1, label: "Coinbase 6", kind: "cex" },
  { address: "0x3cd751e6b0078be393132286c442345e5dc49699", chainId: 1, label: "Coinbase 3", kind: "cex" },
  { address: "0xb5d85cbf7cb3ee0e56b3bb207d5fc4b82f43f511", chainId: 1, label: "Coinbase 4", kind: "cex" },
  // Kraken
  { address: "0x2910543af39aba0cd09dbb2d50200b3e800a63d2", chainId: 1, label: "Kraken 6", kind: "cex" },
  { address: "0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13", chainId: 1, label: "Kraken 13", kind: "cex" },
  { address: "0xe853c56864a2ebe4576a807d26fdc4a0ada51919", chainId: 1, label: "Kraken 5", kind: "cex" },
  // OKX
  { address: "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b", chainId: 1, label: "OKX 1", kind: "cex" },
  { address: "0xa7efae728d2936e78bda97dc267687568dd593f3", chainId: 1, label: "OKX 2", kind: "cex" },
  // Bybit
  { address: "0xf89d7b9c864f589bbf53a82105107622b35eaa40", chainId: 1, label: "Bybit 1", kind: "cex" },
  { address: "0x1db3439a222c519ab44bb1144fc28167b4fa6ee6", chainId: 1, label: "Bybit 2", kind: "cex" },
  // KuCoin
  { address: "0x163a35cf50519ef47beea49e4d5fbfa41db64223", chainId: 1, label: "KuCoin 1", kind: "cex" },
  { address: "0x2b5634c42055806a59e9107ed44d43c426e58258", chainId: 1, label: "KuCoin 2", kind: "cex" },
  // Gate.io
  { address: "0x0d0707963952f2fba59dd06f2b425ace40b492fe", chainId: 1, label: "Gate.io 1", kind: "cex" },
  { address: "0x1c76a31d67708574b6002f23fb940eb0f61ef56b", chainId: 1, label: "Gate.io 2", kind: "cex" },
  // MEXC
  { address: "0x75e89d5979e4f6fba9f97c104c2f0afb3f1dcb88", chainId: 1, label: "MEXC 1", kind: "cex" },
  { address: "0x3cc936b795a188f0e246cbb2d74c5bd190aecf18", chainId: 1, label: "MEXC 2", kind: "cex" },
  // Crypto.com
  { address: "0x6262998ced04146fa42253a5c0af90ca02dfd2a3", chainId: 1, label: "Crypto.com 1", kind: "cex" },
  { address: "0x72a53cdd6e254d29fe1b326a6552044812328ff9", chainId: 1, label: "Crypto.com 2", kind: "cex" },
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
