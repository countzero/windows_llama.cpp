# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Codebase Overview

This repository is a Windows-specific automation wrapper for [llama.cpp](https://github.com/ggerganov/llama.cpp) that simplifies building and running large language models on Windows systems. It automates fetching dependencies, building with CMake, and provides PowerShell scripts for common operations.

### Architecture

**Root Directory Structure:**
- `rebuild_llama.cpp.ps1` - Main build script that automates the entire build process
- `examples/` - PowerShell scripts for common llama.cpp operations
  - `server.ps1` - Starts llama.cpp server with optimal settings
  - `count_tokens.ps1` - Counts tokens in prompts
  - `benchmark.ps1` - Benchmarks model performance
  - `speculative_decoding.ps1` - Demonstrates speculative decoding
- `vendor/llama.cpp/` - Git submodule containing the main llama.cpp repository
- `vendor/OpenBLAS/` - OpenBLAS library for CPU acceleration
- `cache/` - Directory for prompt cache files
- `grammars/` - Grammar files for constrained text generation
- `prompts/` - Prompt templates for different chat formats

**Key Components:**

1. **Build System** (`rebuild_llama.cpp.ps1`):
   - Automatically detects best BLAS accelerator (OpenBLAS for CPU, CUDA for NVIDIA GPUs)
   - Downloads and configures OpenBLAS
   - Builds llama.cpp with CMake using appropriate flags
   - Supports building specific versions via git tag/commit or pull requests
   - Copies dependencies to output directories

2. **Server Script** (`examples/server.ps1`):
   - Automatically calculates optimal settings based on:
     - Available system memory (RAM)
     - Available GPU memory (if NVIDIA GPU detected)
     - Model architecture details extracted from GGUF files
   - Supports multiple chat templates (llama2, llama3, vicuna, gemma, etc.)
   - Automatically enables Flash Attention if GPU supports it (Compute Capability >= 6.0)
   - Calculates optimal number of GPU layers to offload based on available VRAM

3. **BLAS Support:**
   - **OpenBLAS**: CPU-based BLAS acceleration (default fallback)
   - **CUDA**: NVIDIA GPU acceleration (auto-detected if nvidia-smi and nvcc available)

### Common Development Tasks

**Building:**
```powershell
# Build with automatic BLAS detection
./rebuild_llama.cpp.ps1

# Build with specific BLAS accelerator
./rebuild_llama.cpp.ps1 -blasAccelerator "OpenBLAS"
./rebuild_llama.cpp.ps1 -blasAccelerator "CUDA"
./rebuild_llama.cpp.ps1 -blasAccelerator "OFF"

# Build specific version
./rebuild_llama.cpp.ps1 -version "b1138"
./rebuild_llama.cpp.ps1 -version "1d16309"

# Build specific pull request
./rebuild_llama.cpp.ps1 -pullRequest 1234
```

**Running Models:**

1. **Via Server Script (Recommended):**
```powershell
# Start server with automatic optimization
./examples/server.ps1 -model "./vendor/llama.cpp/models/gemma-2-9b-it-IQ4_XS.gguf"

# Custom settings
./examples/server.ps1 -model "C:\models\model.gguf" -chatTemplate "llama3" -parallel 4
```

2. **Via CLI:**
```powershell
./vendor/llama.cpp/build/bin/Release/llama-cli \
    --model "./vendor/llama.cpp/models/model.gguf" \
    --ctx-size 8192 \
    --threads 16 \
    --interactive
```

3. **Via Web Interface:**
```powershell
./vendor/llama.cpp/build/bin/Release/llama-server \
    --model "./vendor/llama.cpp/models/model.gguf" \
    --ctx-size 8192 \
    --threads 16
# Access at http://127.0.0.1:8080/
```

**Utility Scripts:**

Count tokens:
```powershell
./examples/count_tokens.ps1 -model "./vendor/llama.cpp/models/model.gguf" -prompt "Hello World!"
```

Benchmark model:
```powershell
./examples/benchmark.ps1 -model "./vendor/llama.cpp/models/model.gguf"
```

Measure perplexity:
```powershell
./vendor/llama.cpp/build/bin/Release/llama-perplexity \
    --model "./vendor/llama.cpp/models/model.gguf" \
    --file "./vendor/wikitext-2-raw-v1/wikitext-2-raw/wiki.test.raw"
```

### Important Notes

1. **AI Contribution Policy**: This project has strict AI contribution guidelines (see `vendor/llama.cpp/AGENTS.md`). AI-generated pull requests are not accepted. AI can only be used for:
   - Asking about code structure
   - Learning techniques
   - Reviewing human-written code
   - Expanding on verbose modifications already conceptualized by humans
   - Generating repeated code lines with minor variations

2. **Windows-Specific**: This repository is specifically designed for Windows environments with:
   - PowerShell scripts (.ps1 files)
   - CMake builds configured for Windows
   - OpenBLAS Windows binaries

3. **Dependencies**:
   - CMake
   - Visual Studio 2022 (with Desktop development with C++ workload)
   - Git and Git LFS
   - Conda/Miniconda for Python environment
   - Optional: CUDA toolkit for GPU acceleration

4. **Environment Setup**: Users need to create a Conda environment:
```powershell
conda create --name llama.cpp python=3.12
conda activate llama.cpp
```

5. **Memory Optimization**: The server script automatically:
   - Calculates KV cache size based on model architecture
   - Determines optimal GPU layer offloading
   - Checks available system and GPU memory
   - Enables Flash Attention when supported

### Key Files to Understand

- `rebuild_llama.cpp.ps1` - Main build automation
- `examples/server.ps1` - Server startup with automatic optimization
- `vendor/llama.cpp/CMakeLists.txt` - Build configuration (modified for Windows)
- `requirements_override.txt` - Python dependencies

### Build Process Details

1. Downloads OpenBLAS v0.3.30 if not present
2. Downloads wikitext-2-raw-v1 dataset for perplexity testing
3. Updates git submodules
4. Applies Windows-specific OpenBLAS workaround to CMakeLists.txt
5. Configures CMake with appropriate BLAS flags:
   - OpenBLAS: `-DGGML_BLAS=ON -DGGML_BLAS_VENDOR=OpenBLAS`
   - CUDA: `-DGGML_CUDA=ON`
6. Builds in Release configuration with parallel jobs
7. Copies OpenBLAS DLL to build output
8. Installs Python dependencies

### Server Optimization Logic

The server script performs these calculations:
- Extracts model metadata from GGUF file (context_length, head_count, block_count, embedding_length)
- Calculates KV cache size: `2 * 2 * ctx_size * block_count * embedding_length * head_count_kv / head_count`
- Calculates graph size overhead: `head_count/head_count_kv * kv_size / 6`
- Determines maximum GPU layers: `block_count + 1`
- Calculates optimal GPU layers based on available VRAM
- Checks for Flash Attention support (Compute Capability >= 6.0)
