# Build System Reference

Why `rebuild_llama.cpp.ps1` and the `examples/*.ps1` scripts do what they do. Not
auto-loaded into the agent context; read it on demand. The one-line rules these
sections back are in AGENTS.md "Non-obvious behavior".

## Submodule lifecycle

- **The submodule always shows dirty.** `rebuild_llama.cpp.ps1` prepends an OpenBLAS linking shim to `vendor/llama.cpp/CMakeLists.txt` (idempotent; workaround for `find_package(BLAS)` failing on Windows). `.gitmodules` sets `ignore = dirty` for this reason — don't "clean it up."

- **Each build wipes the submodule** back to `origin/master` then checks out the requested `-version` / PR. Any local edits under `vendor/llama.cpp/` are lost by design. The reset/`--remote` step is **scoped to `vendor/llama.cpp` only** — other submodules (e.g. `vendor/Qwen-Fixed-Chat-Templates`, default branch `main`) stay at the SHA pinned in the superproject and are never advanced by the build script. To bump them, do it manually: `git -C vendor/Qwen-Fixed-Chat-Templates fetch && git -C vendor/Qwen-Fixed-Chat-Templates checkout <sha> && git add vendor/Qwen-Fixed-Chat-Templates && git commit`. Once the pin is committed, the next `rebuild_llama.cpp.ps1` mirrors it into the working tree (auto-discovered from `.gitmodules`, `--force`); hand-edits inside the submodule do not survive a rebuild.

## Local patches

- **`./patches/*.patch` are re-applied to `vendor/llama.cpp` on every build.** The step runs after the `-version` / PR checkout (`rebuild_llama.cpp.ps1:254-284`), because the checkout would otherwise discard them. It needs no idempotence guard like the OpenBLAS shim — the `reset --hard` earlier in the script guarantees a clean tree. Applied with `git apply --3way`, so a patch still lands when upstream moves the lines *around* a hunk; if it fails, upstream moved the patched code itself and the script `throw`s rather than silently building an unpatched tree. `--3way` implies `--index`, which would leave the files staged and make `git checkout -- <file>` restore the *patched* copy instead of the upstream one — the trailing `git reset --quiet` unstages them so they show up as plain worktree modifications, same as the shim.

- **`0001-gguf-py-write-row-groups-directly.patch` fixes a 26x conversion slowdown.** `_apply_over_grouped_rows` (`gguf-py/gguf/quants.py:29`) collected every 16-row group in a Python list and merged them with a single `np.concatenate(..., out=out)`. That keeps all groups alive at once and costs an extra full copy of the result, and it degrades sharply with tensor size rather than linearly. Measured on Qwen3.8-Flash-Next `blk.N.ffn_down_exps.weight` (512 x 2560 x 640 f32, 1.68 GB out), BF16 conversion ran at **13.2 MB/s** — against 348.8 MB/s for the identical byte count in the `ffn_gate/up_exps` layout (512 x 640 x 2560), which has 4x fewer groups. Writing each group straight into `out`, and sizing groups by bytes (160 KiB, so one group stays in L2 at any row length), gives a uniform ~500 MB/s: 497.9 / 505.9 / 490.8 MB/s on the down, gate-up and `per_layer_token_embd` shapes, i.e. 37.6x / 1.5x / 2.2x. Per expert tensor the whole stack-plus-quantize pipeline goes 126.7 s -> 4.7 s (26.7x); the residual 1.4 s is the `torch.stack` upcast, which this patch does not touch. The second hunk drops a `np.uint64` widening in `BF16.quantize_blocks` (worth a further ~21%); the NaN fixup directly above it caps `n`, so the add cannot overflow uint32.

- **The patch is byte-for-byte equivalent to upstream, and that was verified three ways.** Against the C implementation with `python gguf-py/tests/test_quants.py --libggml build/bin/Release/ggml-base.dll` (25 types, 60 exact matches, identical output before and after apart from a shifted warning line number); across all 24 registered quant types in both quantize and dequantize directions over six shapes chosen to exercise the remainder path; and for the `uint32` kernel exhaustively over all 2^32 float32 bit patterns (0 mismatches, NaN-fixup path hit 16.7M times). Note `test_quants.py` needs `ggml-base.dll`, not `ggml.dll` — only the former exports `ggml_quantize_chunk` — and `ctypes` needs both `%CUDA_PATH%\bin` and `%CUDA_PATH%\bin\x64` added via `os.add_dll_directory` before the load will resolve.

## Toolchain detection

- **`ml64.exe` (MASM) must be passed as `-DCMAKE_ASM_COMPILER`.** Upstream `ggml/CMakeLists.txt` sets `cmake_policy(SET CMP0194 NEW)` and declares `project(... ASM)`; on CMake 4.1+ with the VS generator this rejects `cl.exe` as the ASM compiler. The script locates `ml64.exe` via `vswhere.exe`. Don't remove. The `vswhere` call passes `-requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64` alongside `-latest` — this is deliberate, not redundant: `-latest` alone returns the newest-installed instance by timestamp, which on a machine with multiple instances may be a Build Tools install lacking the C++ workload, so `-find` returns nothing and the build throws "ml64.exe not found" even though another instance (e.g. Community) has it (#3). `-requires` narrows `-latest` to instances that actually carry the MSVC x64 toolset, matching the pattern upstream uses in `.github/workflows/build-cpu.yml`. Don't drop the `-requires` filter.

- **CUDA is selected iff *both* `nvidia-smi` and `nvcc` are on PATH.** Missing either silently falls back to OpenBLAS.

## CUDA build flags

- **CUDA builds pass `-DGGML_CUDA_FA_ALL_QUANTS=ON`.** Without it the CUDA flash-attention path compiles only four *symmetric* KV kernels — `f16/f16`, `q4_0/q4_0`, `q8_0/q8_0`, `bf16/bf16` (`vendor/llama.cpp/ggml/src/ggml-cuda/CMakeLists.txt:119-124`) — and the dispatcher returns `BEST_FATTN_KERNEL_NONE` -> `GGML_ABORT` for any other K type or any mismatched K/V pair (`ggml-cuda/fattn.cu:424-446`). The flag pulls in the full `fattn-vec*.cu` set so asymmetric / q5 / q4_1 caches work (the presets use `q5_0` K + `q4_1` V). Costs extra `nvcc` compile time.

## Build parallelism

- **Build parallelism is SMT-aware.** `cmake --build --parallel` is fed a count derived from `Win32_Processor`. Upstream's `UseMultiToolTask=true` + `EnforceProcessCountAcrossBuilds=true` (`vendor/llama.cpp/CMakeLists.txt:92-93`) makes this the single cap on concurrent `cl.exe`/`nvcc` — no per-project `/MP` multiplication. On SMT CPUs it uses physical cores (`Sum(NumberOfCores)`): dropping the logical siblings avoids starving the scheduler / ~doubling peak `nvcc` RAM (no throughput gain) and leaves them free so the machine stays usable. On non-SMT CPUs where physical == logical (hybrid Arrow/Lunar Lake; e.g. Core Ultra 9 285HX = 8P+16E, 24 threads) using all cores would peg the box at 100%, so it backs off to 80% of physical (`floor(cores * 0.8)` = 19 on the 285HX) to keep the machine usable during builds. Override with `-parallelJobs N`.

## Python requirements layering

- **`requirements_override.txt` layers on top of upstream `vendor/llama.cpp/requirements.txt`.** It pins `torch` to a CUDA 12.6 wheel, adds `tiktoken` (missing upstream, required for GLM), pins `transformers==5.3.0`, and narrows `numpy` to resolve an `opencv-python-headless` conflict. When bumping any of these, verify both constraints still hold.

## Upstream path dependencies

This repo hardcodes three paths inside `vendor/llama.cpp/`. Each build resets the submodule to the requested revision, so an upstream move breaks them at runtime with no build-time warning. After any `-version` / `-pullRequest` bump, a startup failure mentioning one of these should be treated as a relocation until proven otherwise:

| Path | Used by | Failure signature |
| ---- | ------- | ----------------- |
| `gguf-py/gguf/scripts/gguf_dump.py` | `examples/server.ps1` metadata read | `Failed to extract model details` |
| `tools/server/bench/speed-bench/speed_bench.py` | `examples/speed-bench.ps1` | script not found at startup |
| `models/templates/google-gemma-4-31B-it.jinja` | gemma-4 preset entries | template read fails at model load |

This is not hypothetical: upstream already relocated `gguf_dump.py` once, which is what CHANGELOG 1.24.0 records.

## speed-bench

- **`speed-bench.ps1` drives a router-mode server**, not a single model — it shells out to the vendored `vendor/llama.cpp/tools/server/bench/speed-bench/speed_bench.py` (wiped/refreshed each rebuild, so it tracks the built binary) and sweeps the `-models` preset ids in order, pre-warming each via the router-only `/models/load` endpoint and lazy-swapping through `--models-max 1`. Comparison anchors on the first id; models that fail to load are excluded, not fatal. Needs the `datasets` package (deliberately not in the main requirements) plus network access for the `nvidia/SPEED-Bench` dataset. The router-only `/v1/models` and `/models/load` endpoints mean it does not work against a plain single-model server.

## Script argument parsing

- **`server.ps1 -additionalArguments` splits on whitespace** and re-pairs tokens into key/value flags. Values that contain spaces will not survive this parser.

## Build safety checks

- **Rebuild aborts on running build-tree processes.** Before any destructive op, `rebuild_llama.cpp.ps1` checks `Get-Process` for any EXE under `vendor/llama.cpp/build/` and throws with the PID list. Catches the forgot-to-stop-`llama-server.exe` case.
