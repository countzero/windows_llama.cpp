# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]

### Changed
- [Build] Enable GGML_CUDA_FA_ALL_QUANTS on CUDA builds for all KV cache quant combinations
- [Presets] Switch dual-GPU 16GB+8GB KV cache to q5_0 K / q4_1 V


## [1.37.0] - 2026-06-15

### Added
- [Examples] Add speed-bench wrapper for SPEED-Bench server benchmarking
- [Presets] Add dual-GPU models_16GB_8GB_VRAM.ini preset (16 GB + 8 GB VRAM)
- [Presets] Add gemma-4-31B EAGLE3 speculative-decoding variant to 24 GB tier
- [Tooling] Add pr-code-review and plan-review agent skills

### Changed
- [Documentation] Move repo guidance to AGENTS.md with a CLAUDE.md import shim
- [Presets] Hoist shared threads/models-max into a [*] global section on the 24 GB tier
- [Presets] Switch gemma-4-31B-it 24 GB draft model and draft KV cache to q4_0
- [Presets] Lower gemma-4 24 GB ctx sizes (31B-it 131072, EAGLE3 81920)
- [Presets] Pin gemma-4 entries to the llama.cpp-bundled google-gemma-4-31B-it chat template
- [Vendor] Bump llama.cpp submodule to e36a602

### Removed
- [Presets] Drop gemma-4-26B-A4B from 24 GB tier


## [1.36.0] - 2026-06-08

### Added
- [Presets] Add gemma-4-26B-A4B and gemma-4-12B entries to 24 GB tier

### Changed
- [Build] Default build parallelism to 80% of cores on non-SMT CPUs, physical cores on SMT CPUs
- [Presets] Add direct-io, no-mmap, and fit=off to Qwen3.6 and gemma 16/24 GB tiers
- [Presets] Add draft KV cache types (cache-type-k-draft/cache-type-v-draft) to spec-decode entries
- [Presets] Combine draft-mtp with ngram-mod on Qwen3.6 16 GB tiers
- [Presets] Rework gemma-4-31B 16 GB entry (q4_0 KV cache, no-mmproj-offload)
- [Presets] Rework gemma 24 GB tier to QAT q4_0 unquantized models with draft-mtp,ngram-mod speculative decoding
- [Presets] Set parallel=1 on Qwen3.6 24 GB entries
- [Presets] Lower Qwen3.6-27B 24 GB spec-draft-n-max to 3
- [Vendor] Bump llama.cpp submodule to 42a0afd

### Removed
- [Presets] Drop gemma-4-26B-A4B and Qwen3-Coder-Next from 16 GB tier


## [1.35.0] - 2026-05-29

### Changed
- [Presets] Combine draft-mtp with ngram-mod on Qwen3.6 24 GB tiers (RS-rollback regression fixed upstream, #23269)
- [Presets] Re-enable mmproj-offload on Qwen3.6 24 GB tiers
- [Presets] Raise Qwen3.6-27B 24 GB ctx-size from 172032 to 184320


## [1.34.0] - 2026-05-18

### Changed
- [Vendor] Bump Qwen-Fixed-Chat-Templates submodule to v19
- [Presets] Repoint chat-template-file to unified chat_template.jinja
- [Presets] Drop chat-template-kwargs preserve_thinking override
- [Presets] Fold MTP into main Qwen3.6-27B-IQ4_XS entry (spec-type draft-mtp,ngram-mod)
- [Presets] Increase MTP ctx-size on Qwen3.6 entries
- [Vendor] Bump llama.cpp submodule to c3f95c1 (#23237)

### Removed
- [Build] Drop webui-download.cmake npm-resolver patch (fixed upstream in #23064)
- [Presets] Remove standalone Qwen3.6-27B-IQ4_XS-MTP duplicate entry
- [Presets] Remove Abiray-Qwen3.6-27B-NVFP4 entries
- [Presets] Remove draft-model speculative decoding presets


## [1.33.0] - 2026-05-15

### Changed
- [Presets] Combine draft-mtp with ngram-mod fallback on Qwen3.6 MTP entries

### Fixed
- [Presets] Rename spec-type `mtp` to `draft-mtp` on Qwen3.6 MTP entries (#22673)
- [Examples] Add --model CLI flag to mtp-bench.py for router-mode compatibility


## [1.32.0] - 2026-05-15

### Added
- [Build] Abort rebuild when a running process was launched from vendor/llama.cpp/build/
- [Examples] Add MTP speculative-decoding benchmark script

### Changed
- [Vendor] Bump Qwen-Fixed-Chat-Templates submodule to 5983684 (chat_template-v13)
- [Presets] Switch all Qwen 3.6 entries to chat_template-v13.jinja
- [Documentation] Note v13 template fixes in CLAUDE.md
- [Build] Mirror pinned SHA of non-llama.cpp submodules into working tree on each build
- [Build] Patch webui-download.cmake to resolve npm via find_program


## [1.31.0] - 2026-05-10

### Added
- [Presets] Add 24 GB Qwen3.6-27B-IQ4_XS-MTP entry with spec-type=mtp (#22673)
- [Presets] Add 24 GB Qwen3.6-35B-A3B-MTP-IMAT-IQ4_XS-Q8nextn entry with spec-type=mtp

### Changed
- [Vendor] Bump Qwen-Fixed-Chat-Templates submodule to 7efa9ee (chat_template-v8)
- [Presets] Switch all Qwen 3.6 entries to chat_template-v8.jinja
- [Documentation] Note v8 template fixes in CLAUDE.md
- [Vendor] Bump llama.cpp submodule to a8fd165

### Fixed
- [Build] Force-fetch PR ref and skip unused version lookup in -pullRequest path


## [1.30.0] - 2026-05-07

### Added
- [Vendor] Add Qwen-Fixed-Chat-Templates submodule at vendor/Qwen-Fixed-Chat-Templates (pinned 81ec3f0)
- [Presets] Add 24 GB Qwen3.6-35B-A3B IQ4_XS + Qwen3.5-0.8B IQ4_XS draft entry
- [Presets] Add 24 GB Abiray-Qwen3.6-27B-NVFP4 entries (with and without speculative draft)

### Changed
- [Build] Scope per-build submodule reset to vendor/llama.cpp only
- [Presets] Wire chat-template-file to vendor/Qwen-Fixed-Chat-Templates/qwen3.6 on all Qwen 3.6 entries
- [Presets] Bump 24 GB Qwen3.6-27B preset from IQ3_XXS to IQ4_XS
- [Documentation] Clarify parallelJobs rationale for hybrid non-SMT CPUs in CLAUDE.md
- [Vendor] Bump llama.cpp submodule to 739393b


## [1.29.0] - 2026-04-28

### Added
- [Build] Add -parallelJobs option to override cmake --build --parallel
- [Presets] Add 24 GB Qwen3.6-27B IQ3_XXS + Qwen3.5-0.8B IQ4_XS draft-model entry
- [Documentation] Document physical-core build parallelism rationale in CLAUDE.md

### Changed
- [Build] Cap default build parallelism at physical cores
- [Presets] Bump Qwen3.5-27B to Qwen3.6-27B in 16 GB and 24 GB tiers
- [Presets] Tune Qwen3.6 anti-repeat sampling (min-p, presence-penalty); reduce parallel on 24 GB
- [Documentation] Refresh CLAUDE.md ngram-mod flag names and line citations
- [Vendor] Bump llama.cpp submodule to f42e29f

### Fixed
- [Presets] Adopt renamed ngram-mod flags (#22397): spec-ngram-mod-n-match / -n-min / -n-max
- [Examples] Adopt renamed draft flags in speculative_decoding.ps1: --spec-draft-n-min / -n-max / -p-min
- [Presets] Fix presence_penalty to presence-penalty hyphenation in 24 GB Qwen3.6 entries


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
