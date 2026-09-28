import type { MxAccount, MxTransaction } from "./rules";

// FinancialDataProvider — the adapter the derive job reads through (FINDINGS-fact-derivation §4).
// MxProvider is the one implementation: MX Platform API v20250224, HTTP Basic (client_id:api_key).
// The MX user is addressed by OUR id (Supabase auth uid), which MX accepts wherever a path takes
// {user_identifier} — so no mapping table.
//
// Keys are read when the job runs, NOT at boot: a missing key fails one job, not the deploy.

export type MxMember = {
  guid: string;
  connection_status?: string | null;
  is_being_aggregated?: boolean | null;
  successfully_aggregated_at?: string | null;
};

export interface FinancialDataProvider {
  getMembers(userRef: string): Promise<MxMember[]>;
  getAccounts(userRef: string): Promise<MxAccount[]>;
  getTransactions(userRef: string, from: Date): Promise<MxTransaction[]>;
}

export class MxError extends Error {
  constructor(public code: "mx_not_configured" | "mx_auth_failed" | "mx_user_not_found" | "mx_request_failed", message: string) {
    super(`${code}: ${message}`);
    this.name = "MxError";
  }
}

const PER_PAGE = 100;
const MAX_PAGES = 50;   // 5,000 rows — far above a 120-day window; a hard stop, not a real limit

export class MxProvider implements FinancialDataProvider {
  private readonly base: string;
  private readonly auth: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const id = env.MX_CLIENT_ID?.trim();
    const key = env.MX_API_KEY?.trim();
    if (!id || !key) throw new MxError("mx_not_configured", "MX_CLIENT_ID / MX_API_KEY are not set on this service");
    this.base = (env.MX_BASE_URL?.trim() || "https://int-api.mx.com").replace(/\/+$/, "");
    this.auth = "Basic " + Buffer.from(`${id}:${key}`).toString("base64");
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(this.base + path, {
      headers: { Authorization: this.auth, Accept: "application/json", "Accept-Version": "v20250224" },
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new MxError("mx_auth_failed", `GET ${path.split("?")[0]} → ${res.status}`);
    if (res.status === 404) throw new MxError("mx_user_not_found", `GET ${path.split("?")[0]} → 404`);
    if (!res.ok) throw new MxError("mx_request_failed", `GET ${path.split("?")[0]} → ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text) as Record<string, unknown>;
  }

  private async paged<T>(path: string, field: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.get(`${path}${sep}page=${page}&records_per_page=${PER_PAGE}`);
      out.push(...((body[field] as T[] | undefined) ?? []));
      const totalPages = Number((body.pagination as { total_pages?: number } | undefined)?.total_pages ?? 1);
      if (page >= totalPages) return out;
    }
    throw new MxError("mx_request_failed", `${path.split("?")[0]}: more than ${MAX_PAGES} pages`);
  }

  getMembers(userRef: string): Promise<MxMember[]> {
    return this.paged<MxMember>(`/users/${encodeURIComponent(userRef)}/members`, "members");
  }

  getAccounts(userRef: string): Promise<MxAccount[]> {
    return this.paged<MxAccount>(`/users/${encodeURIComponent(userRef)}/accounts`, "accounts");
  }

  // from_date is sent as UNIX EPOCH SECONDS. The v20250224 spec documents YYYY-MM-DD, but the live
  // API (sandbox, 2026-09-28) rejects that with 400 "From date is not a valid integer" and accepts an
  // epoch integer. Without from_date MX returns a shorter default window (~90 days).
  getTransactions(userRef: string, from: Date): Promise<MxTransaction[]> {
    const epoch = Math.floor(from.getTime() / 1000);
    return this.paged<MxTransaction>(`/users/${encodeURIComponent(userRef)}/transactions?from_date=${epoch}`, "transactions");
  }
}
