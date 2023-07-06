# Windows llama.cpp

A PowerShell automation to rebuild [llama.cpp](https://github.com/ggerganov/llama.cpp) for a Windows environment. It automates the following steps:

1. Fetching and extracting a specific release of [OpenBLAS](https://github.com/xianyi/OpenBLAS/releases)
2. Fetching the latest version of [llama.cpp](https://github.com/ggerganov/llama.cpp)
3. Fixing OpenBLAS binding in the `CMakeLists.txt`
4. Rebuilding the binaries with CMake
5. Updating the Python dependencies

## BLAS support

This script currently supports `OpenBLAS` for CPU BLAS acceleration and `cuBLAS` for NVIDIA GPU BLAS acceleration.

## Installation

### 1. Install Prerequisites

Download and install the latest versions:

* [CMake](https://cmake.org/download/)
* [Cuda](https://developer.nvidia.com/cuda-downloads)
* [Git Large File Storage](https://git-lfs.com)
* [Git](https://git-scm.com/download)
* [Miniconda](https://conda.io/projects/conda/en/stable/user-guide/install)
* [Visual Studio 2022 - Community](https://visualstudio.microsoft.com/downloads/)

**Hint:** When installing Visual Studio 2022 it is sufficent to just install the `Build Tools for Visual Studio 2022` package. Also make sure that `Desktop development with C++` is enabled in the installer.

### 2. Clone the repository from GitHub

Clone the repository to a nice place on your machine via:

```Shell
git clone --recurse-submodules git@github.com:countzero/windows_llama.cpp.git
```

### 3. Update the llama.cpp submodule to the latest version (optional)
This repository can reference an outdated version of the llama.cpp repository. To update the submodule to the latest version execute the following.

```Shell
git submodule update --remote --merge
```

Then add, commit and push the changes to make the update available for others.

```Shell
git add --all; git commit -am "Update llama.cpp submodule to latest commit"; git push
```

**Hint:** This is optional because the build script will pull the latest version.

### 4. Create a new Conda environment

Create a new Conda environment for this project with a specific version of Python:

```Shell
conda create --name llama.cpp python=3.10
```

### 5. Initialize Conda for shell interaction

To make Conda available in you current shell execute the following:

```Shell
conda init
```

**Hint:** You can always revert this via `conda init --reverse`.

### 6. Execute the build script

To build llama.cpp binaries for a Windows environment with CUDA BLAS acceleration execute the script:

```PowerShell
./rebuild_llama.cpp.ps1 -blasAccelerator "cuBLAS"
```

### 7. Download a large language model

Download a large language model (LLM) with weights in the GGML format into the `./vendor/llama.cpp/models` directory. You can for example download the [open-llama-7b](https://huggingface.co/openlm-research/open_llama_7b) model in a quantized GGML format:

* https://huggingface.co/TheBloke/open-llama-7b-open-instruct-GGML/resolve/main/open-llama-7B-open-instruct.ggmlv3.q4_K_M.bin

**Hint:** See the [🤗 Open LLM Leaderboard](https://huggingface.co/spaces/HuggingFaceH4/open_llm_leaderboard) for best in class open source LLMs.

## Usage

### Chat via CLI

You can now chat with the model:

```PowerShell
./vendor/llama.cpp/build/bin/Release/main `
    --model "./vendor/llama.cpp/models/open-llama-7B-open-instruct.ggmlv3.q4_K_M.bin" `
    --ctx-size 2048 `
    --n-predict 2048 `
    --threads 16 `
    --n-gpu-layers 32 `
    --reverse-prompt '[[USER_NAME]]:' `
    --file "./vendor/llama.cpp/prompts/chat-with-vicuna-v1.txt" `
    --color `
    --interactive
```

### Chat via Webinterface

You can start llama.cpp as a webserver:

```PowerShell
./vendor/llama.cpp/build/bin/Release/server `
    --model "./vendor/llama.cpp/models/open-llama-7B-open-instruct.ggmlv3.q4_K_M.bin" `
    --ctx-size 2048 `
    --threads 16 `
    --n-gpu-layers 32
```

And then access llama.cpp via the webinterface at:

* http://localhost:8080/

### Measure model perplexity

Execute the following to measure the perplexity of the GGML formatted model:

```PowerShell
./vendor/llama.cpp/build/bin/Release/perplexity `
    --model "./vendor/llama.cpp/models/open-llama-7B-open-instruct.ggmlv3.q4_K_M.bin" `
    --ctx-size 2048 `
    --n-predict 2048 `
    --threads 16 `
    --n-gpu-layers 32 `
    --file "./vendor/wikitext-2-raw-v1/wikitext-2-raw/wiki.test.raw"
```

### Rebuild llama.cpp

Every time there is a new release of [llama.cpp](https://github.com/ggerganov/llama.cpp) you can simply execute the script to automatically rebuild everything:

| Command                                               | Description                |
| ----------------------------------------------------- | -------------------------- |
| `./rebuild_llama.cpp.ps1`                             | Without BLAS acceleration  |
| `./rebuild_llama.cpp.ps1 -blasAccelerator "OpenBLAS"` | With CPU BLAS acceleration |
| `./rebuild_llama.cpp.ps1 -blasAccelerator "cuBLAS"`   | With GPU BLAS acceleration |
