# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
