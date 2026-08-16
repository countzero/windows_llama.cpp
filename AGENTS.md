# AGENTS.md

Canonical agent-instruction file for this repository. Both Claude Code (via the `@AGENTS.md` import in `CLAUDE.md`) and OpenCode (which reads `AGENTS.md` natively) load this file. It carries the always-on rules; deep reference documentation lives under `docs/` and is read on demand, not loaded into context (see *Reference* at the end).

## What this is

A PowerShell wrapper around upstream [llama.cpp](https://github.com/ggml-org/llama.cpp), pinned as a submodule at `vendor/llama.cpp/`. No original C/C++ lives here — only `.ps1` scripts driving CMake + MSVC + Conda, plus one benchmark helper in `examples/mtp-bench.py`. The session shell is bash on Windows; the project's own scripts must run from `pwsh`/`powershell`.

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

- **The submodule always shows dirty.** `rebuild_llama.cpp.ps1` prepends an idempotent OpenBLAS linking shim to `vendor/llama.cpp/CMakeLists.txt`; `.gitmodules` sets `ignore = dirty` for it. Don't "clean it up." `docs/build_system.md` -> *Submodule lifecycle*
- **Each build wipes `vendor/llama.cpp`** back to `origin/master` then checks out the requested `-version` / PR, so local edits there are lost by design. Other submodules are never advanced by the build script and must be bumped by hand. `docs/build_system.md` -> *Submodule lifecycle*
- **`ml64.exe` (MASM) must be passed as `-DCMAKE_ASM_COMPILER`**, located via `vswhere.exe` with both `-latest` and `-requires ...VC.Tools.x86.x64`. Don't remove either. `docs/build_system.md` -> *Toolchain detection*
- **CUDA is selected iff *both* `nvidia-smi` and `nvcc` are on PATH.** Missing either silently falls back to OpenBLAS.
- **CUDA builds pass `-DGGML_CUDA_FA_ALL_QUANTS=ON`.** Without it any asymmetric or non-`f16`/`q4_0`/`q8_0`/`bf16` KV pair aborts at runtime, and the presets use `q5_0` K + `q4_1` V. Costs extra `nvcc` time. `docs/build_system.md` -> *CUDA build flags*
- **Build parallelism is SMT-aware** and is the single cap on concurrent `cl.exe`/`nvcc`: physical cores on SMT CPUs, 80% of them on non-SMT hybrids. Override with `-parallelJobs N`. `docs/build_system.md` -> *Build parallelism*
- **`requirements_override.txt` layers on top of upstream `vendor/llama.cpp/requirements.txt`**, pinning `torch` (cu126), `transformers`, `numpy`, and adding `tiktoken`. When bumping any of them, verify both constraints still hold. `docs/build_system.md` -> *Python requirements layering*
- **Three vendored paths are hardcoded** (`gguf_dump.py`, `speed-bench/`, `models/templates/`). Upstream has moved them before; after a version bump treat a startup failure naming one as a relocation first. `docs/build_system.md` -> *Upstream path dependencies*
- **`server.ps1 -additionalArguments` splits on whitespace** and re-pairs tokens into key/value flags. Values that contain spaces will not survive this parser.
- **`speed-bench.ps1` drives a router-mode server**, not a single model, and needs the `datasets` package plus network access. It does not work against a plain single-model server. `docs/build_system.md` -> *Upstream path dependencies*
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

Non-committed agent artifacts (diffs, trace outputs, generated reports, experimental scripts) go under `.tmp/sessions/<session-id>/` at the repo root; `.tmp/` is gitignored. `<session-id>` is the `SESSION_ID` injected into context at session start — by the `SessionStart` hook in `.claude/settings.json` under Claude Code, by `.opencode/plugins/session-id-injector.js` under OpenCode. If neither fired and no `SESSION_ID` is in context, mint `YYYYMMDD-HHMMSS-<random6>` instead. Never write scratch files to `.claude/`, the repo root, or `vendor/`.

## Reference

Deep reference documentation lives under `docs/` and is **read on demand**, not loaded into context. Consult the relevant file when a task touches its area:

| Document               | When to read                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/build_system.md` | Why the build scripts do what they do: submodule lifecycle, `ml64.exe`/`vswhere` toolchain detection, CUDA flags, SMT-aware parallelism, the Python requirements layering, and the hardcoded upstream paths. **Read before editing `rebuild_llama.cpp.ps1` or any `examples/*.ps1`.** |
| `docs/presets.md`      | Cross-model INI rules: device pinning and multi-GPU, `load-mode`, `mmproj-offload`, context size and `override-kv`, ngram-mod speculative decoding. **Read before editing any file under `presets/`.** |
| `docs/model_tuning.md` | Per-family rationale and measured VRAM/throughput numbers for Qwen 3.6 and 3.8, gemma-4, Bonsai and DSpark, DeepSeek-V4-Flash, and Muse Glimmer. **Read before adding, retuning or removing a model entry.** |
