# Scripts para Yaak

[English](README.md) | **Português**

Plugin do [Yaak](https://yaak.app) que adiciona scripts de pré-request e pós-response no estilo do Postman: alterar o request antes de enviar, testar a resposta, guardar variáveis entre requests e rodar uma pasta inteira em sequência.

```js
// Pré-request
yk.request.headers.upsert({ key: "X-Request-Id", value: crypto.randomUUID() });

// Pós-response
yk.test("status 200", () => yk.response.to.have.status(200));
yk.variables.set("token", yk.response.json().token);
```

## Instalação

1. Baixe o `yaak-plugin-script-vX.Y.Z.zip` da [última release](https://github.com/aejuniordev/action-script/releases/latest).
2. Extraia. O zip contém a pasta `yaak-plugin-script/` (`package.json` + `build/`).
3. No Yaak, abra **Settings → Plugins** e adicione a pasta extraída.

## Uso

O plugin adiciona estas ações aos menus do Yaak:

| Onde | Ação | O que faz |
| --- | --- | --- |
| Request | **Edit Scripts** | Edita os scripts de pré-request e pós-response do request |
| Request | **Send with Scripts** | Roda o pré-request, envia, roda o pós-response e mostra o resultado |
| Pasta | **Run with Scripts** | Faz o mesmo com cada request da pasta (e subpastas), na ordem da sidebar |
| Workspace | **Script Variables** | Mostra e edita as variáveis dos scripts como JSON |
| Request, pasta, workspace | **Stop Scripts** | Para todos os scripts que ainda estão rodando |

O **Send** normal do Yaak não roda os scripts; use **Send with Scripts**.

Se o pré-request falhar, o request não é enviado. O pré-request altera uma cópia do request, então o request salvo não muda.

Quando há logs, erros ou testes falhando, abre um relatório; se não, aparece só um toast com o status. Se a execução passar de 3 s, um toast avisa como pará-la.

### Variáveis

As variáveis ficam salvas por workspace e são compartilhadas por todos os requests. Em **Run with Scripts**, um request pode passar valores para o próximo.

Para usar uma variável no request:

- `${[ nome ]}` é substituído pelo valor da variável em requests enviados com **Send with Scripts** / **Run with Scripts**. Se a variável não existir, o Yaak renderiza normalmente (por exemplo, uma variável de environment com esse nome).
- `${[ script.var(name="nome") ]}` lê a variável em qualquer request, inclusive no **Send** normal.

Valores que não são string são inseridos como JSON.

## API dos scripts

O script roda como corpo de uma função `async`, então dá para usar `await` direto, fora de qualquer função. Se o script dispara um envio ou um teste sem `await`, o plugin espera ele terminar antes de encerrar o script, como faz o Postman.

### `yk.request`

| | |
| --- | --- |
| `id`, `name` | Somente leitura |
| `method`, `url` | Leitura e escrita |
| `body.raw` | Corpo como texto (leitura e escrita) |
| `headers.get(name)` / `.has(name)` / `.toObject()` | Headers habilitados; o nome não diferencia maiúsculas de minúsculas |
| `headers.upsert({ key, value })` | Substitui o header com esse nome ou adiciona |
| `headers.add({ key, value })` ou `add("Nome: valor")` | Adiciona |
| `headers.remove(name)` | Remove todos com esse nome |

### `yk.response` (pós-response)

| | |
| --- | --- |
| `code` | Status numérico |
| `status` | Texto do status (`"OK"`) |
| `responseTime` | Tempo em ms |
| `url` | URL final |
| `headers.get(name)` / `.has(name)` / `.toObject()` | Headers da resposta |
| `text()` / `json()` | Corpo (até 16 MB) |
| `to.have.status(code)`, `to.have.header(name)`, `to.be.ok` | Asserções |

### Testes

```js
yk.test("usuário tem id", () => {
  const user = yk.response.json();
  yk.expect(user).to.have.property("id");
  yk.expect(user.name).to.be.a("string").and.not.be.empty;
});
```

`yk.expect` é um subconjunto do chai:

- **Comparação:** `equal` (`eq`, `equals`), `eql` / `deep.equal`, `include` (`contain`), `match`, `oneOf`
- **Números:** `above` (`gt`), `below` (`lt`), `least` (`gte`), `most` (`lte`)
- **Tipo e forma:** `a` / `an`, `property(name[, value])`, `lengthOf`
- **Flags:** `not`, `ok`, `true`, `false`, `null`, `undefined`, `exist`, `empty`
- **Encadeamento:** `to`, `be`, `been`, `is`, `that`, `which`, `and`, `has`, `have`, `with`, `at`, `of`, `same`, `does`

Testes podem ser `async`.

### Variáveis

```js
yk.variables.set("token", "abc");
yk.variables.get("token");
yk.variables.has("token");
yk.variables.unset("token");
yk.variables.clear();
yk.variables.toObject();
yk.variables.replaceIn("Bearer ${[ token ]}");
```

`yk.environment`, `yk.collectionVariables` e `yk.globals` são o mesmo conjunto (no Postman são separados).

### Outros

```js
// Envia outro request (string = GET)
const res = await yk.sendRequest("https://api.example.com/health");

// Ou com opções no formato do Postman
const login = await yk.sendRequest({
  url: "https://api.example.com/login",
  method: "POST",
  header: { "Content-Type": "application/json" },
  body: { mode: "raw", raw: JSON.stringify({ user: "a", pass: "b" }) },
});
yk.variables.set("token", login.json().token);

// Com callback
yk.sendRequest("https://api.example.com/ping", (err, res) => console.log(res.code));

// Renderiza um template do Yaak no environment ativo
const base = await yk.render("${[ baseUrl ]}");

// Espera entre um passo e outro
await yk.sleep(2000);
```

Também disponíveis: `yk.info` (`eventName`, `requestId`, `requestName`), `console.log/info/warn/error/debug`, `crypto`, `atob`, `btoa`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`.

### Limites

- 1 s de código síncrono sem devolver o controle. É esse limite que interrompe um loop infinito.
- 30 s no total, contando o tempo gasto em `await`. O script pode mudar isso com `yk.timeout(ms)`, contado a partir do início dele; `yk.timeout(0)` tira o limite. Um script sem limite roda até terminar ou até você usar **Stop Scripts**.

Um script que estoura o tempo ou é parado não passa do próximo `yk.sleep`, e qualquer `yk.sendRequest` que ele fizer depois disso falha.

```js
// Consulta a cada 5 s, por até 10 minutos
yk.timeout(10 * 60_000);
while ((await yk.sendRequest("https://api.example.com/job/1")).json().state !== "done") {
  await yk.sleep(5000);
}
```

## Exemplos

- [`examples/uptime-monitor.js`](examples/uptime-monitor.js): depois que o request é enviado, repete a checagem a cada poucos segundos e mostra latência (mínima, média, p95, máxima) e falhas, com testes para as duas (comentários em inglês)

## Avisos

- **Scripts não rodam em sandbox.** O `node:vm` separa as variáveis globais, mas um script consegue alcançar o runtime do plugin. Rode só scripts em que você confia tanto quanto em um plugin.
- Scripts e variáveis ficam no armazenamento do plugin, não nos dados do workspace. Não vão junto em export ou Git sync do Yaak.

## Desenvolvimento

Requer Node 24 (exigido pelo `yaakcli`). Com nvm:

```sh
nvm install && nvm use
npm install
```

| Comando | |
| --- | --- |
| `npm run dev` | Build em modo watch |
| `npm run build` | Gera `build/index.js` |
| `npm run typecheck` | Checagem de tipos |
| `npm test` | Testes (vitest) |

Código:

- `src/index.ts`: ações, template function e integração com o Yaak
- `src/runtime.ts`: execução dos scripts e API `yk`, sem dependência do Yaak em runtime
- `tests/`: testes do runtime

## Release

O push de uma tag `v*` dispara `.github/workflows/release.yml`, que roda typecheck, testes e build e publica uma release com o zip do plugin. A tag precisa bater com o `version` do `package.json`.

`npm run release` faz tudo, a partir do `master` sem alterações pendentes:

```sh
npm run release -- patch   # 0.4.0 -> 0.4.1
npm run release -- minor   # 0.4.0 -> 0.5.0
npm run release -- 1.0.0   # versão exata
```

Ele roda typecheck e testes, atualiza o `version` no `package.json` e no `package-lock.json`, faz o commit `chore: release vX.Y.Z`, cria a tag `vX.Y.Z` e envia os dois. Para antes de mudar qualquer coisa se você estiver em outra branch, tiver alterações sem commit ou alguma checagem falhar.

## Licença

[MIT](LICENSE)
