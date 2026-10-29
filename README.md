# Scripts for Yaak

**English** | [Português](README.pt-BR.md)

A [Yaak](https://yaak.app) plugin that adds Postman-style pre-request and post-response scripts: change a request before it is sent, test the response, keep variables between requests, and run a whole folder in order.

```js
// Pre-request
yk.request.headers.upsert({ key: "X-Request-Id", value: crypto.randomUUID() });

// Post-response
yk.test("status 200", () => yk.response.to.have.status(200));
yk.variables.set("token", yk.response.json().token);
```

## Installation

1. Download `yaak-plugin-script-vX.Y.Z.zip` from the [latest release](https://github.com/aejuniordev/action-script/releases/latest).
2. Extract it. The zip contains a `yaak-plugin-script/` folder (`package.json` + `build/`).
3. In Yaak, open **Settings → Plugins** and add the extracted folder.

## Usage

The plugin adds these actions to Yaak's menus:

| Where | Action | What it does |
| --- | --- | --- |
| Request | **Edit Scripts** | Edit the request's pre-request and post-response scripts |
| Request | **Send with Scripts** | Run the pre-request script, send, run the post-response script, and show the results |
| Folder | **Run with Scripts** | Do the same for every request in the folder (and subfolders), in sidebar order |
| Workspace | **Script Variables** | View and edit the script variables as JSON |
| Request, folder, workspace | **Stop Scripts** | Stop every script run still going |

Yaak's regular **Send** does not run scripts; use **Send with Scripts**.

If the pre-request script fails, the request is not sent. The pre-request script edits a copy of the request, so the saved request is left unchanged.

When there are logs, errors, or failing tests, a report opens; otherwise a toast shows the status. A run still going after 3 s shows a toast saying how to stop it.

### Variables

Variables are saved per workspace and shared by all its requests. In **Run with Scripts**, one request can hand values to the next.

To use a variable in a request:

- `${[ name ]}` is replaced with the variable's value in requests sent with **Send with Scripts** / **Run with Scripts**. If there is no such variable, Yaak renders it as usual (for example, an environment variable with that name).
- `${[ script.var(name="name") ]}` reads the variable in any request, including a regular **Send**.

Non-string values are inserted as JSON.

## Script API

A script runs as the body of an `async` function, so top-level `await` works. If the script starts a send or a test without `await`, the plugin waits for it before the script finishes, as Postman does.

### `yk.request`

| | |
| --- | --- |
| `id`, `name` | Read-only |
| `method`, `url` | Read and write |
| `body.raw` | Body as text (read and write) |
| `headers.get(name)` / `.has(name)` / `.toObject()` | Enabled headers; names are case-insensitive |
| `headers.upsert({ key, value })` | Replace the header with that name, or add it |
| `headers.add({ key, value })` or `add("Name: value")` | Add |
| `headers.remove(name)` | Remove every header with that name |

### `yk.response` (post-response)

| | |
| --- | --- |
| `code` | Numeric status |
| `status` | Status text (`"OK"`) |
| `responseTime` | Time in ms |
| `url` | Final URL |
| `headers.get(name)` / `.has(name)` / `.toObject()` | Response headers |
| `text()` / `json()` | Body (up to 16 MB) |
| `to.have.status(code)`, `to.have.header(name)`, `to.be.ok` | Assertions |

### Tests

```js
yk.test("user has an id", () => {
  const user = yk.response.json();
  yk.expect(user).to.have.property("id");
  yk.expect(user.name).to.be.a("string").and.not.be.empty;
});
```

`yk.expect` is a subset of chai:

- **Comparison:** `equal` (`eq`, `equals`), `eql` / `deep.equal`, `include` (`contain`), `match`, `oneOf`
- **Numbers:** `above` (`gt`), `below` (`lt`), `least` (`gte`), `most` (`lte`)
- **Type and shape:** `a` / `an`, `property(name[, value])`, `lengthOf`
- **Flags:** `not`, `ok`, `true`, `false`, `null`, `undefined`, `exist`, `empty`
- **Chains:** `to`, `be`, `been`, `is`, `that`, `which`, `and`, `has`, `have`, `with`, `at`, `of`, `same`, `does`

Tests can be `async`.

### Variables

```js
yk.variables.set("token", "abc");
yk.variables.get("token");
yk.variables.has("token");
yk.variables.unset("token");
yk.variables.clear();
yk.variables.toObject();
yk.variables.replaceIn("Bearer ${[ token ]}");
```

`yk.environment`, `yk.collectionVariables`, and `yk.globals` are the same set (Postman keeps them apart).

### Other

```js
// Send another request (a string means GET)
const res = await yk.sendRequest("https://api.example.com/health");

// Or with Postman-style options
const login = await yk.sendRequest({
  url: "https://api.example.com/login",
  method: "POST",
  header: { "Content-Type": "application/json" },
  body: { mode: "raw", raw: JSON.stringify({ user: "a", pass: "b" }) },
});
yk.variables.set("token", login.json().token);

// With a callback
yk.sendRequest("https://api.example.com/ping", (err, res) => console.log(res.code));

// Render a Yaak template against the active environment
const base = await yk.render("${[ baseUrl ]}");

// Wait between steps
await yk.sleep(2000);
```

Also available: `yk.info` (`eventName`, `requestId`, `requestName`), `console.log/info/warn/error/debug`, `crypto`, `atob`, `btoa`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`.

### Limits

- 1 s of synchronous code without yielding. This is the limit an infinite loop hits.
- 30 s in total, including time spent in `await`. A script can change this with `yk.timeout(ms)`, counted from its start; `yk.timeout(0)` removes the limit. A script with no limit runs until it ends or you use **Stop Scripts**.

A script that times out or is stopped goes no further than its next `yk.sleep`, and any `yk.sendRequest` it makes after that fails.

```js
// Poll every 5 s for up to 10 minutes
yk.timeout(10 * 60_000);
while ((await yk.sendRequest("https://api.example.com/job/1")).json().state !== "done") {
  await yk.sleep(5000);
}
```

## Examples

- [`examples/uptime-monitor.js`](examples/uptime-monitor.js): after a request is sent, checks it again every few seconds and reports latency (min, average, p95, max) and failures, with tests for both

## Caveats

- **Scripts are not sandboxed.** `node:vm` keeps globals apart, but a script can reach the plugin runtime. Only run scripts you would trust as a plugin.
- Scripts and variables live in the plugin's storage, not in the workspace data. They are not included in Yaak's export or Git sync.

## Development

Requires Node 24 (needed by `yaakcli`). With nvm:

```sh
nvm install && nvm use
npm install
```

| Command | |
| --- | --- |
| `npm run dev` | Build in watch mode |
| `npm run build` | Build `build/index.js` |
| `npm run typecheck` | Type check |
| `npm test` | Tests (vitest) |

Code:

- `src/index.ts`: actions, template function, and Yaak integration
- `src/runtime.ts`: script execution and the `yk` API, with no runtime dependency on Yaak
- `tests/`: runtime tests

## Release

Pushing a `v*` tag runs `.github/workflows/release.yml`, which type-checks, tests, builds, and publishes a release with the plugin zip. The tag must match `version` in `package.json`.

`npm run release` does all of it, from a clean `master`:

```sh
npm run release -- patch   # 0.4.0 -> 0.4.1
npm run release -- minor   # 0.4.0 -> 0.5.0
npm run release -- 1.0.0   # an exact version
```

It type-checks and tests, bumps `version` in `package.json` and `package-lock.json`, commits `chore: release vX.Y.Z`, tags `vX.Y.Z`, and pushes both. It stops before changing anything if you are on another branch, have uncommitted changes, or a check fails.

## License

[MIT](LICENSE)
