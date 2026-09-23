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

Selection va ko'rsatma yoziladi, model tanlangan qism uchun whole-block rewrite qiladi. Natijantext tor va format sodda.
 joyida inline diff bo'lib chiqadi, Tab bilan qabul qilinadi, Esc bilan rad etiladi. Bu 7B model uchun eng ishonchli rejim, chunki co
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

Keyingi javobda shu rejaning kodini yozishni boshlashim mumkin: yadrodan (`providers` + `tools` + `edit` + `agent/loop`) ishlaydigan skelet, keyin UI va FIM.