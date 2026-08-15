# AGENTS.md

This file provides guidance to coding agents (Claude Code, OpenCode) when working with code in this repository.

## What this is

A PowerShell wrapper around upstream [llama.cpp](https://github.com/ggml-org/llama.cpp), pinned as a submodule at `vendor/llama.cpp/`. No original C/C++ lives here — only `.ps1` scripts driving CMake + MSVC + Conda. The session shell is bash on Windows; the project's own scripts must run from `pwsh`/`powershell`.

## Commands

```powershell
./rebuild_llama.cpp.ps1                          # auto-detects CUDA vs OpenBLAS
./rebuild_llama.cpp.ps1 -version "b1138"         # pin a tag / commit
./rebuild_llama.cpp.ps1 -pullRequest "18675"     # build a PR
./rebuild_llama.cpp.ps1 -target "llama-server"   # CMake target subset
./rebuild_llama.cpp.ps1 -blasAccelerator OFF     # OpenBLAS | CUDA | OFF

./examples/server.ps1 -model ".\vendor\llama.cpp\models\<x>.gguf"
Get-Help -Detailed ./examples/server.ps1         # full option list
```

Binaries land in `./vendor/llama.cpp/build/bin/Release/`. Conda env `llama.cpp` (Python 3.12) must already exist — the scripts call `conda activate llama.cpp` themselves.

**No tests, no linter.** Verify changes by running an example script against a real GGUF model.

## Non-obvious behavior

- **The submodule always shows dirty.** `rebuild_llama.cpp.ps1` prepends an OpenBLAS linking shim to `vendor/llama.cpp/CMakeLists.txt` (idempotent; workaround for `find_package(BLAS)` failing on Windows). `.gitmodules` sets `ignore = dirty` for this reason — don't "clean it up."
- **Each build wipes the submodule** back to `origin/master` then checks out the requested `-version` / PR. Any local edits under `vendor/llama.cpp/` are lost by design. The reset/`--remote` step is **scoped to `vendor/llama.cpp` only** — other submodules (e.g. `vendor/Qwen-Fixed-Chat-Templates`, default branch `main`) stay at the SHA pinned in the superproject and are never advanced by the build script. To bump them, do it manually: `git -C vendor/Qwen-Fixed-Chat-Templates fetch && git -C vendor/Qwen-Fixed-Chat-Templates checkout <sha> && git add vendor/Qwen-Fixed-Chat-Templates && git commit`. Once the pin is committed, the next `rebuild_llama.cpp.ps1` mirrors it into the working tree (auto-discovered from `.gitmodules`, `--force`); hand-edits inside the submodule do not survive a rebuild.
- **`ml64.exe` (MASM) must be passed as `-DCMAKE_ASM_COMPILER`.** Upstream `ggml/CMakeLists.txt` sets `cmake_policy(SET CMP0194 NEW)` and declares `project(... ASM)`; on CMake 4.1+ with the VS generator this rejects `cl.exe` as the ASM compiler. The script locates `ml64.exe` via `vswhere.exe`. Don't remove. The `vswhere` call passes `-requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64` alongside `-latest` — this is deliberate, not redundant: `-latest` alone returns the newest-installed instance by timestamp, which on a machine with multiple instances may be a Build Tools install lacking the C++ workload, so `-find` returns nothing and the build throws "ml64.exe not found" even though another instance (e.g. Community) has it (#3). `-requires` narrows `-latest` to instances that actually carry the MSVC x64 toolset, matching the pattern upstream uses in `.github/workflows/build-cpu.yml`. Don't drop the `-requires` filter.
- **CUDA is selected iff *both* `nvidia-smi` and `nvcc` are on PATH.** Missing either silently falls back to OpenBLAS.
- **CUDA builds pass `-DGGML_CUDA_FA_ALL_QUANTS=ON`.** Without it the CUDA flash-attention path compiles only four *symmetric* KV kernels — `f16/f16`, `q4_0/q4_0`, `q8_0/q8_0`, `bf16/bf16` (`vendor/llama.cpp/ggml/src/ggml-cuda/CMakeLists.txt:119-124`) — and the dispatcher returns `BEST_FATTN_KERNEL_NONE` -> `GGML_ABORT` for any other K type or any mismatched K/V pair (`ggml-cuda/fattn.cu:424-446`). The flag pulls in the full `fattn-vec*.cu` set so asymmetric / q5 / q4_1 caches work (the presets use `q5_0` K + `q4_1` V). Costs extra `nvcc` compile time.
- **Build parallelism is SMT-aware.** `cmake --build --parallel` is fed a count derived from `Win32_Processor`. Upstream's `UseMultiToolTask=true` + `EnforceProcessCountAcrossBuilds=true` (`vendor/llama.cpp/CMakeLists.txt:92-93`) makes this the single cap on concurrent `cl.exe`/`nvcc` — no per-project `/MP` multiplication. On SMT CPUs it uses physical cores (`Sum(NumberOfCores)`): dropping the logical siblings avoids starving the scheduler / ~doubling peak `nvcc` RAM (no throughput gain) and leaves them free so the machine stays usable. On non-SMT CPUs where physical == logical (hybrid Arrow/Lunar Lake; e.g. Core Ultra 9 285HX = 8P+16E, 24 threads) using all cores would peg the box at 100%, so it backs off to 80% of physical (`floor(cores * 0.8)` = 19 on the 285HX) to keep the machine usable during builds. Override with `-parallelJobs N`.
- **`requirements_override.txt` layers on top of upstream `vendor/llama.cpp/requirements.txt`.** It pins `torch` to a CUDA 12.6 wheel, adds `tiktoken` (missing upstream, required for GLM), pins `transformers==5.3.0`, and narrows `numpy` to resolve an `opencv-python-headless` conflict. When bumping any of these, verify both constraints still hold.
- **`server.ps1` reads GGUF metadata** by shelling out to `vendor/llama.cpp/gguf-py/gguf/scripts/gguf_dump.py`. Upstream has moved this path before (CHANGELOG 1.24.0) — if server startup fails with "Failed to extract model details", check the path first.
- **`server.ps1 -additionalArguments` splits on whitespace** and re-pairs tokens into key/value flags. Values that contain spaces will not survive this parser.
- **`speed-bench.ps1` drives a router-mode server**, not a single model — it shells out to the vendored `vendor/llama.cpp/tools/server/bench/speed-bench/speed_bench.py` (wiped/refreshed each rebuild, so it tracks the built binary) and sweeps the `-models` preset ids in order, pre-warming each via the router-only `/models/load` endpoint and lazy-swapping through `--models-max 1`. Comparison anchors on the first id; models that fail to load are excluded, not fatal. Needs the `datasets` package (deliberately not in the main requirements) plus network access for the `nvidia/SPEED-Bench` dataset. The router-only `/v1/models` and `/models/load` endpoints mean it does not work against a plain single-model server. If startup fails reading the script after a rebuild, check whether upstream moved `tools/server/bench/speed-bench/` (same failure mode as the `gguf_dump.py` note above).
- **Rebuild aborts on running build-tree processes.** Before any destructive op, `rebuild_llama.cpp.ps1` checks `Get-Process` for any EXE under `vendor/llama.cpp/build/` and throws with the PID list. Catches the forgot-to-stop-`llama-server.exe` case.
- **`load-mode = dio` does not enable DirectIO on Windows — it only disables mmap.** The Win32 `llama_file::impl` ctor takes `use_direct_io` as `[[maybe_unused]]` and just calls `ggml_fopen` (`vendor/llama.cpp/src/llama-mmap.cpp:86-95`); `FILE_FLAG_NO_BUFFERING` is never set and `read_alignment()` stays 1 (`:391`), so the loader's async staging buffers are 4 x 1 MiB of pinned host memory instead of the 4 x 64 MiB the aligned path would use (`src/llama-model-loader.cpp:1418`, `:1427`). `has_direct_io()` nevertheless returns a hardcoded `true` on Windows (`:173-175`). Net effect of `dio` on this platform: buffered reads, no mmap, and zero VRAM cost — it is never implicated in a CUDA OOM. Keep the key for the deprecation-warning reason documented under Presets, but do not reason about page-cache behaviour from it.

## Presets

VRAM-tier presets: `presets/models_16GB_VRAM.ini`, `presets/models_24GB_VRAM.ini`,
`presets/models_16GB_8GB_VRAM.ini` (dual-GPU).
See `presets/README.md` for the user-facing quick-start; notes below are for editing.

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

- **All entries use `load-mode = dio`; never pair `direct-io` with `no-mmap` again.** Both spellings
  are deprecated, and they write the *same* mutually exclusive enum — `--no-mmap` sets
  `LLAMA_LOAD_MODE_NONE` (`common/arg.cpp:2594`) while `--direct-io` sets
  `LLAMA_LOAD_MODE_DIRECT_IO` (`:2603`) — so setting both means only whichever is parsed last wins.
  Which one that is is *not* the INI order: `common/preset.cpp` emits `opt.args.back()` while
  iterating an unordered map. It happened to resolve to DirectIO, but a container-order change would
  silently downgrade to `NONE`, dropping DirectIO *and* mmap for plain buffered reads. `dio` is the
  single equivalent of the old pair and also removes two deprecation warnings per launch. Valid
  values are `none`, `mmap`, `mlock`, `mmap+mlock`, `dio` (`arg.cpp:2615-2619`) — anything else
  throws at startup.

- **Qwen-VL entries pin `image-min-tokens = 1024`.** `clip.cpp:1500` sets the per-image token limits
  to `(8, 4096)`, so the default *minimum* is 8 tokens — 8192 px at `merge = 2` / `patch = 16` — and
  `clip.cpp:1502-1506` warns on every load because upstream needs >= 1024 tokens (1024x1024 px) for
  grounding (#16842). The key raises a floor only: images already above 1024 tokens are unchanged,
  smaller ones get upscaled, which costs context and CLIP time on the CPU because the 16 GB tier
  sets `no-mmproj-offload = true`; the 24 GB `Qwen3.8-27B` entry offloads CLIP to the GPU and
  pays it there instead. Applies to the `qwen3vl_merger` entries (Qwen3.6, Qwen3.8 and
  Ternary-Bonsai); gemma-4 uses a different projector and must not get this key.

- **`mmproj-offload = true` fails silently at startup on a saturated GPU.** CLIP's warmup
  compute buffer OOMs but the server keeps running — only image requests error at generation
  time. Set `false` on tiers where LLM + KV already saturate VRAM.

- **All Qwen 3.6 entries pin `chat-template-file = vendor\Qwen-Fixed-Chat-Templates\chat_template.jinja`.**
  Required, *not* redundant with `jinja = true` — `chat-template-file` *replaces*
  the GGUF-embedded template entirely (`vendor/llama.cpp/common/arg.cpp:3142`,
  `params.chat_template = read_file(value)`). The upstream embedded template has
  documented issues with tool calls, role handling, `<think>` block rendering,
  agentic loops, and llama.cpp KV-prefix cache stability; the vendored template
  fixes all of them (full list in `vendor/Qwen-Fixed-Chat-Templates/README.md`).
  Since v19 the template is a single unified file covering both Qwen 3.5 and 3.6
  variants (the old `qwen3.5/` and `qwen3.6/` subdirectories now live under
  `archive/`). The template adds a `<|think_on|>` / `<|think_off|>` toggle, and
  v19 defaults `preserve_thinking` to `true` (past `<think>` blocks are kept
  chronologically for 100% KV prefix cache stability and agentic reasoning
  continuity). To strip past `<think>` blocks instead, set
  `chat-template-kwargs = {"preserve_thinking":false}` — at the cost of a lower
  KV cache hit rate. Path is repo-relative, so `llama-server` must be launched
  from the repo root — `read_file()` resolves against the process CWD, not the
  INI file's directory. `Qwen3-Coder-Next` entries deliberately keep their
  GGUF-embedded template; froggeric's README only claims compatibility for
  Qwen 3.5 / 3.6 variants.

- **`Qwen3.8-27B` also keeps its GGUF-embedded template — do not "fix" the missing pin.**
  Qwen 3.8 reuses arch `qwen35` and is otherwise byte-for-byte the same shape as
  Qwen3.6-27B (65 blocks, 866 tensors, same `ssm.*`, same 248320-token tokenizer,
  `eos = 248046`), so the tier entry is a near-clone of the 3.6 one. The template is the
  exception: 3.8 embeds a *different, newer* 8952-byte file, not the 7764-byte one the
  pin exists to replace. It already applies the fix the pin is for — `preserve_thinking`
  now defaults on (`preserve_thinking is undefined or preserve_thinking is true or ...`)
  — and it adds `reasoning_effort`, which lives *only* in the model's own template.
  Pinning froggeric's file would therefore silently downgrade the template *and* turn
  `--reasoning-effort` into a no-op, because that flag only writes a template kwarg
  (`common/arg.cpp:3649-3660`) and never reaches the parser. Valid values here are
  `xhigh` (default) / `medium` / `low` only — the template calls `raise_exception` on
  anything else, so the `"high"` used by the DeepSeek entry is startup-fatal on Qwen.
  With `reasoning = on` the default already resolves to `xhigh`, so the entry sets no
  `reasoning-effort` key. Tool-call parsing is unaffected either way: the qwen3_coder
  XML handler is selected purely on `<tool_call>` + `<function=` + `<parameter=` being
  present in the template source (`common/chat.cpp:3364-3369`), which both files satisfy.
  What is lost versus the pin are froggeric's agentic extras (two-tier tool-error
  escalation, `<|think_on|>` / `<|think_off|>`, `developer` role).

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
  silent-OOM window described above. Quality is not the tradeoff: Qwen ships this family's
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
  `models/templates/` (same failure mode as the `gguf_dump.py` note above).

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
  autoparser rather than being repaired. `reasoning_effort` has no CLI flag
  (`server-common.cpp:1089-1095` honours only the literal `"none"`), so the only route is
  `chat-template-kwargs = {"reasoning_effort":"high"}` (or `"max"`); left unset the template
  defaults it to `none` and emits no effort block at all, and `reasoning = off` voids it
  entirely. Do not set `reasoning-format`: the compiled default is already `deepseek`
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

## Changelog style

- One bullet = one physical line. Never insert manual line-breaks; let the editor soft-wrap.
- Format: `- [Component] <verb> <thing>` (Added / Changed / Fixed / Removed).
- No rationale, no file paths, no line numbers, no explanatory prose. Rationale lives in AGENTS.md "Non-obvious behavior" or in the commit message.
- PR refs as bare `#NNNNN`, at most once per release.
- Canonical examples: [1.21.0] – [1.27.0] in CHANGELOG.md.

## Scratch Files

Non-committed agent artifacts (diffs, trace outputs, generated reports, experimental scripts) go under `.tmp/sessions/<session-id>/` at the repo root; `.tmp/` is gitignored. `<session-id>` is `SESSION_ID` when the platform injects it, otherwise a minted `YYYYMMDD-HHMMSS-<random6>`. Never write scratch files to `.claude/`, the repo root, or `vendor/`.
