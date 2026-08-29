# Model Tuning Reference

Per-model-family rationale behind the entries in `presets/*.ini`, with the measured
numbers each decision rests on. Not auto-loaded into the agent context; read the
relevant section on demand. Cross-model rules are in `docs/presets.md`.

## Qwen 3.6 and 3.8

- **Qwen-VL entries pin `image-min-tokens = 1024`.** `clip.cpp:1500` sets the per-image token limits
  to `(8, 4096)`, so the default *minimum* is 8 tokens — 8192 px at `merge = 2` / `patch = 16` — and
  `clip.cpp:1502-1506` warns on every load because upstream needs >= 1024 tokens (1024x1024 px) for
  grounding (#16842). The key raises a floor only: images already above 1024 tokens are unchanged,
  smaller ones get upscaled, which costs context and CLIP time on the CPU because the 16 GB tier
  sets `no-mmproj-offload = true`; the 24 GB `Qwen3.8-27B` entry offloads CLIP to the GPU and
  pays it there instead. Applies to the `qwen3vl_merger` entries (Qwen3.6, Qwen3.8 and
  Ternary-Bonsai); gemma-4 uses a different projector and must not get this key.

- **All Qwen 3.6, Qwen 3.8 and Bonsai entries pin `chat-template-file = vendor\Qwen-Fixed-Chat-Templates\chat_template.jinja`.**
  Required, *not* redundant with `jinja = true` — `chat-template-file` *replaces*
  the GGUF-embedded template entirely (`vendor/llama.cpp/common/arg.cpp:3142`,
  `params.chat_template = read_file(value)`). The upstream embedded template has
  documented issues with tool calls, role handling, `<think>` block rendering,
  agentic loops, and llama.cpp KV-prefix cache stability; the vendored template
  fixes all of them (full list in `vendor/Qwen-Fixed-Chat-Templates/README.md`).
  Since v19 the template is a single unified file, and since v22 it covers Qwen 3.5,
  3.6 *and* 3.8 (the old `qwen3.5/` and `qwen3.6/` subdirectories now live under
  `archive/`). The template adds a `<|think_on|>` / `<|think_off|>` toggle, and
  defaults `preserve_thinking` to `true` (past `<think>` blocks are kept
  chronologically for 100% KV prefix cache stability and agentic reasoning
  continuity). To strip past `<think>` blocks instead, set
  `chat-template-kwargs = {"preserve_thinking":false}` — at the cost of a lower
  KV cache hit rate. It also honours `preserve_reasoning`, so `--reasoning-preserve`
  (`common/arg.cpp:3677-3689`) works as the CLI equivalent. Path is repo-relative,
  so `llama-server` must be launched from the repo root — `read_file()` resolves
  against the process CWD, not the INI file's directory. `Qwen3-Coder-Next` entries
  deliberately keep their GGUF-embedded template; froggeric's README claims
  compatibility only for Qwen 3.5 / 3.6 / 3.8 variants.

- **Every Qwen 3.6 and Bonsai entry pins `reasoning-effort = medium`; the Qwen 3.8 entries pin
  `xhigh`. Never leave the key unset.** The level is one injected paragraph at the top of the
  system prompt — ~45 tokens of "Reasoning effort is set to xhigh..." — and `medium` is the single
  level that injects nothing at all (`chat_template.jinja:53-59`). Qwen 3.6 has no trained notion of
  the concept, so its entries pin `medium`; Qwen 3.8 *is* trained on it and Qwen's own template
  defaults to `xhigh`, so those pin `xhigh`. The template's own default is a
  `_default_reasoning_effort` variable at the top of the file (`chat_template.jinja:17`), currently
  `medium`, and it has moved between template releases before. That is the whole reason to pin:
  an unpinned entry silently changes reasoning level at a template bump, and a pinned one renders
  byte-identically across bumps. `--reasoning-effort` writes only a template kwarg
  (`common/arg.cpp:3650-3660`), which a request can still override
  (`tools/server/server-common.cpp:1312-1319`), as can a `<|think_low|>` / `<|think_medium|>` /
  `<|think_xhigh|>` tag typed inside a message (stripped before rendering). Unlike the
  GGUF-embedded 3.8 template, the vendored one never raises on an unknown level: it maps `high`,
  `max`, `ultracode` and `extreme` to `xhigh`, `minimal` to `low`, `none` and `off` to thinking
  off, and anything else *down* to `medium` (`chat_template.jinja:21-26`). The `ultracode` and
  `extreme` aliases exist for Claude Code, Cursor and Cline.

- **`xhigh` is kept on `Qwen3.8-27B`, and `--reasoning-budget` — not a lower level — is the guard
  rail for it.** Qwen publishes no per-level benchmarks; every number on the 27B card is at the
  `xhigh` default, and the card warns that in multi-turn agentic tasks lower effort "can also lead
  to insufficient analysis, more failures, and repeated retries". The entire mechanism is one
  injected sentence: 123 rendered chars at `medium` against 332 at `xhigh` — no token, no sampling
  change, no budget. The failure that moved froggeric's default to `medium` is a truncation
  artifact rather than a quality result: with a finite `max_tokens` and no budget, `xhigh` ran
  26,000 tokens and returned `content_len = 0` because truncation landed inside `<think>`, while
  the same rig at `xhigh` with a 1500-token thinking budget returned 18,512 chars of working code,
  more than `medium` produced. There is no rung between the two — `high` aliases to `xhigh`.
  `--reasoning-budget N` (`common/arg.cpp:3662-3668`) is live on this entry and deliberately left
  unset: the qwen3_coder handler supplies `<think>` and `{"</think>", "<tool_call>"}`
  (`common/chat.cpp:1181-1184`), the server forwards them (`server-common.cpp:1360-1366`), and on
  exhaustion the sampler masks every logit but the forced `</think>`
  (`common/reasoning-budget.cpp:119-131`, `:178-185`) so the model concludes instead of being cut
  off, re-arming per thinking block (`:146-161`). Unlike `max_tokens` it counts only tokens inside
  the block. Set it if an agentic client that sends its own `max_tokens` starts returning empty
  content; a request can override it per call via `reasoning_budget_tokens`.

- **`Qwen3.8-27B` pins the template too, even though its embedded one is already the newer file.**
  Qwen 3.8 reuses arch `qwen35` and is otherwise byte-for-byte the same shape as
  Qwen3.6-27B (65 blocks, 866 tensors, same `ssm.*`, same 248320-token tokenizer,
  `eos = 248046`), but it embeds a *different, newer* 8952-byte template, not the
  7764-byte one shared by Qwen3.6-27B and both Bonsai variants. That newer file already
  defaults `preserve_thinking` on and adds `reasoning_effort`, so it is a plausible
  candidate for going unpinned. Three defects rule that out, all
  reproducible by rendering the embedded template directly: tool calls whose `arguments`
  arrive as a JSON *string* (what most OpenAI-compatible clients send) abort with
  `Can only get item pairs from a mapping`; history carrying reasoning inside `content`
  rather than `reasoning_content` renders a duplicate blank `<think>\n\n</think>` ahead
  of the real block, because 3.8 dropped the in-content parser; and `reasoning_effort`
  accepts only `xhigh` / `medium` / `low`, calling `raise_exception` on `high`,
  `minimal` and `max` — three of the six levels `common/arg.cpp:3651` advertises.
  The vendored template handles all three and its `xhigh` instruction text is
  byte-identical to the official one, so `reasoning = on` with `reasoning-effort = xhigh`
  reproduces the pre-pin prompt. Tool-call parsing is unaffected: the qwen3_coder XML handler is
  selected purely on `<tool_call>` + `<function=` + `<parameter=` being present in the
  template source (`common/chat.cpp:3590-3594`), which both files satisfy, and the PEG
  parser is built from `inputs.tools` rather than the rendered `<tools>` block. The pin
  additionally brings froggeric's agentic extras (two-tier tool-error escalation,
  `<|think_on|>` / `<|think_off|>`, `developer` role, payload truncation).

- **The vendored template (v22.4, pinned at `e649070`) corrects two v19 deviations from the
  official Qwen prompt format, so moving to it changed every pinned entry, not just the new 3.8
  ones.** v19 serialized `<tools>` entries *unwrapped*
  (`{"description": ..., "name": ..., "parameters": ...}`); the current template emits the wrapped
  OpenAI form (`{"function": {...}, "type": "function"}`), which is what Qwen3.6-27B's own
  7764-byte template and Qwen 3.8's 8952-byte one both produce — v19 was the outlier. v19 also
  rendered `</think>\n` before assistant content where the official templates and llama.cpp's own
  generation prompt use `</think>\n\n` (`common/chat.cpp:1163`). Both are corrections, but they
  change prompt bytes, so adopting the template invalidates existing KV prefix caches once;
  `reasoning-effort = medium` suppresses only the steering paragraph and does not restore v19
  output.

- **The template emits an empty `<think>\n\n</think>` before a historical tool call whose assistant
  message carried no reasoning, and that is deliberate.** Qwen itself emits a think block before a
  tool call when thinking is on, so injecting an empty one keeps rendered history token-aligned
  with the model's own generation. It fires only when the client drops reasoning on the round trip;
  supplying `reasoning_content`, `thinking`, `message.reasoning` (the vLLM and Responses API
  spelling) or an inline `<think>` block suppresses it. This is *not* the "empty think poisoning"
  the template's README calls out — that was replacing *real* thoughts with empty blocks to save
  tokens, which this template does not do. Verified by rendering the template against plain chat,
  system-prompt, thinking-off, multi-turn-with-thinking, vision, and both tool-argument wire
  formats; the tool-call case is the only one where an unset `reasoning_content` changes the
  output. The same release line also brings the effort aliases above, reasoning de-duplication when
  a client populates both `reasoning_content` and an in-content `<think>`, complete serialization of
  scalar and list tool arguments, and single-newline separation between consecutive `<tool_call>`
  blocks for token parity on multi-tool turns.

- **`Qwen3.8-27B` sets `temp = 1.0`, unlike the `0.6` used by the Qwen 3.6 entries.**
  1.0 is the official thinking-mode value on Qwen's card and is what the GGUF itself
  embeds as `general.sampling.temp`, applied at `common/common.cpp:1264` unless the
  preset overrides it. The rest of the sampler block (`top-p 0.95`, `top-k 20`,
  `min-p 0.0`, `presence-penalty 0`) is unchanged from the 3.6 entries. Qwen 3.8's
  non-thinking mode wants a different set (`temp 0.7`, `top-p 0.8`,
  `presence-penalty 1.5`); the preset does not cover it because `reasoning = on`.

- **Qwen 3.8's MTP head is multi-step trained, so `spec-draft-n-max = 3` is a measured
  peak rather than an inherited default.** A day-0 `n_max` sweep of 2/3/4/6 on this model
  put the maximum at 3 — acceptance falls monotonically with depth, but through 3 the
  extra tokens per iteration win. This overturns the Qwen 3.6 rule of thumb that 2 was
  optimal. 3 also happens to be the upstream default (`common/common.h:325`). Note the
  cost: `draft-mtp` sets `n_rs_seq = spec-draft-n-max` (`common/common.cpp:1699`), which
  multiplies the recurrent-state buffer by `1 + n_max` — ~150 MiB becomes ~600 MiB at 3.
  Both `Qwen3.8-27B` and `Qwen3.6-27B` carry `blk.64` (the MTP head) at `Q4_0` in the
  local IQ4_XS files; a 4-bit MTP head is reported to collapse acceptance to 0% on this
  model family, so check the server's acceptance rate before trusting the speedup. Two
  remedies exist: a re-quant keeping `blk.64` at `Q5_K` or above, or — since 2026-08-14 —
  pointing `spec-draft-model` at `ggml-org/Qwen3.8-27B-GGUF`'s standalone
  `mtp-Qwen3.8-27B-Q8_0.gguf`. Neither is taken. The sidecar is 3.16 GB against the
  ~2.65 GiB of headroom measured below, the `Q4_0` sidecar is the same precision as the
  embedded head, and `mparams.load_mtp` is set from the *type list* rather than from the
  presence of a draft path (`common/common.cpp:1689`, `src/models/qwen35.cpp:42`), so the
  target keeps loading its own `blk.64` and an external sidecar double-pays.

- **`Qwen3.8-27B` is the only 24 GB Qwen entry on a `Q8_0` projector instead of `BF16`.**
  600 MiB rather than 888 MiB of VRAM, and that saving is what keeps `mmproj-offload = true`
  affordable at `ctx-size = 262144`: the entry lands at ~19.95 GiB of ~22.6 GiB usable, just
  under the Qwen3.6-27B entry's ~20.23 GiB, which leaves room for the CLIP compute buffer.
  Spending the saving elsewhere is what breaks it — raising the KV cache to `q5_0` K / `q4_1` V
  costs ~0.80 GiB at this context and pushes the total above the 3.6 entry, into the
  silent-OOM window described in `docs/presets.md` -> *mmproj-offload*. Quality is not the tradeoff: Qwen ships this family's
  projector as FP16 *and* `Q8_0` officially, and only 83 of the file's 110 weight tensors are
  actually 8-bit — every `ffn_down` stays `F16`.

- **Quantize Qwen3.8 GGUFs from `Qwen/Qwen3.8-27B`, never from `Qwen/Qwen3.8-27B-FP8`.** BF16 is
  this model's native precision and the FP8 repo is a derived, post-training artifact (HF model
  tree: base model `Qwen3.8-27B`, "Quantized"), so it is already lossy — its card claims only
  "nearly identical" metrics. Quantizing from it would fit the quantizer and the imatrix to
  degraded weights. This is the opposite of DeepSeek-V3/V4, which were *trained* in FP8, making
  their FP8 checkpoint the original and its dequant to BF16 exact; `convert_hf_to_gguf.py:156`
  (`--fp8-as-q8`) exists for that case, not this one. The mmproj is the one exception where the
  source does not matter: the FP8 repo leaves the whole vision tower unquantized (0 of 333
  `model.visual.*` tensors carry `weight_scale_inv`), so it is byte-identical either way. The
  MTP head is not — `mtp.layers.0`'s attention and MLP projections are FP8 there, so any
  re-quant raising `blk.64` above 4-bit must also come from the BF16 repo.

## Qwen3.8-Flash-Next

Arch `qwen4exp` (upstream #27742, merged at `b10660`), a separate architecture from the `qwen35`
family above and tuned on different grounds. 48 blocks: 12 full-attention layers carrying QSA
block-sparse attention over an indexer cache, 36 gated-delta-net layers, 512 experts with 10 used,
`context_length = 262144`, `qwen3vl_merger` projector.

- **`load-mode = mmap` and `no-host = true` are one mechanism, not two independent choices.** The
  26.822 GiB `per_layer_token_embd` n-gram hash table (`Q4_0`, 160 x 320,001,536) is created with
  `TENSOR_READ_LAZY` (`src/models/qwen4exp.cpp:139-140`), and the loader gates that flag on
  `use_mmap` (`src/llama-model-loader.cpp:1290`), which only `mmap` / `mmap+mlock` / `auto` set
  (`:559`). The `auto` threshold is 4 GiB (`:1292`), so the table qualifies without pinning
  `tensor-read-lazy`. A token gathers `ple_n_heads = (ngram_size - 1) * heads_per_ngram` = 16 rows
  (`src/models/qwen4exp.cpp:64`, gather at `:1106-1112`), so a session touches a vanishing fraction
  of the 320 M rows and mmap — which aliases the file rather than copying it
  (`src/llama-model-loader.cpp:1578-1602`) — keeps the resident working set in the hundreds of MiB.
  `dio` reads and holds all 26.822 GiB for nothing; this is the one entry in the tier that must not
  use it. `no-host` is what keeps that path reachable: without it `make_cpu_buft_list` prepends
  `CUDA_Host` to the CPU list (`src/llama-model.cpp:1047-1049`), the chosen buft then fails the
  `is_default_buft` test at `:1715`, the mmap-aliasing branch at `:1718` is skipped entirely, and
  every CPU-resident tensor — tens of GiB of experts plus the 26.822 GiB table — goes through
  `cudaMallocHost`, which is the misleading CUDA OOM documented for DeepSeek below. `mmap+mlock` is
  the other wrong answer: it forces the whole table resident
  (`src/llama-model-loader.cpp:1595-1598`).

- **The table can never be offloaded, so `-ngl` is not the lever and the entire budget question is
  expert layers.** `LLM_TENSOR_PER_LAYER_TOKEN_EMBD` is classified `LLM_TENSOR_LAYER_INPUT`
  (`src/llama-arch.cpp:887`) and `src/llama-model.cpp:1482-1483` pins every input tensor to
  `cpu_buft_list` regardless of `-ngl` ("there is very little benefit to offloading the input
  layer"); only an explicit `-ot` could move it. Composition of the local IQ4_XS (90.635 GiB, 1224
  tensors): 26.822 GiB PLE table plus 0.333 GiB `token_embd` on the CPU by construction, 60.938 GiB
  of routed experts (1.270 GiB per layer x 48) for `fit` to place, and 2.542 GiB of everything else
  on the GPU. The GPU-side floor is therefore small, and how many of the 48 expert layers survive
  beside the KV cache is the only thing that moves throughput.

- **`fit = on` with an explicit `ctx-size`, and fit is blind in two ways here.** Fit reduces context
  only when the user left it unset (`common/fit.cpp:197` `n_ctx_auto = n_ctx == 0`, used at `:392`),
  so `ctx-size = 262144` is honoured and step 3 spends the remainder on expert fractions — its
  overflow pattern `blk\.N\.ffn_(up|down|gate_up|gate)_(ch|)exps` (`common/fit.cpp:522`) matches
  exactly what this arch names them (`src/models/qwen4exp.cpp:202-203`). Blind spot one: fit assumes
  host memory is unlimited (`common/fit.h:24`) and never consults the CPU slot once a GPU is present
  (`common/fit.cpp:331-347`). Blind spot two: it measures with `load_mode = LLAMA_LOAD_MODE_NONE`
  (`common/fit.cpp:57`), so lazy read is off during measurement and its host figure counts the full
  PLE table — a number the real run never produces. Neither matters on a 191 GiB box, but they are
  why the split cannot be sanity-checked from fit's own host accounting. Setting `n-gpu-layers` to
  anything but `-1`, or any `-ot` / `--cpu-moe` / `--n-cpu-moe`, throws inside fit
  (`common/fit.cpp:462-464`, `:483-485`) and is downgraded to a warning at `:893-895`: fit silently
  does nothing and the model no longer fits at all.

- **`cache-type-k` also types the QSA indexer cache, which is why K stays at `q8_0`.**
  `src/llama-model.cpp:2506-2507` hands `params.type_k` / `type_v` to `llama_memory_hybrid_idx`,
  which forwards them unchanged to the indexer cache (`src/llama-memory-hybrid-idx.cpp:56`).
  Indexer K is what `ggml_top_k` ranks blocks on (`src/models/qwen4exp.cpp:599-601`), so cheapening
  it degrades *which* tokens are attended, not just their values. Per-token cost at
  `kv-unified = true`: 12 attention layers x 1024 elements (`n_head_kv = 2` x `head = 256`, K and V)
  plus 12 indexer layers x 384 elements = 17,952 B at `q8_0`, i.e. 4,488 MiB at 262144. Two thirds
  of the indexer share is dead — `src/llama-memory-hybrid-idx.cpp:50-51` sets `n_embd_head_k_full`
  but not `n_embd_head_v_full`, so `is_mla()` is false, `src/llama-kv-cache.cpp:232-235` allocates a
  256-wide V, and the graph only ever calls `cpy_k` / `get_k` (`src/models/qwen4exp.cpp:530`,
  `:533`). Dropping `cache-type-v` to `q4_0` would recover 1,152 MiB at this context with the
  quality cost paid only by the 12 real attention layers; worth trying, not taken. Unlike
  `deepseek4` the two types may legally differ — the equality guard at
  `src/llama-context.cpp:3592-3595` fires only for `is_mla()` or `LLM_ARCH_DEEPSEEK4`.

- **Recurrent state is 112.219 MiB per sequence and independent of `ctx-size`, so `parallel` is the
  cheap knob and context the expensive one.** 36 gated-delta-net layers at
  `n_embd_r = 3 x 10240` and `n_embd_s = 128 x 6144` elements (`src/llama-hparams.cpp:204`, `:232`),
  both hardcoded `GGML_TYPE_F32` (`src/llama-model.cpp:2513-2514`) so no cache type shrinks them,
  and one row per sequence because `qwen4exp` is absent from `llm_arch_supports_rs_rollback`
  (`src/llama-arch.cpp:1099-1113`) and `n_rs_seq` is clamped to 0 at
  `src/llama-context.cpp:105-108`. The entry runs `parallel = 4` on the strength of that: with
  `kv-unified = true` `n_ctx_seq = n_ctx` (`src/llama-context.cpp:290-291`), so four slots *share*
  the 262144-cell pool rather than each being given one, the KV cost is unchanged, and the only
  VRAM the extra slots add is three more recurrent rows — 336.7 MiB. A single long conversation can
  still occupy the whole pool.

- **A context checkpoint here is the entire recurrent state, ~112 MiB, and checkpoints are per
  slot — which is why `ctx-checkpoints` is 8 and not 32.** Checkpoints are written with
  `LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY`, and that flag skips both the attention cache
  (`src/llama-memory-hybrid.cpp:191-192`) and the indexer cache
  (`src/llama-memory-hybrid-idx.cpp:204-206`), leaving only
  `llama_memory_recurrent::state_write` (`src/llama-memory-hybrid.cpp:194`). So the blob is the full
  112.219 MiB rather than the 14.5 MiB a DSV4 checkpoint costs, and because
  `slot.prompt.checkpoints` is per slot (`tools/server/server-context.cpp:2283`) the host budget is
  `parallel x ctx-checkpoints x 112 MiB`. At `parallel = 4`, 32 checkpoints would reserve up to
  14.3 GiB of host RAM; 8 holds it at the ~3.6 GiB that `parallel = 1` with 32 would have cost, and
  at the shipped `parallel = 2` it is ~1.8 GiB. Raising `parallel` again means lowering this in step.

- **Measured on a 24463 MiB card, `q8_0` K + V, CLIP on CPU.** At `ctx-size = 262144` /
  `parallel = 1`: 20174 MiB used, 3964 MiB free, 19.87 t/s tg at short context. At the shipped
  `ctx-size = 524288` / `parallel = 2`: 19950 MiB used, 4513 MiB free, 14.90 t/s on a 400-token
  prose completion. The two throughput figures are *not* a controlled comparison — different
  prompts, and `ngram-mod` acceptance dominates on predictable output (the same config returns
  22.51 t/s counting to 60). "Used" barely moves between configs because `fit` always fills to the
  `fit-target` margin; what changes is the composition. Throughput is expert-traffic bound, not
  attention bound: every token reads 10 of 512 experts across all 48 layers, ~26.1 MiB per layer at
  IQ4_XS, so the ~1.25 GiB per token that is not resident on the GPU is what sets the rate. That is
  the currency `ctx-size` is spent in — 1,300 MiB of KV is one expert layer is roughly 2 % of tg.

- **`ctx-size = 524288` with `parallel = 2` buys two concurrent full-length conversations, and
  costs about half the GPU-resident expert layers to do it.** `llama-fit-params` gives the fixed
  cost directly, in MiB, as a function of `n_ctx_seq` (`context` is KV plus the recurrent rows,
  `compute` is the graph buffer):

  | `n_ctx_seq` | context | compute | fixed total |
  |------------:|--------:|--------:|------------:|
  |      65,536 |   1,234 |     573 |       1,807 |
  |     262,144 |   4,600 |   1,821 |       6,421 |
  |     524,288 |   9,088 |   3,497 |      12,585 |
  |   1,048,576 |  18,064 |   6,829 |      24,893 |

  Add 112 MiB per sequence beyond the first for the extra recurrent row. So the shipped config's
  fixed cost is 12,697 MiB against 6,758 MiB for 262144 / `parallel = 4`; the ~5,900 MiB difference
  comes straight out of expert layers, taking them from ~8.3 of 48 to ~4.4. The benefit is real but
  narrow: under `kv-unified` `n_ctx_seq = n_ctx` (`src/llama-context.cpp:290-291`) while the server
  still caps each *slot* at `n_ctx_train = 262144`, so a single conversation is capped at 262144
  either way and only a *second* concurrent long conversation can reach into the extra cells. On a
  single-user workload the larger pool is paid for and unused.

- **A 1,048,576-cell pool does not fit, and the ceiling is arithmetic rather than a tuning
  question.** Going from 262144 to 1048576 takes the KV cache from 4,488 to 17,952 MiB at `q8_0`,
  `+13,464 MiB`, against 3,964 MiB measured free plus at most ~9 GiB recoverable by moving every
  remaining expert layer to the CPU — and the QSA bias tensors are sized `[n_kv, n_tokens]`
  (`src/llama-memory-hybrid-idx.h:132-138`), so the compute buffer grows by the same factor of four
  on top. Even if it squeezed in it would be a regression, because zero expert layers on the GPU is
  strictly slower than the current split. `parallel` is not a way around it: under `kv-unified` the
  slots share one pool, so wanting four slots that can each reach 262144 *is* asking for 1,048,576
  cells, at exactly the cost tabulated above. The only
  route to a 1 M pool on 24 GB is `q4_0` K and V, which halves it to 9,504 MiB, and `cache-type-k`
  is precisely the value that should not drop because it types the indexer. Note that a large pool
  needs no `override-kv`: `n_ctx_train` is 262144, so the server caps each slot there
  (`tools/server/server-context.cpp:1209-1214`, applied at `:1274`) and the `- capping` line is
  expected rather than a misconfiguration.

- **No MTP head, and context shift and cache-reuse are structurally impossible — which is what makes
  `ctx-checkpoints` load-bearing.** `conversion/qwen4exp.py:28-30` drops the MTP block ("a separate
  draft head; vLLM drops it too"), so the GGUF carries no `nextn` tensors and `spec-type =
  draft-mtp` fails at `src/llama-context.cpp:3637-3642`; `ngram-mod` is the only speculative type
  available. `get_can_shift()` is false because IMRoPE gives `n_pos_per_embd() == 4`
  (`src/llama-kv-cache.cpp:1194-1196`, rope type at `src/llama-model.cpp:2951-2955`), so the server
  force-disables context shift *and* cache-reuse with two warnings at
  `tools/server/server-context.cpp:1185-1195` — both are expected on startup, not a
  misconfiguration. Speculative rollback then goes through checkpoints
  (`tools/server/server-context.cpp:1224-1226`), so a non-zero `ctx-checkpoints` is required for
  `ngram-mod` to be useful rather than being an optimisation. `swa-full` is inert: `swa_type` is
  `NONE`, which is why the model takes the `hybrid_idx` path at `src/llama-model.cpp:2502` at all,
  and the server clears the flag at `:1197-1202`.

- **The template pin is the same file as `Qwen3.8-27B`'s, byte for byte.** The embedded template is
  8952 bytes with sha256 `c3cf9e34abf4f9e3...` — identical to Qwen3.8-27B's — so the three defects
  documented above (tool-call `arguments` arriving as a JSON string, a duplicate blank
  `<think>\n\n</think>` from history, `raise_exception` on `high` / `minimal` / `max`) apply
  unchanged, and so does the fix. `reasoning-effort = xhigh` for the same reason; `--reasoning-budget`
  remains the guard rail rather than a lower level. Pinning costs no vision: the vendored template
  renders `<|vision_start|><|image_pad|><|vision_end|>`
  (`vendor/Qwen-Fixed-Chat-Templates/chat_template.jinja:67-88`). The projector is
  `qwen3vl_merger`, so `image-min-tokens = 1024` applies as it does to the other Qwen-VL entries.
  The sampler block restates the GGUF's own `general.sampling.*` (`temp 1.0`, `top-p 0.95`,
  `top-k 20`), matching Qwen3.8-27B.

- **`no-mmproj-offload = true`, because CLIP is exactly what `fit` cannot see.** Fit measures the
  language model alone and commits the expert split before `mtmd` loads the projector, so a
  `mmproj-offload = true` here lands in the silent-OOM window described in `docs/presets.md` ->
  *mmproj-offload* with no margin left to absorb it — the 588 MiB of `Q8_0` weights plus ~310 MiB of
  CLIP compute would have to be reserved by hand through `fit-target`. `fit-target = 3072` is the
  same WDDM-plus-untracked-CUDA-scratch margin as the DeepSeek entry on the same card, for the same
  reasons. `cache-ram = 32768` rather than the 51200 used by the small entries: a full-context
  prompt state is ~4.6 GiB here (4,488 MiB KV plus the recurrent rows), and the host is already
  backing most of a 90.635 GiB file through the page cache plus a PLE working set that only grows.

## gemma-4

- **All gemma-4 entries pin `chat-template-file = vendor\llama.cpp\models\templates\google-gemma-4-31B-it.jinja`.**
  This is Google's fixed official template as aligned by upstream (#21704) — the exact
  file upstream's `tests/test-chat.cpp` locks against the native gemma4 chat handler
  (`vendor/llama.cpp/common/chat.cpp:1216`), so parser and template always come from the
  same submodule commit (each rebuild resets the submodule to master, mirroring the built
  binary). GGUF-embedded templates from conversions predating Google's template fixes
  lack the `{#- OpenAI Chat Completions:` marker; llama.cpp then logs "detected an
  outdated gemma4 chat template" and rewrites messages via C++ compatibility workarounds
  (`common/chat.cpp:2250-2258`) — the pin avoids that path. One file covers the whole
  series (12B / 26B-A4B / 31B, incl. `<|image|>`/`<|audio|>` placeholders), and
  `reasoning = on` maps to the template's `enable_thinking` kwarg
  (`common/arg.cpp:3167-3175`), so no `chat-template-kwargs` are needed. Unlike the Qwen
  template, past `<|channel>thought` blocks are *stripped* from history by design —
  Gemma 4 is trained that way — so cross-turn KV-prefix invalidation is inherent
  (`ctx-checkpoints` mitigates); do not add a preserve-thinking hack. If startup fails
  reading the template after a rebuild, check whether upstream moved
  `models/templates/` — see `docs/build_system.md` -> *Upstream path dependencies*.

## Bonsai and DSpark

- **Both Bonsai entries use the same `chat-template-file` pin as the Qwen 3.6 entries.**
  `Ternary-Bonsai-27B` and `Bonsai-27B` ship from separate HF repos but are both Qwen3.6-27B
  derivatives: arch `qwen35`, and their tokenizers are byte-identical to stock Qwen3.6-27B
  (248320 tokens, same merges, `eos = 248046`) right down to the same 7764-byte embedded template —
  which is exactly the upstream template the pin exists to replace. `general.sampling.temp = 1.0` is
  embedded in both GGUFs and applied at `common/common.cpp:1264`, so `temp` has to be pinned in the
  preset or generation runs at 1.0. The presets use `0.6` to match the sibling Qwen 3.6 entries;
  Prism's own card benchmarks at `0.7`. Unlike the DSpark sidecar below, both weight files are
  mainline-packed (`Q2_0` at `QK2_0 64`, `Q1_0` at `QK1_0 128`) and load without a tensor-offset
  mismatch.

- **The DSpark drafter shipped beside Ternary Bonsai 27B cannot be enabled on mainline.**
  `Ternary-Bonsai-27B-dspark-Q4_1.gguf` has its `token_embd.weight` in `Q2_0` at Prism's
  group-128 packing while mainline is group-64 (`QK2_0 64`, `ggml/src/ggml-common.h`), so
  `gguf_init_from_reader` rejects the file on a tensor-offset mismatch before any architecture
  dispatch. Repacking would not help: `general.architecture = 'dspark'` is unregistered
  (`src/llama-arch.cpp:136` has only `dflash`), and mainline's DSpark is DeepSeek-V4
  DFlash + Markov (`src/models/dflash.cpp`, tensors `markov_w1`/`markov_w2`/`conf_proj`,
  requiring MLA and sqrtsoftplus MoE scoring), not Prism's 6-layer Qwen3.6-shaped drafter
  (`dspark.fc`, `dspark.log_snr_fc*`, `dspark.markov_head_*`). Upstream confirmed on #25707
  that it stays fork-only. The GGUF carries no MTP tensors either, so `draft-mtp` is out and
  the entry uses `ngram-mod`. Only the group-64 pack is mainline-loadable — `Q2_0.gguf` and
  `PQ2_0.gguf` in the same HF repo are group-128 fork packs.

## DeepSeek-V4-Flash

- **DeepSeek-V4-Flash-0731 must set `cache-type-k` *and* `cache-type-v` to the same value.**
  Arch is `deepseek4` (the HF card's "dflash / 20B" is the DSpark sidecar's metadata, not the
  model). `llama-context.cpp:3560-3563` compares the two values and refuses to create the
  context — `does not support different K (%s) and V (%s) cache types` — for
  `LLM_ARCH_DEEPSEEK4` specifically, because `hparams.is_mla()` is *false* for this arch and the
  guard needs the explicit disjunct. So `cache-type-v = q8_0` is load-bearing even though V is
  never allocated: DSV4 is K-only everywhere (`dsv4_make_k_only()` at
  `llama-kv-cache-dsv4.cpp:831-835` forces `is_mla` true on hparams copies, so
  `has_v = !is_mla` at `llama-kv-cache.cpp:229` is false). Copying the Qwen dual-GPU pair
  `q5_0` K / `q4_1` V here is startup-fatal, not merely wasteful. `q8_0` also clears
  `n_embd_head_k() % 64 == 0` so quantized K gets the Hadamard rotation
  (`llama-kv-cache.cpp:319-323`); the lightning-indexer cache is rotated unconditionally for
  this arch (`:325-329`). `kv-unified` is silently discarded (`GGML_UNUSED(unified)`,
  `dsv4.cpp:1189-1192`), and `cache-type-*-draft` is dead without a draft model.

- **The DSV4 KV cache is tiny, so context is cheap and quantizing it buys little.** 43 layers
  split 2 raw / 21 CSA (ratio 4) / 20 HCA (ratio 128) via `attention.compress_ratios`, all
  K-only at `n_embd_k_gqa = 512`; the raw tier is SWA-windowed to
  `PAD(min(n_ctx, 128 + n_ubatch), 256)` = 768 cells regardless of `ctx-size`. At 262144 that
  is 942 MiB at `q8_0` (1764 MiB at f16) plus a fixed 11.64 MiB of F32 compressor state that no
  cache type shrinks. Never set `swa-full`: it collapses the window formula to `n_ctx`
  (`llama-kv-cache-iswa.cpp:76-81`), turning a 17 MiB raw cache into ~11 GiB. The server warns
  `swa_full is not supported` only *after* the cache is built, so the flag still takes effect.

- **Leave `fit = on` and never add `n-cpu-moe`/`-ot` to the DeepSeek entry.** Measured UD-Q8_K_XL
  composition: 137.06 GiB routed experts (MXFP4, 90.9%), 2.02 GiB shared experts, 11.67 GiB
  non-expert — so non-expert + shared is only 13.69 GiB and fits a 24 GB card alongside the KV
  with room for a full expert layer or two (3.19 GiB each). `fit` finds that split at sub-layer
  granularity (`fit.cpp:399-441`, `:719-769`); forcing `-ncmoe 43` would push all experts to CPU
  and strand ~9 GiB of VRAM. Any user `-ot`/`--cpu-moe`/`--n-cpu-moe` aborts fit outright
  (`fit.cpp:395-397`), as does setting `n-gpu-layers` to anything but `-1` (`fit.cpp:374-376`) —
  which is why the entry keeps `-1` explicitly. Note `--cpu-moe`'s pattern matches only
  `_exps`/`_chexps`, so shared experts would stay on GPU either way.

- **`no-host = true` is mandatory on the DeepSeek entry, and this is the trap that actually stops
  it loading.** Unless `no_host` is set, `make_cpu_buft_list()` prepends
  `ggml_backend_dev_host_buffer_type()` to the CPU buffer list, so *every* CPU-resident tensor is
  allocated in a `CUDA_Host` (page-locked) buffer (`src/llama-model.cpp:896-917`, wired from
  `params.no_host` at `common/common.cpp:1611` and `include/llama.h:338`). For this model the
  loader then reports one `CUDA_Host model buffer size = 137046.96 MiB` — a 133.8 GiB
  `cudaMallocHost` on a 192 GB box. The reservation *succeeds*, so `ggml_cuda_host_malloc`'s
  clean-failure fallback to an ordinary CPU buffer never fires; the failure happens later while
  the pages are committed during the read and surfaces as `CUDA error: out of memory` inside
  `cudaEventSynchronize` at `src/llama-model-loader.cpp:1591`. That makes a host-memory problem
  look like a VRAM problem — raising `fit-target` does not help it, and neither does changing
  `load-mode`. With `no-host = true` the same config loads in ~144 s at 18650 MiB VRAM and
  ~124 GiB of ordinary host RAM. `GGML_CUDA_NO_PINNED=1` is the env-var equivalent. This applies
  to any entry that pushes tens of GiB of experts to CPU, not only DeepSeek. The GPU upload
  staging buffers are unaffected — the loader asks for those buffer types directly
  (`src/llama-model-loader.cpp:1467`) rather than through `cpu_buft_list` — but expert weights
  that `op-offload` ships to the GPU for large-batch matmuls now come from pageable memory, which
  may cost some prompt-processing throughput. There is no way to keep that and still load.

- **`fit-target = 3072` on the DeepSeek entry is a WDDM safety margin, not the fix for the load
  failure** (that is `no-host` above). `fit` measures rather than guesses — it performs a
  `no_alloc` model load plus a real graph reservation (`fit.cpp:56-75`), so its KV figure is
  byte-exact (942 MiB at 262144/`q8_0`) and its compute figure is a genuine `ggml_gallocr`
  measurement. What it cannot see is the CUDA VMM scratch pool (32 GiB of VA reserved, physical
  pages committed on demand, `ggml/src/ggml-cuda/ggml-cuda.cu:536-656`), the lazy cuBLAS
  workspace, and CUDA graph instances; none are reported to `memory_breakdown()`. It also takes a
  single `cudaMemGetInfo` snapshot at t=0 (`fit.cpp:194`) and carries no WDDM or framebuffer
  allowance anywhere. At the default 1024 MiB margin fit keeps blk.0 and blk.1 routed experts on
  the GPU (6.375 GiB — every one of the 43 layers carries 3.188 GiB of routed experts, there are
  no dense layers) and leaves only 1368 of 23139 usable MiB for those untracked consumers.
  `3072` leaves 3497 MiB and costs one extra expert layer on CPU (~2.3% more expert traffic).
  Do not raise it to 6144: that collapses `-ngl` to 38 and starts stranding whole layers.
  `--fit-target` writes only `params.fit_params_target` and never `mparams`, so unlike
  `-ngl`/`-ncmoe`/`-ot` it cannot trip the aborts at `fit.cpp:374-397`.

- **`cache-ram` is 16384 on the DeepSeek entry, not the 51200 used elsewhere.** `fit` reports
  133.8 GiB of `Host model` weights for this entry (measured at `fit-target = 3072`), so on a
  192 GB box a 50 GiB prompt cache overcommits and pages. A full-context prompt
  state at 262144/`q8_0` is 931 MiB (`server-task.cpp:1671-1683` — an entry larger than the
  whole limit is silently skipped), so 16 GiB still holds ~17 of them. Context checkpoints are
  separate and cheap: 14.5 MiB each and independent of `ctx-size`, because a DSV4 checkpoint
  stores only the 128-position SWA window plus the fixed compressor state.

- **The DeepSeek-V4-Flash entry deliberately does *not* pin `chat-template-file`.** This is the
  one exception to the convention above. The GGUF ships Unsloth's fixed template, and both it
  and upstream's bundled `models/templates/deepseek-ai-DeepSeek-V4-Flash-0731.jinja` (#26398)
  satisfy the detection heuristic at `common/chat.cpp:3170-3179` (`dsml_token` + `DSML` +
  `tool_calls`), so both route to the native PEG parser
  (`common_chat_params_init_deepseek_v3_2`, `chat.cpp:2097`) and classify as V4 via the
  `function_calls`-absent test at `:2105`. Unsloth's additionally restores `reasoning_content`
  on tool calls, which the official template drops. Unlike gemma-4 there is no outdated-template
  rewrite path for `deepseek4` — detection is all-or-nothing, and a miss degrades to the generic
  autoparser rather than being repaired. The entry carries the effort as
  `chat-template-kwargs = {"reasoning_effort":"high"}` (or `"max"`); `reasoning-effort = high` is
  equivalent and simpler — `common/arg.cpp:3650` writes the same template kwarg, and the level
  `xhigh` is listed in its help text. Only the *request* field special-cases the literal `"none"`
  (`server-common.cpp:1296-1304`). Left unset the template defaults it to `none` and emits no
  effort block at all, and `reasoning = off` voids it entirely. Do not set `reasoning-format`: the compiled default is already `deepseek`
  (`common.h:631`, despite the help text saying `auto`), and `none` leaks `</think>` into
  `content`.

- **Context shift and cache-reuse are permanently unavailable on `deepseek4`.**
  `llama_kv_cache_dsv4::get_can_shift()` returns false (`dsv4.cpp:1394-1398`), so the server
  force-disables both with a warning (`server-context.cpp:1268-1278`); slots then stop cleanly
  at `STOP_TYPE_LIMIT` instead of shifting. `seq_rm` also refuses partial removal when
  `n_rs_seq == 0` (`dsv4.cpp:1427-1429`), which `ngram-mod` does not set, so rollback goes
  through checkpoints — correct, but each rejected draft costs a ~14.5 MiB state restore and the
  net throughput effect is uncharacterised. The `dspark` sidecar in the same HF repo is a
  genuine mainline `dflash` drafter (unlike the Bonsai one above), but is unusable here: its
  README requires `--fit off` plus full offload of target *and* drafter (11 GiB drafter +
  13.69 GiB non-expert exceeds 24 GB), `--spec-draft-n-max` is clamped to 5, multi-GPU needs a
  rebuild with `GGML_SCHED_MAX_SPLIT_INPUTS=48`, and it carries an open decode-time CUDA abort
  after ~2500 tokens (#26554). The regression that broke spec decoding on this arch (#26576,
  a 2D `wo_a` in `dflash.cpp` after #26531) is fixed by #26577 at `b10269`.

## Muse Glimmer

- **Muse Glimmer has no architectural positional ceiling, so never add RoPE scaling.** Meta's
  `config.json` sets `layer_rope_theta = 0` on all 13 `full_attention` layers (NoPE) and
  `sliding_window = 2048` on the other 39; the GGUF's `sliding_window_pattern` confirms the
  `[true, true, true, false]` x13 split. RoPE therefore never sees a relative position above 2048
  at any context length — 131072 is a training length, not a limit, which is why Meta writes
  "131,072+". Because the GGUF carries no `rope.scaling.*` keys the type defaults to `linear` with
  `freq_scale 1` (`src/llama-model.cpp:1187-1189`), so a user `--rope-scale` is *applied*, not
  ignored, and would compress local resolution on the SWA layers for no benefit. The
  `--rope-scaling yarn` recipes circulating on the HF model page are wrong; only their
  `--override-kv` half is load-bearing.

- **Never set `swa-full` or `context-shift` on a Muse Glimmer entry.** `swa-full` collapses the
  4608-cell SWA cache to the full `n_ctx` by the mechanism documented for DeepSeek above — a ~114x
  blowup at `ctx-size = 524288`. `context-shift` is the more dangerous one, and it is the exact
  inverse of the `deepseek4` case: `llama_hparams::has_rope()` knows only about `router_layer`
  (`src/llama-hparams.cpp:287-295`), so a K-shift rotates 128 dims on all 52 layers including the
  13 NoPE ones, while `get_can_shift()` returns true. Silent corruption rather than a refusal. It
  is dormant only because `ctx_shift` defaults false (`common/common.h:561`) and loading an mmproj
  force-disables it (`server-context.cpp:1163-1171`); dropping the mmproj would make it reachable.

- **`spec-draft-n-max = 15` is `block_size - 1`, and the absent `chat-template-file` and
  `reasoning` keys are both deliberate.** The drafter carries `dflash.block_size = 16` and spends
  block position 0 on the committed anchor, so 15 is the maximum legal draft
  (`common/speculative.cpp:970-978`, no clamp and no warning); the upstream default is 3
  (`common/common.h:325`), so leaving it unset discards 80% of a block that is decoded in one
  forward pass regardless. Judge it by `mean len` in the slot timings
  (`1 + n_accepted / n_verif_steps`, `server-context.cpp:620`), never by `draft acceptance` — that
  ratio is a percentage of *drafted* tokens and is meaningless for block diffusion, where
  unaccepted drafts cost nothing. Measured ~3.4 tokens per target pass at short context, ~3.0 at
  4.3k. The template is deliberately not pinned: `common/chat.cpp:3494` selects the native Muse
  Glimmer handler on `<atem:function_calls>` + `<|eom|>` in the template source, and the bundled
  `models/templates/muse-glimmer.jinja` is a test fixture added alongside a `chat.cpp` parser fix
  (#26879, locked by `tests/test-chat.cpp:5951`) that mirrors the GGUF-embedded template — unlike
  gemma-4, where the pin exists to replace genuinely outdated conversions.
  `reasoning = on` is a no-op — neither the handler nor the GGUF's embedded template reads
  `enable_thinking`; reasoning here is the structural ` to=self<|message|>...<|eom|>` channel,
  gated on `reasoning_format` (`chat.cpp:3141`). The template already defaults to
  `Reasoning strength: high` (`models/templates/muse-glimmer.jinja:84`), which matches Meta's
  recommendation, and `--reasoning-effort` reaches it only through the
  `reasoning_effort` -> `reasoning_strength` alias at `common/jinja/caps.cpp:29-33`.
  `--reasoning-budget` is inert: the handler sets no `thinking_end_tags`
  (`server-common.cpp:1360`).

- **Compute buffers dominate this entry's headroom and cannot be derived from KV arithmetic.**
  Measured on a 24463 MiB card at `ctx-size = 524288` / `parallel = 2` / `q5_0` K + `q4_1` V:
  13488.92 MiB target weights, 1371.40 draft, 1956.60 CLIP, 2271.12 KV (2184.00 non-SWA +
  57.59 SWA + 29.53 draft) and **2655.59 MiB of compute buffers** (1135.67 target + 803.03
  spec-context + 407.62 draft + 309.27 CLIP) — 21743.63 MiB total, leaving ~1.0 GiB free. The
  compute term is larger than the whole KV cache and grew 1070.67 -> 1135.67 MiB once a real
  request arrived, so budget it explicitly instead of sizing `ctx-size` off KV alone. Note the
  SWA cache scales with `parallel`, not `ctx-size`
  (`PAD(min(n_ctx, n_swa * n_seq_max + n_ubatch), 256)` = 4608 cells), so raising `parallel`
  is cheap while raising `ctx-size` is not. `mmproj-offload = true` survives this margin (CLIP
  warmup reserves 309.27 MiB and real images decode), but it is the first thing to disable if the
  margin shrinks — see `docs/presets.md` -> *mmproj-offload*. Context checkpoints are host-side, ~38.8 MiB
  each at `max = 32`.
