import { createPublicClient, http, webSocket, type PublicClient, type Transport } from "viem";
import { redactUrl } from "../logger.ts";

// Endpoint probing shared by the EVM adapter and the `doctor` CLI (PLAN.md §11.4).

export interface EndpointProbe {
  url: string;
  reachable: boolean;
  blockNumber: number | null;
  latencyMs: number | null;
  tracesAvailable: boolean | null;
  error: string | null;
}

export function buildClient(url: string): PublicClient {
  const transport: Transport = /^wss?:\/\//.test(url)
    ? webSocket(url, { retryCount: 0, timeout: 15_000 })
    : http(url, { retryCount: 0, timeout: 15_000 });
  return createPublicClient({ transport });
}

/** Probe debug_traceTransaction / trace_transaction support with a dummy hash. */
export async function probeTraceCapability(client: PublicClient): Promise<boolean> {
  const dummy = "0x0000000000000000000000000000000000000000000000000000000000000001";
  for (const method of ["debug_traceTransaction", "trace_transaction"]) {
    try {
      await client.request({ method, params: [dummy] } as never);
      return true;
    } catch (err) {
      const msg = String(err).toLowerCase();
      if (msg.includes("method") && (msg.includes("not found") || msg.includes("does not exist") || msg.includes("not supported") || msg.includes("unsupported") || msg.includes("not available") || msg.includes("missing"))) {
        continue; // method doesn't exist
      }
      // Only method-level validation errors prove the method exists. Auth,
      // timeout, and rate-limit failures are not capability evidence.
      if (msg.includes("transaction not found") || msg.includes("invalid params") || msg.includes("invalid argument")) return true;
      return false;
    }
  }
  return false;
}

export async function probeEndpoint(url: string, withTraces = true): Promise<EndpointProbe> {
  const out: EndpointProbe = { url, reachable: false, blockNumber: null, latencyMs: null, tracesAvailable: null, error: null };
  try {
    const client = buildClient(url);
    const t0 = Date.now();
    const bn = await client.getBlockNumber();
    out.latencyMs = Date.now() - t0;
    out.blockNumber = Number(bn);
    out.reachable = true;
    if (withTraces) out.tracesAvailable = await probeTraceCapability(client);
  } catch (err) {
    out.error = redactUrl(String(err));
  }
  return out;
}
