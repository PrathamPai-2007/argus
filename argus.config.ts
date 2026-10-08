// Argus configuration. Secrets live in .env and are referenced as ${VAR};
// ${VAR:-default} supplies a fallback, and an endpoint whose variable is unset
// is simply skipped. Everything below except `chains` is optional.
export default {
  chains: [
    {
      chainId: 1,
      // HTTP endpoints in priority order. PublicNode batches 500 calls and serves
      // ~9k blocks of logs keyless; dRPC is a rate-limited fallback.
      http: ["${RPC_ETH_HTTP}", "https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
      ws: ["${RPC_ETH_WS}", "${RPC_ETH_MAINNET}", "wss://ethereum-rpc.publicnode.com"],
    },
    {
      chainId: 8453,
      http: ["${RPC_BASE_HTTP}", "https://base-rpc.publicnode.com", "https://base.drpc.org"],
      ws: ["${RPC_BASE_WS}", "wss://base-rpc.publicnode.com"],
    },
  ],

  // Tokens to watch forever, regardless of discovery.
  watchlist: [
    // { chainId: 8453, address: "0x..." },
  ],

  // New V2/V3 pools against WETH/stablecoins are watched from their first block.
  discovery: { newPools: true, watchHours: 6, maxWatchHours: 48, maxWatchedPerChain: 400, baselineLiquidityUsd: 10_000 },

  // Signal thresholds: any key from DEFAULT_SIGNALS in src/signals.ts can be overridden here.
  signals: {
    alertScore: 60,
    highConvictionScore: 80,
    minLiquidityUsd: 10_000,
  },

  // A wallet counts as "smart money" after this realized track record on watched tokens.
  smartMoney: { minClosedTrades: 5, minWinRate: 0.55, minPnlUsd: 0 },

  alerts: { cooldownMinutes: 30, rescoreDelta: 10, maxPerHour: 30 },

  dashboard: { port: 3737 },

  // Outbound webhooks (Discord/Slack/n8n/your server). Private, loopback and
  // metadata targets are rejected; `secret` signs bodies as x-argus-signature.
  webhooks: [
    // { url: "${ARGUS_WEBHOOK_URL}", events: ["alert", "exit"], secret: "${ARGUS_WEBHOOK_SECRET}" },
  ],

  retention: { eventDays: 3 },

  dbPath: "data/argus.db",
};
