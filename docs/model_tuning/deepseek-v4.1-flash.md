# DeepSeek-V4.1-Flash

Per-model rationale behind a `DeepSeek-V4.1-Flash-1017` entry, with the measured numbers each
decision rests on. Not auto-loaded into the agent context; read on demand. Cross-model rules
(`load-mode`, `no-host`, `fit`, `ubatch-size`) are in `docs/presets.md` and referenced here
rather than restated; what V4.1 shares with V4 is in `docs/model_tuning/deepseek-v4-flash.md`.

## Entry

`[DeepSeek-V4.1-Flash-1017-UD-IQ2_XXS.gguf]` in `presets/models_24GB_VRAM.ini`:

- **`ctx-size` 262144**: DeepSeek recommends allowing at least 256K of output; it costs 7 % of
  decode against 32768 at the same batch size (*Measurements*).
- **`batch-size`/`ubatch-size` 2048**: +93 % prefill.
- **`fit-target` 1024**: 2.1 GB free after load, above the ~400 MiB display-GPU floor.
- **No DSpark** (*DSpark*) **and no ngram-mod**: ngram-mod is unmeasured on this arch, and DSV4
  rollback goes through checkpoints (`docs/model_tuning/deepseek-v4-flash.md`).
- **Sampling** temperature 1.0, top-p 1.0, top-k 0, min-p 0, and `reasoning_effort` `high`
  through `chat-template-kwargs` (*Sampling and reasoning*).

## Model and quant

Arch is `deepseek41`: the 552B `deepseek4` backbone plus an Engram n-gram memory. GGUF metadata
of `unsloth/DeepSeek-V4.1-Flash-1017-GGUF`: `block_count` 40, 384 experts with 6 used, Engram on
layers 1 and 14, `ngram_size` 4 and `heads_per_ngram` 8. Each Engram layer therefore reads 24
rows per token, 48 per token in total, from `per_layer_token_embd.weight`, a Q5_K table of one
256-wide row (176 bytes) per n-gram head bucket. Every row read is a random 4 KiB page.

- **UD-IQ2_XXS is the largest quant that fits 24 GB VRAM + 192 GB RAM.** It is 6 shards,
  300.5 GB; shard 6 (135.17 GB) is the Engram table alone. What has to be resident is the rest,
  and Unsloth's figures for it are:

  | Quant       | Non-Engram size | KL wiki | Top-1 wiki | KL long17k | Top-1 long17k |
  | ----------- | --------------: | ------: | ---------: | ---------: | ------------: |
  | UD-IQ2_XXS  |        165.3 GB |   0.203 |     90.5 % |      0.142 |        91.2 % |
  | UD-Q2_K_XL  |        199.6 GB |   0.138 |     91.5 % |     0.0879 |        93.3 % |

  UD-Q2_K_XL is measurably better, but 199.6 GB of weights on 216 GB of combined memory leaves
  nothing for KV, compute buffers, the OS and the page cache the Engram table reads through.

## Build

- **`deepseek41` exists only on upstream PR #30817.** The vendored b11700 has `deepseek4` but no
  `deepseek41`, no Engram and no MXFP8. Build the draft PR (head `b72050d`, merge base b11700 /
  `23f7aab`) with `./rebuild_llama.cpp.ps1 -pullRequest "30817"`; patches 0001 and 0002 apply
  cleanly on that head (`docs/build_system.md` -> *Local patches*). The submodule pointer is not
  committed at the PR commit, so any rebuild without `-pullRequest` silently drops the arch and
  the entry fails at load as an unknown architecture.

## Engram placement

- **Keep `load-mode = mmap` and `lazy-mode = on`; never add `-ot` for the Engram table.** The PR
  (`src/models/deepseek41.cpp`) creates `per_layer_tok_embd` with `TENSOR_READ_LAZY`. A lazy
  tensor short-circuits to the CPU buffer type (`src/llama-model-loader.cpp:1212-1213`,
  `:1081-1087`) and is mmap-mapped whatever the load mode (`src/llama-model.cpp:1916-1919`);
  with lazy off the PR forces host placement anyway. Fit counts the table as host memory, never
  VRAM. This is the same mechanism as `docs/model_tuning/qwen3.8-flash-next.md`.
- **Unsloth's `-ot per_layer_token_embd.weight=CPU` is redundant here and harmful.** Any `-ot`
  makes fit abort (`common/fit.cpp:484-485`, caught at `:894-895`) with only a warning, so the
  load proceeds with fit's placement silently skipped (`docs/presets.md` -> *fit*).
- **The table must sit on storage that serves high-queue-depth random reads.** Unbuffered 4 KiB
  reads of shard 6 on this laptop: a VeraCrypt volume on a Samsung 9100 PRO (Gen4 chipset slot)
  gave 2.2 GB/s sequential and 12.2k IOPS, flat from 16 to 64 threads, because VeraCrypt's
  `EncryptedIoQueue` IoThread issues the lower I/O synchronously; an unencrypted WD Red SN700
  gave 3.4 GB/s and 123.5k IOPS. Sequential bandwidth says nothing about the decode cost here.

## KV cache

- **`cache-type-k` and `cache-type-v` must be identical.** The PR extends the startup-fatal
  K != V check (`src/llama-context.cpp:4058`) to `LLM_ARCH_DEEPSEEK41`. The cache is K-only
  (`src/llama-kv-cache-dsv4.cpp:1257-1313`), so `cache-type-v` is never allocated but is still
  compared. `q8_0`/`q8_0` is a compiled pair (`docs/build_system.md` -> *CUDA build flags*); the
  sizing argument for DSV4 caches is in `docs/model_tuning/deepseek-v4-flash.md`.

## Lazy-mode corruption report

- **A reported lazy-mode corruption does not reproduce here, and its posted fix is a no-op on
  this build.** On the PR (2026-10-20, 2x RTX PRO 6000, UD-IQ3_S) a user saw single-token swaps
  in 7 of 20 hex and 2 of 20 prose runs with lazy on and none with lazy off. The proposed fix
  adds `ggml_backend_dev_init` + `ggml_backend_synchronize` after the Engram
  `ggml_backend_tensor_set`. Graph inputs live in the CPU compute buffer
  (`ggml-backend.cpp:1093-1095`) and the scheduler copies them to the device after a
  synchronize (`:1829-1837`), while a freshly created CUDA backend syncs only its own new
  stream (`ggml-cuda.cu:2680-2686`, `:6143`), so the added call orders nothing. On this laptop
  the hex test was 20/20 exact in both host-gather modes, at the same throughput
  (*Measurements*).
- **`LLAMA_DSV41_HOST_GATHER=0` is the diagnostic switch, not a preset key.** It is read once
  into a static (`deepseek41.cpp:784`) and moves token and Engram row lookup to an in-graph
  `GET_ROWS` on the CPU; CUDA never offloads `GET_ROWS` (`ggml-cuda.cu:5904-5905`). Being an
  environment variable outside `CUDA_*` and `LLAMA_ARG_*`, it does not belong in `.env`
  (`AGENTS.md` -> *Commands*); set it in the shell for a one-off comparison.

## Sampling and reasoning

- **Use temperature 1.0, top_p 1.0, top_k 0, min_p 0**, as Unsloth and DeepSeek recommend.
  `reasoning_effort` accepts 1-100 or `low`/`medium`/`high`/`max` through
  `chat-template-kwargs`; the PR maps the OpenAI request values onto it. Template detection and
  the `reasoning-format` default follow `deepseek4` (`docs/model_tuning/deepseek-v4-flash.md`).

## Measurements

A first smoke test ran with the Engram table on the encrypted D: volume (the 12.2k-IOPS one
above) and is superseded by the series below: `ctx-size` 32768, `fit-target` 1024,
`ubatch-size` 512; cold load ~60 s; 2.6 GB VRAM free; ~41 GB RAM free while serving; hex test
20/20 exact; prefill 65.9 tok/s on a 4,936-token prompt; decode 9.17 tok/s over 512 tokens.

Measured 2026-10-21 on the RTX PRO 5000 Blackwell Laptop 24 GB, Core Ultra 9 285HX and 192 GB
DDR5-4000, PR #30817 head `b72050d` (build 11717), UD-IQ2_XXS with the table on the unencrypted
WD SN700 (E:). Base flags: `fit = on`, `fit-target` 1024, `no-host`, `load-mode = mmap`,
`lazy-mode = on`, `cache-type` `q8_0`/`q8_0`, `flash-attn = on`. Probe: 20 hex-copy prompts
(200 chars, temperature 0), then one 4,936-token prompt generating 512 tokens; one run per arm.

| Arm     | Setting                         | Load s      | Free VRAM after load MiB | Prefill tok/s | Decode tok/s | Hex exact |
| ------- | ------------------------------- | ----------: | -----------------------: | ------------: | -----------: | --------: |
| a1      | ctx 32768, ubatch 512           | 62.1 (cold) |                     2708 |         70.71 |         9.26 |     20/20 |
| b1      | + `LLAMA_DSV41_HOST_GATHER=0`   |        25.9 |                     2708 |         71.00 |         9.22 |     20/20 |
| b2      | + `LLAMA_DSV41_HOST_GATHER=0`   |        25.4 |                     2708 |         70.67 |         9.28 |     20/20 |
| a2      | ctx 32768, ubatch 512           |        25.4 |                     2708 |         70.91 |         9.64 |     20/20 |
| ub2048  | ctx 32768, batch/ubatch 2048    |        24.9 |                     2140 |        136.57 |         9.25 |     20/20 |
| ctx128k | ctx 131072, batch/ubatch 2048   |        24.4 |                     2594 |        134.12 |         9.06 |     20/20 |
| ctx256k | ctx 262144, batch/ubatch 2048   |        22.4 |                     2084 |        134.47 |         8.60 |     20/20 |

- **Host gather on or off is noise, so no environment variable is needed.** Means: a 70.81
  prefill / 9.45 decode, b 70.84 / 9.25.
- **`batch-size`/`ubatch-size` 2048 nearly doubles prefill (+93 %).** With experts in host RAM,
  llama.cpp copies the CPU-resident expert weights to the GPU once per ubatch for batches of 32
  tokens or more; 4,936 tokens at ubatch 512 is 10 copies of ~134 GiB (~20.7 GB/s effective over
  PCIe Gen5 x16 from pageable memory), at 2048 it is 3 (`docs/presets.md` -> *batch-size and
  ubatch-size*). It costs ~0.5 GiB of VRAM margin and no decode.
- **Decode is bound by the CPU expert kernels, not by bandwidth.** 146.1 GiB of routed experts
  x 6/384 is ~2.28 GiB per token, ~2.1 GiB of it from host RAM; 9.3-9.6 tok/s is ~21 GB/s,
  about a third of the ~64 GB/s DDR5-4000 dual-channel peak. Engram row reads (~450 IOPS at
  this rate) are negligible on storage like E:, so the SSD matters for load time and prompt-time
  row reads, not for decode.
- **262144 context loads, at a decode cost.** It keeps 2084 MiB free and 20/20, but fit moves
  experts to the CPU and decode drops 7 % against ub2048 at 32768 (9.25 -> 8.60); 131072 costs
  ~2 %.
- **A cold load (empty page cache) takes ~60 s, a warm one ~25 s.**
- **Threads: the entry keeps the tier default `threads = 24`** (the `[*]` section of
  `presets/models_24GB_VRAM.ini`). At ctx 262144, batch/ubatch 2048, `fit-target` 1024:

  | Threads | Threads-batch | Prefill tok/s | Decode tok/s |
  | ------: | ------------: | ------------: | -----------: |
  |       8 |            24 |        125.91 |         6.54 |
  |      16 |            24 |        129.28 |         8.70 |
  |      24 |   (default)   |        129.03 |         8.42 |

  The ctx256k row above is an earlier run of the default (134.47 / 8.60). Eight P-core threads
  decode 24 % slower, so the E-cores add usable capacity; 16 is within the ~2 % run-to-run noise
  of 24.

## DSpark

- **The Q8_0 drafter does not load with `fit-target` 1024.** `dspark-DeepSeek-V4.1-Flash-1017-Q8_0.gguf`
  (7.98 GB, arch `dflash`) runs with `--spec-type draft-dspark`, and `--spec-draft-n-max` is
  clamped to 5. At both 262144 and 32768 context fit logs `failed to measure the memory of the
  extra model, fitting without it`, gives the card to the target, and the drafter's 7,602 MiB
  CUDA0 buffer then fails `cudaMalloc ... out of memory`.
- **With `fit-target` 9000 the drafter loads, and costs more than it saves.** At ctx 262144 it
  leaves 3280 MiB free after load, but against the same config without the drafter (threads 16)
  decode falls from 8.70 to 3.16 tok/s (-64 %) and prefill from 129.28 to 109.53 tok/s (-15 %).
  Acceptance was 84-95 % on the short hex copies but 33 % (254/765, mean length 1.99) on the
  512-token essay. The ~8 GB reservation pushes experts to the CPU, so the entry ships without
  DSpark.
