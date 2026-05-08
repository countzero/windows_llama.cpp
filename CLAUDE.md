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
- **Each build wipes the submodule** back to `origin/master` then checks out the requested `-version` / PR. Any local edits under `vendor/llama.cpp/` are lost by design. The reset/`--remote` step is **scoped to `vendor/llama.cpp` only** — other submodules (e.g. `vendor/Qwen-Fixed-Chat-Templates`, default branch `main`) stay at the SHA pinned in the superproject and are never advanced by the build script. To bump them, do it manually: `git -C vendor/Qwen-Fixed-Chat-Templates fetch && git -C vendor/Qwen-Fixed-Chat-Templates checkout <sha> && git add vendor/Qwen-Fixed-Chat-Templates && git commit`.
- **`ml64.exe` (MASM) must be passed as `-DCMAKE_ASM_COMPILER`.** Upstream `ggml/CMakeLists.txt` sets `cmake_policy(SET CMP0194 NEW)` and declares `project(... ASM)`; on CMake 4.1+ with the VS generator this rejects `cl.exe` as the ASM compiler. The script locates `ml64.exe` via `vswhere.exe`. Don't remove.
- **CUDA is selected iff *both* `nvidia-smi` and `nvcc` are on PATH.** Missing either silently falls back to OpenBLAS.
- **Build parallelism caps at physical cores.** `cmake --build --parallel` is fed `Sum(Win32_Processor.NumberOfCores)`. Upstream's `UseMultiToolTask=true` + `EnforceProcessCountAcrossBuilds=true` (`vendor/llama.cpp/CMakeLists.txt:92-93`) makes this the single cap on concurrent `cl.exe`/`nvcc` — no per-project `/MP` multiplication. On SMT CPUs it drops siblings (logical-count starves the scheduler, ~doubles peak `nvcc` RAM, no throughput gain). On hybrid non-SMT CPUs (Arrow/Lunar Lake; e.g. Core Ultra 9 285HX = 8P+16E, 24 threads) physical == logical → all P+E cores, which is the right ceiling: E-cores are throughput cores, not background cores. Override with `-parallelJobs N`.
- **`requirements_override.txt` layers on top of upstream `vendor/llama.cpp/requirements.txt`.** It pins `torch` to a CUDA 12.6 wheel, adds `tiktoken` (missing upstream, required for GLM), pins `transformers==5.3.0`, and narrows `numpy` to resolve an `opencv-python-headless` conflict. When bumping any of these, verify both constraints still hold.
- **`server.ps1` reads GGUF metadata** by shelling out to `vendor/llama.cpp/gguf-py/gguf/scripts/gguf_dump.py`. Upstream has moved this path before (CHANGELOG 1.24.0) — if server startup fails with "Failed to extract model details", check the path first.
- **`server.ps1 -additionalArguments` splits on whitespace** and re-pairs tokens into key/value flags. Values that contain spaces will not survive this parser.

## Presets

VRAM-tier presets: `presets/models_16GB_VRAM.ini`, `presets/models_24GB_VRAM.ini`.
See `presets/README.md` for the user-facing quick-start; notes below are for editing.

- **`mmproj-offload = true` fails silently at startup on a saturated GPU.** CLIP's warmup
  compute buffer OOMs but the server keeps running — only image requests error at generation
  time. Set `false` on tiers where LLM + KV already saturate VRAM.

- **All Qwen 3.6 entries pin `chat-template-file = vendor\Qwen-Fixed-Chat-Templates\qwen3.6\chat_template-v8.jinja`.**
  Required, *not* redundant with `jinja = true` — `chat-template-file` *replaces* the
  GGUF-embedded template entirely (`vendor/llama.cpp/common/arg.cpp:3142`,
  `params.chat_template = read_file(value)`). Upstream embeds a Jinja template with
  several bugs that bite under realistic use: the `|items` filter is rejected by the
  C++ Jinja runtime so tool calls fail; the OpenAI-spec `developer` role raises an
  exception; empty `<think>` blocks are spammed into history; on agentic loops where
  the last message is a tool result, the template hard-crashes via
  `raise_exception('No user query found in messages.')`; Qwen 3.6 specifically
  generates `</thinking>` (which the official parser splits on `</think >` and fails
  on); and any *mid-conversation* `system`/`developer` message — as injected by
  agent frameworks like opencode-dcp, Codex CLI, Docker Agent, oh-my-pi —
  raises `'System message must be at the beginning.'`. All eight fixed in the
  vendored `-v8` template (which also adds a `<|think_on|>` / `<|think_off|>`
  toggle that coexists with `chat-template-kwargs = {"preserve_thinking":true}`,
  and rewrites the auto-close-`<think>`-before-`<tool_call>` logic with
  `split`/`join` for strict C++ Jinja compatibility — the prior file used
  `rfind`/slice which is Python-Jinja only). Path is repo-relative, so
  `llama-server` must be launched from the repo root — `read_file()` resolves
  against the process CWD, not the INI file's directory. Gemma and
  `Qwen3-Coder-Next` entries deliberately keep their GGUF-embedded templates;
  upstream's README only claims compatibility for Qwen 3.5 / 3.6 variants.

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
