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

- **On the dual-GPU tier the headroom levers are the inverse of the Qwen ones: weights bind, KV does
  not.** Only 13 of the 52 layers sit on the full-attention tier and they carry `head_count_kv = 2`
  at `key_length = value_length = 128`, so the context-scaling cache is
  `13 x 256 x (22/32 + 20/32)` = 4368 B/token at `q5_0` K + `q4_1` V — 546.00 MiB at
  `ctx-size = 131072` against 14860.33 MiB of GPU weights (13488.93 target + 1371.40 draft;
  `token_embd.weight`'s 721.42 MiB stays on the host, which is the whole gap between the file's
  14210.35 MiB and the target's GPU figure). Dropping KV to `q4_0` buys 78 MiB against the ~1.4 GiB
  the same move is worth on `Qwen3.8-27B` (`docs/model_tuning/qwen.md`), and context costs the
  display card only ~4 MiB per 1k tokens once its KV share and its own mask copy are counted, so
  neither is the lever it is there — one step of `tensor-split` moves ~1072 MiB, and it is paid in
  prompt processing. Measured on the 4070 Ti SUPER + 2060 SUPER pair with `draft-dflash,ngram-mod`,
  `parallel = 2`, `ctx-size = 262144`, identical requests per row. The free-VRAM column is
  normalised to the heaviest compositor state observed (2990 MiB) because the raw reading moves with
  the desktop; `tg/pass` is `tg / mean len`, which removes the drafter's sampling variance:

  | entry | `-ub` | layers 2060/4070 | 4070 free | pp 31k prompt | tg/pass code / reason / 31k |
  | --- | --- | --- | --- | --- | --- |
  | `1,2` | 512 | 18/34 | 873 MiB | 1059 | 14.01 / 14.03 / 11.44 |
  | **`1,2` (entry)** | **256** | 18/34 | **1229 MiB** | 1044 | 14.20 / 13.96 / 11.45 |
  | `1,3` | 256 | 14/38 | 173 MiB | 1256 | 14.77 / 14.83 / 12.10 |

  `1,3` is worth +20 % pp and +4-6 % tg and is still not taken: the compositor moved 2141 -> 2990 MiB
  inside one session here, and at `1,3` that swing leaves the display card under the 400 MiB floor
  (`docs/presets.md` -> *Device pinning and multi-GPU*). Compare rows by `tg/pass`, never by raw tg —
  the raw figures swing 2.4-3.5 on the same prompt from sampling alone. Note the entry runs
  `ctx-size = 262144` with `parallel = 2` and **no** `override-kv`: with `kv-unified` off,
  `n_ctx_seq = n_ctx / n_seq_max` = 131072, which is exactly `muse-glimmer.context_length`, so two
  full-length slots come out of one 262144 pool without exceeding the native ceiling
  (`docs/presets.md` -> *Slots and the prompt cache*).

- **Both compute buffers are allocated per device, and the speculative one is an upstream
  over-reservation that only `ubatch-size` can reach.** Measured at the entry's settings
  (`1,2` / `ctx-size = 262144` / `parallel = 2` / `-ub 256`): target model 4419.51 MiB CUDA0 +
  9069.41 CUDA1, draft model 501.01 + 870.39, non-SWA KV 336.00 + 756.00 (1092.00 total for two
  seqs), SWA KV 20.68 + 36.93 (2304 cells, 39 layers), draft SWA KV 11.81 + 17.72, target compute
  **342.29 on each device**, draft compute 76.71 + **401.90**. The target term is the F16 KQ mask,
  `n_kv x n_ubatch x 2` (`src/llama-graph.cpp:39-41`), paid in full on both cards under
  `split-mode = layer` and not only under `tensor`. The draft term is not an activation at all:
  `common_base_params_to_speculative` computes `n_outputs_max = parallel x (n_max + 1)` = 32, but
  `src/llama-context.cpp:249` discards it because `llama_model_has_encoder()` is true for
  `LLM_ARCH_DFLASH` (`src/llama-model.cpp:3081`), substituting `n_batch`. `reserve()` then sizes the
  logits tensor at `min(n_ubatch, n_batch)` rows — 512 at `-ub 512`, i.e. `512 x 202048 x 4` =
  394.62 MiB, twice over. The draft context's own log line is the tell: `n_outputs_max = 2048`
  beside `n_outputs_max_per_seq = 16`. Halving `-ub` halves it (803.03 -> 401.90 MiB) and costs
  1.5 % pp with `tg/pass` flat, which is why the entry ships `ubatch-size = 256`; there is no flag
  that caps it directly. Draft of an upstream report:
  `.tmp/sessions/*/upstream-dflash-n-outputs-max.md`. Add ~470 MiB of CUDA VMM scratch and cuBLAS
  workspace that `memory_breakdown()` cannot see and that only appears once a real request arrives
  (`docs/presets.md` -> *fit*, blind spot 1); budget from `nvidia-smi` after a request, never from
  the reserve lines.

- **`ubatch-size = 256` is safe for vision here, but would not be on a Gemma entry.** Muse Glimmer's
  images are 1024 tokens (896 px at `patch_size = 14`, `spatial_merge_size = 2`) and therefore span
  four microbatches, which is only sound because `mtmd_decode_use_non_causal()` returns true for
  `GEMMA3` / `GEMMA4V` / `GEMMA4UV` and false for everything else, this projector included
  (`tools/mtmd/mtmd.cpp:2107-2120`). Verified end to end: a 1247-token image request describes the
  photograph correctly. `tools/mtmd/mtmd-helper.cpp:98-101` carries the matching upstream caveat for
  the non-causal case — see `docs/model_tuning/gemma-4.md`.

- **KV quantisation is not a prompt-processing lever on this pair.** For head dim 128,
  `ggml_cuda_get_best_fattn_kernel()` returns `MMA_F16` on both cc 8.9 and cc 7.5 whenever
  `Q->ne[1] > 2` (`ggml/src/ggml-cuda/fattn.cu:461-482`), so prefill runs the same kernel for
  `q5_0`/`q4_1` as for `q8_0`. Quantised KV also gets the *better* decode path here — `fattn.cu:468`
  grants the vector kernel at `Q->ne[1] <= 2`, while `f16` is excluded by the
  `gqa_ratio > 4 && K->ne[1] >= 8192` guard and this model's `gqa_ratio` is 16. Upstream #27109 /
  #27140 report 4-bit KV collapsing prefill, but on `qwen35` hybrid on 2x RTX 3090; it does not
  reproduce here.

- **The 2060 SUPER's PCIe 3.0 x4 link is the card's own ceiling, not a misconfiguration, and it is
  not the bottleneck.** `nvidia-smi` reports `pcie.link.gen.max = 3` and `gpumax = 3` against
  `hostmax = 4` — Turing is PCIe 3.0, so the OCuLink dock's PCIe 4.0 x4 cannot be reached. It costs
  almost nothing under `split-mode = layer`: one layer-boundary handoff is
  `n_ubatch x n_embd x 4` = 6.5 MiB at `-ub 256`, so a 31k-token prefill moves ~790 MiB in total,
  ~0.2 s against a ~30 s prefill. The 2060's compute is what sets pp, which is why `tensor-split` is
  the lever and why `split-mode = tensor` — which needs a per-layer allreduce over that link — is
  not (`docs/model_tuning/qwen.md`).

- **The drafter cannot be parked on the idle card.** `--spec-draft-device CUDA0` looks like free
  headroom — it would move 870.39 MiB of draft weights plus the 803.02 MiB speculative-context
  buffer off the display GPU onto a 2060 SUPER that idles at 2.3 GiB — but dflash reuses the
  target's `output.weight`, which `split-mode = layer` pins to the last device, and the load aborts
  in `ggml-backend.cpp:941` with `pre-allocated tensor (output.weight) in a buffer (CUDA1) that
  cannot run the operation (NONE)`. The draft otherwise inherits the target's `split_mode`,
  `main_gpu` and `tensor_split` wholesale (`common/speculative.cpp:2464-2473` copies the base
  `common_params` and overrides only the path, devices and `n_gpu_layers`), so the split ratio moves
  1371.40 MiB of drafter with it — include that in any per-device budget.
