import { useCallback, useEffect, useRef, useState } from "react";

// Thin fetch wrapper. A 401 flips the app into the token prompt; the session
// cookie set by POST /api/session then authenticates both fetch and SSE.

type AuthListener = (needed: boolean) => void;
const authListeners = new Set<AuthListener>();
export function onAuthChange(fn: AuthListener): () => void {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.status === 401) {
    for (const fn of authListeners) fn(true);
    throw new ApiError("Sign in to view this dashboard.", 401);
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch { /* not json */ }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export async function signIn(token: string): Promise<boolean> {
  const res = await fetch("/api/session", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  if (res.ok) for (const fn of authListeners) fn(false);
  return res.ok;
}

export interface Query<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch on mount and whenever `path` changes; optional polling. Keeps stale data while refetching. */
export function useQuery<T>(path: string | null, opts: { refreshMs?: number } = {}): Query<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const seq = useRef(0);

  const load = useCallback(() => {
    if (path === null) return;
    const id = ++seq.current;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (id !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (id === seq.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, [path]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  useEffect(() => {
    if (!opts.refreshMs) return;
    const t = setInterval(load, opts.refreshMs);
    return () => clearInterval(t);
  }, [load, opts.refreshMs]);

  return { data, error, loading, reload: load };
}
