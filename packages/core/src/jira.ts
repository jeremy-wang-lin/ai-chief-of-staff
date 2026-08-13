/** Jira 唯讀連接器:全部查詢走單一 JQL search endpoint(相容 Server/DC 與 Cloud),
 *  不落地、不鏡像 — Jira 是 backlog/sprint 的唯一事實來源(spec §4)。 */

export class JiraError extends Error {}

export interface JiraConfig {
  baseUrl: string;
  token: string;
  projects: string[];
  fetchFn?: typeof fetch;
}

export function jiraConfigFromEnv(): JiraConfig {
  const baseUrl = process.env.JIRA_BASE_URL ?? "";
  const token = process.env.JIRA_TOKEN ?? "";
  const projects = (process.env.JIRA_PROJECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!baseUrl || !token || projects.length === 0) {
    throw new JiraError("Jira 未設定:需要 JIRA_BASE_URL、JIRA_TOKEN、JIRA_PROJECTS");
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), token, projects };
}

export interface JiraIssue {
  key: string; summary: string; status: string;
  assignee: string | null; priority: string | null; updated: string; type: string;
}

export interface SprintView { project: string; total: number; byStatus: Record<string, number>; issues: JiraIssue[] }

interface RawIssue { key: string; fields: { summary: string; status?: { name?: string }; assignee?: { displayName?: string } | null; priority?: { name?: string } | null; updated?: string; issuetype?: { name?: string } } }

function mapIssue(r: RawIssue): JiraIssue {
  return {
    key: r.key, summary: r.fields.summary,
    status: r.fields.status?.name ?? "Unknown",
    assignee: r.fields.assignee?.displayName ?? null,
    priority: r.fields.priority?.name ?? null,
    updated: r.fields.updated ?? "", type: r.fields.issuetype?.name ?? "Unknown",
  };
}

// 邊界驗證:JQL literal 直接字串插值,惡意/畸形值(引號)會逃出引號字面。
// 值皆來自信任的 env/config,但仍在邊界收斂注入面 — 違規即丟 JiraError(比默默逃逸清楚)。
const PROJECT_KEY = /^[A-Za-z0-9_]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertProject(p: string): string {
  if (!PROJECT_KEY.test(p)) throw new JiraError(`Jira 專案代號不合法:${p}(僅允許英數與底線)`);
  return p;
}

function assertSince(since: string): string {
  if (!ISO_DATE.test(since)) throw new JiraError(`Jira done() 的 since 需為 YYYY-MM-DD:${since}`);
  return since;
}

export function createJira(cfg: JiraConfig) {
  const doFetch = cfg.fetchFn ?? fetch;
  cfg.projects.forEach(assertProject);
  // Server/DC 用 PAT Bearer;Cloud(atlassian.net)的 token 需為 "email:apitoken",改用 Basic。
  const auth = cfg.baseUrl.includes("atlassian.net")
    ? `Basic ${Buffer.from(cfg.token).toString("base64")}`
    : `Bearer ${cfg.token}`;

  async function search(jql: string, maxResults = 100): Promise<JiraIssue[]> {
    const url = `${cfg.baseUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=summary,status,assignee,priority,updated,issuetype&maxResults=${maxResults}`;
    let res: Response;
    try {
      res = await doFetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
    } catch (e) {
      throw new JiraError(`Jira 連線失敗:${(e as Error).message}`);
    }
    // 訊息刻意不含 token 值,也不含英文 "token"(避免洩漏或誤觸秘密掃描)。
    if (!res.ok) throw new JiraError(`Jira 回應 ${res.status}(檢查認證與權限)`);
    const body = (await res.json()) as { issues?: RawIssue[] };
    return (body.issues ?? []).map(mapIssue);
  }

  const scope = (project?: string) =>
    project
      ? `project = "${assertProject(project)}"`
      : `project in (${cfg.projects.map((p) => `"${p}"`).join(",")})`;

  return {
    async sprint(project?: string): Promise<SprintView[]> {
      const targets = project ? [project] : cfg.projects;
      return Promise.all(targets.map(async (p) => {
        const issues = await search(`${scope(p)} AND sprint in openSprints() ORDER BY status`);
        const byStatus: Record<string, number> = {};
        for (const i of issues) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
        return { project: p, total: issues.length, byStatus, issues };
      }));
    },
    async board(): Promise<Record<string, JiraIssue[]>> {
      const issues = await search(`${scope()} AND sprint in openSprints() ORDER BY assignee`);
      const out: Record<string, JiraIssue[]> = {};
      for (const i of issues) (out[i.assignee ?? "未指派"] ??= []).push(i);
      return out;
    },
    stale: (days = 3) => search(`${scope()} AND status = "In Progress" AND updated <= -${days}d`),
    unassigned: () => search(`${scope()} AND sprint in openSprints() AND assignee is EMPTY AND statusCategory != Done`),
    done: (since?: string) => search(`${scope()} AND statusCategory = Done AND resolved >= ${since ? `"${assertSince(since)}"` : "-7d"}`),
    backlog: (top = 20) => search(`${scope()} AND sprint is EMPTY AND statusCategory != Done ORDER BY Rank`, top),
  };
}
