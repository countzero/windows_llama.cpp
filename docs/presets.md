# Presets Reference

Cross-model rules for editing `presets/*.ini`. Not auto-loaded into the agent
context; read it on demand. `presets/README.md` is the user-facing quick-start;
this file is for editing. Per-model rationale lives in `docs/model_tuning.md`.

## Editing presets

VRAM-tier presets: `presets/models_16GB_VRAM.ini`, `presets/models_24GB_VRAM.ini`,
`presets/models_16GB_8GB_VRAM.ini` (dual-GPU).

## Device pinning and multi-GPU

- **Only `models_16GB_8GB_VRAM.ini` pins devices.** It sets `split-mode`, `main-gpu`, and
  `tensor-split` in its `[*]` section; the other two tiers set none of the three, so on a host with
  more than one CUDA device llama.cpp's default `split-mode = layer` spreads every entry across
  *all* visible GPUs — the tier name is then a floor, not a cap. Pin with `CUDA_VISIBLE_DEVICES`
  before launch, not `--device`: in router mode each child's argv is rebuilt from the preset
  (`inst.meta.update_args`), so a parent `--device` never reaches the child, while the environment
  is copied into every child (`tools/server/server-models.cpp:802`). Pinning is a throughput
  decision, not only a memory one — `Ternary-Bonsai-27B-Q2_g64.gguf` measured 56.5 t/s tg and
  1418 t/s pp on one 16 GB card versus 36.5 t/s and 998 t/s spread over a 16 GB plus an 8 GB card.
  `CUDA_VISIBLE_DEVICES` indices follow `CUDA_DEVICE_ORDER`, which defaults to `FASTEST_FIRST` and
  therefore does *not* match `nvidia-smi` ordering; pass a GPU UUID to be unambiguous.

## load-mode

- **All entries use `load-mode = dio`; never pair `direct-io` with `no-mmap` again.** Both spellings
  are deprecated, and they write the *same* mutually exclusive enum — `--no-mmap` sets
  `LLAMA_LOAD_MODE_NONE` (`common/arg.cpp:2594`) while `--direct-io` sets
  `LLAMA_LOAD_MODE_DIRECT_IO` (`:2603`) — so setting both means only whichever is parsed last wins.
  Which one that is is *not* the INI order: `common/preset.cpp` emits `opt.args.back()` while
  iterating an unordered map. It happened to resolve to DirectIO, but a container-order change would
  silently downgrade to `NONE`, dropping DirectIO *and* mmap for plain buffered reads. `dio` is the
  single equivalent of the old pair and also removes two deprecation warnings per launch. Valid
  values are `none`, `mmap`, `mlock`, `mmap+mlock`, `dio` (`arg.cpp:2615-2619`) — anything else
  throws at startup.

- **`Qwen3.8-Flash-Next` is the one entry that must use `load-mode = mmap` instead.** Its 26.8 GiB
  `per_layer_token_embd` n-gram hash table is created with `TENSOR_READ_LAZY`
  (`src/models/qwen4exp.cpp:139-140`) and the loader gates that flag on `use_mmap`
  (`src/llama-model-loader.cpp:1290`), which every non-mmap `load-mode` clears (`:559`). A session
  touches 8 of the table's 320 million rows per token, so under `mmap` the resident working set
  stays in the hundreds of MiB while `dio` reads and holds all 26.8 GiB. `no-host = true` is part
  of the same mechanism, not an independent choice — see `docs/model_tuning.md` -> *Qwen3.8-Flash-Next*.

- **`load-mode = dio` does not enable DirectIO on Windows — it only disables mmap.** The Win32 `llama_file::impl` ctor takes `use_direct_io` as `[[maybe_unused]]` and just calls `ggml_fopen` (`vendor/llama.cpp/src/llama-mmap.cpp:86-95`); `FILE_FLAG_NO_BUFFERING` is never set and `read_alignment()` stays 1 (`:391`), so the loader's async staging buffers are 4 x 1 MiB of pinned host memory instead of the 4 x 64 MiB the aligned path would use (`src/llama-model-loader.cpp:1418`, `:1427`). `has_direct_io()` nevertheless returns a hardcoded `true` on Windows (`:173-175`). Net effect of `dio` on this platform: buffered reads, no mmap, and zero VRAM cost — it is never implicated in a CUDA OOM. Keep the key for the deprecation-warning reason documented above, but do not reason about page-cache behaviour from it.

## mmproj-offload

- **`mmproj-offload = true` fails silently at startup on a saturated GPU.** CLIP's warmup
  compute buffer OOMs but the server keeps running — only image requests error at generation
  time. Set `false` on tiers where LLM + KV already saturate VRAM.

## Context size and override-kv

- **`ctx-size` above the GGUF's `context_length` is dead VRAM unless `override-kv` lifts it too.**
  `llama-context.cpp:131` never clamps `n_ctx`, so the KV cache really is allocated at the
  requested size — but the server then caps every slot at `n_ctx_train`
  (`tools/server/server-context.cpp:1201-1203`, applied as `slot.n_ctx = n_ctx_slot` at `:1255`)
  and rejects any larger request outright at `:3100` / `:3111`. Both Muse Glimmer GGUFs ship
  `muse-glimmer.context_length = 131072`, so the 24 GB entry's former `ctx-size = 262144`
  allocated 262144 cells while no request could exceed 131072 — ~884 MiB of unreachable VRAM.
  `override-kv = muse-glimmer.context_length=int:262144` raises `n_ctx_train` and is the only
  lever; Meta documents 131072 as the default and 262144 as the maximum, so this is the
  vendor-sanctioned ceiling, not an extrapolation hack. The startup line
  `the slot context (...) exceeds the training context of the model (...) - capping` is expected
  here (the pool is 524288 for two 262144 slots); what matters is
  `initializing, n_slots = 2, n_ctx_slot = 262144`. If that reads 131072 the override did not
  take. It also sets `n_ctx_orig_yarn = 262144` (`src/llama-model.cpp:1180`), inert at
  `freq_scale 1`.

## ngram-mod speculative decoding

**ngram-mod speculative decoding** (`--spec-type ngram-mod`): model-agnostic, works on any model.
- All models: `spec-ngram-mod-n-match = 24`, `spec-ngram-mod-n-min = 48`, `spec-ngram-mod-n-max = 64`
  (matches the struct defaults in `common/common.h:329-337` and what `--spec-default` produces
  at `common/arg.cpp:4065-4074`; ggerganov confirmed post-merge in PR #19164 that the min/max
  "likely don't need to be changed from the recommended values"; MoEs require long drafts and
  dense models tolerate them without noticeable cost). Flags were renamed from
  `--draft-min`/`--draft-max`/`--spec-ngram-size-n` in upstream PR #22397; the old names now
  error at startup.
- `n_match < 16` logs a "too small — poor quality is possible" warning at
  `vendor/llama.cpp/common/speculative.cpp:1031-1034`; parser accepts `1..1024`
  (`common/arg.cpp:3606-3615`), so 16 is the lowest non-warning value, not a hard floor.
  Min/max parsers accept `0..1024` (`common/arg.cpp:3587-3605`).
- Memory overhead: ~16 MiB **total**, shared across all server slots
  (single `common_ngram_mod` instance allocated at `common/speculative.cpp:1026`).
- Pool auto-resets on `begin()` if occupancy > 25 %, and after 3 consecutive rounds with
  acceptance < 50 % (`common/speculative.cpp:720-728`, `:790-806`). Smaller `n_match` makes
  these resets fire more often and wipes ngrams learned from the current prompt — another
  reason to stay at `n_match ≥ 24`.
