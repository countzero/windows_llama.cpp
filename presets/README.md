# llama-server Presets

## Start

Pick the preset matching your GPU VRAM budget:

```powershell
llama-server --models-dir D:\AI\LLM\gguf --models-preset presets\models_16GB_VRAM.ini --models-max 1
```

```powershell
llama-server --models-dir D:\AI\LLM\gguf --models-preset presets\models_24GB_VRAM.ini --models-max 1
```

Dual-GPU (16 GB + 8 GB across two cards) - set the device order **before** launching so the
per-device `fit-target` values line up with the physical cards:

```powershell
$env:CUDA_DEVICE_ORDER = "PCI_BUS_ID"   # CUDA0 = 8 GB GPU, CUDA1 = 16 GB GPU
llama-server --models-dir D:\AI\LLM\gguf --models-preset presets\models_16GB_8GB_VRAM.ini
```

| Flag              | Purpose                                                 |
|-------------------|---------------------------------------------------------|
| `--models-dir`    | Directory containing GGUF files (router mode source #1) |
| `--models-preset` | INI file with model configs (router mode source #2)     |

> [!TIP]
> `main-gpu`, `models-max`, `split-mode`, `tensor-split`, and `threads` are handled by the
> preset's `[*]` global section. `--host`, `--port`, and `--models-dir` must stay on the CLI
> — they are parent-server settings that the server manages internally and cannot be set via preset.

> [!NOTE]
The presets `models_16GB_VRAM.ini`, `models_24GB_VRAM.ini`, and `models_16GB_8GB_VRAM.ini` are each tuned for its VRAM budget (context size, KV quantisation, and MoE offload differ). Copy one as a starting point for other hardware.

> [!IMPORTANT]
> **`models_16GB_8GB_VRAM.ini` (dual-GPU: one GPU with 16 GB VRAM + one with 8 GB VRAM).**
> It uses `split-mode = layer` (pipeline parallel - the recommended mode for consumer GPUs
> on PCIe without NVLink) with `tensor-split = 1,2` to weight the 16 GB card twice as
> heavily as the 8 GB card. `main-gpu = 1` puts scratch buffers and intermediate results
> on the 16 GB card. `models-max = 1` limits to one loaded model at a time. `fit = off`;
> each model has a fixed `ctx-size` and `n-gpu-layers = -1` baked in for deterministic launches.
>
> - **Device order matters.** `tensor-split`, `main-gpu`, and `--device` all
>   follow llama.cpp's CUDA order (shown by `llama-server --list-devices`), **not** the
>   `nvidia-smi` order. Set `CUDA_DEVICE_ORDER=PCI_BUS_ID` (as above) so `CUDA0` is the
>   8 GB card and `CUDA1` is the 16 GB card, then **verify once** with `--list-devices`.
> - All vision entries set `no-mmproj-offload = true`, so image preprocessing runs on CPU.
>   This is deliberate: on a VRAM-saturated GPU `mmproj-offload = true` can OOM the CLIP warmup
>   buffer silently and only fail at image-generation time.
> - Global settings (`main-gpu`, `models-max`, `split-mode`, `tensor-split`, etc.) live in
>   the `[*]` section and apply to all models. Per-model sections only override what differs.

## INI Format

Each `[section]` is a model. Keys are `llama-server` flags without `--` for example:

```INI
[model-name]
model = /path/to/file.gguf
n-gpu-layers = -1
ctx-size = 262144
parallel = 2
```

The section header (e.g. `[gemma-4-31B-it.IQ4_XS.gguf]`) is the model name clients pass in the OpenAI-compatible `"model"` field.

> [!TIP]
> See `llama-server --help` for all flags.

> [!IMPORTANT]
> All `Qwen3.6-*` entries set `chat-template-file = vendor\Qwen-Fixed-Chat-Templates\chat_template.jinja`,
> overriding the buggy template embedded in the GGUF. The vendored template is a
> single unified file that handles both Qwen 3.5 and 3.6 variants. The path is repo-relative,
> so launch `llama-server` from the repository root (as the examples above do).
> If you cloned without `--recurse-submodules`, run `git submodule update --init`
> first — otherwise startup fails with a missing-file error.
>
> All `gemma-4-*` entries set `chat-template-file = vendor\llama.cpp\models\templates\google-gemma-4-31B-it.jinja` —
> the official Google template bundled with llama.cpp itself, kept in lock-step with
> its built-in Gemma 4 parser. The same repo-root launch caveat applies.
> `Qwen3-Coder-Next` entries continue to use their GGUF-embedded template.

