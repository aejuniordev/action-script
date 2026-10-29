import { format, inspect } from "node:util";
import vm from "node:vm";
import type { HttpRequest, HttpRequestHeader } from "@yaakapp/api";

export type ScriptVars = Record<string, unknown>;

export type ScriptPhase = "prerequest" | "test";

export interface ScriptResponse {
  status: number;
  statusReason: string | null;
  headers: Array<{ name: string; value: string }>;
  elapsed: number;
  url: string;
  /** The body as text, or null when it could not be read. */
  body: string | null;
}

/** What a script reaches outside itself through. */
export interface ScriptHost {
  send(request: Partial<HttpRequest>): Promise<ScriptResponse>;
  render(template: string): Promise<string>;
}

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ScriptRun {
  tests: TestResult[];
  logs: string[];
  error: string | null;
}

export interface RunScriptArgs {
  source: string;
  phase: ScriptPhase;
  /** The request about to be sent. A pre-request script edits it in place. */
  request: HttpRequest;
  response?: ScriptResponse;
  /** Script variables, edited in place. */
  vars: ScriptVars;
  host: ScriptHost;
  /** How long the script may run without yielding, in milliseconds. */
  syncTimeout?: number;
  /** How long the script may take, awaited work included, in milliseconds. */
  timeout?: number;
}

const DEFAULT_SYNC_TIMEOUT = 1_000;
const DEFAULT_TIMEOUT = 30_000;

// Compiling is the slow part of running a script, and the same few scripts run
// over and over, so the compiled form is kept for the most recent ones.
const MAX_COMPILED = 64;
const compiled = new Map<string, vm.Script>();

function compile(source: string): vm.Script {
  let script = compiled.get(source);
  if (script == null) {
    // Wrapped in an async function so a script can use top-level await
    script = new vm.Script(`(async () => {\n${source}\n})()`, {
      filename: "script.js",
      lineOffset: -1,
    });
    if (compiled.size >= MAX_COMPILED) {
      compiled.delete(compiled.keys().next().value as string);
    }
    compiled.set(source, script);
  }
  return script;
}

/**
 * Run a script against a request and, after it is sent, its response.
 *
 * `node:vm` keeps a script's globals apart from the plugin's, but it is not a
 * security boundary: a script can reach the plugin runtime through the objects
 * it is handed. Run only scripts you would run as a plugin.
 */
export async function runScript(args: RunScriptArgs): Promise<ScriptRun> {
  const run: ScriptRun = { tests: [], logs: [], error: null };
  const pending: Promise<unknown>[] = [];
  const yk = createYk(args, run, pending);

  const log =
    (prefix: string) =>
    (...values: unknown[]) => {
      run.logs.push(prefix + format(...values));
    };
  const context = vm.createContext({
    yk,
    console: {
      log: log(""),
      info: log(""),
      debug: log(""),
      warn: log("[warn] "),
      error: log("[error] "),
    },
    crypto: globalThis.crypto,
    atob,
    btoa,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
  });

  const timeout = args.timeout ?? DEFAULT_TIMEOUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Script timed out after ${timeout}ms`)), timeout);
  });

  try {
    await Promise.race([
      (async () => {
        await compile(args.source).runInContext(context, {
          timeout: args.syncTimeout ?? DEFAULT_SYNC_TIMEOUT,
        });
        // Wait for sends and tests the script started but did not await, the
        // way Postman does, including any those start in turn.
        while (pending.length > 0) {
          await Promise.all(pending.splice(0));
        }
      })(),
      deadline,
    ]);
  } catch (err) {
    run.error = errorMessage(err);
  } finally {
    clearTimeout(timer);
  }

  return run;
}

function createYk(args: RunScriptArgs, run: ScriptRun, pending: Promise<unknown>[]) {
  const { request, response, vars, host } = args;

  const variables = {
    get: (name: string) => vars[name],
    set: (name: string, value: unknown) => {
      if (value === undefined) delete vars[name];
      else vars[name] = value;
    },
    unset: (name: string) => {
      delete vars[name];
    },
    has: (name: string) => Object.hasOwn(vars, name),
    clear: () => {
      for (const name of Object.keys(vars)) delete vars[name];
    },
    toObject: () => ({ ...vars }),
    replaceIn: (template: string) => applyVars(String(template), vars),
  };

  return {
    info: {
      eventName: args.phase,
      requestId: request.id,
      requestName: request.name,
    },
    request: requestView(request),
    response: response == null ? undefined : responseView(response),
    // Postman keeps these apart; here they are one set of script variables
    variables,
    environment: variables,
    collectionVariables: variables,
    globals: variables,
    expect,
    test(name: string, fn: () => unknown) {
      const result: TestResult = { name: String(name), passed: true };
      run.tests.push(result);
      pending.push(
        (async () => {
          try {
            await fn();
          } catch (err) {
            result.passed = false;
            result.error = errorMessage(err);
          }
        })(),
      );
    },
    sendRequest(
      options: string | SendRequestOptions,
      callback?: (err: unknown, res: ReturnType<typeof responseView> | undefined) => unknown,
    ) {
      const sent = host
        .send(applyVarsToRequest(toYaakRequest(options), vars))
        .then((r) => responseView(r));
      if (callback == null) {
        pending.push(sent.catch(() => {}));
        return sent;
      }
      pending.push(
        sent.then(
          (res) => callback(null, res),
          (err) => callback(err, undefined),
        ),
      );
      return undefined;
    },
    /** Render a template, like `${[ baseUrl ]}`, against the active environment. */
    render: (template: string) => host.render(String(template)),
  };
}

function requestView(request: HttpRequest) {
  const isEnabled = (h: HttpRequestHeader) => h.enabled !== false;
  const sameName = (name: string) => (h: HttpRequestHeader) =>
    h.name.toLowerCase() === String(name).toLowerCase();

  const headers = {
    get: (name: string) => request.headers.filter(isEnabled).find(sameName(name))?.value,
    has: (name: string) => request.headers.filter(isEnabled).some(sameName(name)),
    add(header: HeaderInput) {
      request.headers = [...request.headers, toHeader(header)];
    },
    upsert(header: HeaderInput) {
      const next = toHeader(header);
      const index = request.headers.findIndex(sameName(next.name));
      if (index === -1) {
        request.headers = [...request.headers, next];
      } else {
        request.headers = request.headers.map((h, i) => (i === index ? next : h));
      }
    },
    remove(name: string) {
      request.headers = request.headers.filter((h) => !sameName(name)(h));
    },
    toObject: () =>
      Object.fromEntries(request.headers.filter(isEnabled).map((h) => [h.name, h.value])),
  };

  return {
    get id() {
      return request.id;
    },
    get name() {
      return request.name;
    },
    get method() {
      return request.method;
    },
    set method(value: string) {
      request.method = String(value).toUpperCase();
    },
    get url() {
      return request.url;
    },
    set url(value: string) {
      request.url = String(value);
    },
    headers,
    body: {
      get raw(): string | undefined {
        const text = request.body?.text;
        return typeof text === "string" ? text : undefined;
      },
      set raw(value: string) {
        request.body = { ...request.body, text: String(value) };
      },
    },
  };
}

function responseView(response: ScriptResponse) {
  const header = (name: string) =>
    response.headers.find((h) => h.name.toLowerCase() === String(name).toLowerCase())?.value;
  const text = () => {
    if (response.body == null) throw new Error("Response body is not available");
    return response.body;
  };

  return {
    code: response.status,
    status: response.statusReason ?? "",
    responseTime: response.elapsed,
    url: response.url,
    headers: {
      get: header,
      has: (name: string) => header(name) != null,
      toObject: () => Object.fromEntries(response.headers.map((h) => [h.name, h.value])),
    },
    text,
    json: () => JSON.parse(text()),
    to: {
      have: {
        status(code: number) {
          if (response.status !== code) {
            throw new Error(`expected response to have status ${code} but got ${response.status}`);
          }
        },
        header(name: string) {
          if (header(name) == null) throw new Error(`expected response to have header ${name}`);
        },
      },
      be: {
        get ok() {
          if (response.status < 200 || response.status >= 300) {
            throw new Error(`expected response to be ok but got ${response.status}`);
          }
          return true;
        },
      },
    },
  };
}

type HeaderInput = { key?: string; name?: string; value?: unknown } | string;

function toHeader(header: HeaderInput): HttpRequestHeader {
  if (typeof header === "string") {
    const index = header.indexOf(":");
    return {
      enabled: true,
      name: (index === -1 ? header : header.slice(0, index)).trim(),
      value: index === -1 ? "" : header.slice(index + 1).trim(),
    };
  }
  return {
    enabled: true,
    name: String(header.key ?? header.name ?? ""),
    value: stringifyVar(header.value ?? ""),
  };
}

interface SendRequestOptions {
  url: string;
  method?: string;
  header?: Record<string, unknown> | Array<{ key: string; value: unknown }>;
  body?: {
    mode?: "raw" | "urlencoded";
    raw?: string;
    urlencoded?: Array<{ key: string; value: unknown }>;
  };
}

/** Turn `yk.sendRequest`'s Postman-shaped options into a Yaak request. */
export function toYaakRequest(options: string | SendRequestOptions): Partial<HttpRequest> {
  if (typeof options === "string") return { method: "GET", url: options };

  const headers: HttpRequestHeader[] = Array.isArray(options.header)
    ? options.header.map((h) => toHeader(h))
    : Object.entries(options.header ?? {}).map(([name, value]) => toHeader({ name, value }));
  const request: Partial<HttpRequest> = {
    method: (options.method ?? "GET").toUpperCase(),
    url: options.url,
    headers,
  };

  if (options.body?.mode === "urlencoded") {
    request.bodyType = "application/x-www-form-urlencoded";
    request.body = {
      form: (options.body.urlencoded ?? []).map((p) => ({
        enabled: true,
        name: p.key,
        value: stringifyVar(p.value ?? ""),
      })),
    };
  } else if (options.body?.raw != null) {
    const contentType = headers.find((h) => h.name.toLowerCase() === "content-type")?.value;
    request.bodyType = contentType?.includes("json") ? "application/json" : "other";
    request.body = { text: options.body.raw };
  }

  return request;
}

const VAR_PATTERN = /\$\{\[\s*([A-Za-z_][\w.-]*)\s*\]\}/g;

/**
 * Replace `${[ name ]}` with a script variable of that name, leaving the rest
 * of the template for Yaak to render.
 */
export function applyVars<T>(value: T, vars: ScriptVars): T {
  if (typeof value === "string") {
    return value.replace(VAR_PATTERN, (match, name: string) =>
      Object.hasOwn(vars, name) ? stringifyVar(vars[name]) : match,
    ) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => applyVars(v, vars)) as T;
  }
  if (value != null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, applyVars(v, vars)])) as T;
  }
  return value;
}

export function applyVarsToRequest<T extends Partial<HttpRequest>>(
  request: T,
  vars: ScriptVars,
): T {
  if (Object.keys(vars).length === 0) return request;
  return {
    ...request,
    url: applyVars(request.url, vars),
    urlParameters: applyVars(request.urlParameters, vars),
    headers: applyVars(request.headers, vars),
    body: applyVars(request.body, vars),
    authentication: applyVars(request.authentication, vars),
  };
}

export function stringifyVar(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A small, chai-shaped subset of what Postman's `pm.expect` offers. */
export function expect(actual: unknown) {
  let negate = false;
  let deep = false;

  const assertion = {} as Record<string, unknown>;
  const check = (passed: boolean, message: string) => {
    if (passed === negate) {
      throw new Error(`expected ${show(actual)} ${negate ? "not " : ""}${message}`);
    }
    return assertion;
  };

  const methods: Record<string, (...args: never[]) => unknown> = {
    equal: (expected: unknown) =>
      deep
        ? check(deepEqual(actual, expected), `to deeply equal ${show(expected)}`)
        : check(Object.is(actual, expected), `to equal ${show(expected)}`),
    eql: (expected: unknown) =>
      check(deepEqual(actual, expected), `to deeply equal ${show(expected)}`),
    include: (expected: unknown) =>
      check(includes(actual, expected), `to include ${show(expected)}`),
    match: (pattern: RegExp) =>
      check(typeof actual === "string" && pattern.test(actual), `to match ${String(pattern)}`),
    above: (n: number) => check(typeof actual === "number" && actual > n, `to be above ${n}`),
    below: (n: number) => check(typeof actual === "number" && actual < n, `to be below ${n}`),
    least: (n: number) => check(typeof actual === "number" && actual >= n, `to be at least ${n}`),
    most: (n: number) => check(typeof actual === "number" && actual <= n, `to be at most ${n}`),
    oneOf: (list: unknown[]) =>
      check(
        Array.isArray(list) && list.some((v) => deepEqual(v, actual)),
        `to be one of ${show(list)}`,
      ),
    a: (type: string) => check(typeOf(actual) === String(type).toLowerCase(), `to be a ${type}`),
    property: (name: string, ...value: unknown[]) =>
      check(
        actual != null &&
          typeof actual === "object" &&
          name in actual &&
          (value.length === 0 || deepEqual((actual as Record<string, unknown>)[name], value[0])),
        value.length === 0
          ? `to have property ${show(name)}`
          : `to have property ${show(name)} of ${show(value[0])}`,
      ),
    lengthOf: (n: number) =>
      check(actual != null && (actual as { length?: unknown }).length === n, `to have length ${n}`),
  };
  const aliases: Record<string, string> = {
    equals: "equal",
    eq: "equal",
    eqls: "eql",
    includes: "include",
    contain: "include",
    contains: "include",
    an: "a",
    greaterThan: "above",
    gt: "above",
    lessThan: "below",
    lt: "below",
    gte: "least",
    lte: "most",
    length: "lengthOf",
  };
  for (const [name, fn] of Object.entries(methods)) assertion[name] = fn;
  for (const [alias, name] of Object.entries(aliases)) assertion[alias] = methods[name];

  const flags: Record<string, () => unknown> = {
    not: () => {
      negate = !negate;
      return assertion;
    },
    deep: () => {
      deep = true;
      return assertion;
    },
    ok: () => check(Boolean(actual), "to be truthy"),
    true: () => check(actual === true, "to be true"),
    false: () => check(actual === false, "to be false"),
    null: () => check(actual === null, "to be null"),
    undefined: () => check(actual === undefined, "to be undefined"),
    exist: () => check(actual != null, "to exist"),
    empty: () => check(isEmpty(actual), "to be empty"),
  };
  for (const word of [
    "to",
    "be",
    "been",
    "is",
    "that",
    "which",
    "and",
    "has",
    "have",
    "with",
    "at",
    "of",
    "same",
    "does",
  ]) {
    flags[word] = () => assertion;
  }
  for (const [name, get] of Object.entries(flags)) {
    Object.defineProperty(assertion, name, { get, enumerable: false });
  }

  return assertion;
}

function includes(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === "string") return haystack.includes(String(needle));
  if (Array.isArray(haystack)) return haystack.some((v) => deepEqual(v, needle));
  if (
    haystack != null &&
    typeof haystack === "object" &&
    needle != null &&
    typeof needle === "object"
  ) {
    return Object.entries(needle).every(([k, v]) =>
      deepEqual((haystack as Record<string, unknown>)[k], v),
    );
  }
  return false;
}

function isEmpty(value: unknown): boolean {
  if (typeof value === "string" || Array.isArray(value)) return value.length === 0;
  if (value != null && typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Structural equality that ignores prototypes, because a value a script builds
 * and one the plugin parsed come from different realms and never share one.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) =>
      Object.hasOwn(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function show(value: unknown): string {
  return inspect(value, { depth: 2, breakLength: Infinity });
}

export function errorMessage(err: unknown): string {
  // Errors thrown inside the script come from another realm, so `instanceof
  // Error` is false for them
  if (err != null && typeof err === "object" && "message" in err) return String(err.message);
  return String(err);
}
