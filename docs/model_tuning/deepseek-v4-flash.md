# DeepSeek-V4-Flash

Per-model rationale behind the `DeepSeek-V4-Flash-0731` entry in `presets/*.ini`, with the measured
numbers each decision rests on. Not auto-loaded into the agent context; read on demand.
Cross-model rules — `no-host`, `fit`, `swa-full`, context shift — are in `docs/presets.md` and
referenced here rather than restated.

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
  cache type shrinks. Never set `swa-full`: it turns the 17 MiB raw cache into ~11 GiB
  (`docs/presets.md` -> *swa-full*).

- **Leave `fit = on` and never add `n-cpu-moe`/`-ot` to the DeepSeek entry.** Measured UD-Q8_K_XL
  composition: 137.06 GiB routed experts (MXFP4, 90.9%), 2.02 GiB shared experts, 11.67 GiB
  non-expert — so non-expert + shared is only 13.69 GiB and fits a 24 GB card alongside the KV
  with room for a full expert layer or two (3.19 GiB each). `fit` finds that split at sub-layer
  granularity; forcing `-ncmoe 43` would push all experts to CPU and strand ~9 GiB of VRAM, and
  any `-ot` / `--cpu-moe` / `--n-cpu-moe` or a non-`-1` `n-gpu-layers` makes fit silently no-op —
  which is why the entry keeps `-1` explicitly (`docs/presets.md` -> *fit*).

- **`no-host = true` is mandatory on the DeepSeek entry, and this is the trap that actually stops
  it loading.** Without it the loader reports one `CUDA_Host model buffer size = 137046.96 MiB` —
  a 133.8 GiB `cudaMallocHost` on a 192 GB box — and the load dies later as `CUDA error: out of
  memory`, a host-memory problem wearing a VRAM error (`docs/presets.md` -> *no-host* for the
  mechanism). With `no-host = true` the same config loads in ~144 s at 18650 MiB VRAM and
  ~124 GiB of ordinary host RAM.

- **`fit-target = 3072` on the DeepSeek entry is a WDDM safety margin, not the fix for the load
  failure** (that is `no-host` above). `fit`'s KV figure is byte-exact (942 MiB at 262144/`q8_0`)
  and its compute figure is a genuine `ggml_gallocr` measurement; what it cannot see — the CUDA
  VMM scratch pool, the lazy cuBLAS workspace, CUDA graph instances, and any WDDM or framebuffer
  allowance — is listed under `docs/presets.md` -> *fit*. At the default 1024 MiB margin fit
  keeps blk.0 and blk.1 routed experts on the GPU (6.375 GiB — every one of the 43 layers carries
  3.188 GiB of routed experts, there are no dense layers) and leaves only 1368 of 23139 usable MiB
  for those untracked consumers. `3072` leaves 3497 MiB and costs one extra expert layer on CPU
  (~2.3% more expert traffic). Do not raise it to 6144: that collapses `-ngl` to 38 and starts
  stranding whole layers.

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
  force-disables both — `docs/presets.md` -> *context-shift and cache-reuse*. `seq_rm` also
  refuses partial removal when `n_rs_seq == 0` (`dsv4.cpp:1427-1429`), which `ngram-mod` does not
  set, so rollback goes through checkpoints — correct, but each rejected draft costs a ~14.5 MiB
  state restore and the net throughput effect is uncharacterised. The `dspark` sidecar in the
  same HF repo is a genuine mainline `dflash` drafter (unlike the Bonsai one in
  `docs/model_tuning/qwen.md`), but is unusable here: its README requires `--fit off` plus full
  offload of target *and* drafter (11 GiB drafter + 13.69 GiB non-expert exceeds 24 GB),
  `--spec-draft-n-max` is clamped to 5, multi-GPU needs a rebuild with
  `GGML_SCHED_MAX_SPLIT_INPUTS=48`, and it carries an open decode-time CUDA abort after ~2500
  tokens (#26554). The regression that broke spec decoding on this arch (#26576, a 2D `wo_a` in
  `dflash.cpp` after #26531) is fixed by #26577 at `b10269`.
