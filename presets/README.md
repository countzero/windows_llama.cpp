# llama-server Presets

## Start

Pick the preset matching your GPU VRAM budget:

```powershell
llama-server --models-dir D:\AI\LLM\gguf --models-preset presets\models_16GB_VRAM.ini --models-max 1
```

```powershell
llama-server --models-dir D:\AI\LLM\gguf --models-preset presets\models_24GB_VRAM.ini --models-max 1
```

| Flag              | Purpose                                                 |
|-------------------|---------------------------------------------------------|
| `--models-dir`    | Directory containing GGUF files (router mode source #1) |
| `--models-preset` | INI file with model configs (router mode source #2)     |
| `--models-max`    | Max simultaneous loaded models (1 = only one at a time) |

> [!NOTE]
The presets `models_16GB_VRAM.ini` and `models_24GB_VRAM.ini` are each tuned for its VRAM budget (context size, KV quantisation, and MoE offload differ). Copy one as a starting point for other hardware.

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
> All `Qwen3.6-*` entries set `chat-template-file = vendor\Qwen-Fixed-Chat-Templates\qwen3.6\chat_template-v8.jinja`,
> overriding the buggy template embedded in the GGUF. The path is repo-relative,
> so launch `llama-server` from the repository root (as the examples above do).
> If you cloned without `--recurse-submodules`, run `git submodule update --init`
> first — otherwise startup fails with a missing-file error. Gemma and
> `Qwen3-Coder-Next` entries continue to use their GGUF-embedded templates.

