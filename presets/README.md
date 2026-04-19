# llama-server Presets

## Start

```powershell
llama-server --models-dir D:\AI\LLM\gguf --models-preset presets\models_24GB_VRAM.ini --models-max 1
```

| Flag | Purpose |
|------|---------|
| `--models-dir` | Directory containing GGUF files (router mode source #1) |
| `--models-preset` | INI file with model configs (router mode source #2) |
| `--models-max` | Max simultaneous loaded models (1 = only one at a time) |

## INI Format

Each `[section]` is a model. Keys are `llama-server` flags without `--`.

```INI
[model-name]
model = /path/to/file.gguf
n-gpu-layers = -1
ctx-size = 262144
parallel = 2
```

See `llama-server --help` for all flags.
