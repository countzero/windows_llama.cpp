# Ling 3.0

Per-model rationale behind the `Ling-3.0-tiny` entry in `presets/*.ini`. Not auto-loaded into the
agent context; read on demand. Cross-model rules — context shift, `fit`, `swa-full`, slots and the
prompt cache — are in `docs/presets.md` and referenced here rather than restated. Numbers below are
read from the GGUF and from the pinned submodule's sources; the VRAM breakdown is not yet measured
on this hardware.

`Ling-3.0-tiny` is inclusionAI's 7.9B-total / 1.3B-active MoE, GGUF architecture `bailingmoe3`
(`vendor/llama.cpp/src/llama-arch.cpp:112`). 24 blocks, `embedding_length = 1536`, 128 routed
experts with 8 active plus 1 shared, `expert_feed_forward_length = 512`, `context_length = 131072`,
`rope.freq_base = 6000000`, vocab 157184 on the `bailingmoe2` pre-tokenizer. No projector, no MTP
head (`n_layer_nextn = 0`; only the larger `Ling-3.0-flash` ships one), so the entry is text-only
and its speculation is `ngram-mod` alone.

- **`cache-type-k` and `cache-type-v` must be identical, and this is startup-fatal, not a warning.**
  Ling 3.0 stacks 3 KDA (Kimi Delta Attention) layers to 1 MLA layer per 4-layer block, so 6 of the
  24 layers carry a real KV cache and the GGUF advertises `attention.kv_lora_rank = 512`,
  `attention.key_length_mla = 192` and `attention.value_length_mla = 128`. That makes
  `llama_hparams::is_mla()` true (`src/llama-hparams.cpp:297-302`, which keys purely off the two
  `*_head_*_mla` dims), and `src/llama-context.cpp:3697-3700` then rejects `type_k != type_v`
  outright — it logs `model does not support different K (...) and V (...) cache types` and returns
  `nullptr`, so the model never loads. The check is on `is_mla()`, *not* on an architecture match,
  which is why `AGENTS.md` states the trap for MLA entries generally rather than for `deepseek4`
  alone. The `q5_0`/`q4_1` split that the Muse Glimmer entries use to claw back VRAM cannot be
  copied here. `q8_0`/`q8_0` is the choice: with only 6 attention layers the cache is a small part
  of the footprint, so there is nothing to buy by quantising it harder.

- **`ctx-checkpoints` is load-bearing, and it is 8 rather than 32 because it is a per-slot ring.**
  `bailingmoe3` is a hybrid architecture (`llm_arch_is_hybrid` — `src/llama-arch.cpp:1079`), so
  `get_can_shift()` is false and the server force-disables both context shift and cache-reuse with
  two startup warnings; that is expected. Speculative rollback then has to go through checkpoints,
  which is what makes a non-zero `ctx-checkpoints` a requirement rather than an optimisation —
  `docs/presets.md` -> *context-shift and cache-reuse*. The value is 8, not the 32 that the dense
  entries use, because `--ctx-checkpoints` is documented as "max number of context checkpoints to
  create per slot" (`common/arg.cpp:1706-1708`) and a checkpoint on a hybrid model has to capture
  the recurrent KDA state of all 18 linear layers. At `parallel = 4` a 32-deep ring is 128 live
  copies of that state. `Qwen3.8-Flash-Next` also sits at 8, though at `parallel = 1` — there the
  driver is the size of a single checkpoint, here it is that size multiplied by four slots. Raise
  it only against a measured `memory_breakdown`.

- **`ctx-size = 524288` with `parallel = 4` is four slots at the model's full native context, and
  the pool figure is not the per-slot figure.** With `kv-unified` unset, `n_ctx_seq = n_ctx /
  n_seq_max` padded to 256 (`src/llama-context.cpp:290-303`), so 524288/4 lands exactly on the
  GGUF's `context_length = 131072` — no `override-kv` is needed and no capping warning should
  appear. Confirm with `initializing, n_slots = 4, n_ctx_slot = 131072`; if it reads 65536 the
  `ctx-size` was left at 262144. Four slots is a deliberate choice for agentic use: a resident slot
  per concurrent subagent avoids the save-and-reload round-trip that slot stealing otherwise costs
  — `docs/presets.md` -> *Slots and the prompt cache*. `kv-unified` stays unset on purpose; turning
  it on would save and clear every idle slot on each new task, which is the opposite of what four
  slots are for.

- **The GGUF-embedded Bailing V3 template is kept, and tool calling works through the generic
  autoparser.** Ling's tool-call markup is `<tool_call>{name}` followed by `<arg_key>`/`<arg_value>`
  pairs, which matches none of the branches in `common_chat_try_specialized_template`
  (`common/chat.cpp:1080-1202`) — in particular it is *not* the Qwen3-Coder
  shape, which needs `<function=` and `<parameter=` (`common/chat.cpp:1194-1200`). It therefore
  falls through to the auto-generated PEG parser, and that path is explicitly covered upstream by
  `tests/test-chat-auto-parser.cpp:2529 test_bailing_v3_tool_format`, registered as the
  `bailing_v3` case at `:565`. So `jinja = true` alone is enough and there is nothing to pin. No
  vendored template exists for this family, and llama.cpp bundles none.

- **`reasoning = on` is the whole thinking control; there is no `reasoning-effort` to pin.** The
  embedded template normalises `enable_thinking` into its own `thinking_option` and defaults to
  `'on'`, matching the model card ("Thinking mode is enabled by default"). `reasoning = on` maps to
  `--reasoning`, which sets `default_template_kwargs["enable_thinking"] = "true"`
  (`common/arg.cpp:3714-3719`), so the entry pins the default rather than inheriting it from a
  template that may move. The template contains no `reasoning_effort` variable at all, so adding
  `reasoning-effort` would be inert. Clients can still turn thinking off per request via
  `chat_template_kwargs`.

- **The sampler block is inclusionAI's published recommendation, and it also matches what the GGUF
  bakes in.** The model card gives `temperature=1.0`, `top_p=0.95`, `top_k=20` for both the SGLang
  and vLLM paths, and the GGUF carries the same three as `general.sampling.*`. They are written out
  in the entry anyway, because the repo's other entries do and because a GGUF requantised from a
  newer upstream conversion could change them silently. `min-p = 0.0` is the house default; no
  `presence-penalty` is set, as the vendor recommends none.

- **`split-mode = tensor` is unavailable on this architecture, so a dual-GPU entry can only be
  pipeline-parallel.** `llm_arch_supports_sm_tensor` returns false for `LLM_ARCH_BAILINGMOE3`
  (`src/llama-arch.cpp:1150`) and `src/llama-model.cpp:354` refuses the load. This costs nothing on
  the 24 GB tier, which does not pin devices at all, but it removes one knob if the entry is ever
  copied into `models_16GB_8GB_VRAM.ini` — `docs/presets.md` -> *Device pinning and multi-GPU*.

- **Not done, deliberately: the 262144 YaRN extension.** inclusionAI's own SGLang recipe reaches
  256K by overriding `rope_scaling` to `{"rope_type":"yarn","factor":2.0,...}` on top of the native
  131072. That is a different lever from the `override-kv` context lift the Muse Glimmer entry uses
  — it changes `freq_scale`, not just `n_ctx_train` — and neither its quality cost nor its VRAM
  cost has been measured here. The entry spends the same KV budget on four native-length slots
  instead; revisit only with numbers.
