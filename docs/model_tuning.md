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
  KV cache hit rate. v22 also honours `preserve_reasoning`, so `--reasoning-preserve`
  (`common/arg.cpp:3677-3689`) works as the CLI equivalent. Path is repo-relative,
  so `llama-server` must be launched from the repo root — `read_file()` resolves
  against the process CWD, not the INI file's directory. `Qwen3-Coder-Next` entries
  deliberately keep their GGUF-embedded template; froggeric's README claims
  compatibility only for Qwen 3.5 / 3.6 / 3.8 variants.

- **Every Qwen 3.6 and Bonsai entry pins `reasoning-effort = medium`; the Qwen 3.8 entry does not.**
  v22 added Qwen 3.8's reasoning-effort steering but gates it on nothing — the default
  resolves to `xhigh` for *every* model the template serves, injecting a ~45-token
  "Reasoning effort is set to xhigh..." paragraph at the top of the system prompt.
  Qwen 3.6 has no trained notion of the concept, so the entries pin `medium`, the one
  level for which v22 emits no instruction text at all. Qwen 3.8 *is* trained on it and
  its own template defaults to `xhigh`, so that entry leaves the key unset and inherits
  the same default it had before the pin. `--reasoning-effort` writes only a template
  kwarg (`common/arg.cpp:3650-3660`), which a request can still override
  (`tools/server/server-common.cpp:1296-1303`). Unlike the GGUF-embedded 3.8 template,
  v22 never raises on an unknown level — `high` is aliased to `xhigh` and anything else
  falls back to it.

- **`Qwen3.8-27B` pins the template too — v22 removed the reason it used to be the exception.**
  Qwen 3.8 reuses arch `qwen35` and is otherwise byte-for-byte the same shape as
  Qwen3.6-27B (65 blocks, 866 tensors, same `ssm.*`, same 248320-token tokenizer,
  `eos = 248046`), but it embeds a *different, newer* 8952-byte template, not the
  7764-byte one shared by Qwen3.6-27B and both Bonsai variants. That newer file already
  defaults `preserve_thinking` on and adds `reasoning_effort`, which is why the entry
  shipped unpinned until v22 supported 3.8. Three defects justify pinning anyway, all
  reproducible by rendering the embedded template directly: tool calls whose `arguments`
  arrive as a JSON *string* (what most OpenAI-compatible clients send) abort with
  `Can only get item pairs from a mapping`; history carrying reasoning inside `content`
  rather than `reasoning_content` renders a duplicate blank `<think>\n\n</think>` ahead
  of the real block, because 3.8 dropped the in-content parser; and `reasoning_effort`
  accepts only `xhigh` / `medium` / `low`, calling `raise_exception` on `high`,
  `minimal` and `max` — three of the six levels `common/arg.cpp:3651` advertises.
  v22 handles all three and its `xhigh` instruction text is byte-identical to the
  official one, so `reasoning = on` with no `reasoning-effort` key reproduces the
  pre-pin prompt. Tool-call parsing is unaffected: the qwen3_coder XML handler is
  selected purely on `<tool_call>` + `<function=` + `<parameter=` being present in the
  template source (`common/chat.cpp:3364-3369`), which both files satisfy, and the PEG
  parser is built from `inputs.tools` rather than the rendered `<tools>` block. The pin
  additionally brings froggeric's agentic extras (two-tier tool-error escalation,
  `<|think_on|>` / `<|think_off|>`, `developer` role, payload truncation).

- **v22 fixed two v19 deviations from the official Qwen prompt format, so the bump changed
  every pinned entry, not just the new 3.8 one.** v19 serialized `<tools>` entries
  *unwrapped* (`{"description": ..., "name": ..., "parameters": ...}`); v22 emits the
  wrapped OpenAI form (`{"function": {...}, "type": "function"}`), which is what
  Qwen3.6-27B's own 7764-byte template and Qwen 3.8's 8952-byte one both produce — v19
  was the outlier. v19 also rendered `</think>\n` before assistant content where the
  official templates and llama.cpp's own generation prompt use `</think>\n\n`
  (`common/chat.cpp:1163`). Both are corrections, but they change prompt bytes, so the
  bump invalidates existing KV prefix caches once; `reasoning-effort = medium` suppresses
  only the new steering paragraph and does not restore v19 output.

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
  model family, so check the server's acceptance rate before trusting the speedup —
  the fix would be a re-quant keeping `blk.64` at `Q5_K` or above, not a preset change.

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
  `models/templates/` (same failure mode as the `gguf_dump.py` note in AGENTS.md
  "Non-obvious behavior").

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
  4.3k. No template may be pinned: `common/chat.cpp:3276` selects the native Muse Glimmer handler
  on `<atem:function_calls>` + `<|eom|>` in the template source, and there is no bundled file to
  pin. `reasoning = on` is a no-op — neither the handler nor the GGUF's embedded template reads
  `enable_thinking`; reasoning here is the structural ` to=self<|message|>...<|eom|>` channel,
  gated on `reasoning_format` (`chat.cpp:3141`). The template already defaults to
  `Reasoning strength: high` (`models/templates/muse-glimmer.jinja:84`), which matches Meta's
  recommendation, and `--reasoning-effort` reaches it only through the
  `reasoning_effort` -> `reasoning_strength` alias at `common/jinja/caps.cpp:29-33`.
  `--reasoning-budget` is inert: the handler sets no `thinking_end_tags`
  (`server-common.cpp:1343`).

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
