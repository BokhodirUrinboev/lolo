Zo'r, `num_ctx` 32k qilingani asosiy muammoni yopadi. Quyida o'sha model atrofida qurilgan to'liq extension rejasi: bitta work order, hamma modul birga.

# Loyiha: Local-first AI Coding Agent (VS Code extension)

**Maqsad:** `qwen2.5-coder-32k` kabi 7B–14B lokal modellar bilan Cline/Copilot darajasidagi UX: chat, inline edit, multi-file agent, autocomplete, diff review, checkpoint. Sifat model hisobiga emas, orchestration hisobiga olinadi.

**Stack:** TypeScript, esbuild, VS Code Extension API. Webview UI uchun React + Vite. Kod tahlili uchun `web-tree-sitter` (WASM), qidiruv uchun `@vscode/ripgrep`, model bilan aloqa uchun Ollama API va OpenAI-compatible API (llama.cpp, LM Studio, vLLM ham ulanadi).

## Repo tuzilmasi

```
agent-ext/
├─ src/
│  ├─ extension.ts              # activate, command'lar, DI
│  ├─ providers/                # LLM qatlami
│  │  ├─ ollama.ts              # /api/chat, /api/generate (FIM), format=schema
│  │  ├─ openaiCompat.ts
│  │  └─ modelProfiles.ts       # har model uchun sozlamalar
│  ├─ context/
│  │  ├─ repoMap.ts             # tree-sitter symbol xaritasi + ranking
│  │  ├─ collectors.ts          # active file, selection, tabs, diagnostics, git diff
│  │  ├─ mentions.ts            # @file @symbol @problems @git @terminal
│  │  └─ budget.ts              # token budgeter
│  ├─ edit/
│  │  ├─ formats.ts             # whole-file | search-replace | line-range
│  │  ├─ fuzzyApply.ts
│  │  ├─ diffView.ts            # inline decoration + CodeLens Accept/Reject per hunk
│  │  └─ checkpoints.ts         # shadow git snapshot / restore
│  ├─ tools/
│  │  ├─ registry.ts            # schema, validate, permission
│  │  ├─ readFile.ts search.ts listDir.ts edit.ts createFile.ts
│  │  ├─ runCommand.ts          # shell integration orqali output ushlash
│  │  └─ diagnostics.ts
│  ├─ agent/
│  │  ├─ loop.ts                # plan → act → verify → repair
│  │  ├─ planner.ts             # todo list
│  │  ├─ prompts.ts             # qisqa, modelga moslangan promptlar
│  │  ├─ compaction.ts          # history siqish
│  │  └─ trajectoryLog.ts       # JSONL log (eval + fine-tune dataset)
│  ├─ autocomplete/
│  │  └─ fimProvider.ts         # InlineCompletionItemProvider
│  ├─ inline/
│  │  └─ inlineEdit.ts          # Ctrl+I: selection'ni tahrirlash
│  └─ ui/webview/               # React chat panel
├─ eval/
│  ├─ tasks/                    # .NET va TS repo'larda benchmark vazifalar
│  └─ runner.ts                 # headless agent run + metrikalar
└─ .agent/rules.md (namuna)     # loyiha qoidalari, CLAUDE.md analogi
```

## Modullar

### 1. Provider va Model Profile qatlami

Har model o'z profile'iga ega. Agentning qolgan qismi modelni emas, profile'ni biladi:

```ts
interface ModelProfile {
  id: string;                    // "qwen2.5-coder-32k:latest"
  ctx: number;                   // 32768
  toolMode: "schema" | "native" | "xml";   // qwen 7B uchun: schema
  editFormat: "whole" | "search-replace" | "line-range" | "auto";
  wholeFileMaxLines: number;     // 150
  fim?: { prefix: string; suffix: string; middle: string };  // <|fim_prefix|> ...
  temperature: number;
  maxOutput: number;
}
```

Katta model (masalan Qwen3-Coder-30B-A3B) ulansa, `toolMode: "native"` bo'ladi va prompt boyroq ketadi. Kichik modelda aksincha. Shu tariqa bitta extension har xil model bilan ishlaydi.

Prompt tartibi ataylab barqaror saqlanadi: system prompt → rules → repo map → keyin o'zgaruvchan qism. Ollama bir xil prefix'ni KV-cache'da ushlab turadi, shunda har step'da 32k context qayta prefill qilinmaydi. CPU'da bu tezlikni bir necha barobar oshiradi.

### 2. Context Engine

Asosiy tamoyil: contextni kod yig'adi, model "qaysi faylni o'qiy?" deb iteratsiya qilib vaqt yo'qotmaydi.

- **Repo map:** tree-sitter bilan har fayldan class, method va signature'lar olinadi. Ular reference graph bo'yicha rank qilinadi (Aider uslubidagi PageRank) va budjetga sig'adigan ~2–4k tokenli xarita promptga qo'shiladi. Index fayl o'zgarganda incremental yangilanadi.
- **Collectors:** active file (cursor atrofi), selection, ochiq tab'lar, `getDiagnostics()`, `git diff`, oxirgi terminal output.
- **@-mention'lar:** `@file`, `@folder`, `@symbol` (LSP `executeWorkspaceSymbolProvider`), `@problems`, `@git`, `@terminal`.
- **Budget:** har bo'limga token kvota beriladi (masalan rules 5%, map 12%, fayllar 45%, history 25%, output zaxirasi 13%). Oshsa, eng past prioritetli qism kesiladi.
- **Rules:** `.agent/rules.md` fayli bor bo'lsa, u doim promptga kiradi. Loyiha konvensiyalari, build/test komandalari va taqiqlar shu yerda yoziladi.

### 3. Tool Layer

Tool'lar to'plami: `read_file` (range bilan), `search` (ripgrep), `list_dir`, `edit`, `create_file`, `run_command`, `get_diagnostics`, `ask_user`, `done`.

- **Constrained decoding:** schema mode'da tool call `format: JSONSchema` bilan majburlanadi. Keyin kod darajasida validate qilinadi: path workspace ichidami, fayl mavjudmi, kerakli maydonlar to'ldirilganmi. Xato bo'lsa, aniq sababi bilan qayta so'raladi.
- **Permission tizimi:** read tool'lar avtomatik ishlaydi. Write tool'lar diff preview orqali tasdiqlanadi yoki "auto-approve edits" sozlamasi bilan o'tadi. `run_command` uchun allowlist bor (`dotnet build`, `dotnet test`, `npm test` va hokazo), qolganlari uchun tasdiq so'raladi. `rm -rf` kabi xavfli pattern'lar doim bloklanadi.
- **Terminal:** `terminal.shellIntegration.executeCommand` orqali output va exit code ushlanadi. Uzun output'ning boshi va oxiri qoldiriladi, xato qatorlari esa to'liq saqlanadi.

### 4. Edit Engine

- **Format tanlash (`auto`):** fayl `wholeFileMaxLines` dan kichik bo'lsa whole-file rewrite, katta bo'lsa search-replace. Search-replace ikki marta fail bo'lsa, line-range formatiga o'tiladi: fayl raqamlangan qatorlar bilan qayta ko'rsatiladi va model `{start, end, content}` beradi.
- **fuzzyApply:** match uch bosqichda qidiriladi: exact → whitespace-normalized → fuzzy (≥0.85). Indentatsiya avtomatik tiklanadi. Match topilmasa, eng yaqin fragment modelga qaytariladi.
- **"Lazy edit" himoyasi:** whole-file javobda `// ... existing code ...` kabi placeholder'lar aniqlanadi va asl fayldan to'ldiriladi (merge). Bunday holatlar 7B modelda tez-tez uchraydi.
- **Diff UX:** o'zgarishlar editor ichida inline decoration bilan ko'rinadi: yashil va qizil qatorlar, har hunk ustida `Accept | Reject` CodeLens. "Accept all" va "Reject all" ham bor. Qo'llash `WorkspaceEdit` orqali bo'ladi, shunda native undo ham ishlaydi.
- **Checkpoints:** har agent run'dan oldin `.agent/checkpoints` ichidagi shadow git repo'ga snapshot olinadi. Foydalanuvchi git'iga tegilmaydi. Chat'dagi istalgan xabarga "shu nuqtaga qaytarish" imkoni bor.

### 5. Agent Loop

```
User task
  → Planner: 2–6 bandli todo list (model yozadi, UI'da ko'rinadi, foydalanuvchi tahrirlay oladi)
  → har band uchun:
       Context (kod yig'adi) → Act (bitta tool call) → Observe
       → edit bo'lsa: Verify (diagnostics + rules'dagi build/test)
       → xato bo'lsa: Repair (≤3 urinish, xato qatorlari bilan)
  → done: o'zgarishlar xulosasi + diff review
```

- Har step'da bitta tool call bo'ladi. Kichik model uchun parallel call'lar beqaror.
- **Stuck detection:** bir xil tool va argument 2 marta takrorlansa yoki N step davomida progress bo'lmasa, strategiya almashadi (edit formati o'zgaradi yoki foydalanuvchidan so'raladi).
- **Compaction:** eski observation'lar bir qatorlik xulosaga qisqartiriladi ("read_file X: 240 qator, UserService class"). Oxirgi 3 step to'liq qoladi.
- **Rejimlar:** Ask (faqat read tool'lar), Agent (hammasi) va Plan-only (reja tuzadi, lekin bajarmaydi).

### 6. Autocomplete (FIM)

qwen2.5-coder native FIM token'larini qo'llaydi (`<|fim_prefix|>…<|fim_suffix|>…<|fim_middle|>`). `InlineCompletionItemProvider` quyidagicha ishlaydi:

- Debounce ~250ms, oldingi so'rov `AbortController` bilan bekor qilinadi.
- Prefix va suffix cursor atrofidan olinadi, repo map'dan tegishli import va signature'lar prefix boshiga qo'shiladi.
- Stop qoidalari: blok yopilishida yoki keyingi top-level declaration'da to'xtaydi. Suffix bilan takrorlanayotgan qism kesiladi.
- Autocomplete uchun alohida kichikroq model tanlash mumkin (masalan `qwen2.5-coder:1.5b`), CPU'da ayniqsa foydali.

### 7. Inline Edit (Ctrl+I)

Selection va ko'rsatma yoziladi, model tanlangan qism uchun whole-block rewrite qiladi. Natija joyida inline diff bo'lib chiqadi, Tab bilan qabul qilinadi, Esc bilan rad etiladi. Bu 7B model uchun eng ishonchli rejim, chunki context tor va format sodda.

### 8. UI (Webview)

- Chat panel: markdown, kod bloklari "Apply" tugmasi bilan, streaming.
- Tool call'lar yig'iladigan kartalar ko'rinishida ("📄 read UserService.cs", "✏️ edit 2 hunks").
- Todo list progress, token va context bandligi indikatori.
- Model tanlash dropdown'i va rejim almashtirgich (Ask / Agent / Plan).
- Chat history `workspaceState`'da saqlanadi.

### 9. Eval harness va Trajectory log

Kichik model bilan ishlaganda bu modul majburiy: prompt yoki format o'zgarishi yaxshilandimi yo'qmi, faqat raqam ko'rsatadi.

- `eval/tasks/` ichida 30–50 ta vazifa bo'ladi. Har biri: repo snapshot, topshiriq va tekshiruv komandasi (`dotnet test --filter ...`). O'zingizning .NET kutubxonalaringizdan olingan real vazifalar eng yaxshi manba.
- **Metrikalar:** tool-call validity %, edit apply %, task pass %, o'rtacha step soni va vaqt.
- Har run JSONL formatida log qilinadi. Muvaffaqiyatli trajectory'lar keyin LoRA fine-tune uchun dataset bo'ladi, ya'ni o'zingizning "tuned" modelingizni o'z agent formatingizga moslab o'qitasiz. 7B model uchun bu eng katta sakrash.

### 10. Sozlamalar va Packaging

- `settings.json` orqali: endpoint, profile'lar, auto-approve, command allowlist, autocomplete model, FIM debounce.
- **Test:** unit testlar (fuzzyApply, budget, validate), `@vscode/test-electron` bilan integration test va eval harness CI'da.
- **Nashr:** `vsce package`, VS Code Marketplace va Open VSX.

## Definition of Done

- `qwen2.5-coder-32k` bilan eval to'plamida tool-call validity ≥ 98% (schema tufayli), edit apply ≥ 95%, task pass ≥ 60%.
- Agent diff preview va checkpoint'siz hech qachon faylga yozmaydi. Istalgan run bitta klik bilan qaytariladi.
- Autocomplete p50 latency GPU'da < 500ms. CPU'da 1.5B model bilan ~1s.
- Boshqa modelga o'tish uchun faqat yangi profile qo'shish kifoya, kod o'zgarmaydi.

> **Holat (0.5.0):** RTX 4070 Ti, Windows 11, 38 vazifa × 2 run. `qwen2.5-coder-32k`: tool-call validity 98.7%, edit apply 89.6%, task pass 78.9% (shu vazifalarda tuzatishlardan oldin 60.5% edi). `qwen3.5:9b`: 99.8%, 95.8%, 93.4%, ya'ni uchala maqsad ham bajarildi. qwen2.5-coder'da edit apply 95% dan past: muvaffaqiyatsiz edit'larning ko'pi modelning `search`'ni noto'g'ri yozishi. Policy rad etgan chaqiruvlar (o'qilmagan faylni tahrirlash yoki ko'chirish, himoyalangan testlar) validity'ga kirmaydi, alohida sanaladi (qwen2.5-coder'da 6.0%). Autocomplete (`eval.js fim`, 40 ta completion, 250 ms debounce'siz): GPU'da qwen2.5-coder:1.5b p50 60 ms (p90 121 ms), 7b p50 156 ms (p90 780 ms); faqat CPU'da 1.5b p50 325 ms (p90 1.07 s). Diff preview va checkpoint'siz yozish yo'q; model o'qimagan faylni tahrirlay olmaydi. Yangi model oilalari (qwen2.5, qwen3, llama3, gemma3, mistral, deepseek-coder-v2, starcoder2, codellama) faqat profile bilan qo'shildi.

## Keyingi bosqich (0.4+)

0.3 bilan asosiy reja bajarildi. Endi agent imkoniyatlarini kengaytiramiz. Asosiy qoida o'zgarmaydi: kichik model uchun **har bir yangi tool bu yangi xato ehtimoli**. Har tool `anyOf` schema'ga yangi branch qo'shadi, 7B model esa ro'yxat qancha uzun bo'lsa, tool'ni shuncha ko'p adashtiradi. Shuning uchun har imkoniyat:

- default holatda o'chiq yoki faqat kerak bo'lganda yoqiladi;
- eval'da o'lchanadi: validity va pass % tushmasligi kerak;
- tashqariga chiqadigan har qanday so'rov (internet, MCP) permission kartasidan o'tadi.

### 11. Tooling'ni kuchaytirish

> **Holat (0.4.0): bajarildi.** Bitta farq bor: tool guruhlarini planner emas, kod tanlaydi (`agent/needs.ts`, kalit so'zlar orqali). Planner'ning `needs` maydoni 7B model uchun yana bitta xato manbai bo'lardi. Eval: 6 vazifada pass 83% → 92%, o'rtacha qadam 7.6 → 4.2 (rename 11–18 qadam o'rniga 2 qadamda).

- **Dinamik tool to'plami:** har todo uchun faqat kerakli tool'lar yoqiladi. Planner todo'ga `needs` (masalan `edit`, `run`, `web`, `mcp:db`) belgilaydi, kod shunga qarab `anyOf` branch'larini tanlaydi. Maqsad: bir step'da ≤ 8 tool.
- **LSP tool'lari** (Host orqali, core `vscode`'ni import qilmaydi): `find_references`, `go_to_definition`, `rename_symbol`. Ko'p faylli rename'ni model qo'lda qilgandan ko'ra LSP bilan qilish ancha ishonchli. `NodeHost`'da tree-sitter fallback ishlatiladi.
- **`read_symbol`:** fayl nomi va symbol bo'yicha faqat o'sha funksiya yoki class o'qiladi (tree-sitter). Katta fayllarda context tejaladi.
- **Fayl amallari:** `move_file`, `delete_file` (checkpoint bor, lekin baribir tasdiq so'raladi).
- **Git (read-only):** `git_diff`, `git_log`, `git_blame`. Kerak bo'lsa commit message yozish va o'zgarishlarni review qilish buyruqlari.
- **Test natijalarini parse qilish:** `dotnet test`, jest/vitest, pytest va `cargo test` output'idan yiqilgan testlar `fayl:qator + xabar` ko'rinishida ajratib olinadi. Repair'ga xom log emas, shu ro'yxat beriladi.
- **Background jarayonlar:** hozir server komandalari rad etiladi. Buning o'rniga `start_process` qo'shiladi: jarayon fonda ishga tushadi, port ochilishi kutiladi, log'lar o'qiladi, run oxirida esa jarayon albatta o'ldiriladi. Shunda "API'ni ishga tushirib curl bilan tekshir" kabi vazifalar ham bajariladi.
- **Hooks:** `.agent/rules.md` ichida `after-edit: dotnet format` va `before-done: npm run lint` kabi qatorlar. Formatlashni model emas, kod qiladi.
- **Semantic search:** Ollama embedding modeli (`nomic-embed-text`) bilan kod bo'laklari indekslanadi (`.agent/index`). `search` tool'iga `semantic: true` rejimi qo'shiladi. Repo map'ni to'ldiradi, o'rnini bosmaydi.

### 12. MCP (Model Context Protocol)

> **Holat (0.4.0): bajarildi**, Lolo'ni MCP server qilish ham (`cli --mcp-server`). VS Code'ning `vscode.lm.tools` API'si 1.93 engine'da yo'q, shuning uchun uning o'rniga `.vscode/mcp.json` va `mcp.servers` sozlamasi o'qiladi.

> **Holat (0.5.0):** chat'dagi "Tools" menyusi qo'shildi: `/mcp` har serverning tool'larini ro'yxat qilib ko'rsatadi, belgisi olib tashlangan tool agentga hech qachon taklif qilinmaydi (workspace uchun saqlanadi).

- **MCP client:** `@modelcontextprotocol/sdk` bilan stdio va streamable HTTP transport'lari. Konfiguratsiya `.agent/mcp.json` va `localAgent.mcpServers` sozlamasida bo'ladi. VS Code'ning o'zida sozlangan MCP serverlar ham ko'rinadi (`vscode.lm.tools`, `VsCodeHost` orqali).
- **Tool mapping:** MCP tool'ning `inputSchema`'si `anyOf` branch'iga aylanadi, nomi `mcp__<server>__<tool>` ko'rinishida bo'ladi. Schema Ollama `format` tushunadigan subset'ga keltiriladi: `$ref` ochiladi, qo'llab-quvvatlanmaydigan keyword'lar olib tashlanadi. Tavsif qisqartiriladi, chunki uzun tavsif prompt'ni shishiradi.
- **Tanlash:** MCP serverlarda o'nlab tool bo'lishi mumkin. Foydalanuvchi har server uchun qaysi tool'lar yoqilishini belgilaydi (chat'dagi "Tools" menyusi). Qolganini dinamik to'plam (11-bo'lim) filtrlaydi: todo matniga eng mos top-k tool olinadi.
- **Permission:** MCP tool'lar default holatda tasdiq so'raydi. `readOnlyHint` annotatsiyasi bor tool'lar read tool kabi avtomatik o'tadi. "Don't ask again" tool bo'yicha ishlaydi.
- **Resources va prompts:** MCP resource'lar `@mcp:<server>/<resource>` mention bo'ladi, MCP prompt'lar esa `/` buyruqlari ro'yxatida chiqadi.
- **Natija hajmi:** katta output kesiladi va budget'ga sig'diriladi, rasm yoki binary kontent matnli izoh bilan almashtiriladi.
- **Keyinroq:** Agent Lolo'ning o'zini MCP server qilib ochish (`edit` engine va repo map'ni boshqa agentlar ham ishlatishi uchun).

### 13. Web search va fetch

> **Holat (0.4.0): bajarildi.** Qo'shimcha provider sifatida DuckDuckGo qo'shildi (kalitsiz). `@docs` avval lokal o'rnatilgan paketdan o'qiydi, registry'ga (npm/PyPI) faqat web yoqilgan bo'lsa murojaat qiladi.

- **`web_search`:** provider tanlanadi. Default va local-first varianti SearXNG (self-hosted), qo'shimcha variantlar Brave Search API va Tavily (API key bilan). Default holatda o'chiq. Yoqilganda ham har query tasdiq kartasida ko'rsatiladi, chunki ma'lumot mashinadan tashqariga chiqadi.
- **`fetch_url`:** faqat http(s). Sahifa readability → markdown'ga o'tkaziladi va `.agent/cache`'da saqlanadi. Lokal/private IP manzillar bloklanadi.
- **Kichik model uchun siqish:** butun sahifa context'ga tiqilmaydi. Alohida model chaqiruvi sahifadan faqat savolga tegishli qismni ajratib beradi ("extract, don't summarize": kod misollari so'zma-so'z qoladi).
- **Qachon qidiradi:** foydalanuvchi `@web` yozganda yoki planner `needs: web` qo'yganda. Model o'zi xohlagan payt qidirmaydi, aks holda 7B model ish o'rniga qidiruvga berilib ketadi (xuddi `ask_user` bilan bo'lgani kabi).
- **`@docs`:** o'rnatilgan paket versiyasiga mos hujjatlar (masalan NuGet yoki npm paketining README'si yoki docs sahifasi) mention sifatida qo'shiladi. Bu Context7 kabi MCP server orqali ham qilinishi mumkin.

### 14. Boshqa yo'nalishlar

> **Holat (0.4.0):** explore, memory, custom buyruqlar, rasm kiritish va eval'ni 14 vazifaga (JS, Python, C#, Go) kengaytirish bajarildi. Fine-tune pipeline'i tayyor (`scripts/finetune`), lekin o'qitish hali ishga tushirilmagan: GPU'da soatlab vaqt va torch/unsloth o'rnatish kerak. Windows/macOS'da test qilish va Open VSX'ga chiqarish (`npm run publish:ovsx`, token kerak) qo'lda qilinadi.

> **Holat (0.5.0):** Windows 11'da to'liq sinovdan o'tdi: unit testlar, haqiqiy VS Code ichidagi smoke test va eval. Buyruqlar Git Bash'da ishlaydi (model yozadigan `ls`, `grep`, `&&`, `test -f` Windows'da ham ishlaydi), `python3` faqat Microsoft Store yorlig'i bo'lsa shim qo'yiladi, fon serverlari (`npm run dev`) run oxirida albatta to'xtatiladi. CI testlar va smoke test'ni Linux, Windows va macOS'da ishga tushiradi (macOS shu yo'l bilan tekshiriladi). Eval 14 dan 38 vazifaga kengaytirildi: .NET, ko'p faylli refactor, TypeScript, MCP (mock tracker server), web (yozib olingan javoblar), git, xotira, fon server va ikki xabarli suhbat; har vazifada namunaviy yechim bor, `eval.js validate` ularni tekshiradi; CI'da nightly eval. Eval topgan xatolar orchestration'da tuzatildi (CHANGELOG, 0.5.0). Marketplace va Open VSX'ga nashr `release.yml` orqali: `v*` tag, VSCE_PAT/OVSX_PAT secret qo'shilganda. Fine-tune bajarildi: eval'dagi muvaffaqiyatli run'lardan 2044 ta namuna olindi (12 ta vazifa `eval.js export --exclude` bilan chetda qoldirildi), `qwen2.5-coder:7b` QLoRA bilan RTX 4070 Ti'da 1 soatda o'qitildi, llama.cpp orqali Q4_K_M GGUF qilinib `lolo-coder` nomi bilan Ollama'ga qo'shildi (hozirgi Ollama safetensors'ni faqat MLX arxitekturalari uchun import qiladi). Chetda qoldirilgan vazifalarda, 4 run: `lolo-coder` 77.1% (validity 100%, edit apply 91.3%, o'rtacha 6.8 step), asosiy model 72.9% (99.5%, 84.8%, 7.9 step). Yutuq bor, lekin orchestration bergan yutuqdan kichik: o'sha vazifalarda asosiy modelning o'zi 61% dan 73% ga chiqdi. Muhim ikki narsa: Modelfile qwen2.5-coder'ning template'ini saqlashi kerak (har xabarni chiqaradigan template system prompt'ni ikki marta yuborgan va natija 39% ga tushgan), Windows'da esa unsloth attention'i SDPA'ning GQA yo'lidan qochishi kerak (FlashAttention yo'q: 3 barobar sekin va 12 GB yetmaydi).

- **Explore sub-run:** read-only tool'lar bilan alohida qisqa run ishlaydi va asosiy run'ga faqat xulosa qaytaradi ("qaysi fayllar, qaysi funksiyalar"). Asosiy context toza qoladi. Kichik model uchun bu parallel agentlardan foydaliroq.
- **Uzoq muddatli xotira:** `.agent/memory.md`. Agent loyiha haqidagi faktlarni taklif qiladi, foydalanuvchi tasdiqlagani saqlanadi va prompt'ga kiradi (rules'dan keyin, o'zgarmas qism sifatida, KV cache buzilmaydi).
- **Custom slash buyruqlar:** `.agent/commands/*.md` fayllari `/nom` bo'lib chiqadi (prompt shablon + `$ARGUMENTS`).
- **Rasm kiritish:** multimodal modellar (qwen3.5, qwen2.5-vl) uchun screenshot'ni chat'ga paste qilish ("shu UI xatosini tuzat").
- **Eval'ni kengaytirish:** 6 vazifadan 30–50 taga. Real .NET vazifalari, ko'p faylli refactor, MCP (mock server) va web (yozib olingan javoblar) vazifalari. CI'da nightly run.
- **Fine-tune:** trajectory'lardan LoRA dataset (`eval.js export`) yig'iladi, `qwen2.5-coder:7b` Lolo tool formatiga moslab o'qitiladi va eval'da taqqoslanadi. *(0.5.0'da bajarildi: `lolo-coder`, yuqoridagi holatga qarang.)*
- **Platformalar:** Windows va macOS'da to'liq test, Open VSX'ga nashr.

**Tartib:** 11 (dinamik tool to'plami, test parse, LSP) → 13 (web, eng ko'p so'raladigan narsa) → 12 (MCP) → 14. Har bosqich oxirida eval natijasi CHANGELOG'ga yoziladi.