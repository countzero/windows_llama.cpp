# Windows llama.cpp

A PowerShell automation to rebuild [llama.cpp](https://github.com/ggerganov/llama.cpp) for a Windows environment. It automates the following steps:

1. Fetching and extracting a specific release of [OpenBLAS](https://github.com/xianyi/OpenBLAS/releases)
2. Fetching the latest version of [llama.cpp](https://github.com/ggerganov/llama.cpp)
3. Fixing OpenBLAS binding in the `CMakeLists.txt`
4. Rebuilding the binaries with CMake
5. Updating the Python dependencies
6. Automatically detects the best BLAS acceleration

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

> [!TIP]
> When installing Visual Studio 2022 it is sufficent to just install the `Build Tools for Visual Studio 2022` package. Also make sure that `Desktop development with C++` is enabled in the installer.

### 2. Enable Hardware Accelerated GPU Scheduling (optional)

Execute the following in a PowerShell terminal with Administrator privileges to enable the [Hardware Accelerated GPU Scheduling](https://devblogs.microsoft.com/directx/hardware-accelerated-gpu-scheduling/) feature:

```PowerShell
New-ItemProperty `
    -Path "HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers" `
    -Name "HwSchMode" `
    -Value "2" `
    -PropertyType DWORD `
    -Force
```

Then restart your computer to activate the feature.

### 3. Clone the repository from GitHub

Clone the repository to a nice place on your machine via:

```PowerShell
git clone --recurse-submodules git@github.com:countzero/windows_llama.cpp.git
```

### 4. Create a new Conda environment

Create a new Conda environment for this project with a specific version of Python:

```PowerShell
conda create --name llama.cpp python=3.10
```

### 5. Initialize Conda for shell interaction

To make Conda available in you current shell execute the following:

```PowerShell
conda init
```

> [!TIP]
> You can always revert this via `conda init --reverse`.

### 6. Execute the build script

To build llama.cpp binaries for a Windows environment with the best available BLAS acceleration execute the script:

```PowerShell
./rebuild_llama.cpp.ps1
```

> [!TIP]
> If PowerShell is not configured to execute files allow it by executing the following in an elevated PowerShell: `Set-ExecutionPolicy RemoteSigned`

### 7. Download a large language model

Download a large language model (LLM) with weights in the GGUF format into the `./vendor/llama.cpp/models` directory. You can for example download the [OpenChat-3.5-0106](https://huggingface.co/openchat/openchat-3.5-0106) 7B model in a quantized GGUF format:

* https://huggingface.co/TheBloke/openchat-3.5-0106-GGUF/resolve/main/openchat-3.5-0106.Q5_K_M.gguf

> [!TIP]
> See the [🤗 Open LLM Leaderboard](https://huggingface.co/spaces/HuggingFaceH4/open_llm_leaderboard) for best in class open source LLMs.

## Usage

### Chat via server script

You can easily chat with a specific model by using the [.\examples\server.ps1](./examples/server.ps1) script:

```PowerShell
 .\examples\server.ps1 -model ".\vendor\llama.cpp\models\openchat-3.5-0106.Q5_K_M.gguf"
```

> [!NOTE]
> The script will automatically start the llama.cpp server with an optimal configuration for your machine.

Execute the following to get detailed help on further options of the server script:

```PowerShell
Get-Help -Detailed .\examples\server.ps1
```

### Chat via CLI

You can now chat with the model:

```PowerShell
./vendor/llama.cpp/build/bin/Release/main `
    --model "./vendor/llama.cpp/models/openchat-3.5-0106.Q5_K_M.gguf" `
    --ctx-size 8192 `
    --threads 16 `
    --n-gpu-layers 32 `
    --reverse-prompt '[[USER_NAME]]:' `
    --prompt-cache "./cache/openchat-3.5-0106.Q5_K_M.gguf.prompt" `
    --file "./vendor/llama.cpp/prompts/chat-with-vicuna-v1.txt" `
    --color `
    --interactive
```

### Chat via Webinterface

You can start llama.cpp as a webserver:

```PowerShell
./vendor/llama.cpp/build/bin/Release/server `
    --model "./vendor/llama.cpp/models/openchat-3.5-0106.Q5_K_M.gguf" `
    --ctx-size 8192 `
    --threads 16 `
    --n-gpu-layers 32
```

And then access llama.cpp via the webinterface at:

* http://127.0.0.1:8080/

### Increase the context size

You can increase the context size of a model with a minimal quality loss by setting the RoPE parameters. The formula for the parameters is as follows:

```
context_scale = increased_context_size / original_context_size
rope_frequency_scale = 1 / context_scale
rope_frequency_base = 10000 * context_scale
```

> [!NOTE]
> To increase the context size of an [OpenChat-3.5-0106](https://huggingface.co/openchat/openchat-3.5-0106) model from its original context size of `8192` to `32768` means, that the `context_scale` is `4.0`. The `rope_frequency_scale` will then be `0.25` and the `rope_frequency_base` equals `40000`.

To extend the context to 32k execute the following:

```PowerShell
./vendor/llama.cpp/build/bin/Release/main `
    --model "./vendor/llama.cpp/models/openchat-3.5-0106.Q5_K_M.gguf" `
    --ctx-size 32768 `
    --rope-freq-scale 0.25 `
    --rope-freq-base 40000 `
    --threads 16 `
    --n-gpu-layers 32 `
    --reverse-prompt '[[USER_NAME]]:' `
    --prompt-cache "./cache/openchat-3.5-0106.Q5_K_M.gguf.prompt" `
    --file "./vendor/llama.cpp/prompts/chat-with-vicuna-v1.txt" `
    --color `
    --interactive
```

### Enforce JSON response

You can enforce a specific grammar for the response generation. The following will always return a JSON response:

```PowerShell
./vendor/llama.cpp/build/bin/Release/main `
    --model "./vendor/llama.cpp/models/openchat-3.5-0106.Q5_K_M.gguf" `
    --ctx-size 8192 `
    --threads 16 `
    --n-gpu-layers 32 `
    --prompt-cache "./cache/openchat-3.5-0106.Q5_K_M.gguf.prompt" `
    --prompt "The scientific classification (Taxonomy) of a Llama: " `
    --grammar-file "./vendor/llama.cpp/grammars/json.gbnf"
    --color
```

### Measure model perplexity

Execute the following to measure the perplexity of the GGML formatted model:

```PowerShell
./vendor/llama.cpp/build/bin/Release/perplexity `
    --model "./vendor/llama.cpp/models/openchat-3.5-0106.Q5_K_M.gguf" `
    --ctx-size 8192 `
    --threads 16 `
    --n-gpu-layers 32 `
    --file "./vendor/wikitext-2-raw-v1/wikitext-2-raw/wiki.test.raw"
```

### Count prompt tokens

You can easily count the tokens of a prompt for a specific model by using the [.\examples\count_tokens.ps1](./examples/count_tokens.ps1) script:

```PowerShell
 .\examples\count_tokens.ps1 `
     -model ".\vendor\llama.cpp\models\openchat-3.5-0106.Q5_K_M.gguf" `
     -file ".\prompts\chat_with_llm.txt"
```

To inspect the actual tokenization result you can use the `-debug` flag:

```PowerShell
 .\examples\count_tokens.ps1 `
     -model ".\vendor\llama.cpp\models\openchat-3.5-0106.Q5_K_M.gguf" `
     -prompt "Hello Word!" `
     -debug
```

> [!NOTE]
> The script is a simple wrapper for the [tokenize.cpp](https://github.com/ggerganov/llama.cpp/blob/master/examples/tokenize/tokenize.cpp) example of the llama.cpp project.

Execute the following to get detailed help on further options of the server script:

```PowerShell
Get-Help -Detailed .\examples\count_tokens.ps1
```

## Build

### Rebuild llama.cpp

Every time there is a new release of [llama.cpp](https://github.com/ggerganov/llama.cpp) you can simply execute the script to automatically rebuild everything:

| Command                                               | Description                                  |
| ----------------------------------------------------- | -------------------------------------------- |
| `./rebuild_llama.cpp.ps1`                             | Automatically detects best BLAS acceleration |
| `./rebuild_llama.cpp.ps1 -blasAccelerator "OFF"`      | Without any BLAS acceleration                |
| `./rebuild_llama.cpp.ps1 -blasAccelerator "OpenBLAS"` | With CPU BLAS acceleration                   |
| `./rebuild_llama.cpp.ps1 -blasAccelerator "cuBLAS"`   | With NVIDIA GPU BLAS acceleration            |

### Build a specific version of llama.cpp

You can build a specific version of llama.cpp by specifying a git tag or commit:

| Command                                      | Description          |
| -------------------------------------------- | -------------------- |
| `./rebuild_llama.cpp.ps1`                    | The latest release   |
| `./rebuild_llama.cpp.ps1 -version "b1138"`   | The tag `b1138`      |
| `./rebuild_llama.cpp.ps1 -version "1d16309"` | The commit `1d16309` |
