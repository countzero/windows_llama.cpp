# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]


## [1.29.0] - 2026-04-28

### Added
- [Build] `-parallelJobs <N>` override for `cmake --build --parallel`
  (`rebuild_llama.cpp.ps1`)
- [Presets] 24 GB tier: Qwen3.6-27B IQ3_XXS + Qwen3.5-0.8B IQ4_XS
  draft model — combines ngram-mod with vocab-compatible draft-model
  speculative decoding (enabled by upstream PR [#22397](https://github.com/ggml-org/llama.cpp/pull/22397); both models
  share arch `qwen3_5` and token embedding 248320 so the no-translation
  draft path is used)
- [Documentation] CLAUDE.md notes on physical-core build parallelism
  rationale (`UseMultiToolTask` + `EnforceProcessCountAcrossBuilds` make
  `--parallel N` the single authoritative cap)

### Changed
- [Build] Cap default build parallelism at physical cores instead of
  logical processors — drops SMT siblings to halve concurrent
  `cl.exe`/`nvcc`, prevents OS-scheduler starvation, and roughly halves
  peak `nvcc` RAM on CUDA builds. Override with `-parallelJobs`.
- [Presets] Bump Qwen3.5-27B → Qwen3.6-27B in both 16 GB and 24 GB
  tiers; enable `chat-template-kwargs` `preserve_thinking` on 24 GB
- [Presets] Anti-repeat-loop tuning for Qwen3.6 entries: `min-p=0.0`,
  `presence-penalty=1.5` (both tiers); reduce `parallel=1` on both
  24 GB Qwen3.6 entries
- [Documentation] Update CLAUDE.md ngram-mod section to renamed flag
  names and refresh `common/speculative.cpp` / `common/arg.cpp` line
  citations after upstream refactor ([#22397](https://github.com/ggml-org/llama.cpp/pull/22397))
- [Vendor] Bump llama.cpp submodule to `f42e29f`, picking up upstream
  PR [#22397](https://github.com/ggml-org/llama.cpp/pull/22397) (spec params refactor), PR [#21237](https://github.com/ggml-org/llama.cpp/pull/21237) (webui server tools),
  CVE-2026-21869 server fix ([#22267](https://github.com/ggml-org/llama.cpp/pull/22267)), and ~80 other upstream changes

### Fixed
- [Presets] Adopt renamed ngram-mod speculative flags (upstream PR [#22397](https://github.com/ggml-org/llama.cpp/pull/22397)):
  `spec-ngram-size-n` → `spec-ngram-mod-n-match`,
  `draft-min` → `spec-ngram-mod-n-min`,
  `draft-max` → `spec-ngram-mod-n-max`.
  Old names now error at startup ("the argument has been removed").
  Affects `presets/models_16GB_VRAM.ini` and `presets/models_24GB_VRAM.ini`.
- [Examples] Rename removed draft flags in `examples/speculative_decoding.ps1`:
  `--draft-min` → `--spec-draft-n-min`, `--draft-max` → `--spec-draft-n-max`,
  `--draft-p-min` → `--spec-draft-p-min`. Uses a real draft model so this is
  the `--spec-draft-*` family, not the ngram-mod family.
- [Presets] Fix `presence_penalty` → `presence-penalty` hyphenation in
  24 GB Qwen3.6 entries (CLI parser rejects the underscore form)


## [1.28.0] - 2026-04-22

### Added
- [Presets] Add 24 GB VRAM presets example for coding models
- [Presets] Add 16 GB VRAM presets example for coding models
- [Presets] Add presets/README.md with quick start, INI format docs,
  shipped-preset catalogue, and model-selection notes
- [Presets] Add model aliases
- [Documentation] Add CLAUDE.md with repo guidance for Claude Code

### Changed
- [Build] Override transformers package version to 5.3.0
- [Build] Override numpy to resolve opencv-python-headless dependency conflict
- [Build] Clean untracked files in vendor/llama.cpp before each build to
  prevent stale header shadowing
- [Presets] Harmonize ngram-mod speculative decoding across presets
  (n=24, draft-min=48, draft-max=64), normalize min-p=0.01 and
  ctx-checkpoints=32

### Fixed
- [Build] Pass ml64.exe as ASM compiler for CMake 4.1+ MSVC builds
  (also for the OFF accelerator case)
- [Presets] Fix 16 GB preset bugs: stray quote in Qwen3-Coder-Next header,
  missing jinja and n-cpu-moe=40, incorrect reasoning=on, and
  mmproj-offload=true CLIP warmup OOM on Qwen3.6 IQ3_XXS

## [1.27.0] - 2026-02-23

### Added
- [Build] Add bartowski1182 calibration_datav5.txt
- [Server] Add -disableMultimodal option to enable prompt caching

### Fixed
- [Documentation] Fix prerequisites installation order

## [1.26.0] - 2026-01-05

### Added
- [Build] Add -pullRequest option to build a specific pull request
- [Server] Add automatic loading of mmproj file

### Changed
- [Build] Update OpenBLAS
- [Build] Update torch and tiktoken packages
- [Server] Remove now per default enabled --jinja option
- [Server] Default llama-server host to 0.0.0.0
- [Server] Make -fa explicit

### Fixed
- [Build] Fix tiktoken package version
- [Build] Fix torch dependency
- [Build] Use -UseBasicParsing to silence warning in PowerShell 5.1
- [Server] Fix UTF-8 encoding error

## [1.25.0] - 2025-05-31

### Added
- [Server] Add -disableThinking option

## [1.24.0] - 2025-01-09

### Fixed
- [Server] Fix path to gguf_dump.py

## [1.23.0] - 2024-11-26

### Added
- [Server] Add -additionalArguments option

## [1.22.0] - 2024-10-14

### Removed
- [Server] Remove deprecated self extending context window from llama-server example
- [Server] Remove --log-disable from llama-server example

## [1.21.0] - 2024-08-03

### Added
- [Server] Add -help option
- [Server] Add -chatTemplate option
- [Server] Add human readable file size
- [Benchmark] Add llama-bench example

### Changed
- [Build] Update torch to 2.2.1+cu121
- [Build] Update OpenBLAS to 0.3.27
- [Build] Update Python to 3.12
- [Server] Default KV cache type to f16
- [Documentation] Use gemma-2-9b-it-IQ4_XS.gguf model across all examples

### Fixed
- [Build] Fix CUDA build after renaming in upstream llama.cpp
- [Build] Fix gguf_dump.py after renaming in upstream llama.cpp
- [Build] Add missing tiktoken package to support GLM models
- [Build] Fix wikitext URI

### Removed
- [Server] Remove broken chrome startup

## [1.20.0] - 2024-06-13

### Changed
- [Build] Simplify the python dependency installation
- [Build] Downgrade the "torch" package to 2.1.2+cu121

## [1.19.0] - 2024-06-13

### Added
- [Build] Add build targets option

### Changed
- [Server] Change binary `server` to `llama-server` to match renaming in llama.cpp project
- [Tools] Change binary `tokenize` to `llama-tokenize` to match renaming in llama.cpp project
- [Documentation] Update examples to match the state of the llama.cpp project

## [1.18.0] - 2024-06-05

### Added
- [Server] Limit KV cache data types to f32, f16, q8_0 and q4_0

### Changed
- [Build] Rename cuBLAS to CUDA

## [1.17.0] - 2024-06-04

### Added
- [Server] Add kvCacheDataType option
- [Server] Automatically enable q4_0 quantized KV cache with Flash Attention
- [Server] Automatically enable Flash Attention on GPUS with at least Pascal architecture
- [Build] Enable parallel building with CMake utilizing all CPU threads

## [1.16.0] - 2024-05-30

### Added
- [Server] Add verbose option
- [Server] Output the exact invocation command of the llama.cpp server

## [1.15.0] - 2024-05-27

### Added
- [Tools] Add count_tokens.ps1 script
- [Server] Add n-predict option

### Changed
- [Build] Update "torch" package to 2.4.0.dev20240516+cu121

## [1.14.0] - 2024-04-30

### Added
- [Server] Enable flash attention

### Fixed
- [Build] Fix installation of latest python packages

### Removed
- [Server] Remove now per default enabled option --cont-batching

## [1.13.0] - 2024-03-12

### Added
- [Server] Add -port option
- [Build] Add list of installed python packages

### Changed
- [Build] Update "torch" package to 2.3.0.dev20240311+cu121

## [1.12.0] - 2024-03-01

### Added
- [Server] Add fallback for empty head_count_kv values
- [Server] Add fallback if model details could not be read by gguf-dump.py

## [1.11.0] - 2024-02-20

### Added
- [Server] Add filename of the model path as an alias
- [Server] Add support for self extending the context window (SelfExtend)

## [1.10.0] - 2024-02-19

### Added
- [Server] Add automatic calculation of numberOfGPULayers option
- [Server] Add formatted output of computed memory details

### Fixed
- [Server] Fix numberOfGPULayers option override

## [1.9.0] - 2024-02-11

### Added
- [Server] Add contextSize option
- [Server] Add numberOfGPULayers option

## [1.8.0] - 2024-01-31

### Added
- [Server] Add parallel option
- [Server] Add support for executing the server example script from any directory

## [1.7.0] - 2024-01-29

### Added
- [Server] Add listing available models if model path is missing
- [Server] Add KV cache placeholder
- [Server] Add polling for server before starting the browser
- [Server] Add maximum of 10 parallel job executions

## [1.6.0] - 2024-01-25

### Added
- [Build] Add automatic NVIDIA GPU detection in the build context

### Changed
- [Server] Replace all server examples with one generic server.ps1 script
- [Build] Update OpenBLAS to v0.3.26

### Fixed
- [Build] Fix python requirements installation

## [1.5.0] - 2023-09-28

### Added
- [Build] Add Falcon 180B convert script
- [Build] Add additional convert requirements for Falcon models
- [Server] Add example for Falcon 40B model
- [Server] Add example for FashionGPT 70B model
- [Server] Add example for Llama 2 7B model
- [Server] Add example for Llama 2 13B model
- [Server] Add example for Upstage Llama 2 70B
- [Server] Add example for Phind CodeLlama 34B model
- [Server] Add example for Phind CodeLlama 34B model with 16k context
- [Server] Add example for Phind CodeLlama 34B model with 32k context
- [Server] Add example for WizardCoder 15B model
- [Server] Add example for Mistral 7B model
- [Prompt] Add prompt to chat with Llama 2

## [1.4.0] - 2023-09-01

### Added
- [Prompt] Add german language prompt
- [Grammar] Add JSON grammar with floating point numbers support
- [Documentation] Add RoPE parameter to documentation
- [Documentation] Add JSON response to documentation
- [Documentation] Add version parameter to documentation
- [Documentation] Add prompt cache to documentation
- [Documentation] Add enabling of Hardware Accelerated GPU Scheduling to documentation

### Fixed
- [Build] Fix python requirements installation

## [1.3.0] - 2023-07-13

### Added
- [Build] Add optional version parameter
- [Build] Add console output and execution duration

### Changed
- [Build] Default llama.cpp version to latest release tag

## [1.2.0] - 2023-07-06

### Added
- [Build] Add server example to the build
- [Build] Add documentation on how to use the webinterface

### Fixed
- [Build] Fix automatic update of the submodules

## [1.1.0] - 2023-07-03

### Added
- [Build] Add dataset "wikitext-2-raw-v1"
- [Build] Add documentation on how to measure model perplexity

## [1.0.0] - 2023-06-28

### Added
- [Build] OpenBLAS workaround for Windows
- [Build] Rebuild script
