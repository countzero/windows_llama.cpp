# Build System Reference

Why `rebuild_llama.cpp.ps1` and the `examples/*.ps1` scripts do what they do. Not
auto-loaded into the agent context; read it on demand. The one-line rules these
sections back are in AGENTS.md "Non-obvious behavior".

## Submodule lifecycle

- **The submodule always shows dirty.** `rebuild_llama.cpp.ps1` prepends an OpenBLAS linking shim to `vendor/llama.cpp/CMakeLists.txt` (idempotent; workaround for `find_package(BLAS)` failing on Windows). `.gitmodules` sets `ignore = dirty` for this reason — don't "clean it up."

- **Each build wipes the submodule** back to `origin/master` then checks out the requested `-version` / PR. Any local edits under `vendor/llama.cpp/` are lost by design. The reset/`--remote` step is **scoped to `vendor/llama.cpp` only** — other submodules (e.g. `vendor/Qwen-Fixed-Chat-Templates`, default branch `main`) stay at the SHA pinned in the superproject and are never advanced by the build script. To bump them, do it manually: `git -C vendor/Qwen-Fixed-Chat-Templates fetch && git -C vendor/Qwen-Fixed-Chat-Templates checkout <sha> && git add vendor/Qwen-Fixed-Chat-Templates && git commit`. Once the pin is committed, the next `rebuild_llama.cpp.ps1` mirrors it into the working tree (auto-discovered from `.gitmodules`, `--force`); hand-edits inside the submodule do not survive a rebuild.

## Local patches

- **`./patches/*.patch` are re-applied to `vendor/llama.cpp` on every build.** The step runs after the `-version` / PR checkout (`rebuild_llama.cpp.ps1:254-284`), because the checkout would otherwise discard them. It needs no idempotence guard like the OpenBLAS shim — the `reset --hard` earlier in the script guarantees a clean tree. Applied with `git apply --3way`, so a patch still lands when upstream moves the lines *around* a hunk; if it fails, upstream moved the patched code itself and the script `throw`s rather than silently building an unpatched tree. `--3way` implies `--index`, which would leave the files staged and make `git checkout -- <file>` restore the *patched* copy instead of the upstream one — the trailing `git reset --quiet` unstages them so they show up as plain worktree modifications, same as the shim.

- **`0001-gguf-py-size-row-groups-by-bytes.patch` fixes a 27x conversion slowdown.** `_apply_over_grouped_rows` (`gguf-py/gguf/quants.py:29`) split rows into groups of 16 *rows*, so the group's byte size followed the row width. The patch grows the group until it holds 160 KiB of input but never goes below 16 rows, leaving `np.array_split` and `np.concatenate(..., out=out)` untouched. Two lines of logic. Measured full scale (3.355 GB f32 in) on Windows with numpy 2.2.6: a 640-wide row goes **129.4 s -> 4.8 s (27.0x)**; 2560-wide is unchanged (the budget yields exactly 16 rows there, so the patch is a no-op by construction). Across an 18-point width ladder from 128 to 16384 the patched form is flat at ~1.13-1.18 s where upstream ranges 1.12-5.13 s.

- **The cause is the Windows low-fragmentation heap, and the trigger is the *retained* block, not the working buffer.** Each `func(group)` call allocates several transient temporaries and returns one result the caller retains until the whole tensor is done. Microsoft documents that the LFH does not serve allocations above ~16 KiB. Once the retained result crosses that, the interleaving of long-lived and short-lived blocks fragments the general heap and per-allocation cost grows roughly with the square of the live block count: measured 3.7 us/alloc flat from 1 K to 65 K live blocks at 8 KiB retained, against 13 -> 526 us/alloc over the same range at 32 KiB retained. The cliff was located by varying the result-to-temporary size ratio and watching it move: it sits at 17 KiB retained for a 0.5 ratio and 16.2 KiB for 0.25, pinned to the documented ceiling in both cases. Upstream's 16 rows of 640 f32 lands at 20,480 B retained, just past it. A pure allocator microbenchmark with no gguf code reproduces the whole effect (`.tmp/.../alloc_band.py`), and the same script on glibc is flat at 0.88-1.16x with no band at any size.

- **The 16-row floor is deliberate and costs Windows real throughput; do not remove it.** Without it the budget asks for fewer than 16 rows once a f32 row exceeds 2560 elements, and that regresses Linux by about 1.2x at widths 4096-8192 — reproduced on WSL1 and on a real Debian 13 / kernel 6.12 / glibc 2.41 VM, twice, at repeats 7 and 15. The floor makes the patch a no-op for every width the budget cannot improve, so it can never be slower than upstream anywhere. The price is paid on Windows: at 5120-wide full scale the floored form is 7.57 s against 4.79 s unfloored (1.58x). That trade was chosen because not regressing other platforms is the harder constraint. Flipping `max(16, ...)` back to `max(1, ...)` buys the Windows win back and is a one-character change.

- **Three alternatives were measured and rejected.** A larger fixed row count only relocates the fault, because the pathology follows `rows x width x itemsize`: 64 rows fixes 640-wide and breaks 160-wide (4.1 s -> 26.4 s). Writing each group straight into `out` instead of concatenating is faster on Windows with numpy 2.x but regresses 2.2x on numpy 1.26.4, which upstream CI pins, and 2.3x on glibc for wide rows. Bounding the *retained* block to 16 KiB directly, which the mechanism suggests, loses 1.18-1.24x to the 160 KiB input budget at every scale from 1/8 to full. A `np.uint64` widening in `BF16.quantize_blocks` is worth a further 1.41x on Windows / 1.84x on glibc and was measured but **deliberately left out** to keep this patch to one concern; it is a separate change to a line upstream added on purpose in #7843.

- **It is a throughput fix, not an OOM fix, and the `per_layer_token_embd` figure is per shard.** `conversion/qwen4exp.py:145-172` wraps the 128 PLE shards in `gguf.LazyChunkedTensor`, whose `tofile` quantizes one shard at a time (`gguf-py/gguf/lazy.py:275-289`), so `_apply_over_grouped_rows` only ever sees ~1.6 GB of that table, never all 95 GiB. Peak RSS for it was solved separately by `53c0f624a` (stream the shards, ~300 GB -> one shard) and `a510c82e1` (`LazyChunkedTensor`) — don't re-credit that to this patch. Don't pitch the patch upstream against #15623 / #15648 either: both target peak RSS, and this patch does not change it.

- **The patch is byte-for-byte equivalent to upstream, and that was verified three ways.** Against the C implementation with `python gguf-py/tests/test_quants.py --libggml build/bin/Release/ggml-base.dll` (25 types, 60 exact matches, 0 mismatches, exit 0); across 10 type and width combinations in both quantize and dequantize directions on Windows/numpy 2.2.6, Windows/numpy 1.26.4 and glibc/numpy 2.2.6; and over 15 adversarial shapes covering a single row, row counts below one group, prime row counts that leave a remainder, and rows up to 262144 wide (180 comparisons per numpy version, 0 failures). Note `test_quants.py` needs `ggml-base.dll`, not `ggml.dll` — only the former exports `ggml_quantize_chunk` — and `ctypes` needs both `%CUDA_PATH%\bin` and `%CUDA_PATH%\bin\x64` added via `os.add_dll_directory` before the load will resolve.

## Toolchain detection

- **`ml64.exe` (MASM) must be passed as `-DCMAKE_ASM_COMPILER`.** Upstream `ggml/CMakeLists.txt` sets `cmake_policy(SET CMP0194 NEW)` and declares `project(... ASM)`; on CMake 4.1+ with the VS generator this rejects `cl.exe` as the ASM compiler. The script locates `ml64.exe` via `vswhere.exe`. Don't remove. The `vswhere` call passes `-requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64` alongside `-latest` — this is deliberate, not redundant: `-latest` alone returns the newest-installed instance by timestamp, which on a machine with multiple instances may be a Build Tools install lacking the C++ workload, so `-find` returns nothing and the build throws "ml64.exe not found" even though another instance (e.g. Community) has it (#3). `-requires` narrows `-latest` to instances that actually carry the MSVC x64 toolset, matching the pattern upstream uses in `.github/workflows/build-cpu.yml`. Don't drop the `-requires` filter.

- **CUDA is selected iff *both* `nvidia-smi` and `nvcc` are on PATH.** Missing either silently falls back to OpenBLAS.

## CUDA build flags

- **CUDA builds pass `-DGGML_CUDA_FA_ALL_QUANTS=ON`, and the failure without it is silent.** Without the flag the CUDA flash-attention path compiles only four *symmetric* KV kernels — `f16/f16`, `q4_0/q4_0`, `q8_0/q8_0`, `bf16/bf16` (`vendor/llama.cpp/ggml/src/ggml-cuda/CMakeLists.txt:119-124`) — and `ggml_cuda_get_best_fattn_kernel` returns `BEST_FATTN_KERNEL_NONE` for `q4_1` / `q5_0` / `q5_1` (`ggml-cuda/fattn.cu:338-356`) or any mismatched K/V pair (`:442-446`). The `GGML_ABORT` at `fattn.cu:574` is unreachable: `supports_op` consults `ggml_cuda_flash_attn_ext_supported` first (`ggml-cuda/ggml-cuda.cu:5287`), so the scheduler simply places `FLASH_ATTN_EXT` on the **CPU** backend — no error, no log line, a ~20-30x prefill collapse (#27109). Both Muse Glimmer entries use `q5_0` K + `q4_1` V and would hit it. The flag pulls in the full `fattn-vec*.cu` set at the cost of extra `nvcc` compile time.

- **CUDA builds pass `-DGGML_SCHED_MAX_COPIES=1` (ggml's default is 4).** `sched->n_copies = parallel ? GGML_SCHED_MAX_COPIES : 1` (`vendor/llama.cpp/ggml/src/ggml-backend.cpp:1804`), so pinning it to 1 leaves every multi-copy staging branch dead even when `cparams.pipeline_parallel` is true (`src/llama-context.cpp:428-455`). Single-stream decode gains nothing from the extra copies and they cost ~1.6 GiB on a two-device layer split. It is also what keeps this repo out of #26873, where with pipeline parallelism active one image request permanently costs ~39% prefill for the process lifetime — reproduced on Qwen3.8-27B + mmproj and on Muse Glimmer, with `-ot zzz_never_matches=CUDA0` (which disables pipeline parallelism outright) the only workaround found upstream.

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
