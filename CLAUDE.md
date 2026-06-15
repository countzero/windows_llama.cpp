# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **`ml64.exe` (MASM) must be passed as `-DCMAKE_ASM_COMPILER`.** Upstream `ggml/CMakeLists.txt` sets `cmake_policy(SET CMP0194 NEW)` and declares `project(... ASM)`; on CMake 4.1+ with the VS generator this rejects `cl.exe` as the ASM compiler. The script locates `ml64.exe` via `vswhere.exe`. Don't remove.
- **CUDA is selected iff *both* `nvidia-smi` and `nvcc` are on PATH.** Missing either silently falls back to OpenBLAS.
- **Build parallelism is SMT-aware.** `cmake --build --parallel` is fed a count derived from `Win32_Processor`. Upstream's `UseMultiToolTask=true` + `EnforceProcessCountAcrossBuilds=true` (`vendor/llama.cpp/CMakeLists.txt:92-93`) makes this the single cap on concurrent `cl.exe`/`nvcc` — no per-project `/MP` multiplication. On SMT CPUs it uses physical cores (`Sum(NumberOfCores)`): dropping the logical siblings avoids starving the scheduler / ~doubling peak `nvcc` RAM (no throughput gain) and leaves them free so the machine stays usable. On non-SMT CPUs where physical == logical (hybrid Arrow/Lunar Lake; e.g. Core Ultra 9 285HX = 8P+16E, 24 threads) using all cores would peg the box at 100%, so it backs off to 80% of physical (`floor(cores * 0.8)` = 19 on the 285HX) to keep the machine usable during builds. Override with `-parallelJobs N`.
- **`requirements_override.txt` layers on top of upstream `vendor/llama.cpp/requirements.txt`.** It pins `torch` to a CUDA 12.6 wheel, adds `tiktoken` (missing upstream, required for GLM), pins `transformers==5.3.0`, and narrows `numpy` to resolve an `opencv-python-headless` conflict. When bumping any of these, verify both constraints still hold.
- **`server.ps1` reads GGUF metadata** by shelling out to `vendor/llama.cpp/gguf-py/gguf/scripts/gguf_dump.py`. Upstream has moved this path before (CHANGELOG 1.24.0) — if server startup fails with "Failed to extract model details", check the path first.
- **`server.ps1 -additionalArguments` splits on whitespace** and re-pairs tokens into key/value flags. Values that contain spaces will not survive this parser.
- **`speed-bench.ps1` drives a router-mode server**, not a single model — it shells out to the vendored `vendor/llama.cpp/tools/server/bench/speed-bench/speed_bench.py` (wiped/refreshed each rebuild, so it tracks the built binary) and sweeps the `-models` preset ids in order, pre-warming each via the router-only `/models/load` endpoint and lazy-swapping through `--models-max 1`. Comparison anchors on the first id; models that fail to load are excluded, not fatal. Needs the `datasets` package (deliberately not in the main requirements) plus network access for the `nvidia/SPEED-Bench` dataset. The router-only `/v1/models` and `/models/load` endpoints mean it does not work against a plain single-model server. If startup fails reading the script after a rebuild, check whether upstream moved `tools/server/bench/speed-bench/` (same failure mode as the `gguf_dump.py` note above).
- **Rebuild aborts on running build-tree processes.** Before any destructive op, `rebuild_llama.cpp.ps1` checks `Get-Process` for any EXE under `vendor/llama.cpp/build/` and throws with the PID list. Catches the forgot-to-stop-`llama-server.exe` case.

## Presets

VRAM-tier presets: `presets/models_16GB_VRAM.ini`, `presets/models_24GB_VRAM.ini`.
See `presets/README.md` for the user-facing quick-start; notes below are for editing.

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
- No rationale, no file paths, no line numbers, no explanatory prose. Rationale lives in CLAUDE.md "Non-obvious behavior" or in the commit message.
- PR refs as bare `#NNNNN`, at most once per release.
- Canonical examples: [1.21.0] – [1.27.0] in CHANGELOG.md.
