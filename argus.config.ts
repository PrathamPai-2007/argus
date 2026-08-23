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
    maxCandidatesPerCycle: 25,
    evaluationMinutes: 30,
    candidateTtlHours: 24,
    promotionScore: 35,
    minimumLiquidityUsd: 10_000,
    minimumIndependentBuyers: 2,
  },

  // DexScreener stablecoin-quoted volume drives slow background enrichment.
  volumeRanking: { pollMinutes: 5, topN: 10, backfillHours: 1 },

  rules: {
    R1: { enabled: true, supplyPct: 15, windowHours: 2, walletAgeDays: 7, weight: 35 },
    R2: { enabled: true, volumeSpikePct: 300, windowMinutes: 15, weight: 25 },
    R3: { enabled: true, minRecipients: 10, windowMinutes: 15, weight: 30 },
    R4: { enabled: true, warnPct: 10, critPct: 20, critWeight: 45, weight: 30 },
    R5: { enabled: true, minBuyers: 5, walletAgeDays: 7, weight: 25 },
    R6: { enabled: true, maxHops: 2, minClusterPct: 1, weight: 50 },
    R7: { enabled: true, minLockedPct: 30, minPoolAgeHours: 48, weight: 20 },
    R8: { enabled: true, minWallets: 3, windowMinutes: 60, weight: 20 },
  },

  scoring: { info: 40, alert: 60, critical: 80, signalWindowHours: 6 },

  alerts: { telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID), cooldownMinutes: 30, escalationDelta: 20, maxAlertsPerMinute: 10 },

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
