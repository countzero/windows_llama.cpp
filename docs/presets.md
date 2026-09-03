# Presets Reference

Cross-model rules for editing `presets/*.ini`. Not auto-loaded into the agent
context; read it on demand. `presets/README.md` is the user-facing quick-start;
this file is for editing. Per-model rationale lives in `docs/model_tuning/<family>.md`.

## Device pinning and multi-GPU

- **Only `models_16GB_8GB_VRAM.ini` pins devices.** It sets `split-mode`, `main-gpu`, and
  `tensor-split` in its `[*]` section; the other two tiers set none of the three, so on a host with
  more than one CUDA device llama.cpp's default `split-mode = layer` spreads every entry across
  *all* visible GPUs — the tier name is then a floor, not a cap. Pin with `CUDA_VISIBLE_DEVICES`
  before launch, not `--device`: in router mode each child's argv is rebuilt from the preset
  (`inst.meta.update_args`), so a parent `--device` never reaches the child, while the environment
  is copied into every child (`tools/server/server-models.cpp:802`). Pinning is a throughput
  decision, not only a memory one — `Ternary-Bonsai-27B-Q2_g64.gguf` measured 56.5 t/s tg and
  1418 t/s pp on one 16 GB card versus 36.5 t/s and 998 t/s spread over a 16 GB plus an 8 GB card.
  `CUDA_VISIBLE_DEVICES` indices follow `CUDA_DEVICE_ORDER`, which defaults to `FASTEST_FIRST` and
  therefore does *not* match `nvidia-smi` ordering; pass a GPU UUID to be unambiguous.
- **Environment is the only channel for these.** Presets carry `llama-server` flags; `CUDA_*`
  variables are read by the CUDA driver, not by llama.cpp, so they can never live in an INI. The
  repository root `.env` (template: `.env.example`, loader: `load_env.ps1`) is where they belong,
  next to the server-scoped `LLAMA_ARG_*` values that replace the launch flags.
- **`CUDA_SCALE_LAUNCH_QUEUES=4x` is worth +10-11.5 % prompt processing on the dual-GPU tier and
  nothing on a single GPU.** It scales the CUDA command buffer, i.e. how far the CPU may enqueue
  ahead of the GPU. With `GGML_SCHED_MAX_COPIES=1` the scheduler hard-synchronises at every
  device boundary, so a full queue on one device starves the other; a deeper queue keeps both fed.
  Measured on `Qwen3.8-27B.IQ4_XS.gguf`, `tensor-split 1/2`, q8_0 KV, same binary: pp8192
  1025 → 1143 t/s, pp2048 at 32k depth 690 → 759, at 64k 509 → 565; the 4070 Ti SUPER alone
  1733 → 1723 (noise). Only `0.25x`, `0.5x`, `2x` and `4x` are valid — NVIDIA documents that
  *any other value is interpreted as `1x`*, silently, so `4` without the `x` does nothing. It
  is a driver variable, so it must be in the environment before the process starts; in router
  mode the parent's environment reaches every child the same way `CUDA_DEVICE_ORDER` does.
  Rebuilding with `GGML_SCHED_MAX_COPIES=4` instead was measured at −2.5 % alone and +1.5 %
  on top of the env var, so pipeline parallelism is not the lever on this GPU pair and the
  build default stays at 1.
- **Keep ~400 MiB free on the display GPU; below ~250-300 MiB WDDM pages the working set to
  system RAM and the entry silently runs 20-45 % slower.** Windows' video memory manager demotes
  parts of an oversubscribed adapter's allocations to host memory behind the driver's back, and the
  desktop compositor lives on the same card (`dwm.exe` held ~2.6 GB of the 4070 Ti SUPER on a
  2560x1440 three-monitor desktop and grows with open windows). llama.cpp cannot see it —
  `cudaMalloc` succeeds, `memory_breakdown()` reports the nominal figures, `nvidia-smi` just shows
  the card full — so throughput is the only symptom. Measured on the dual-GPU `Qwen3.8-27B` entry
  at identical context: 28 MiB free → pp 617 / tg 48.9 t/s, 347 MiB free → pp 884 / tg 52.1
  (`docs/model_tuning/qwen.md`). `fit` carries no WDDM allowance (see *fit* below), so on a
  `fit = on` entry the margin lives in `fit-target`; on a `fit = off` entry it lives in `ctx-size`.
  The NVIDIA control panel's *CUDA - Sysmem Fallback Policy*, set to *Prefer No Sysmem Fallback* per
  program on `llama-server.exe`, converts an over-commit into a hard failure instead of a silent
  spill: a deliberately over-committed launch dies with `cudaMalloc failed: out of memory` at
  `alloc_tensor_range` rather than loading slowly. The policy binds when the CUDA context is
  created, so the server has to be restarted after changing it. Whether it also prevents WDDM
  *demoting an already-committed* working set — the case above — is still untested; testing it
  safely on a live desktop is impractical. Note also that the 250-300 MiB figure is conservative for
  this machine: rows measured at 253 and 293 MiB free showed no throughput loss at all, so the
  observed cliff sits below that, and the 28 MiB row remains the only unambiguous demotion.
- **On the dual-GPU tier `tensor-split` is a prompt-processing knob, not a generation one.** With
  `split-mode = layer` prefill is a pipeline whose throughput is set by its slowest stage, and the
  2060 SUPER has roughly a third of the 4070 Ti SUPER's tensor throughput, so every layer moved off
  it raises pp — llama-bench pp2048 on `Qwen3.8-27B.IQ4_XS.gguf`: `1/2` 1134, `1/3` 1375, `1/4`
  1578, `1/6` 1745 t/s — while tg is bandwidth-bound and sequential (bytes on the 2060 / 448 GB/s
  plus bytes on the 4070 / 672 GB/s) and moved 3-8 %. The price is 4070 VRAM: at `1,3` each 1k
  tokens of context costs that card ~15 MiB, so a heavier ratio is bought with `ctx-size`.
  `split-mode = tensor` inverts the trade — tg +25-45 %, short-prompt pp halved, context capped by
  a compute buffer that is allocated in full on every device — and stays off; measurements in
  `docs/model_tuning/qwen.md`.
- **The compute buffer is allocated in full on every device under `split-mode = layer` too, so a
  context bump costs twice what the KV arithmetic says.** Its context-scaling term is the F16 KQ
  mask, `n_kv x n_ubatch x 2` (`src/llama-graph.cpp:39-41`), and both cards get their own copy:
  measured 300.67 MiB on each at `ctx-size = 131072` and 556.67 MiB on each at 262144
  (`docs/model_tuning/muse-glimmer.md`). Only the per-device *cap* is what `split-mode = tensor`
  additionally worsens, not the duplication itself. A draft model adds a second compute buffer whose
  size follows `n_outputs_max = parallel x (n_max + 1)` (`common/speculative.cpp:2494-2500`) rather
  than `n_ctx`, and it lands on whichever device holds `output.weight` — a fixed tax on the last
  device that `ctx-size` cannot reduce.

## load-mode

- **Every entry but `Qwen3.8-Flash-Next` uses `load-mode = dio`; never pair `direct-io` with
  `no-mmap` again.** Both spellings
  are deprecated, and they write the *same* mutually exclusive enum — `--no-mmap` sets
  `LLAMA_LOAD_MODE_NONE` (`common/arg.cpp:2594`) while `--direct-io` sets
  `LLAMA_LOAD_MODE_DIRECT_IO` (`:2603`) — so setting both means only whichever is parsed last wins.
  Which one that is is *not* the INI order: `common/preset.cpp` emits `opt.args.back()` while
  iterating an unordered map. It happened to resolve to DirectIO, but a container-order change would
  silently downgrade to `NONE`, dropping DirectIO *and* mmap for plain buffered reads. `dio` is the
  single equivalent of the old pair and also removes two deprecation warnings per launch. Valid
  values are `none`, `mmap`, `mlock`, `mmap+mlock`, `dio` (`arg.cpp:2615-2619`) — anything else
  throws at startup.

- **`Qwen3.8-Flash-Next` is the one entry that must use `load-mode = mmap` instead.** Its 26.8 GiB
  `per_layer_token_embd` n-gram hash table is read lazily, and only an mmap mode keeps that path
  enabled; `dio` reads and holds the whole table for nothing. `no-host = true` is part of the same
  mechanism, not an independent choice — see *no-host* below and
  `docs/model_tuning/qwen3.8-flash-next.md`.

- **`load-mode = dio` does not enable DirectIO on Windows — it only disables mmap.** The Win32 `llama_file::impl` ctor takes `use_direct_io` as `[[maybe_unused]]` and just calls `ggml_fopen` (`vendor/llama.cpp/src/llama-mmap.cpp:86-95`); `FILE_FLAG_NO_BUFFERING` is never set and `read_alignment()` stays 1 (`:391`), so the loader's async staging buffers are 4 x 1 MiB of pinned host memory instead of the 4 x 64 MiB the aligned path would use (`src/llama-model-loader.cpp:1418`, `:1427`). `has_direct_io()` nevertheless returns a hardcoded `true` on Windows (`:173-175`). Net effect of `dio` on this platform: buffered reads, no mmap, and zero VRAM cost — it is never implicated in a CUDA OOM. Keep the key for the deprecation-warning reason documented above, but do not reason about page-cache behaviour from it.

## no-host

- **`no-host = true` is mandatory on any entry that pushes tens of GiB of weights to the CPU, and
  without it the load fails as a misleading CUDA OOM.** Unless `no_host` is set,
  `make_cpu_buft_list()` prepends `ggml_backend_dev_host_buffer_type()` — `CUDA_Host`, page-locked —
  to the CPU buffer list (`src/llama-model.cpp:1047-1049`, wired from `params.no_host` at
  `common/common.cpp:1611` and `include/llama.h:338`), so *every* CPU-resident tensor is allocated
  through `cudaMallocHost`. The reservation *succeeds*, so `ggml_cuda_host_malloc`'s clean-failure
  fallback to an ordinary CPU buffer never fires; the failure happens later while the pages are
  committed during the read and surfaces as `CUDA error: out of memory` inside
  `cudaEventSynchronize` at `src/llama-model-loader.cpp:1591`. That makes a host-memory problem
  look like a VRAM problem — raising `fit-target` does not help it, and neither does changing
  `load-mode`. `GGML_CUDA_NO_PINNED=1` is the env-var equivalent. The GPU upload staging buffers
  are unaffected — the loader asks for those buffer types directly
  (`src/llama-model-loader.cpp:1467`) rather than through `cpu_buft_list` — but expert weights
  that `op-offload` ships to the GPU for large-batch matmuls now come from pageable memory, which
  may cost some prompt-processing throughput. There is no way to keep that and still load.
  Measured DeepSeek figures with and without the flag: `docs/model_tuning/deepseek-v4-flash.md`.

- **It is also what keeps mmap aliasing reachable.** With `CUDA_Host` at the head of the list the
  chosen buft fails the `is_default_buft` test at `src/llama-model.cpp:1715`, the mmap-aliasing
  branch at `:1718` is skipped entirely, and every CPU-resident tensor is copied into pinned memory
  instead of aliased from the file. This is why `no-host` and `load-mode = mmap` are one mechanism
  on `Qwen3.8-Flash-Next` — `docs/model_tuning/qwen3.8-flash-next.md`.

## fit

- **Keep `fit = on` on an entry that relies on it; never add `n-cpu-moe`/`-ot`, and never set
  `n-gpu-layers` to anything but `-1` — fit then silently no-ops.** Any user `-ot` / `--cpu-moe` /
  `--n-cpu-moe`, or `n-gpu-layers` other than `-1`, throws inside fit (`common/fit.cpp:462-464`,
  `:483-485`) and is downgraded to a warning at `:893-895`: fit does nothing and the model no
  longer fits at all. This is why the DeepSeek and `Qwen3.8-Flash-Next` entries keep
  `n-gpu-layers = -1` explicitly. `--fit-target` writes only `params.fit_params_target` and never
  `mparams`, so unlike `-ngl` / `-ncmoe` / `-ot` it cannot trip the aborts. Fit places experts at
  sub-layer granularity (`common/fit.cpp:399-441`, `:719-769`); its overflow pattern is
  `blk\.N\.ffn_(up|down|gate_up|gate)_(ch|)exps` (`common/fit.cpp:522`). Note `--cpu-moe`'s
  pattern matches only `_exps`/`_chexps`, so shared experts stay on the GPU either way.

- **Fit honours an explicit `ctx-size` and reduces context only when the user left it unset**
  (`common/fit.cpp:197` `n_ctx_auto = n_ctx == 0`, used at `:392`); step 3 then spends the
  remainder on expert fractions.

- **Fit measures rather than guesses, but it is blind in four ways.** It performs a `no_alloc`
  model load plus a real graph reservation (`common/fit.cpp:56-75`), so its KV figure is
  byte-exact and its compute figure is a genuine `ggml_gallocr` measurement. What it cannot see:
  1. The CUDA VMM scratch pool (32 GiB of VA reserved, physical pages committed on demand,
     `ggml/src/ggml-cuda/ggml-cuda.cu:536-656`), the lazy cuBLAS workspace, and CUDA graph
     instances — none are reported to `memory_breakdown()`. It also takes a single
     `cudaMemGetInfo` snapshot at t=0 (`common/fit.cpp:194`) and carries no WDDM or framebuffer
     allowance anywhere. `fit-target` is the only place to budget these.
  2. Host memory — it assumes it is unlimited (`common/fit.h:24`) and never consults the CPU slot
     once a GPU is present (`common/fit.cpp:331-347`).
  3. Lazy reads — it measures with `load_mode = LLAMA_LOAD_MODE_NONE` (`common/fit.cpp:57`), so
     its host figure counts every lazily-read tensor in full, a number the real run never
     produces. The split cannot be sanity-checked from fit's own host accounting.
  4. The projector — fit measures the language model alone and commits the expert split before
     `mtmd` loads the mmproj, so `mmproj-offload = true` on a fit entry lands in the silent-OOM
     window below with no margin left to absorb it unless `fit-target` reserves the CLIP weights
     and compute buffer by hand.

## mmproj-offload

- **`mmproj-offload = true` fails silently at startup on a saturated GPU.** CLIP's warmup
  compute buffer OOMs but the server keeps running — only image requests error at generation
  time. Set `false` on tiers where LLM + KV already saturate VRAM, and on any `fit = on` entry
  unless `fit-target` carries the CLIP budget — see *fit* above.

## swa-full

- **Never set `swa-full` on an entry whose architecture has a sliding-window tier.** The SWA cache
  is sized `PAD(min(n_ctx, n_swa * n_seq_max + n_ubatch), 256)` cells and therefore scales with
  `parallel`, not `ctx-size`; `swa-full` collapses that formula to `n_ctx`
  (`src/llama-kv-cache-iswa.cpp:76-81`). The server warns `swa_full is not supported` only *after*
  the cache is built, so the flag still takes effect. Magnitudes: a 17 MiB raw cache becomes
  ~11 GiB on DeepSeek-V4-Flash, and a 4608-cell cache grows ~114x on Muse Glimmer at
  `ctx-size = 524288` — `docs/model_tuning/deepseek-v4-flash.md`, `docs/model_tuning/muse-glimmer.md`.
  On an arch with `swa_type = NONE` the flag is inert and the server clears it
  (`tools/server/server-context.cpp:1197-1202`).

## context-shift and cache-reuse

- **When `get_can_shift()` is false the server force-disables context shift *and* cache-reuse
  with two startup warnings** (`tools/server/server-context.cpp:1185-1195`) — expected, not a
  misconfiguration; slots then stop cleanly at `STOP_TYPE_LIMIT` instead of shifting. Speculative
  rollback then goes through checkpoints (`tools/server/server-context.cpp:1224-1226`), so a
  non-zero `ctx-checkpoints` is *required* for `ngram-mod` to be useful on such an entry rather
  than being an optimisation. Which entries and why: `deepseek4`
  (`docs/model_tuning/deepseek-v4-flash.md`) and `Qwen3.8-Flash-Next`
  (`docs/model_tuning/qwen3.8-flash-next.md`).

- **`get_can_shift()` returning true is not proof that shifting is safe.** Muse Glimmer returns
  true while a K-shift silently corrupts its NoPE layers — `docs/model_tuning/muse-glimmer.md`.
  It is dormant only because `ctx_shift` defaults false (`common/common.h:561`) and loading an
  mmproj force-disables it (`tools/server/server-context.cpp:1163-1171`); dropping the mmproj
  would make it reachable.

## Context size and override-kv

- **`ctx-size` above the GGUF's `context_length` is dead VRAM unless `override-kv` lifts it too.**
  `llama-context.cpp:131` never clamps `n_ctx`, so the KV cache really is allocated at the
  requested size — but the server then caps every slot at `n_ctx_train`
  (`tools/server/server-context.cpp:1209-1214`, applied as `slot.n_ctx = n_ctx_slot` at `:1274`)
  and rejects any larger request outright. Both Muse Glimmer GGUFs ship
  `muse-glimmer.context_length = 131072`, so the 24 GB entry's former `ctx-size = 262144`
  allocated 262144 cells while no request could exceed 131072 — ~884 MiB of unreachable VRAM.
  `override-kv = muse-glimmer.context_length=int:262144` raises `n_ctx_train` and is the only
  lever; Meta documents 131072 as the default and 262144 as the maximum, so this is the
  vendor-sanctioned ceiling, not an extrapolation hack. The startup line
  `the slot context (...) exceeds the training context of the model (...) - capping` is expected
  here (the pool is 524288 for two 262144 slots); what matters is
  `initializing, n_slots = 2, n_ctx_slot = 262144`. If that reads 131072 the override did not
  take. It also sets `n_ctx_orig_yarn = 262144` (`src/llama-model.cpp:1180`), inert at
  `freq_scale 1`.

## Slots and the prompt cache

- **`parallel` does not divide the context when `kv-unified` is off — it is `n_ctx / n_seq_max` per
  slot, and that is usually what you want.** `src/llama-context.cpp:290-294` sets
  `n_ctx_seq = n_ctx` under `kv-unified` and `n_ctx / n_seq_max` otherwise. So `ctx-size = 262144`
  with `parallel = 2` and no `kv-unified` yields two slots of 131072 each; if that equals the GGUF's
  `context_length`, no `override-kv` is needed. Confirm with
  `initializing, n_slots = 2, n_ctx_slot = 131072` at startup.
- **`kv-unified = true` is the wrong key for keeping two conversations resident.** It lets any slot
  address the whole pool, but `tools/server/server-context.cpp:2409-2425` then saves *and clears*
  every idle slot on each new task (`[TAG_IDLE_SLOT_CLEAR]`), because in a shared pool an idle slot
  would starve the active one. With `kv-unified` off, idle slots keep their cells and nothing is
  swapped. Set it only when one sequence genuinely needs more than `n_ctx / n_seq_max`.
- **A stolen slot is not a lost prompt, but it is a PCIe round-trip.** Slot selection is
  longest-common-prefix first, LRU second (`server-context.cpp:1560-1623`); on an LRU pick, or when
  the incoming task would discard more than half the slot (`f_keep < 0.5`), the outgoing prompt is
  saved to the host cache and the best match reloaded (`:1631-1645`). `cache-ram` sizes that cache
  in MiB, but its *token* budget defaults to `ctx-size`, so raising `ctx-size` also buys cache
  depth. Upstream built this to make one slot sufficient for agentic clients (#16391); the mtmd
  incompatibility noted there is fixed — `server_tokens::deserialize` carries media chunks.
- **A second slot removes the round-trip entirely, for the cost of the SWA caches only.** Measured
  on the dual-GPU Muse Glimmer entry, `parallel = 1 -> 2` at the same per-slot context costs ~40 MiB
  (both SWA caches scale with `parallel`, not `ctx-size`). With two slots, a long conversation and
  two interleaved side calls resolved as: main prefills 7476 tokens in slot 1, both side calls land
  in slot 0, and the main follow-up returns to slot 1 with `prompt_n = 14`, `cached = 7512`,
  `f_keep = 0.993`, and no `updating prompt cache` line at all.
- **Behind an mmproj there is no partial prefix reuse at all, so prefix stability is the whole
  game.** `cache-reuse` works by KV-shifting matched chunks into new positions, and loading an
  mmproj zeroes it at startup with a warning (`server-context.cpp:1179-1182`), backed by a runtime
  guard `can_cache_reuse = llama_memory_can_shift(...) && !slot.prompt.tokens.has_mtmd`
  (`:3202-3208`). That is a mercy on a NoPE model, where the shift would be silent corruption — but
  it means the only reuse mechanism left is exact longest-common-prefix matching. One changed token
  early in the prompt costs the entire remainder. Measure it with
  `slot print_timing: ... prompt eval time = X ms / Y tokens`, where `Y` is what was actually
  re-prefilled; a warm turn should report tens of tokens, not thousands.
- **A second model is never the answer to slot contention on a single-GPU box.** `models-max` is a
  router-level parameter and is stripped from child presets (`tools/server/server-models.cpp:305`),
  so it cannot be scoped per entry. At `models-max = 1` a request for a different model is queued
  (`:113`), and the running model is unloaded the moment it goes idle to free the slot
  (`:213-214`) — so routing auxiliary traffic to a small sidecar model costs a full unload/reload of
  the large one per call. Raising it to 2 lets any two entries in the preset try to co-reside, which
  on a 16 GB + 8 GB pair is an out-of-memory abort rather than a degradation. Use `parallel` and, if
  placement must be deterministic, `id_slot`.
- **Slot placement is a tie-break, so pin it if it matters.** `f_sim` is `lcp / len(new prompt)`, so
  a *short* side call sharing only the chat template can score as high as the real conversation, and
  which slot wins comes down to scan order and the strict `>` at `server-context.cpp:1579`. Sending
  `id_slot` in the request body bypasses the heuristic (`server-context.cpp:4296` ->
  `get_slot_by_id`, logged as `selected slot by id (N)`); it works on the OpenAI-compatible route,
  not just `/completion`. Three traps: `get_slot_by_id` does `id_slot % slots.size()`, so with
  `parallel = 1` every pin silently collapses onto slot 0; a pinned slot that is busy defers the
  task rather than reassigning it; and child tasks force `id_slot = -1`
  (`tools/server/server-task.h:236`).

## ngram-mod speculative decoding

**ngram-mod speculative decoding** (`--spec-type ngram-mod`): model-agnostic, works on any model.
- All models: `spec-ngram-mod-n-match = 24`, `spec-ngram-mod-n-min = 48`, `spec-ngram-mod-n-max = 64`
  (matches the struct defaults in `common/common.h:329-337` and what `--spec-default` produces
  at `common/arg.cpp:4065-4074`; ggerganov confirmed post-merge in PR #19164 that the min/max
  "likely don't need to be changed from the recommended values"; MoEs require long drafts and
  dense models tolerate them without noticeable cost). Flags were renamed from
  `--draft-min`/`--draft-max`/`--spec-ngram-size-n` in upstream PR #22397; the old names now
  error at startup.
- `n_match < 16` logs a "too small — poor quality is possible" warning at
  `vendor/llama.cpp/common/speculative.cpp:1031-1034`; parser accepts `1..1024`
  (`common/arg.cpp:3606-3615`), so 16 is the lowest non-warning value, not a hard floor.
  Min/max parsers accept `0..1024` (`common/arg.cpp:3587-3605`).
- Memory overhead: ~16 MiB **total**, shared across all server slots
  (single `common_ngram_mod` instance allocated at `common/speculative.cpp:1026`).
- Pool auto-resets on `begin()` if occupancy > 25 %, and after 3 consecutive rounds with
  acceptance < 50 % (`common/speculative.cpp:720-728`, `:790-806`). Smaller `n_match` makes
  these resets fire more often and wipes ngrams learned from the current prompt — another
  reason to stay at `n_match ≥ 24`.
