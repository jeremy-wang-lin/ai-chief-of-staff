import { describe, it, expect, vi, afterEach } from "vitest";
import { createJira, jiraConfigFromEnv, JiraError } from "../src/jira.ts";

const ISSUE = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  fields: {
    summary: `摘要 ${key}`, status: { name: "In Progress" },
    assignee: { displayName: "王同事" }, priority: { name: "High" },
    updated: "2026-08-01T10:00:00.000+0800", issuetype: { name: "Task" },
    ...over,
  },
});

function fakeFetch(issues: unknown[], capture?: { url?: string; auth?: string }) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.auth = (init?.headers as Record<string, string>)?.Authorization;
    }
    return new Response(JSON.stringify({ issues, total: issues.length }), { status: 200 });
  }) as unknown as typeof fetch;
}

const CFG = { baseUrl: "https://jira.example.com", token: "tok", projects: ["PAY", "DATA"] };

describe("jira connector", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("configFromEnv requires all three vars", () => {
    vi.stubEnv("JIRA_BASE_URL", "https://jira.example.com");
    vi.stubEnv("JIRA_TOKEN", "");
    vi.stubEnv("JIRA_PROJECTS", "PAY");
    expect(() => jiraConfigFromEnv()).toThrow(JiraError);
    vi.stubEnv("JIRA_TOKEN", "tok");
    expect(jiraConfigFromEnv().projects).toEqual(["PAY"]);
  });

  it("configFromEnv rejects missing baseUrl and empty projects", () => {
    vi.stubEnv("JIRA_TOKEN", "tok");
    vi.stubEnv("JIRA_PROJECTS", "PAY");
    vi.stubEnv("JIRA_BASE_URL", "");
    expect(() => jiraConfigFromEnv()).toThrow(JiraError);
    vi.stubEnv("JIRA_BASE_URL", "https://jira.example.com");
    vi.stubEnv("JIRA_PROJECTS", "  , ,");
    expect(() => jiraConfigFromEnv()).toThrow(JiraError);
    // trailing slash trimmed; comma list parsed & trimmed
    vi.stubEnv("JIRA_PROJECTS", " PAY , DATA ");
    vi.stubEnv("JIRA_BASE_URL", "https://jira.example.com/");
    const cfg = jiraConfigFromEnv();
    expect(cfg.baseUrl).toBe("https://jira.example.com");
    expect(cfg.projects).toEqual(["PAY", "DATA"]);
  });

  it("sprint builds JQL with project scope and maps issues", async () => {
    const cap: { url?: string } = {};
    const jira = createJira({ ...CFG, fetchFn: fakeFetch([ISSUE("PAY-1"), ISSUE("PAY-2", { status: { name: "Done" } })], cap) });
    const views = await jira.sprint("PAY");
    expect(decodeURIComponent(cap.url!)).toContain('project = "PAY" AND sprint in openSprints()');
    expect(views[0].byStatus).toEqual({ "In Progress": 1, Done: 1 });
    expect(views[0].issues[0]).toMatchObject({ key: "PAY-1", assignee: "王同事", status: "In Progress" });
  });

  it("sprint() with no project fans out to every configured project", async () => {
    const cap: { url?: string } = {};
    const jira = createJira({ ...CFG, fetchFn: fakeFetch([ISSUE("X-1")], cap) });
    const views = await jira.sprint();
    expect(views).toHaveLength(2);
    expect(views.map((v) => v.project)).toEqual(["PAY", "DATA"]);
    // each view is scoped to its single project, not the whole "in (...)" list
    expect(decodeURIComponent(cap.url!)).toContain('project = "DATA" AND sprint in openSprints()');
    expect(views[0]).toMatchObject({ project: "PAY", total: 1, byStatus: { "In Progress": 1 } });
  });

  it("board queries openSprints across all projects and groups by assignee", async () => {
    const cap: { url?: string } = {};
    const jira = createJira({ ...CFG, fetchFn: fakeFetch([ISSUE("PAY-1"), ISSUE("PAY-2", { assignee: null })], cap) });
    const board = await jira.board();
    expect(decodeURIComponent(cap.url!)).toContain('project in ("PAY","DATA") AND sprint in openSprints()');
    expect(Object.keys(board).sort()).toEqual(["未指派", "王同事"]);
    expect(board["王同事"]).toHaveLength(1);
    expect(board["未指派"][0].key).toBe("PAY-2");
  });

  it("stale/unassigned/done/backlog build the documented JQL", async () => {
    const cap: { url?: string } = {};
    const jira = createJira({ ...CFG, fetchFn: fakeFetch([], cap) });
    await jira.stale(5);
    expect(decodeURIComponent(cap.url!)).toContain("updated <= -5d");
    await jira.unassigned();
    expect(decodeURIComponent(cap.url!)).toContain("assignee is EMPTY");
    await jira.done("2026-07-28");
    expect(decodeURIComponent(cap.url!)).toContain('resolved >= "2026-07-28"');
    await jira.backlog(10);
    expect(decodeURIComponent(cap.url!)).toContain("sprint is EMPTY");
    expect(cap.url).toContain("maxResults=10");
  });

  it("uses Bearer PAT for Server/DC and Basic base64 for Cloud (atlassian.net)", async () => {
    const capDC: { auth?: string } = {};
    await createJira({ ...CFG, fetchFn: fakeFetch([], capDC) }).unassigned();
    expect(capDC.auth).toBe("Bearer tok");

    const capCloud: { auth?: string } = {};
    // Cloud token is pre-formatted "email:apitoken"; connector base64s it for Basic.
    await createJira({
      baseUrl: "https://example.atlassian.net", token: "user@example.com:api-xyz", projects: ["PAY"],
      fetchFn: fakeFetch([], capCloud),
    }).unassigned();
    expect(capCloud.auth!.startsWith("Basic ")).toBe(true);
    expect(capCloud.auth).toBe(`Basic ${Buffer.from("user@example.com:api-xyz").toString("base64")}`);
  });

  it("non-2xx and network failure → JiraError without leaking the token (raw or base64)", async () => {
    const SECRET = "sekret-pat-xyz";
    const capture = { message: "" };
    const grab = (e: unknown) => { capture.message = (e as Error).message; throw e; };

    const boom = vi.fn(async () => new Response("go away", { status: 401 })) as unknown as typeof fetch;
    const jiraDC = createJira({ ...CFG, token: SECRET, fetchFn: boom });
    await expect(jiraDC.sprint().catch(grab)).rejects.toThrow(JiraError);
    await expect(jiraDC.sprint()).rejects.not.toThrow(/sekret/);
    expect(capture.message).not.toContain(SECRET);
    expect(capture.message).not.toContain(Buffer.from(SECRET).toString("base64"));

    // Cloud (Basic) branch: base64 of the token must not surface either.
    const jiraCloud = createJira({
      baseUrl: "https://jira.example.com", token: SECRET, projects: ["PAY"], fetchFn: boom,
    });
    await expect(jiraCloud.sprint().catch(grab)).rejects.toThrow(JiraError);
    expect(capture.message).not.toContain(SECRET);
    expect(capture.message).not.toContain(Buffer.from(SECRET).toString("base64"));

    const dead = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(createJira({ ...CFG, token: SECRET, fetchFn: dead }).backlog().catch(grab)).rejects.toThrow(JiraError);
    expect(capture.message).not.toContain(SECRET);
  });

  it("rejects a JQL-injecting project name / malformed since at the boundary", async () => {
    const jira = createJira({ ...CFG, fetchFn: fakeFetch([]) });
    // a double-quote would break out of the quoted JQL literal → refuse, don't interpolate
    await expect(jira.sprint('PAY" OR "1"="1')).rejects.toThrow(JiraError);
    expect(() => jira.done("2026/07/28")).toThrow(JiraError);
    // invalid project in config is caught at construction
    expect(() => createJira({ ...CFG, projects: ['PAY"'], fetchFn: fakeFetch([]) })).toThrow(JiraError);
  });
});
