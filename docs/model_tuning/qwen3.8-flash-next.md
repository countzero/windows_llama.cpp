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

- **`fit = on` with an explicit `ctx-size`.** Fit honours the `ctx-size` the entry sets — 262144 on
  the 24 GB and 16 GB tiers, 131072 on the dual-GPU tier — and spends the
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
  it degrades *which* tokens are attended, not just their values. Per-token cost: 12 attention
  layers x 1024 elements (`n_head_kv = 2` x `head = 256`, K and V) plus 12 indexer layers x 384
  elements = 17,952 B at `q8_0`, i.e. 4,488 MiB at 262144. Two thirds of the indexer share is
  dead — `src/llama-memory-hybrid-idx.cpp:50-51` sets `n_embd_head_k_full`
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
  `src/llama-context.cpp:105-108`. The entry ships `parallel = 1`, so the context carries one
  recurrent row and a single conversation owns the whole 262144-cell pool. Raising it stays cheap
  in VRAM if it is ever wanted — restore `kv-unified = true` and `n_ctx_seq = n_ctx`
  (`src/llama-context.cpp:290-291`), so the extra slots *share* the pool rather than each being
  given one and cost only 112.219 MiB apiece. It is not free elsewhere: it multiplies the
  checkpoint budget below, and without `kv-unified` `n_ctx_seq` becomes `n_ctx / n_seq_max`, so
  each slot's reach shrinks in proportion instead.

- **A context checkpoint here is the entire recurrent state, ~112 MiB, and checkpoints are per
  slot — which is why `ctx-checkpoints` is 8 and not 32.** Checkpoints are written with
  `LLAMA_STATE_SEQ_FLAGS_PARTIAL_ONLY`, and that flag skips both the attention cache
  (`src/llama-memory-hybrid.cpp:191-192`) and the indexer cache
  (`src/llama-memory-hybrid-idx.cpp:204-206`), leaving only
  `llama_memory_recurrent::state_write` (`src/llama-memory-hybrid.cpp:194`). So the blob is the full
  112.219 MiB rather than the 14.5 MiB a DSV4 checkpoint costs, and because
  `slot.prompt.checkpoints` is per slot (`tools/server/server-context.cpp:2283`) the host budget is
  `parallel x ctx-checkpoints x 112 MiB`. The 8 was chosen when the entry ran `parallel = 4`, where
  32 checkpoints would have reserved up to 14.3 GiB of host RAM. At the shipped `parallel = 1` it
  costs ~0.9 GiB and 32 would cost ~3.6 GiB, so 8 is now a conservative floor rather than a measured
  ceiling. Raising `parallel` again means lowering this in step.

- **On the dual-GPU tier prefill is bound by expert host-to-device traffic, not by compute, so the
  levers are `ubatch-size`, the device pin and `ctx-size` — together worth 4.4x.** Measured on
  b10952 through the router with the real `.env`, 32318-token prompt:

  | dual-GPU entry | pp 32k | tg code / reasoning / after 32k | 4070 free | load |
  | --- | ---: | ---: | ---: | ---: |
  | as shipped in 1.42.0 | 53.8 / 53.7 | 10.8 / 11.3 / 11.1 | 99-541 MiB | 79-120 s |
  | **retuned** | **240.3 / 237.5** | **15.0 / 15.8 / 16.0** | **1946 idle, 1616 run** | **28 s** |

  The 8k-prompt sweep that isolates each lever, `fitt` = `fit-target`, all rows `device = CUDA1`
  except the two marked *both*:

  | config | pp | tg | 4070 free |
  | --- | ---: | ---: | ---: |
  | ctx 262144, ub 512 (default), fitt 1024, *both* | 55.1 | 14.1 | 520 |
  | ctx 262144, ub 4096, fitt 1024,1024, *both* | fails to load | — | `create_context` OOM |
  | ctx 262144, ub 4096, fitt 1024 | 131.4 | 4.3 | 108 |
  | ctx 131072, ub 4096, fitt 1024 | 203.1 | 14.5 | 840 |
  | ctx 131072, ub 4096, fitt 1024, `-tb 16` | 191.9 | 13.2 | 814 |
  | ctx 131072, ub 4096, fitt 2048 | 181.1 | 9.5 | 1667 |
  | **ctx 131072, ub 2048, fitt 2048 (shipped)** | **184.6** | **14.9** | **1998** |
  | ctx 262144, ub 2048, fitt 2048 | 157.0 | 8.8 | 2130 |

  Three things to read off it. **The entry set no `ubatch-size` at all**, so it ran the 512 default
  while the reference box for this model swept 2048=762, 4096=850, 6144=864 t/s — below its lowest
  tested point. **The 2060 SUPER negotiates PCIe 3.0 x4** (`nvidia-smi --query-gpu=pcie.link.gen.current,pcie.link.width.current`),
  about 3.9 GB/s, and offloaded-MoE prefill is bound by serial expert H2D copies with the GPU idle
  a large fraction of each pass (upstream #25859), so putting a share of the 60.938 GiB of experts
  behind that link dominated everything else; dropping the card was the single largest gain and it
  costs nothing, because `fit` simply places more experts on the 4070 instead. **`ctx-size 131072`
  beats 262144 on both axes** (+18 % pp, +69 % tg at equal target) — the fixed cost table below is
  the reason, and the QSA bullet below is why the context penalty is steeper here than the table
  alone implies. `threads-batch` was measured and rejected: 16 is worse than the inherited 24 on
  both axes. `ubatch-size 4096` costs 5.4 t/s of tg against 2048 for 2.5 t/s of pp, so 2048 ships.
  Context: a single RTX 4090 with 96 GB DDR5 at UD-IQ3_XXS reports 863-1360 t/s prefill and
  19.5-30 t/s decode, so even the retuned entry is an order of magnitude short of a
  one-card-fits-the-hot-path box; the remaining gap is the dense QSA path below.

- **The `device = CUDA1` pin needs a local `main-gpu = 0` beside it.** `--device` filters the
  device list before `main-gpu` indexes into it, so the `[*]` section's `main-gpu = 1` would point
  past the end of a one-device list. `--device` is the right key rather than `CUDA_VISIBLE_DEVICES`
  in `.env`, because the environment reaches every child in router mode
  (`tools/server/server-models.cpp:802`) and would strip the 2060 from the four entries that want
  it. Confirm with `--list-devices`: under `CUDA_DEVICE_ORDER=PCI_BUS_ID`, `CUDA0` is the 2060
  SUPER and `CUDA1` the 4070 Ti SUPER.

- **QSA attention still runs the dense O(n_kv) path on this build, which is why `ctx-size` costs
  more than its bytes.** `src/models/qwen4exp.cpp:747-750` passes `0` as `n_kv_max` with the
  sparse call commented out behind a `// TODO: enable sparse attention when we are ready`, and
  `ggml/src/ggml-cuda/fattn-mma-f16.cuh:1760-1761` whitelists sparse only for `DKQ == 512` and
  `DKQ == 576` while this arch is `DKQ = DV = 256`, so the kernel is not reachable even if the call
  were enabled. Upstream #28734 profiles the same thing on 5x RTX 3090 and reports attention at
  ~11 ms/token at 250K against 0.22 ms once the sparse path is enabled, with prefill 609 -> 716
  t/s at 111K. Two of its patches are three lines total and `patches/` is the supported vehicle,
  but they are unmerged third-party changes and would need a needle-in-haystack retrieval gate
  before being trusted; not taken.

- **Measured on a 24463 MiB card, `q8_0` K + V, CLIP on CPU, `fit-target = 3072`.** At the shipped
  `ctx-size = 262144` / `parallel = 1`: 20174 MiB used, 3964 MiB free, 19.87 t/s tg at short
  context. At `ctx-size = 524288` / `parallel = 2`: 19950 MiB used, 4513 MiB free, 14.90 t/s on a
  400-token prose completion. Both rows predate `fit-target = 1024`, which spends about 2 GiB of
  the free figure on further expert fractions and leaves the rest of the picture unchanged; neither
  row has been retaken at that target. The two throughput figures are *not* a controlled
  comparison — different prompts, and `ngram-mod` acceptance dominates on predictable output (the
  same config returns 22.51 t/s counting to 60). "Used" barely moves between configs because `fit`
  always fills to the `fit-target` margin; what changes is the composition. Throughput is
  expert-traffic bound, not
  attention bound: every token reads 10 of 512 experts across all 48 layers, ~26.1 MiB per layer at
  IQ4_XS, so the ~1.25 GiB per token that is not resident on the GPU is what sets the rate. That is
  the currency `ctx-size` is spent in — 1,300 MiB of KV is one expert layer is roughly 2 % of tg.

- **On the 24 GB tier, `ctx-size = 262144` with `parallel = 1`, because the 524288 pool cost about
  half the
  GPU-resident expert layers and bought reach no single-user workload can use.** `llama-fit-params`
  gives the fixed cost directly, in MiB, as a function of `n_ctx_seq` (`context` is KV plus the
  recurrent rows, `compute` is the graph buffer):

  | `n_ctx_seq` | context | compute | fixed total |
  |------------:|--------:|--------:|------------:|
  |      65,536 |   1,234 |     573 |       1,807 |
  |     262,144 |   4,600 |   1,821 |       6,421 |
  |     524,288 |   9,088 |   3,497 |      12,585 |
  |   1,048,576 |  18,064 |   6,829 |      24,893 |

  Add 112 MiB per sequence beyond the first for the extra recurrent row. So the shipped config's
  fixed cost is 6,421 MiB against the 12,697 MiB the 524288 / `parallel = 2` pool took; the
  ~6,276 MiB difference goes straight back into expert layers, taking them from ~4.4 of 48 to ~8.3.
  What the larger pool bought was real but narrow: under `kv-unified` `n_ctx_seq = n_ctx`
  (`src/llama-context.cpp:290-291`) while the server still caps each *slot* at
  `n_ctx_train = 262144`, so a single conversation was capped at 262144 either way and only a
  *second* concurrent long conversation could reach into the extra cells. On a single-user workload
  that is paid for and unused, and the expert layers are worth more.

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
  otherwise. The 24 GB and 16 GB entries keep `fit-target = 1024` rather than the 3072 the DeepSeek
  entry keeps on the same card: the margin still clears the ~400 MiB WDDM floor (`docs/presets.md`
  -> *Device pinning and multi-GPU*) and the ~2 GiB it releases buys expert layers, but it is the
  tightest target in the tier and the compositor's share of the card moves by hundreds of MiB with
  desktop state, so an unexplained slowdown there is a paging check before it is anything else. The
  dual-GPU entry carries **2048** instead, measured: at 1024 it landed at 99-541 MiB free and lost
  a third of its prefill to WDDM paging, and the 2048 target costs 2.5 t/s of pp for 1.3 GiB of
  margin on a display GPU whose desktop swings ~450 MiB. Reaching a target is not automatic —
  `fit`'s only lever is expert placement, so once `ctx-size` and the `ubatch` compute buffer have
  claimed the card it undershoots silently (`docs/presets.md` -> *fit*, blind spot 5); the
  ctx 262144 / ub 4096 row above asked for 1024 MiB and got 108. Verify the margin with
  `nvidia-smi` after load rather than reading it off the target. `cache-ram = 32768` rather than
  the 51200 used by the small entries: a full-context prompt state is ~4.6 GiB here (4,488 MiB KV
  plus the recurrent rows), and the host is already backing most of a 90.635 GiB file through the
  page cache plus a PLE working set that only grows.

