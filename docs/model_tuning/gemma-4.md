# gemma-4

Per-model rationale behind the `gemma-4-*` entries in `presets/*.ini`. Not auto-loaded into the
agent context; read on demand. Cross-model rules are in `docs/presets.md`.

- **All gemma-4 entries pin `chat-template-file = vendor\llama.cpp\models\templates\google-gemma-4-31B-it.jinja`.**
  This is Google's fixed official template as aligned by upstream (#21704) — the exact
  file upstream's `tests/test-chat.cpp` locks against the native gemma4 chat handler
  (`vendor/llama.cpp/common/chat.cpp:1216`), so parser and template always come from the
  same submodule commit (each rebuild resets the submodule to master, mirroring the built
  binary). GGUF-embedded templates from conversions predating Google's template fixes
  lack the `{#- OpenAI Chat Completions:` marker; llama.cpp then logs "detected an
  outdated gemma4 chat template" and rewrites messages via C++ compatibility workarounds
  (`common/chat.cpp:2250-2258`) — the pin avoids that path. One file covers the whole
  series (12B / 26B-A4B / 31B, incl. `<|image|>`/`<|audio|>` placeholders), and
  `reasoning = on` maps to the template's `enable_thinking` kwarg
  (`common/arg.cpp:3167-3175`), so no `chat-template-kwargs` are needed. Unlike the Qwen
  template, past `<|channel>thought` blocks are *stripped* from history by design —
  Gemma 4 is trained that way — so cross-turn KV-prefix invalidation is inherent
  (`ctx-checkpoints` mitigates); do not add a preserve-thinking hack. If startup fails
  reading the template after a rebuild, check whether upstream moved
  `models/templates/` — see `docs/build_system.md` -> *Upstream path dependencies*.

- **Never set `image-min-tokens` on a gemma-4 entry.** It is a `qwen3vl_merger` projector key;
  gemma-4 uses a different projector — `docs/model_tuning/qwen.md`.
