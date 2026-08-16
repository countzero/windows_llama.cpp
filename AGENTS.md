# AGENTS.md

Canonical agent-instruction file for this repository. Both Claude Code (via the `@AGENTS.md` import in `CLAUDE.md`) and OpenCode (which reads `AGENTS.md` natively) load this file. It carries the always-on rules; deep reference documentation lives under `docs/` and is read on demand, not loaded into context (see *Reference* at the end).

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

## Presets

VRAM-tier presets: `presets/models_16GB_VRAM.ini`, `presets/models_24GB_VRAM.ini`, `presets/models_16GB_8GB_VRAM.ini` (dual-GPU).

`presets/README.md` is the user-facing quick-start. For editing, the cross-model rules are in `docs/presets.md` and the per-model rationale with its measured numbers is in `docs/model_tuning.md`.

## Traps

Prohibitions that cause a silent OOM, silent corruption, or a startup abort. Each is stated here without rationale so it is always in context; read the linked section before acting on one. These lines are a deliberate projection of `docs/` — when a trap changes, both move together.

- Never pair `direct-io` with `no-mmap`; use `load-mode = dio`. `docs/presets.md` -> *load-mode*
- Never set `mmproj-offload = true` on a tier where LLM + KV already saturate VRAM. `docs/presets.md` -> *mmproj-offload*
- Never set `swa-full` on a DeepSeek-V4-Flash or Muse Glimmer entry. `docs/model_tuning.md` -> *DeepSeek-V4-Flash*, *Muse Glimmer*
- Never set `context-shift` on a Muse Glimmer entry; it is silent corruption, not a refusal. `docs/model_tuning.md` -> *Muse Glimmer*
- Never add RoPE scaling to a Muse Glimmer entry. `docs/model_tuning.md` -> *Muse Glimmer*
- `no-host = true` is mandatory on the DeepSeek entry; without it the load fails as a misleading CUDA OOM. `docs/model_tuning.md` -> *DeepSeek-V4-Flash*
- Keep `fit = on` on the DeepSeek entry; never add `n-cpu-moe`/`-ot`, and never set `n-gpu-layers` to anything but `-1`. `docs/model_tuning.md` -> *DeepSeek-V4-Flash*
- `cache-type-k` and `cache-type-v` must be identical on `deepseek4`; differing values are startup-fatal. `docs/model_tuning.md` -> *DeepSeek-V4-Flash*
- Never set `image-min-tokens` on a gemma-4 entry; it is a `qwen3vl_merger` key only. `docs/model_tuning.md` -> *Qwen 3.6 and 3.8*
- Never drop a `chat-template-file` pin; it replaces the GGUF-embedded template and is not redundant with `jinja = true`. `docs/model_tuning.md`
- Quantize Qwen3.8 GGUFs from `Qwen/Qwen3.8-27B`, never from the derived `-FP8` repo. `docs/model_tuning.md` -> *Qwen 3.6 and 3.8*

## Changelog style

- One bullet = one physical line. Never insert manual line-breaks; let the editor soft-wrap.
- Format: `- [Component] <verb> <thing>` (Added / Changed / Fixed / Removed).
- No rationale, no file paths, no line numbers, no explanatory prose. Rationale lives in AGENTS.md "Non-obvious behavior", the matching `docs/` file, or the commit message.
- PR refs as bare `#NNNNN`, at most once per release.
- Canonical examples: [1.21.0] – [1.27.0] in CHANGELOG.md.

## Scratch Files

Non-committed agent artifacts (diffs, trace outputs, generated reports, experimental scripts) go under `.tmp/sessions/<session-id>/` at the repo root; `.tmp/` is gitignored. `<session-id>` is `SESSION_ID` when the platform injects it, otherwise a minted `YYYYMMDD-HHMMSS-<random6>`. Never write scratch files to `.claude/`, the repo root, or `vendor/`.

## Reference

Deep reference documentation lives under `docs/` and is **read on demand**, not loaded into context. Consult the relevant file when a task touches its area:

| Document               | When to read                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/presets.md`      | Cross-model INI rules: device pinning and multi-GPU, `load-mode`, `mmproj-offload`, context size and `override-kv`, ngram-mod speculative decoding. **Read before editing any file under `presets/`.** |
| `docs/model_tuning.md` | Per-family rationale and measured VRAM/throughput numbers for Qwen 3.6 and 3.8, gemma-4, Bonsai and DSpark, DeepSeek-V4-Flash, and Muse Glimmer. **Read before adding, retuning or removing a model entry.** |
