# Windows llama.cpp

Some PowerShell automation to rebuild [llama.cpp](https://github.com/ggerganov/llama.cpp) for a Windows environment.

## Installation

### 1. Install Prerequisites

Download and install the latest versions:

* [CMake](https://cmake.org/download/)
* [Cuda](https://developer.nvidia.com/cuda-downloads)
* [Git Large File Storage](https://git-lfs.com)
* [Git](https://git-scm.com/download^^)
* [Miniconda](https://conda.io/projects/conda/en/stable/user-guide/install)
* [Visual Studio 2022 - Community](https://visualstudio.microsoft.com/downloads/)

**Hint:** When installing Visual Studio 2022 it is sufficent to just install the `Build Tools for Visual Studio 2022` package. Also make sure that `Desktop development with C++` is enabled in the installer.

### 2. Clone the repository from GitHub

Clone the repository to a nice place on your machine via:

```Shell
git clone --recurse-submodules git@github.com:countzero/windows_llama.cpp.git
```

### 3. Update the llama.cpp submodule to the latest version (optional)
This repository can reference an outdated version of the stadtwerk_ssh_authorized_keys repository. To update the submodule to the latest version execute the following.

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

To build llama.cpp binaries for a Windows environment with CUDA support execute the script:

```PowerShell
./rebuild_llama.cpp.ps1
```

### 7. Download a large language model

Download a large language model (LLM) with weights in the GGML format into the `./vendor/llama.cpp/models` directory. You can for example download the [open-llama-7b](https://huggingface.co/openlm-research/open_llama_7b) model in a quantized GGML format:

* https://huggingface.co/TheBloke/open-llama-7b-open-instruct-GGML/resolve/main/open-llama-7B-open-instruct.ggmlv3.q4_K_M.bin

**Hint:** See the [🤗 Open LLM Leaderboard](https://huggingface.co/spaces/HuggingFaceH4/open_llm_leaderboard) for best in class open source LLMs.

## Usage

### Chat

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

### Rebuild llama.cpp

Every time there is a new release of [llama.cpp](https://github.com/ggerganov/llama.cpp) you can simply execute the script to automatically:

1. fetch the latest changes
2. rebuild the binaries
3. update the Python dependencies

```PowerShell
./rebuild_llama.cpp.ps1
```
