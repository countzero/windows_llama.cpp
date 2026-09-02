# Qwen3.8-Flash-Next

Per-model rationale behind the `Qwen3.8-Flash-Next` entries in `presets/*.ini`, with the measured
numbers each decision rests on. Not auto-loaded into the agent context; read on demand.
Cross-model rules — `no-host`, `fit`, `swa-full`, context shift — are in `docs/presets.md` and
referenced here rather than restated. The `qwen35`-family entries are in `docs/model_tuning/qwen.md`.

Arch `qwen4exp` (upstream #27742, merged at `b10660`), a separate architecture from the `qwen35`
family and tuned on different grounds. 48 blocks: 12 full-attention layers carrying QSA
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
  use it. `no-host` is what keeps the mmap-aliasing branch reachable at all — without it every
  CPU-resident tensor, tens of GiB of experts plus the 26.822 GiB table, goes through
  `cudaMallocHost` and the load fails as a misleading CUDA OOM (`docs/presets.md` -> *no-host*).
  `mmap+mlock` is the other wrong answer: it forces the whole table resident
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

- **`fit = on` with an explicit `ctx-size`.** Fit honours `ctx-size = 262144` and spends the
  remainder on expert fractions; its overflow pattern matches exactly what this arch names them
  (`src/models/qwen4exp.cpp:202-203`). Two of fit's blind spots bite here specifically: it assumes
  host memory is unlimited, and it measures with lazy read off, so its host figure counts the full
  PLE table — a number the real run never produces. Neither matters on a 191 GiB box, but they are
  why the split cannot be sanity-checked from fit's own host accounting. The abort-and-no-op
  behaviour on `-ngl` / `-ot` / `--n-cpu-moe` applies unchanged — `docs/presets.md` -> *fit*.

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
  (`src/llama-kv-cache.cpp:1194-1196`, rope type at `src/llama-model.cpp:2951-2955`), so the two
  startup warnings and the checkpoint-based rollback described in `docs/presets.md` ->
  *context-shift and cache-reuse* apply. `swa-full` is inert: `swa_type` is `NONE`, which is why
  the model takes the `hybrid_idx` path at `src/llama-model.cpp:2502` at all (`docs/presets.md` ->
  *swa-full*).

- **The template pin is the same file as `Qwen3.8-27B`'s, byte for byte.** The embedded template is
  8952 bytes with sha256 `c3cf9e34abf4f9e3...` — identical to Qwen3.8-27B's — so the three defects
  documented in `docs/model_tuning/qwen.md` apply unchanged, and so does the fix.
  `reasoning-effort = xhigh` for the same reason; `--reasoning-budget` remains the guard rail
  rather than a lower level. Pinning costs no vision: the vendored template renders
  `<|vision_start|><|image_pad|><|vision_end|>`
  (`vendor/Qwen-Fixed-Chat-Templates/chat_template.jinja:67-88`). The projector is
  `qwen3vl_merger`, so `image-min-tokens = 1024` applies as it does to the other Qwen-VL entries.
  The sampler block restates the GGUF's own `general.sampling.*` (`temp 1.0`, `top-p 0.95`,
  `top-k 20`), matching Qwen3.8-27B.

- **`no-mmproj-offload = true`, because CLIP is exactly what `fit` cannot see** (`docs/presets.md`
  -> *fit*, blind spot 4). The 588 MiB of `Q8_0` weights plus ~310 MiB of CLIP compute would have
  to be reserved by hand through `fit-target`, and there is no margin left to absorb them
  otherwise. `fit-target = 3072` is the same WDDM-plus-untracked-CUDA-scratch margin as the
  DeepSeek entry on the same card, for the same reasons. `cache-ram = 32768` rather than the 51200
  used by the small entries: a full-context prompt state is ~4.6 GiB here (4,488 MiB KV plus the
  recurrent rows), and the host is already backing most of a 90.635 GiB file through the page
  cache plus a PLE working set that only grows.
