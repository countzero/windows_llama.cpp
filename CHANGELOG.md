# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] - 2024-01-25

### Added
- Add automatic NVIDIA GPU detection in the build context

### Changed
- Replace all server examples with one generic server.ps1 script
- Update OpenBLAS to v0.3.26

### Fixed
- Fix python requirements installation

## [1.5.0] - 2023-09-28

### Added
- Add Falcon 180B convert script
- Add additional convert requirements for Falcon models
- Add example for Falcon 40B model
- Add example for FashionGPT 70B model
- Add example for Llama 2 7B model
- Add example for Llama 2 13B model
- Add example for Upstage Llama 2 70B
- Add example for Phind CodeLlama 34B model
- Add example for Phind CodeLlama 34B model with 16k context
- Add example for Phind CodeLlama 34B model with 32k context
- Add example for WizardCoder 15B model
- Add example for Mistral 7B model
- Add prompt to chat with Llama 2

## [1.4.0] - 2023-09-01

### Added
- Add german language prompt
- Add JSON grammar with floating point numbers support
- Add RoPE parameter to documentation
- Add JSON response to documentation
- Add version parameter to documentation
- Add prompt cache to documentation
- Add enabling of Hardware Accelerated GPU Scheduling to documentation

### Fixed
- Fix python requirements installation

## [1.3.0] - 2023-07-13

### Added
- Add optional version parameter
- Add console output and execution duration

### Changed
- Default llama.cpp version to latest release tag

## [1.2.0] - 2023-07-06

### Added
- Add server example to the build
- Add documentation on how to use the webinterface

### Fixed
- Fix automatic update of the submodules

## [1.1.0] - 2023-07-03

### Added
- Add dataset "wikitext-2-raw-v1"
- Add documentation on how to measure model perplexity

## [1.0.0] - 2023-06-28

### Added
- OpenBLAS workaround for Windows
- Rebuild script
