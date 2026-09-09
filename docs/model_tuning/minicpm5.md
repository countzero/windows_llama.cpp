# MiniCPM5

Per-model rationale behind the `MiniCPM5-2B` entry in `presets/*.ini`. Not auto-loaded into the
agent context; read on demand. Cross-model rules — context shift, slots and the prompt cache,
`fit` — are in `docs/presets.md` and referenced here rather than restated. Numbers below are read
from the GGUF and from the pinned submodule's sources; the VRAM breakdown is not yet measured on
this hardware.

`MiniCPM5-2B` is OpenBMB's dense 2.5B, and its GGUF architecture is plain `llama` — the HF config
is a stock `LlamaForCausalLM`, so there is no `minicpm5` arch in llama.cpp and none is needed
(`src/llama-arch.cpp:53-54` carries only `minicpm` and `minicpm3`, neither of which applies).
42 blocks, `embedding_length = 2048`, GQA with 16 query and 2 KV heads at `key_length = 128`,
`rope.freq_base = 5000000`, `context_length = 131072`, vocab 130560 on the `minicpm5`
pre-tokenizer. No projector and no draft model on disk, so the entry is text-only and speculates
with `ngram-mod` alone.

- **Never pin `chat-template-file = vendor\llama.cpp\models\templates\openbmb-MiniCPM5-1B.jinja` on
  this entry.** llama.cpp does bundle a MiniCPM5 template, and the repo's habit with gemma-4 is to
  prefer the bundled file — but that one is the *1B* template and it differs from the 2B GGUF's
  embedded template in exactly the place that matters. They are 9062 and 9060 bytes and diverge in
  a single hunk, the historical-assistant-message branch: the bundled 1B file guards reasoning
  output with `{%- if loop.index0 > ns.last_query_index %}`, so how a given past turn renders
  depends on how many turns have been appended since. The embedded 2B template drops that guard
  and instead emits
  a stable empty `<think>\n\n</think>` for any prior assistant message that carries no
  `reasoning_content`. The 1B behaviour re-renders old turns as the conversation grows, which
  invalidates the KV prefix on every request; the 2B behaviour is deterministic given the history
  and is the same empty-`<think>` device documented for the Qwen template
  (`docs/model_tuning/qwen.md`). Pinning the bundled file would therefore be a downgrade, not the
  usual safety win. If a future submodule bump adds an `openbmb-MiniCPM5-2B.jinja`, re-diff before
  adopting it.

- **Dropping the template pin does not cost the dedicated tool-call parser.** llama.cpp detects
  MiniCPM5 by content, not by filename: `common_chat_try_specialized_template`
  (`common/chat.cpp:1186-1192`) routes to `common_chat_params_init_minicpm5` when the template
  source contains all three of
  `Tool usage guidelines:`, `<function name="` and `<param name="`. The 2B GGUF's embedded template
  contains all three, so `jinja = true` alone reaches the XML
  `<function name="..."><param name="...">...</param></function>` handler, CDATA escaping included.
  Verified against the embedded template, not assumed.

- **`cache-type-k`/`cache-type-v` are `q4_0`, one step below the house `q8_0`, because this model
  is almost all KV.** 42 attention layers at 2 KV heads × 128 dims give 256 elements each for K and
  V per token per layer, so ~21.5k cache elements per token — against only 1358 MiB of IQ4_XS
  weights. At the entry's 524288-token pool that works out (arithmetic, not yet measured) to
  roughly 11 GiB of KV at `q8_0` versus ~5.9 GiB at `q4_0`, i.e. the cache outweighs the weights by
  nearly an order of magnitude either way.
  Halving it is the cheapest 5 GiB on the tier and a 2B is not the model to spend precision on.
  Unlike `Ling-3.0-tiny` this is not an MLA model, so K and V *could* differ — they are kept equal
  for uniformity only, and `docs/presets.md` has no rule requiring it here.

- **`ctx-size = 524288` with `parallel = 4` is four slots at the model's full native context.**
  With `kv-unified` unset, `n_ctx_seq = n_ctx / n_seq_max` padded to 256
  (`src/llama-context.cpp:290-303`), so 524288/4 lands exactly on the GGUF's
  `context_length = 131072` and no `override-kv` is needed. Confirm with
  `initializing, n_slots = 4, n_ctx_slot = 131072`. `ctx-checkpoints` stays at the house 32 here,
  unlike the 8 on `Ling-3.0-tiny`: this is a dense attention model, so a checkpoint holds no
  recurrent state and the per-slot ring is cheap. Being non-hybrid, it also keeps a working
  `get_can_shift()`, so none of the force-disable warnings that `Ling-3.0-tiny` prints apply.

- **`reasoning = on`, and there is no `reasoning-effort` to pin.** The embedded template reads
  `enable_thinking` and OpenBMB documents `enable_thinking=True` as the default; `reasoning = on`
  maps to `--reasoning`, which writes
  `default_template_kwargs["enable_thinking"] = "true"` (`common/arg.cpp:3714-3719`), pinning that
  default rather than inheriting whatever a future conversion ships. The template has no
  `reasoning_effort` variable, so the key would be inert.

- **`top-k = 0` is deliberate, not an omission.** OpenBMB's recommendation is
  `temperature=1.0, top_p=0.95` and nothing else; the GGUF backs this up by baking only
  `general.sampling.top_p` and `general.sampling.temp` and no `top_k`. `top-k = 0` is how the repo
  writes "top-k disabled" — the same value the DeepSeek entries use — so the entry states the
  vendor's position explicitly instead of leaving a knob to drift.

- **Not done, deliberately: the DSpark drafter.** OpenBMB publishes `MiniCPM5-2B-DSpark-GGUF`, and
  the repo already has a working `spec-type = draft-dspark` precedent on the DeepSeek entry. It is
  not on disk and its acceptance rate here is unmeasured, so the entry ships with `ngram-mod` only.
  Adding it later means a `spec-draft-model`, matching `cache-type-*-draft` values, a
  `spec-draft-n-max`, and a re-measure — not a one-line change.
