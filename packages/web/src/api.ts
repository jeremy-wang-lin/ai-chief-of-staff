export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const TOKEN_KEY = "lcos_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, unknown>,
): Promise<T> {
  let url = `/api${path}`;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "" && v !== null) qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // 連線失敗(server 沒起來、網路斷掉)時 fetch 是 reject,不會回 Response。
    // 不接的話呼叫端會收到 TypeError,得為「請求失敗」這同一件事寫兩套錯誤處理。
    // status 0 = 根本沒拿到回應。
    throw new ApiError("OP_FAILED", (e as Error).message, 0);
  }
  if (res.status === 401) {
    // 金鑰失效(換了 LCOS_TOKEN、或還沒登入):清掉後整頁重載交回 AuthGate,
    // 不在每個呼叫端各寫一份 401 處理。reload 非同步,先丟錯讓當前流程停下。
    clearToken();
    location.reload();
    throw new ApiError("UNAUTHORIZED", "需要登入", 401);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } })?.error ?? {};
    // 不用 res.statusText 當 fallback:HTTP/2 底下它恆為空字串。
    throw new ApiError(e.code ?? "OP_FAILED", e.message ?? "請求失敗", res.status);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, params?: Record<string, unknown>) => req<T>("GET", path, undefined, params),
  post: <T>(path: string, body?: unknown) => req<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body: unknown) => req<T>("PATCH", path, body),
  del: (path: string) => req<unknown>("DELETE", path),
};

/**
 * 登入 gate 專用的健康檢查:401 回 false 而不是走 req 的 reload 路徑 ——
 * AuthGate 自己就是 401 的處理者,在這裡 reload 會變成無限重載。
 */
export async function checkAuth(token?: string): Promise<boolean> {
  const res = await fetch("/api/health", {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  if (res.status === 401) return false;
  if (!res.ok) throw new ApiError("OP_FAILED", "健康檢查失敗", res.status);
  return true;
}

// ── 前端型別(欄位與 core row 一致,camelCase)──
// 手寫而非 re-export @lcos/core:前端 bundle 不該把 drizzle/better-sqlite3 的型別鏈拖進來。
export interface Task {
  id: number;
  title: string;
  status: "To-do" | "In Progress" | "Done" | "Blocked";
  priority: "P0" | "P1" | "P2" | "P3";
  dueDate: string | null;
  source: string;
  origin: "human" | "ai";
  owner: string | null;
  projectId: number | null;
  radarId: number | null;
  noteId: number | null;
  bodyMd: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Note {
  id: number;
  title: string | null;
  date: string;
  type: "Meeting" | "Discussion" | "Thinking" | "Scratch";
  attendees: string | null;
  projectId: number | null;
  processedAt: string | null;
  bodyMd: string;
  createdAt: string;
  updatedAt: string;
}

export interface Radar {
  id: number;
  title: string;
  severity: "P0" | "P1" | "P2" | "P3";
  status: "Open" | "In Progress" | "Resolved";
  source: string | null;
  owner: string | null;
  projectId: number | null;
  noteId: number | null;
  bodyMd: string | null;
  updatedAt: string;
}

export interface Project {
  id: number;
  name: string;
  status: "Active" | "On Hold" | "Done";
  team: string | null;
  risk: string | null;
  nextMilestone: string | null;
  elevatorPitch: string | null;
  bodyMd: string | null;
  updatedAt: string;
}

export interface Briefing {
  id: number;
  kind: "daily" | "weekly";
  date: string;
  summary: string;
  bodyMd: string;
}

export interface Snapshot {
  today: string;
  dueToday: Task[];
  overdue: Task[];
  completedYesterday: Task[];
  unprocessedNotes: { id: number; date: string; type: string; label: string }[];
  openRadar: (Radar & { staleDays: number })[];
  latestBriefing: { kind: string; date: string } | null;
}

export interface SearchHit {
  table: string;
  rowId: number;
  title: string;
  snippet: string;
  isRevision: boolean;
  revisionCreatedAt?: string;
}

export interface Revision {
  id: number;
  tableName: string;
  rowId: number;
  field: string;
  oldValue: string | null;
  actor: string;
  workflow: string | null;
  createdAt: string;
}

export interface ProjectContext {
  project: Project;
  tasks: Task[];
  radar: Radar[];
  notes: Note[];
}
