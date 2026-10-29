import type { HttpRequest } from "@yaakapp/api";
import { describe, expect, test } from "vitest";
import {
  applyVarsToRequest,
  runScript,
  toYaakRequest,
  type ScriptHost,
  type ScriptResponse,
  type ScriptVars,
} from "../src/runtime";

function makeRequest(patch: Partial<HttpRequest> = {}): HttpRequest {
  return {
    model: "http_request",
    id: "rq_1",
    createdAt: "",
    updatedAt: "",
    workspaceId: "wk_1",
    folderId: null,
    authentication: {},
    authenticationType: null,
    body: {},
    bodyType: null,
    description: "",
    headers: [],
    method: "GET",
    name: "Users",
    sortPriority: 0,
    url: "https://api.example.com/users",
    urlParameters: [],
    settingSendCookies: "inherit",
    settingStoreCookies: "inherit",
    settingValidateCertificates: "inherit",
    settingFollowRedirects: "inherit",
    settingRequestTimeout: "inherit",
    settingHttpVersion: "inherit",
    ...patch,
  } as HttpRequest;
}

function makeResponse(patch: Partial<ScriptResponse> = {}): ScriptResponse {
  return {
    status: 200,
    statusReason: "OK",
    headers: [{ name: "Content-Type", value: "application/json" }],
    elapsed: 12,
    url: "https://api.example.com/users",
    body: '{"id":7,"tags":["a","b"]}',
    ...patch,
  };
}

function makeHost(sent: Partial<HttpRequest>[] = []): ScriptHost {
  return {
    async send(request) {
      sent.push(request);
      return makeResponse({ url: request.url ?? "" });
    },
    async render(template) {
      return template.replace("${[ baseUrl ]}", "https://api.example.com");
    },
  };
}

async function run(
  source: string,
  options: {
    request?: HttpRequest;
    response?: ScriptResponse;
    vars?: ScriptVars;
    host?: ScriptHost;
    timeout?: number;
    signal?: AbortSignal;
  } = {},
) {
  const request = options.request ?? makeRequest();
  const vars = options.vars ?? {};
  const result = await runScript({
    source,
    phase: options.response == null ? "prerequest" : "test",
    request,
    response: options.response,
    vars,
    host: options.host ?? makeHost(),
    syncTimeout: 100,
    timeout: options.timeout ?? 1_000,
    signal: options.signal,
  });
  return { result, request, vars };
}

describe("pre-request scripts", () => {
  test("edit the request", async () => {
    const { result, request } = await run(`
      yk.request.method = "post";
      yk.request.url = yk.request.url + "?page=2";
      yk.request.headers.upsert({ key: "X-Trace", value: "abc" });
      yk.request.headers.add("Accept: application/json");
      yk.request.body.raw = JSON.stringify({ a: 1 });
    `);
    expect(result.error).toBeNull();
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.example.com/users?page=2");
    expect(request.headers).toEqual([
      { enabled: true, name: "X-Trace", value: "abc" },
      { enabled: true, name: "Accept", value: "application/json" },
    ]);
    expect(request.body).toEqual({ text: '{"a":1}' });
  });

  test("upsert replaces a header regardless of case, and remove drops it", async () => {
    const request = makeRequest({ headers: [{ name: "authorization", value: "old" }] });
    const { result } = await run(
      `yk.request.headers.upsert({ key: "Authorization", value: "new" });
       console.log(yk.request.headers.get("AUTHORIZATION"));
       yk.request.headers.remove("Authorization");
       console.log(yk.request.headers.has("authorization"));`,
      { request },
    );
    expect(result.logs).toEqual(["new", "false"]);
    expect(request.headers).toEqual([]);
  });

  test("set variables", async () => {
    const { vars } = await run(`
      yk.variables.set("token", "t1");
      yk.environment.set("n", 3);
      yk.variables.set("gone", 1);
      yk.variables.unset("gone");
    `);
    expect(vars).toEqual({ token: "t1", n: 3 });
  });
});

describe("post-response scripts", () => {
  test("pass and fail tests, keeping their order", async () => {
    const { result } = await run(
      `
      yk.test("status", () => yk.response.to.have.status(200));
      yk.test("id", () => yk.expect(yk.response.json().id).to.equal(8));
      yk.test("tags", () => yk.expect(yk.response.json().tags).to.eql(["a", "b"]));
      yk.test("async", async () => { await Promise.resolve(); yk.expect(1).to.be.above(0); });
      `,
      { response: makeResponse() },
    );
    expect(result.error).toBeNull();
    expect(result.tests).toEqual([
      { name: "status", passed: true },
      { name: "id", passed: false, error: "expected 7 to equal 8" },
      { name: "tags", passed: true },
      { name: "async", passed: true },
    ]);
  });

  test("read headers and timing", async () => {
    const { result } = await run(
      `console.log(yk.response.code, yk.response.status, yk.response.headers.get("content-type"), yk.response.responseTime)`,
      { response: makeResponse() },
    );
    expect(result.logs).toEqual(["200 OK application/json 12"]);
  });

  test("text() fails when the body could not be read", async () => {
    const { result } = await run(`yk.response.text()`, { response: makeResponse({ body: null }) });
    expect(result.error).toBe("Response body is not available");
  });
});

describe("expect", () => {
  test.each([
    `yk.expect(1).to.equal(1)`,
    `yk.expect({ a: [1] }).to.deep.equal({ a: [1] })`,
    `yk.expect("hello").to.include("ell")`,
    `yk.expect([1, 2]).to.include(2)`,
    `yk.expect({ a: 1, b: 2 }).to.include({ a: 1 })`,
    `yk.expect("abc").to.match(/b/)`,
    `yk.expect(3).to.be.below(4).and.above(2)`,
    `yk.expect([]).to.be.an("array").that.is.empty`,
    `yk.expect({ a: 1 }).to.have.property("a", 1)`,
    `yk.expect([1, 2]).to.have.lengthOf(2)`,
    `yk.expect(true).to.be.true`,
    `yk.expect(0).to.not.be.ok`,
    `yk.expect(1).to.not.equal(2)`,
    `yk.expect(2).to.be.oneOf([1, 2])`,
  ])("passes: %s", async (source) => {
    const { result } = await run(source);
    expect(result.error).toBeNull();
  });

  test.each([
    [`yk.expect(1).to.equal(2)`, "expected 1 to equal 2"],
    [`yk.expect(1).to.not.equal(1)`, "expected 1 not to equal 1"],
    [`yk.expect("a").to.be.a("number")`, "expected 'a' to be a number"],
    [`yk.expect(null).to.exist`, "expected null to exist"],
  ])("fails: %s", async (source, message) => {
    const { result } = await run(source);
    expect(result.error).toBe(message);
  });
});

describe("sendRequest", () => {
  test("waits for sends the script did not await, as Postman does", async () => {
    const sent: Partial<HttpRequest>[] = [];
    const { result } = await run(
      `
      for (let i = 0; i < 3; i++) {
        yk.sendRequest({ url: "https://x.test/" + i, method: "post", header: { "Content-Type": "application/json" } },
          (err, res) => console.log(i, err, res.code));
      }
      `,
      { host: makeHost(sent) },
    );
    expect(result.error).toBeNull();
    expect(result.logs.sort()).toEqual(["0 null 200", "1 null 200", "2 null 200"]);
    expect(sent.map((r) => [r.method, r.url])).toEqual([
      ["POST", "https://x.test/0"],
      ["POST", "https://x.test/1"],
      ["POST", "https://x.test/2"],
    ]);
  });

  test("returns a promise without a callback, and fills in script variables", async () => {
    const sent: Partial<HttpRequest>[] = [];
    const { result } = await run(
      `const res = await yk.sendRequest("https://x.test/\${[ id ]}"); console.log(res.json().id)`,
      { host: makeHost(sent), vars: { id: 42 } },
    );
    expect(result.logs).toEqual(["7"]);
    expect(sent[0]?.url).toBe("https://x.test/42");
  });

  test("hands send errors to the callback", async () => {
    const host: ScriptHost = {
      send: async () => {
        throw new Error("connection refused");
      },
      render: async (t) => t,
    };
    const { result } = await run(
      `yk.sendRequest("https://x.test", (err) => console.log(err.message))`,
      {
        host,
      },
    );
    expect(result.error).toBeNull();
    expect(result.logs).toEqual(["connection refused"]);
  });

  test("render reaches the host", async () => {
    const { result } = await run(`console.log(await yk.render("\${[ baseUrl ]}/x"))`);
    expect(result.logs).toEqual(["https://api.example.com/x"]);
  });
});

describe("limits", () => {
  test("stops a script that never yields", async () => {
    const { result } = await run(`while (true) {}`);
    expect(result.error).toMatch(/timed out/);
  });

  test("stops a script that never finishes", async () => {
    const { result } = await run(`await new Promise(() => {})`);
    expect(result.error).toBe("Script timed out after 1000ms");
  });

  test("reports syntax errors", async () => {
    const { result } = await run(`yk.test(`);
    expect(result.error).toMatch(/Unexpected/);
  });

  test("sleep waits without counting against the sync limit", async () => {
    const started = Date.now();
    const { result } = await run(`await yk.sleep(150); console.log("done")`);
    expect(result.error).toBeNull();
    expect(result.logs).toEqual(["done"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  test("a script can extend its own timeout", async () => {
    const { result } = await run(`yk.timeout(500); await yk.sleep(200)`, { timeout: 100 });
    expect(result.error).toBeNull();
  });

  test("a script can lift its timeout", async () => {
    const { result } = await run(`yk.timeout(0); await yk.sleep(200)`, { timeout: 100 });
    expect(result.error).toBeNull();
  });

  test("a script can shorten its timeout", async () => {
    const { result } = await run(`yk.timeout(50); await yk.sleep(500)`);
    expect(result.error).toBe("Script timed out after 50ms");
  });

  test("an abort stops the script, and it sends nothing more", async () => {
    const sent: Partial<HttpRequest>[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 120);
    const { result } = await run(
      `while (true) { await yk.sendRequest("https://api.example.com/tick"); await yk.sleep(50); }`,
      { host: makeHost(sent), signal: controller.signal, timeout: 0 },
    );
    expect(result.error).toBe("Script stopped");
    const count = sent.length;
    expect(count).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sent.length).toBe(count);
  });

  test("a timed-out script sends nothing more", async () => {
    const sent: Partial<HttpRequest>[] = [];
    const { result } = await run(
      `while (true) { await yk.sendRequest("https://api.example.com/tick"); await yk.sleep(30); }`,
      { host: makeHost(sent), timeout: 100 },
    );
    expect(result.error).toMatch(/timed out/);
    const count = sent.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent.length).toBe(count);
  });

  test("an already aborted signal stops the script before it starts waiting", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await run(`await yk.sleep(10)`, { signal: controller.signal });
    expect(result.error).toBe("Script stopped");
  });

  test("does not leak globals between runs", async () => {
    await run(`globalThis.leaked = 1`);
    const { result } = await run(`console.log(typeof leaked)`);
    expect(result.logs).toEqual(["undefined"]);
  });
});

describe("applyVarsToRequest", () => {
  test("replaces only known variables", () => {
    const request = applyVarsToRequest(
      makeRequest({
        url: "${[ baseUrl ]}/users/${[id]}",
        headers: [{ name: "Authorization", value: "Bearer ${[ token ]}" }],
        body: { text: '{"n":${[ n ]}}' },
      }),
      { id: 7, token: "t1", n: 3 },
    );
    expect(request.url).toBe("${[ baseUrl ]}/users/7");
    expect(request.headers).toEqual([{ name: "Authorization", value: "Bearer t1" }]);
    expect(request.body).toEqual({ text: '{"n":3}' });
  });

  test("returns the request untouched when there are no variables", () => {
    const request = makeRequest();
    expect(applyVarsToRequest(request, {})).toBe(request);
  });
});

describe("toYaakRequest", () => {
  test("maps a raw JSON body", () => {
    expect(
      toYaakRequest({
        url: "https://x.test",
        method: "post",
        header: [{ key: "Content-Type", value: "application/json" }],
        body: { mode: "raw", raw: "{}" },
      }),
    ).toEqual({
      method: "POST",
      url: "https://x.test",
      headers: [{ enabled: true, name: "Content-Type", value: "application/json" }],
      bodyType: "application/json",
      body: { text: "{}" },
    });
  });

  test("maps a urlencoded body", () => {
    expect(
      toYaakRequest({
        url: "https://x.test",
        method: "POST",
        body: { mode: "urlencoded", urlencoded: [{ key: "a", value: 1 }] },
      }).body,
    ).toEqual({ form: [{ enabled: true, name: "a", value: "1" }] });
  });
});
