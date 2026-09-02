# Muse Glimmer

Per-model rationale behind the Muse Glimmer entries in `presets/*.ini`, with the measured numbers
each decision rests on. Not auto-loaded into the agent context; read on demand. Cross-model rules —
`swa-full`, context shift, `mmproj-offload` — are in `docs/presets.md` and referenced here rather
than restated.

- **Muse Glimmer has no architectural positional ceiling, so never add RoPE scaling.** Meta's
  `config.json` sets `layer_rope_theta = 0` on all 13 `full_attention` layers (NoPE) and
  `sliding_window = 2048` on the other 39; the GGUF's `sliding_window_pattern` confirms the
  `[true, true, true, false]` x13 split. RoPE therefore never sees a relative position above 2048
  at any context length — 131072 is a training length, not a limit, which is why Meta writes
  "131,072+". Because the GGUF carries no `rope.scaling.*` keys the type defaults to `linear` with
  `freq_scale 1` (`src/llama-model.cpp:1187-1189`), so a user `--rope-scale` is *applied*, not
  ignored, and would compress local resolution on the SWA layers for no benefit. The
  `--rope-scaling yarn` recipes circulating on the HF model page are wrong; only their
  `--override-kv` half is load-bearing.

- **Never set `swa-full` or `context-shift` on a Muse Glimmer entry.** `swa-full` collapses the
  4608-cell SWA cache to the full `n_ctx` — a ~114x blowup at `ctx-size = 524288`
  (`docs/presets.md` -> *swa-full*). `context-shift` is the more dangerous one, and it is the
  exact inverse of the `deepseek4` case: `llama_hparams::has_rope()` knows only about
  `router_layer` (`src/llama-hparams.cpp:287-295`), so a K-shift rotates 128 dims on all 52 layers
  including the 13 NoPE ones, while `get_can_shift()` returns true. Silent corruption rather than
  a refusal. It is dormant only because the mmproj force-disables it — `docs/presets.md` ->
  *context-shift and cache-reuse*.

- **`spec-draft-n-max = 15` is `block_size - 1`, and the absent `chat-template-file` and
  `reasoning` keys are both deliberate.** The drafter carries `dflash.block_size = 16` and spends
  block position 0 on the committed anchor, so 15 is the maximum legal draft
  (`common/speculative.cpp:970-978`, no clamp and no warning); the upstream default is 3
  (`common/common.h:325`), so leaving it unset discards 80% of a block that is decoded in one
  forward pass regardless. Judge it by `mean len` in the slot timings
  (`1 + n_accepted / n_verif_steps`, `server-context.cpp:620`), never by `draft acceptance` — that
  ratio is a percentage of *drafted* tokens and is meaningless for block diffusion, where
  unaccepted drafts cost nothing. Measured ~3.4 tokens per target pass at short context, ~3.0 at
  4.3k. The template is deliberately not pinned: `common/chat.cpp:3494` selects the native Muse
  Glimmer handler on `<atem:function_calls>` + `<|eom|>` in the template source, and the bundled
  `models/templates/muse-glimmer.jinja` is a test fixture added alongside a `chat.cpp` parser fix
  (#26879, locked by `tests/test-chat.cpp:5951`) that mirrors the GGUF-embedded template — unlike
  gemma-4, where the pin exists to replace genuinely outdated conversions.
  `reasoning = on` is a no-op — neither the handler nor the GGUF's embedded template reads
  `enable_thinking`; reasoning here is the structural ` to=self<|message|>...<|eom|>` channel,
  gated on `reasoning_format` (`chat.cpp:3141`). The template already defaults to
  `Reasoning strength: high` (`models/templates/muse-glimmer.jinja:84`), which matches Meta's
  recommendation, and `--reasoning-effort` reaches it only through the
  `reasoning_effort` -> `reasoning_strength` alias at `common/jinja/caps.cpp:29-33`.
  `--reasoning-budget` is inert: the handler sets no `thinking_end_tags`
  (`server-common.cpp:1360`).

- **Compute buffers dominate this entry's headroom and cannot be derived from KV arithmetic.**
  Measured on a 24463 MiB card at `ctx-size = 524288` / `parallel = 2` / `q5_0` K + `q4_1` V:
  13488.92 MiB target weights, 1371.40 draft, 1956.60 CLIP, 2271.12 KV (2184.00 non-SWA +
  57.59 SWA + 29.53 draft) and **2655.59 MiB of compute buffers** (1135.67 target + 803.03
  spec-context + 407.62 draft + 309.27 CLIP) — 21743.63 MiB total, leaving ~1.0 GiB free. The
  compute term is larger than the whole KV cache and grew 1070.67 -> 1135.67 MiB once a real
  request arrived, so budget it explicitly instead of sizing `ctx-size` off KV alone. The SWA
  cache is 4608 cells here (`n_swa = 2048`, `parallel = 2`, `n_ubatch = 512`) and scales with
  `parallel`, not `ctx-size` (`docs/presets.md` -> *swa-full*), so raising `parallel` is cheap
  while raising `ctx-size` is not. `mmproj-offload = true` survives this margin (CLIP warmup
  reserves 309.27 MiB and real images decode), but it is the first thing to disable if the margin
  shrinks — see `docs/presets.md` -> *mmproj-offload*. Context checkpoints are host-side,
  ~38.8 MiB each at `max = 32`.
