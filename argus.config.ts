// Argus configuration — see README.md for usage. Secrets live in .env and are
// referenced here as ${VAR_NAME} placeholders.
export default {
  chains: [
    {
      chainId: 1,
      name: "ethereum",
      enabled: true,
      // Pool is used with automatic failover. Public endpoints work for dev;
      // put keyed endpoints in .env for production use.
      rpcs: ["${RPC_ETH_MAINNET}", "${RPC_ETH_BACKUP:-wss://ethereum-rpc.publicnode.com}"],
      httpRpcs: [process.env.RPC_ETH_HTTP ?? `https://rpc.ankr.com/eth/${process.env.ANKR_API_KEY ?? ""}`, process.env.RPC_ETH_BACKUP_HTTP ?? "https://ethereum-rpc.publicnode.com"],
      infuraRetryMinutes: 5,
      finalityDepth: 12,
      staleAfterMs: 30_000,
      backfill: {
        etherscan: { enabled: true, apiUrl: "https://api.etherscan.io/v2/api", apiKey: "${ETHERSCAN_API_KEY}", requestsPerSecond: 3 },
        bigquery: { enabled: false, projectId: null, credentialsPath: null, dataset: "bigquery-public-data.crypto_ethereum", maxBytesBilled: null },
        bigqueryThresholdHours: 6,
      },
    },
    // { chainId: 56, name: "bnb", enabled: false, rpcs: ["wss://..."], finalityDepth: 32, staleAfterMs: 9_000 },
    // { chainId: 8453, name: "base", enabled: false, rpcs: ["wss://..."], finalityDepth: 32, staleAfterMs: 6_000 },
  ],

  watchlist: [
    // { chainId: 1, address: "0x..." },
    // Tip for a smoke test: watch a high-velocity token like USDT
    // { chainId: 1, address: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
  ],

  autoWatch: { enabled: true, factories: ["uniswap-v2"], watchHours: 24 },

  // Candidates are evaluated with targeted history before they become live watches.
  candidateDiscovery: {
    enabled: true,
    maxCandidatesPerCycle: 10,
    evaluationMinutes: 15,
    candidateTtlHours: 24,
    promotionScore: 25,
    minimumLiquidityUsd: 5_000,
    minimumIndependentBuyers: 2,
  },

  // DexScreener stablecoin-quoted volume drives slow background enrichment.
  volumeRanking: { pollMinutes: 5, topN: 10, backfillHours: 1 },

  rules: {
    R1: { enabled: true, supplyPct: 8, windowHours: 4, walletAgeDays: 14, weight: 35 },
    R2: { enabled: true, volumeSpikePct: 150, windowMinutes: 30, weight: 25 },
    R3: { enabled: true, minRecipients: 5, windowMinutes: 30, weight: 30 },
    R4: { enabled: true, warnPct: 6, critPct: 12, critWeight: 45, weight: 30 },
    R5: { enabled: true, minBuyers: 3, walletAgeDays: 14, weight: 25 },
    R6: { enabled: true, maxHops: 3, minClusterPct: 0.5, weight: 50 },
    R7: { enabled: true, minLockedPct: 50, minPoolAgeHours: 24, weight: 20 },
    R8: { enabled: true, minWallets: 2, windowMinutes: 120, weight: 20 },
  },

  scoring: { info: 25, alert: 50, critical: 75, signalWindowHours: 6 },

  alerts: { telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID), cooldownMinutes: 15, escalationDelta: 10, maxAlertsPerMinute: 20 },

  dashboard: { port: 3737 },

  // Outbound webhooks: POST JSON to an HTTP(S) endpoint (Discord/Slack/n8n/your server).
  // Private, loopback, link-local, and metadata destinations are rejected by validation.
  // events: which payloads to send — "alert" (new alerts + reorg retractions) and/or "signal".
  // secret: optional; signs the body as x-argus-signature: sha256=<HMAC-SHA256 hex>. Keep in .env.
  webhooks: [
    // { url: "https://hooks.slack.com/services/T000/B000/XXX", events: ["alert"], secret: null, timeoutMs: 10_000, retries: 2 },
  ],

  retention: { eventDays: 7 },

  dbPath: "data/argus.db",
};
