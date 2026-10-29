import type { Context, Folder, HttpRequest, PluginDefinition, SentHttpRequest } from "@yaakapp/api";
import {
  applyVarsToRequest,
  errorMessage,
  runScript,
  stringifyVar,
  type ScriptHost,
  type ScriptResponse,
  type ScriptRun,
  type ScriptVars,
} from "./runtime";

interface StoredScript {
  pre: string;
  post: string;
}

interface RequestRun {
  name: string;
  method: string;
  status: number | null;
  error: string | null;
  pre: ScriptRun | null;
  post: ScriptRun | null;
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;

// Runs still going, so "Stop Scripts" can end them
const running = new Set<AbortController>();

const scriptKey = (requestId: string) => `script.${requestId}`;
const varsKey = (workspaceId: string) => `vars.${workspaceId}`;

const HELP = `
**Request** (edit it in the pre-request script)
\`yk.request.url\`, \`yk.request.method\`, \`yk.request.body.raw\`,
\`yk.request.headers.get(name)\` / \`.upsert({ key, value })\` / \`.add(...)\` / \`.remove(name)\`

**Response** (post-response script)
\`yk.response.code\`, \`.status\`, \`.responseTime\`, \`.headers.get(name)\`, \`.text()\`, \`.json()\`,
\`yk.response.to.have.status(200)\`

**Tests**
\`yk.test("name", () => yk.expect(value).to.equal(1))\`, with \`.eql\`, \`.include\`,
\`.match\`, \`.above\`, \`.below\`, \`.a("string")\`, \`.property\`, \`.lengthOf\`, \`.not\`,
\`.to.be.true\` / \`.ok\` / \`.empty\`

**Variables**
\`yk.variables.set(name, value)\` / \`.get\` / \`.unset\` (\`yk.environment\` is the same set).
A script variable replaces \`\${[ name ]}\` in requests sent with a script, and
\`\${[ script.var(name="name") ]}\` reads it in any request.

**Other**
\`await yk.sendRequest(urlOrOptions)\` (or with a callback), \`await yk.render("\${[ baseUrl ]}")\`,
\`await yk.sleep(ms)\`, \`yk.timeout(ms)\` (default 30 s, \`0\` for no limit; end a run with **Stop Scripts**),
\`console.log\`, \`crypto\`, \`atob\` / \`btoa\`, \`URL\`. Top-level \`await\` works.
`.trim();

export const plugin: PluginDefinition = {
  httpRequestActions: [
    {
      label: "Send with Scripts",
      async onSelect(ctx, { httpRequest }) {
        const vars = await loadVars(ctx, httpRequest.workspaceId);
        const run = await whileRunning((signal) => runRequest(ctx, httpRequest, vars, signal));
        await saveVars(ctx, httpRequest.workspaceId, vars);

        // Output worth reading gets the report; otherwise a toast is enough
        const hasOutput = [run.pre, run.post].some(
          (s) =>
            s != null && (s.logs.length > 0 || s.error != null || s.tests.some((t) => !t.passed)),
        );
        if (hasOutput || run.error != null) {
          await showReport(ctx, `Script Results: ${run.name}`, [run]);
        } else {
          await ctx.toast.show({
            message: summarize([run]),
            color: "success",
            icon: "check_circle",
          });
        }
      },
    },
    {
      label: "Edit Scripts",
      async onSelect(ctx, { httpRequest }) {
        const existing = await ctx.store.get<StoredScript>(scriptKey(httpRequest.id));
        const values = await ctx.prompt.form({
          id: `script-${httpRequest.id}`,
          title: `Scripts: ${requestName(httpRequest)}`,
          size: "lg",
          confirmText: "Save",
          inputs: [
            {
              type: "editor",
              name: "pre",
              label: "Pre-request",
              language: "javascript",
              optional: true,
              rows: 10,
              defaultValue: existing?.pre ?? "",
              placeholder:
                'yk.request.headers.upsert({ key: "X-Request-Id", value: crypto.randomUUID() });',
            },
            {
              type: "editor",
              name: "post",
              label: "Post-response",
              language: "javascript",
              optional: true,
              rows: 10,
              defaultValue: existing?.post ?? "",
              placeholder: 'yk.test("ok", () => yk.response.to.have.status(200));',
            },
            {
              type: "accordion",
              label: "Script API",
              inputs: [{ type: "markdown", content: HELP }],
            },
          ],
        });
        if (values == null) return;

        const pre = String(values.pre ?? "");
        const post = String(values.post ?? "");
        if (pre.trim() === "" && post.trim() === "") {
          await ctx.store.delete(scriptKey(httpRequest.id));
        } else {
          await ctx.store.set<StoredScript>(scriptKey(httpRequest.id), { pre, post });
        }
        await ctx.toast.show({ message: "Scripts saved", color: "success", icon: "check" });
      },
    },
  ],
  folderActions: [
    {
      label: "Run with Scripts",
      async onSelect(ctx, { folder }) {
        const requests = await requestsInFolder(ctx, folder);
        if (requests.length === 0) {
          await ctx.toast.show({ message: "No requests in folder", color: "info", icon: "info" });
          return;
        }

        // One set of variables for the whole run, so a request can hand values to the next
        const vars = await loadVars(ctx, folder.workspaceId);
        const runs: RequestRun[] = [];
        await whileRunning(async (signal) => {
          for (const request of requests) {
            if (signal.aborted) break;
            runs.push(await runRequest(ctx, request, vars, signal));
          }
        });
        await saveVars(ctx, folder.workspaceId, vars);
        await showReport(ctx, `Run: ${folder.name}`, runs);
      },
    },
  ],
  workspaceActions: [
    {
      label: "Stop Scripts",
      async onSelect(ctx) {
        const count = running.size;
        for (const controller of running) controller.abort();
        await ctx.toast.show({
          message: count === 0 ? "No scripts running" : `Stopped ${count} script run(s)`,
          color: "info",
          icon: "info",
        });
      },
    },
    {
      label: "Script Variables",
      async onSelect(ctx, { workspace }) {
        const vars = await loadVars(ctx, workspace.id);
        const values = await ctx.prompt.form({
          id: `script-vars-${workspace.id}`,
          title: "Script Variables",
          confirmText: "Save",
          inputs: [
            {
              type: "editor",
              name: "vars",
              label: "Variables (JSON)",
              language: "json",
              rows: 12,
              defaultValue: JSON.stringify(vars, null, 2),
            },
          ],
        });
        if (values == null) return;

        let next: unknown;
        try {
          next = JSON.parse(String(values.vars ?? "") || "{}");
        } catch (err) {
          await ctx.toast.show({ message: `Invalid JSON: ${errorMessage(err)}`, color: "danger" });
          return;
        }
        if (next == null || typeof next !== "object" || Array.isArray(next)) {
          await ctx.toast.show({ message: "Variables must be a JSON object", color: "danger" });
          return;
        }
        await saveVars(ctx, workspace.id, next as ScriptVars);
        await ctx.toast.show({ message: "Variables saved", color: "success", icon: "check" });
      },
    },
  ],
  templateFunctions: [
    {
      name: "script.var",
      description: "Read a variable set by a script",
      args: [{ type: "text", name: "name", label: "Name" }],
      async onRender(ctx, args) {
        const name = String(args.values.name ?? "");
        const workspaceId = await ctx.window.workspaceId();
        if (name === "" || workspaceId == null) return null;
        const vars = await loadVars(ctx, workspaceId);
        return Object.hasOwn(vars, name) ? stringifyVar(vars[name]) : null;
      },
    },
  ],
};

async function whileRunning<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  running.add(controller);
  try {
    return await fn(controller.signal);
  } finally {
    running.delete(controller);
  }
}

async function runRequest(
  ctx: Context,
  request: HttpRequest,
  vars: ScriptVars,
  signal: AbortSignal,
): Promise<RequestRun> {
  const run: RequestRun = {
    name: requestName(request),
    method: request.method,
    status: null,
    error: null,
    pre: null,
    post: null,
  };
  const script = await ctx.store.get<StoredScript>(scriptKey(request.id));
  const host = createHost(ctx);
  // The pre-request script edits a copy, so the saved request is left alone
  const toSend = structuredClone(request);

  if (script != null && script.pre.trim() !== "") {
    run.pre = await runScript({
      source: script.pre,
      phase: "prerequest",
      request: toSend,
      vars,
      host,
      signal,
    });
    if (run.pre.error != null) {
      run.error = "Not sent: the pre-request script failed";
      return run;
    }
  }

  let sent: SentHttpRequest;
  try {
    // Keeping the id files the response under the request, like a normal send
    sent = await ctx.httpRequest.send({ httpRequest: applyVarsToRequest(toSend, vars) });
  } catch (err) {
    run.error = errorMessage(err);
    return run;
  }
  run.status = sent.httpResponse.status;
  if (sent.httpResponse.error != null) {
    run.error = sent.httpResponse.error;
    return run;
  }

  if (script != null && script.post.trim() !== "") {
    const response = await readResponse(sent);
    run.post = await runScript({
      source: script.post,
      phase: "test",
      request: toSend,
      response,
      vars,
      host,
      signal,
    });
  }
  return run;
}

function createHost(ctx: Context): ScriptHost {
  return {
    async send(httpRequest) {
      const sent = await ctx.httpRequest.send({ httpRequest });
      if (sent.httpResponse.error != null) throw new Error(sent.httpResponse.error);
      return readResponse(sent);
    },
    render: (template) => ctx.templates.render({ data: template, purpose: "send" }),
  };
}

async function readResponse({ httpResponse, body }: SentHttpRequest): Promise<ScriptResponse> {
  let text: string | null = null;
  try {
    text = await body.text({ maxBytes: MAX_BODY_BYTES });
  } catch {
    // Too large or unreadable: the script sees no body rather than failing to start
  }
  return {
    status: httpResponse.status,
    statusReason: httpResponse.statusReason,
    headers: httpResponse.headers,
    elapsed: httpResponse.elapsed,
    url: httpResponse.url,
    body: text,
  };
}

async function loadVars(ctx: Context, workspaceId: string): Promise<ScriptVars> {
  return (await ctx.store.get<ScriptVars>(varsKey(workspaceId))) ?? {};
}

async function saveVars(ctx: Context, workspaceId: string, vars: ScriptVars) {
  await ctx.store.set<ScriptVars>(varsKey(workspaceId), vars);
}

/** The folder's requests, in the order the sidebar shows them. */
async function requestsInFolder(ctx: Context, folder: Folder): Promise<HttpRequest[]> {
  const [folders, requests] = await Promise.all([ctx.folder.list(), ctx.httpRequest.list()]);
  type Child = (typeof folders)[number] | (typeof requests)[number];

  const children = new Map<string, Child[]>();
  for (const child of [...folders, ...requests]) {
    if (child.folderId == null) continue;
    const siblings = children.get(child.folderId) ?? [];
    siblings.push(child);
    children.set(child.folderId, siblings);
  }

  const ordered: HttpRequest[] = [];
  const visit = (folderId: string) => {
    const siblings = (children.get(folderId) ?? [])
      .slice()
      .sort((a, b) =>
        a.sortPriority === b.sortPriority
          ? a.updatedAt > b.updatedAt
            ? 1
            : -1
          : a.sortPriority - b.sortPriority,
      );
    for (const child of siblings) {
      if (child.model === "folder") visit(child.id);
      else ordered.push(child);
    }
  };
  visit(folder.id);
  return ordered;
}

async function showReport(ctx: Context, title: string, runs: RequestRun[]) {
  await ctx.prompt.form({
    id: `script-report-${Date.now()}`,
    title,
    size: "lg",
    confirmText: "Close",
    inputs: [
      {
        type: "markdown",
        content: `**${summarize(runs)}**\n\n${runs.map(reportRun).join("\n\n")}`,
      },
    ],
  });
}

function reportRun(run: RequestRun): string {
  const lines = [`### ${run.method} ${escapeMarkdown(run.name)} — ${run.status ?? "not sent"}`];
  if (run.error != null) lines.push(`> ${escapeMarkdown(run.error)}`);
  for (const [label, script] of [
    ["Pre-request", run.pre],
    ["Post-response", run.post],
  ] as const) {
    if (script == null) continue;
    if (script.error != null)
      lines.push(`- ✗ ${label} script error: ${escapeMarkdown(script.error)}`);
    for (const test of script.tests) {
      lines.push(
        test.passed
          ? `- ✓ ${escapeMarkdown(test.name)}`
          : `- ✗ ${escapeMarkdown(test.name)}: ${escapeMarkdown(test.error ?? "")}`,
      );
    }
    if (script.logs.length > 0) {
      lines.push(`\n\`\`\`text\n${script.logs.join("\n").replaceAll("```", "'''")}\n\`\`\``);
    }
  }
  return lines.join("\n");
}

function summarize(runs: RequestRun[]): string {
  const tests = runs.flatMap((r) => [...(r.pre?.tests ?? []), ...(r.post?.tests ?? [])]);
  const passed = tests.filter((t) => t.passed).length;
  const failed = runs.filter(
    (r) => r.error != null || r.pre?.error != null || r.post?.error != null,
  ).length;

  const parts = [
    runs.length === 1 ? `${runs[0]?.status ?? "Not sent"}` : `${runs.length} requests`,
  ];
  if (tests.length > 0) parts.push(`${passed}/${tests.length} tests passed`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

function requestName(request: HttpRequest): string {
  return request.name || request.url || "Untitled";
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]<>#|])/g, "\\$1");
}
