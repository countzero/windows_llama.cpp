# Qwen 3.6, Qwen 3.8, Bonsai and DSpark

Per-model rationale behind the `qwen35`-arch entries in `presets/*.ini` — Qwen3.6-27B, Qwen3.8-27B,
Ternary-Bonsai-27B and Bonsai-27B — with the measured numbers each decision rests on. Not
auto-loaded into the agent context; read on demand. Cross-model rules are in `docs/presets.md`.
`Qwen3.8-Flash-Next` is a different architecture and has its own file,
`docs/model_tuning/qwen3.8-flash-next.md`.

## Qwen 3.6 and 3.8

- **Qwen-VL entries pin `image-min-tokens = 1024`.** `clip.cpp:1500` sets the per-image token limits
  to `(8, 4096)`, so the default *minimum* is 8 tokens — 8192 px at `merge = 2` / `patch = 16` — and
  `clip.cpp:1502-1506` warns on every load because upstream needs >= 1024 tokens (1024x1024 px) for
  grounding (#16842). The key raises a floor only: images already above 1024 tokens are unchanged,
  smaller ones get upscaled, which costs context and CLIP time on the CPU because the 16 GB tier
  sets `no-mmproj-offload = true`; the 24 GB `Qwen3.8-27B` entry offloads CLIP to the GPU and
  pays it there instead. Applies to the `qwen3vl_merger` entries (Qwen3.6, Qwen3.8 and
  Ternary-Bonsai); gemma-4 uses a different projector and must not get this key.

- **All Qwen 3.6, Qwen 3.8 and Bonsai entries pin `chat-template-file = vendor\Qwen-Fixed-Chat-Templates\chat_template.jinja`.**
  Required, *not* redundant with `jinja = true` — `chat-template-file` *replaces*
  the GGUF-embedded template entirely (`vendor/llama.cpp/common/arg.cpp:3142`,
  `params.chat_template = read_file(value)`). The upstream embedded template has
  documented issues with tool calls, role handling, `<think>` block rendering,
  agentic loops, and llama.cpp KV-prefix cache stability; the vendored template
  fixes all of them (full list in `vendor/Qwen-Fixed-Chat-Templates/README.md`).
  Since v19 the template is a single unified file, and since v22 it covers Qwen 3.5,
  3.6 *and* 3.8 (the old `qwen3.5/` and `qwen3.6/` subdirectories now live under
  `archive/`). The template adds a `<|think_on|>` / `<|think_off|>` toggle, and
  defaults `preserve_thinking` to `true` (past `<think>` blocks are kept
  chronologically for 100% KV prefix cache stability and agentic reasoning
  continuity). To strip past `<think>` blocks instead, set
  `chat-template-kwargs = {"preserve_thinking":false}` — at the cost of a lower
  KV cache hit rate. It also honours `preserve_reasoning`, so `--reasoning-preserve`
  (`common/arg.cpp:3677-3689`) works as the CLI equivalent. Path is repo-relative,
  so `llama-server` must be launched from the repo root — `read_file()` resolves
  against the process CWD, not the INI file's directory. `Qwen3-Coder-Next` entries
  deliberately keep their GGUF-embedded template; froggeric's README claims
  compatibility only for Qwen 3.5 / 3.6 / 3.8 variants.

- **Every Qwen 3.6 and Bonsai entry pins `reasoning-effort = medium`; the Qwen 3.8 entries pin
  `xhigh`. Never leave the key unset.** The level is one injected paragraph at the top of the
  system prompt — ~45 tokens of "Reasoning effort is set to xhigh..." — and `medium` is the single
  level that injects nothing at all (`chat_template.jinja:53-59`). Qwen 3.6 has no trained notion of
  the concept, so its entries pin `medium`; Qwen 3.8 *is* trained on it and Qwen's own template
  defaults to `xhigh`, so those pin `xhigh`. The template's own default is a
  `_default_reasoning_effort` variable at the top of the file (`chat_template.jinja:17`), currently
  `medium`, and it has moved between template releases before. That is the whole reason to pin:
  an unpinned entry silently changes reasoning level at a template bump, and a pinned one renders
  byte-identically across bumps. `--reasoning-effort` writes only a template kwarg
  (`common/arg.cpp:3650-3660`), which a request can still override
  (`tools/server/server-common.cpp:1312-1319`), as can a `<|think_low|>` / `<|think_medium|>` /
  `<|think_xhigh|>` tag typed inside a message (stripped before rendering). Unlike the
  GGUF-embedded 3.8 template, the vendored one never raises on an unknown level: it maps `high`,
  `max`, `ultracode` and `extreme` to `xhigh`, `minimal` to `low`, `none` and `off` to thinking
  off, and anything else *down* to `medium` (`chat_template.jinja:21-26`). The `ultracode` and
  `extreme` aliases exist for Claude Code, Cursor and Cline.

- **`xhigh` is kept on `Qwen3.8-27B`, and `--reasoning-budget` — not a lower level — is the guard
  rail for it.** Qwen publishes no per-level benchmarks; every number on the 27B card is at the
  `xhigh` default, and the card warns that in multi-turn agentic tasks lower effort "can also lead
  to insufficient analysis, more failures, and repeated retries". The entire mechanism is one
  injected sentence: 123 rendered chars at `medium` against 332 at `xhigh` — no token, no sampling
  change, no budget. The failure that moved froggeric's default to `medium` is a truncation
  artifact rather than a quality result: with a finite `max_tokens` and no budget, `xhigh` ran
  26,000 tokens and returned `content_len = 0` because truncation landed inside `<think>`, while
  the same rig at `xhigh` with a 1500-token thinking budget returned 18,512 chars of working code,
  more than `medium` produced. There is no rung between the two — `high` aliases to `xhigh`.
  `--reasoning-budget N` (`common/arg.cpp:3662-3668`) is live on this entry and deliberately left
  unset: the qwen3_coder handler supplies `<think>` and `{"</think>", "<tool_call>"}`
  (`common/chat.cpp:1181-1184`), the server forwards them (`server-common.cpp:1360-1366`), and on
  exhaustion the sampler masks every logit but the forced `</think>`
  (`common/reasoning-budget.cpp:119-131`, `:178-185`) so the model concludes instead of being cut
  off, re-arming per thinking block (`:146-161`). Unlike `max_tokens` it counts only tokens inside
  the block. Set it if an agentic client that sends its own `max_tokens` starts returning empty
  content; a request can override it per call via `reasoning_budget_tokens`.

- **`Qwen3.8-27B` pins the template too, even though its embedded one is already the newer file.**
  Qwen 3.8 reuses arch `qwen35` and is otherwise byte-for-byte the same shape as
  Qwen3.6-27B (65 blocks, 866 tensors, same `ssm.*`, same 248320-token tokenizer,
  `eos = 248046`), but it embeds a *different, newer* 8952-byte template (sha256
  `c3cf9e34abf4f9e3...`), not the 7764-byte one shared by Qwen3.6-27B and both Bonsai variants.
  That newer file already defaults `preserve_thinking` on and adds `reasoning_effort`, so it is a
  plausible candidate for going unpinned. Three defects rule that out, all
  reproducible by rendering the embedded template directly: tool calls whose `arguments`
  arrive as a JSON *string* (what most OpenAI-compatible clients send) abort with
  `Can only get item pairs from a mapping`; history carrying reasoning inside `content`
  rather than `reasoning_content` renders a duplicate blank `<think>\n\n</think>` ahead
  of the real block, because 3.8 dropped the in-content parser; and `reasoning_effort`
  accepts only `xhigh` / `medium` / `low`, calling `raise_exception` on `high`,
  `minimal` and `max` — three of the six levels `common/arg.cpp:3651` advertises.
  The vendored template handles all three and its `xhigh` instruction text is
  byte-identical to the official one, so `reasoning = on` with `reasoning-effort = xhigh`
  reproduces the pre-pin prompt. Tool-call parsing is unaffected: the qwen3_coder XML handler is
  selected purely on `<tool_call>` + `<function=` + `<parameter=` being present in the
  template source (`common/chat.cpp:3590-3594`), which both files satisfy, and the PEG
  parser is built from `inputs.tools` rather than the rendered `<tools>` block. The pin
  additionally brings froggeric's agentic extras (two-tier tool-error escalation,
  `<|think_on|>` / `<|think_off|>`, `developer` role, payload truncation).
  `Qwen3.8-Flash-Next` embeds the same 8952-byte file, so the same three defects and the same fix
  apply there — `docs/model_tuning/qwen3.8-flash-next.md`.

- **The vendored template (v22.4, pinned at `e649070`) corrects two v19 deviations from the
  official Qwen prompt format, so moving to it changed every pinned entry, not just the new 3.8
  ones.** v19 serialized `<tools>` entries *unwrapped*
  (`{"description": ..., "name": ..., "parameters": ...}`); the current template emits the wrapped
  OpenAI form (`{"function": {...}, "type": "function"}`), which is what Qwen3.6-27B's own
  7764-byte template and Qwen 3.8's 8952-byte one both produce — v19 was the outlier. v19 also
  rendered `</think>\n` before assistant content where the official templates and llama.cpp's own
  generation prompt use `</think>\n\n` (`common/chat.cpp:1163`). Both are corrections, but they
  change prompt bytes, so adopting the template invalidates existing KV prefix caches once;
  `reasoning-effort = medium` suppresses only the steering paragraph and does not restore v19
  output.

- **The template emits an empty `<think>\n\n</think>` before a historical tool call whose assistant
  message carried no reasoning, and that is deliberate.** Qwen itself emits a think block before a
  tool call when thinking is on, so injecting an empty one keeps rendered history token-aligned
  with the model's own generation. It fires only when the client drops reasoning on the round trip;
  supplying `reasoning_content`, `thinking`, `message.reasoning` (the vLLM and Responses API
  spelling) or an inline `<think>` block suppresses it. This is *not* the "empty think poisoning"
  the template's README calls out — that was replacing *real* thoughts with empty blocks to save
  tokens, which this template does not do. Verified by rendering the template against plain chat,
  system-prompt, thinking-off, multi-turn-with-thinking, vision, and both tool-argument wire
  formats; the tool-call case is the only one where an unset `reasoning_content` changes the
  output. The same release line also brings the effort aliases above, reasoning de-duplication when
  a client populates both `reasoning_content` and an in-content `<think>`, complete serialization of
  scalar and list tool arguments, and single-newline separation between consecutive `<tool_call>`
  blocks for token parity on multi-tool turns.

- **`Qwen3.8-27B` sets `temp = 1.0`, unlike the `0.6` used by the Qwen 3.6 entries.**
  1.0 is the official thinking-mode value on Qwen's card and is what the GGUF itself
  embeds as `general.sampling.temp`, applied at `common/common.cpp:1264` unless the
  preset overrides it. The rest of the sampler block (`top-p 0.95`, `top-k 20`,
  `min-p 0.0`, `presence-penalty 0`) is unchanged from the 3.6 entries. Qwen 3.8's
  non-thinking mode wants a different set (`temp 0.7`, `top-p 0.8`,
  `presence-penalty 1.5`); the preset does not cover it because `reasoning = on`.

- **Qwen 3.8's MTP head is multi-step trained, so `spec-draft-n-max = 3` is a measured
  peak rather than an inherited default.** A day-0 `n_max` sweep of 2/3/4/6 on this model
  put the maximum at 3 — acceptance falls monotonically with depth, but through 3 the
  extra tokens per iteration win. This overturns the Qwen 3.6 rule of thumb that 2 was
  optimal. 3 also happens to be the upstream default (`common/common.h:325`). Note the
  cost: `draft-mtp` sets `n_rs_seq = spec-draft-n-max` (`common/common.cpp:1699`), which
  multiplies the recurrent-state buffer by `1 + n_max` — ~150 MiB becomes ~600 MiB at 3.
  Both `Qwen3.8-27B` and `Qwen3.6-27B` carry `blk.64` (the MTP head) at `Q4_0` in the
  local IQ4_XS files; a 4-bit MTP head is reported to collapse acceptance to 0% on this
  model family, so check the server's acceptance rate before trusting the speedup. Two
  remedies exist: a re-quant keeping `blk.64` at `Q5_K` or above, or — since 2026-08-14 —
  pointing `spec-draft-model` at `ggml-org/Qwen3.8-27B-GGUF`'s standalone
  `mtp-Qwen3.8-27B-Q8_0.gguf`. Neither is taken. The sidecar is 3.16 GB against the
  ~2.65 GiB of headroom measured below, the `Q4_0` sidecar is the same precision as the
  embedded head, and `mparams.load_mtp` is set from the *type list* rather than from the
  presence of a draft path (`common/common.cpp:1689`, `src/models/qwen35.cpp:42`), so the
  target keeps loading its own `blk.64` and an external sidecar double-pays.

- **`Qwen3.8-27B` is the only 24 GB Qwen entry on a `Q8_0` projector instead of `BF16`.**
  600 MiB rather than 888 MiB of VRAM, and that saving is what keeps `mmproj-offload = true`
  affordable at `ctx-size = 262144`: the entry lands at ~19.95 GiB of ~22.6 GiB usable, just
  under the Qwen3.6-27B entry's ~20.23 GiB, which leaves room for the CLIP compute buffer.
  Spending the saving elsewhere is what breaks it — raising the KV cache to `q5_0` K / `q4_1` V
  costs ~0.80 GiB at this context and pushes the total above the 3.6 entry, into the
  silent-OOM window described in `docs/presets.md` -> *mmproj-offload*. Quality is not the tradeoff: Qwen ships this family's
  projector as FP16 *and* `Q8_0` officially, and only 83 of the file's 110 weight tensors are
  actually 8-bit — every `ffn_down` stays `F16`.

- **Quantize Qwen3.8 GGUFs from `Qwen/Qwen3.8-27B`, never from `Qwen/Qwen3.8-27B-FP8`.** BF16 is
  this model's native precision and the FP8 repo is a derived, post-training artifact (HF model
  tree: base model `Qwen3.8-27B`, "Quantized"), so it is already lossy — its card claims only
  "nearly identical" metrics. Quantizing from it would fit the quantizer and the imatrix to
  degraded weights. This is the opposite of DeepSeek-V3/V4, which were *trained* in FP8, making
  their FP8 checkpoint the original and its dequant to BF16 exact; `convert_hf_to_gguf.py:156`
  (`--fp8-as-q8`) exists for that case, not this one. The mmproj is the one exception where the
  source does not matter: the FP8 repo leaves the whole vision tower unquantized (0 of 333
  `model.visual.*` tensors carry `weight_scale_inv`), so it is byte-identical either way. The
  MTP head is not — `mtp.layers.0`'s attention and MLP projections are FP8 there, so any
  re-quant raising `blk.64` above 4-bit must also come from the BF16 repo.

## Bonsai and DSpark

- **Both Bonsai entries are Qwen3.6-27B derivatives and take every Qwen 3.6 pin above.**
  `Ternary-Bonsai-27B` and `Bonsai-27B` ship from separate HF repos but share arch `qwen35`, and
  their tokenizers are byte-identical to stock Qwen3.6-27B (248320 tokens, same merges,
  `eos = 248046`) right down to the same 7764-byte embedded template — which is exactly the
  upstream template the `chat-template-file` pin exists to replace. `general.sampling.temp = 1.0`
  is embedded in both GGUFs and applied at `common/common.cpp:1264`, so `temp` has to be pinned in
  the preset or generation runs at 1.0. The presets use `0.6` to match the sibling Qwen 3.6
  entries; Prism's own card benchmarks at `0.7`. Unlike the DSpark sidecar below, both weight
  files are mainline-packed (`Q2_0` at `QK2_0 64`, `Q1_0` at `QK1_0 128`) and load without a
  tensor-offset mismatch.

- **The DSpark drafter shipped beside Ternary Bonsai 27B cannot be enabled on mainline.**
  `Ternary-Bonsai-27B-dspark-Q4_1.gguf` has its `token_embd.weight` in `Q2_0` at Prism's
  group-128 packing while mainline is group-64 (`QK2_0 64`, `ggml/src/ggml-common.h`), so
  `gguf_init_from_reader` rejects the file on a tensor-offset mismatch before any architecture
  dispatch. Repacking would not help: `general.architecture = 'dspark'` is unregistered
  (`src/llama-arch.cpp:136` has only `dflash`), and mainline's DSpark is DeepSeek-V4
  DFlash + Markov (`src/models/dflash.cpp`, tensors `markov_w1`/`markov_w2`/`conf_proj`,
  requiring MLA and sqrtsoftplus MoE scoring), not Prism's 6-layer Qwen3.6-shaped drafter
  (`dspark.fc`, `dspark.log_snr_fc*`, `dspark.markov_head_*`). Upstream confirmed on #25707
  that it stays fork-only. The GGUF carries no MTP tensors either, so `draft-mtp` is out and
  the entry uses `ngram-mod`. Only the group-64 pack is mainline-loadable — `Q2_0.gguf` and
  `PQ2_0.gguf` in the same HF repo are group-128 fork packs.
