import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import type { Log as ViemLog } from "viem";
import type { Address } from "../types.ts";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
  private_key_id?: string;
}

const base64url = (input: string | Uint8Array) => {
  const value = typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
  return value.toString("base64url");
};

function loadCredentials(path: string): ServiceAccount {
  return JSON.parse(readFileSync(path, "utf8")) as ServiceAccount;
}

async function accessToken(credentialsPath: string): Promise<string> {
  const credentials = loadCredentials(credentialsPath);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...(credentials.private_key_id ? { kid: credentials.private_key_id } : {}) }));
  const claim = base64url(JSON.stringify({ iss: credentials.client_email, scope: "https://www.googleapis.com/auth/bigquery", aud: credentials.token_uri ?? "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const jwt = `${unsigned}.${base64url(signer.sign(credentials.private_key))}`;
  const response = await fetch(credentials.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!response.ok) throw new Error(`Google auth HTTP ${response.status}`);
  const body = await response.json() as { access_token?: string };
  if (!body.access_token) throw new Error("Google auth response did not include access_token");
  return body.access_token;
}

export async function fetchBigQueryLogs(args: {
  projectId: string;
  credentialsPath: string;
  dataset: string;
  addresses: Address[];
  topic0: string;
  fromBlock: bigint;
  toBlock: bigint;
  maxBytesBilled?: number;
}): Promise<ViemLog[]> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(args.dataset)) throw new Error("BigQuery dataset is invalid");
  if (args.addresses.length === 0 || args.addresses.some((a) => !/^0x[0-9a-f]{40}$/i.test(a))) throw new Error("BigQuery log address is invalid");
  if (!/^0x[0-9a-f]{64}$/i.test(args.topic0) || args.fromBlock < 0n || args.toBlock < args.fromBlock) throw new Error("BigQuery log query is invalid");
  const token = await accessToken(args.credentialsPath);
  const addresses = args.addresses.map((a) => `'${a.toLowerCase()}'`).join(",");
  const query = `SELECT address, data, topics, block_number, block_timestamp, transaction_hash, transaction_index, log_index FROM \`${args.dataset}.logs\` WHERE LOWER(address) IN (${addresses}) AND block_number BETWEEN ${args.fromBlock} AND ${args.toBlock} AND topics[SAFE_OFFSET(0)] = '${args.topic0}' ORDER BY block_number, transaction_index, log_index`;
  const response = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(args.projectId)}/queries`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, useLegacySql: false, maxResults: 100_000, ...(args.maxBytesBilled ? { maximumBytesBilled: String(args.maxBytesBilled) } : {}) }),
  });
  if (!response.ok) throw new Error(`BigQuery HTTP ${response.status}`);
  let body = await response.json() as {
    error?: { message?: string };
    rows?: Array<{ f: Array<{ v: unknown }> }>;
    pageToken?: string;
    jobComplete?: boolean;
    jobReference?: { jobId?: string; location?: string };
  };
  if (body.error) throw new Error(`BigQuery query failed: ${body.error.message ?? "unknown error"}`);
  const rows = [...(body.rows ?? [])];
  let pageToken = body.pageToken;
  if (body.jobComplete === false) {
    const jobId = body.jobReference?.jobId;
    if (!jobId) throw new Error("BigQuery query did not complete and returned no job id");
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const pollUrl = new URL(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(args.projectId)}/queries/${encodeURIComponent(jobId)}`);
      if (body.jobReference?.location) pollUrl.searchParams.set("location", body.jobReference.location);
      const poll = await fetch(pollUrl, { headers: { authorization: `Bearer ${token}` } });
      if (!poll.ok) throw new Error(`BigQuery result HTTP ${poll.status}`);
      body = await poll.json() as typeof body;
      if (body.error) throw new Error(`BigQuery query failed: ${body.error.message ?? "unknown error"}`);
      rows.push(...(body.rows ?? []));
      pageToken = body.pageToken;
      if (body.jobComplete !== false) break;
      if (attempt === 59) throw new Error("BigQuery query timed out while polling results");
    }
  }
  while (pageToken) {
    const pageUrl = new URL(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(args.projectId)}/queries/${encodeURIComponent(body.jobReference?.jobId ?? "")}`);
    pageUrl.searchParams.set("pageToken", pageToken);
    const page = await fetch(pageUrl, { headers: { authorization: `Bearer ${token}` } });
    if (!page.ok) throw new Error(`BigQuery page HTTP ${page.status}`);
    const pageBody = await page.json() as typeof body;
    if (pageBody.error) throw new Error(`BigQuery page failed: ${pageBody.error.message ?? "unknown error"}`);
    rows.push(...(pageBody.rows ?? []));
    pageToken = pageBody.pageToken;
    body = pageBody;
  }
  return rows.map((row) => {
    const values = row.f.map((field) => field.v);
    const topics = values[2] as Array<string | { v: string }>;
    const timestampValue = values[4] as string | { v?: string };
    const timestamp = Date.parse(typeof timestampValue === "string" ? timestampValue : String(timestampValue?.v ?? "")) / 1000;
    if (values[3] === null || values[5] === null || values[6] === null || values[7] === null) throw new Error("BigQuery log missing block/transaction/log identity");
    return {
      address: String(values[0]) as `0x${string}`,
      data: String(values[1]) as `0x${string}`,
      topics: topics.map((t) => typeof t === "string" ? t : t.v) as `0x${string}`[],
      blockNumber: BigInt(String(values[3])),
      transactionHash: String(values[5]) as `0x${string}`,
      transactionIndex: Number(values[6]),
      logIndex: Number(values[7]),
      ...(Number.isFinite(timestamp) ? { blockTimestamp: timestamp } : {}),
    } as unknown as ViemLog;
  }).sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
}
