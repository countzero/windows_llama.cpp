# Inkling 2

Per-model rationale behind the `Inkling-2-Mini` entry, with the measured numbers each decision
rests on. Not auto-loaded into the agent context; read on demand. Cross-model rules (`fit`,
`ubatch-size`, `mmproj-offload`, slots) are in `docs/presets.md` and referenced here rather than
restated.

## Entry

`[Inkling-2-Mini.IQ4_XS.gguf]` in `presets/models_24GB_VRAM.ini`:

- **`ctx-size` 262144 with `batch-size`/`ubatch-size` 64**: the compute buffer scales with
  context x ubatch (*Attention and the compute buffer*), so context is bought with ubatch.
  879 MiB free after load, 809 MiB after a 48.7k-token prompt.
- **`cache-type-k`/`cache-type-v` `q8_0`** with `flash-attn = true` (*KV cache*).
- **No speculative decoding**: neither the DSpark drafter nor ngram-mod beats plain decoding at
  the vendor sampling (*DSpark*).
- **Q8_0 projector on the GPU** (`mmproj-offload = true`), verified with a real image request.
- **`fit = off`**, every layer on the GPU, `load-mode = dio`.
- **Sampling** temperature 1.0, top-p 1.0, top-k 0, min-p 0; the embedded chat template, no
  `chat-template-file` (*Sampling and reasoning*).

## Model and quant

Thinking Machines' `thinkingmachines/Inkling-2-Mini`, Apache-2.0: a multimodal MoE of 26.4B
total and 3.4B active parameters, 128 routed experts with 8 used and no shared expert. GGUF arch
is `inkling2_loop`: 24 physical blocks, of which blocks 6-17 run three times with shared weights
(`loop.start` 6, `loop.end` 18, `loop.count` 3), so every token makes 48 layer visits. 20 blocks
are sliding-window (window 1024) and 4 are global; there is no RoPE, position enters as a learned
relative-position bias, and K, V and the attention output pass a short convolution whose state is
recurrent. `context_length` is 1048576.

- **The file is a local IQ4_XS, 14.38 GB.** Its metadata names the imatrix
  `Inkling-2-Mini.importance-matrix.gguf` (392 entries, 1770 chunks). Comparable published quants
  are larger: Unsloth `UD-IQ4_XS` 15.73 GB, bartowski `IQ4_XS` 15.09 GB, ggml-org `IQ4_NL`
  17.63 GB. Unsloth's root files are mainline layout since 2026-11-23; anything from
  `Old_Support/` needs their fork.

## Build

- **The arch needs b12600 (#32694) and the DSpark drafter b12720 (#32218).** The submodule
  commit `36d818e` (build 12727) contains both. A build before b12611 (#32704) loads Unsloth's
  files but produces gibberish.

## Attention and the compute buffer

- **Flash attention never runs on Inkling's own attention, so the dense KQ matrix sets the
  memory budget.** `src/models/inkling2.cpp:380-394` passes the relative-position bias as `kq_b`,
  and `build_attn_mha` takes the flash path only when `kq_b == nullptr`
  (`src/llama-graph.cpp:3168`). The fallback materialises `kq` and `kq + kq_b` in F32 for all 24
  heads: the CUDA0 compute buffer is ~196 bytes per (context cell x ubatch token). Measured:
  3221 MiB at 131072 x 128 and at 65536 x 256, 3195 MiB at 262144 x 64, 6549 MiB at 65536 x 512,
  and 131072 x 512 asks for 12885 MiB and fails to load.
- **ubatch costs prefill only mildly here, so context wins.** On the same 48.7k-token prompt:
  ubatch 64 457 t/s, 128 418-489 t/s, 256 519 t/s, 512 572 t/s (*Measurements*; run-to-run noise
  is ~10 %). Generation does not move. CUDA support for the indexed bias (#32740) exists only in
  forks; once it lands upstream, this trade disappears and the entry should be re-measured.

## KV cache

- **`q8_0`/`q8_0` halves the KV cache and costs nothing measurable.** Only the 8 global-layer
  visits grow with context: f16 4096 MiB at 131072 cells, q8_0 2176 MiB; the 40 SWA visits hold
  1280 cells, 200 MiB f16 or 106 MiB q8_0. At 131072 x 128 q8_0 left 3536 MiB free against f16's
  1466 MiB, at 71.7 / 68.9 t/s generation against 67.0 / 64.7. Unsloth's report that q8_0 used
  *more* VRAM than f16 on mainline does not reproduce on this build.
- **`flash-attn = true` is still required.** It does nothing for Inkling's attention, but a
  quantized V cache is refused without it (`src/llama-context.cpp:4534-4540`). `q8_0-q8_0` is a
  compiled pair (`docs/build_system.md` -> *CUDA build flags*).

## DSpark

- **The drafter that loads is Unsloth's root `dspark-Inkling-2-Mini-Q8_0.gguf`, 503,889,952
  bytes.** It carries `dflash.has_markov_context = true` and the unpadded 200058-row
  `markov_w1`; the 0.40 GB `_Old` file is padded to 201024 rows and fails `check_tensor_dims`.
  On the GPU it costs ~1.3 GB (469 MiB weights, 277 MiB KV at q8_0, 550 MiB compute), more than
  the 262144 entry's margin.
- **At temperature 1.0 every DSpark setting decoded slower than no drafter.** At 131072 x 128,
  q8_0, the mean accepted length on the code probe was 2.71 at `n-max` 3, yet decode fell from
  71.7 to 46.7 t/s; on prose acceptance was 13-30 %. `--spec-draft-sampling probabilistic`, the
  Inkling-specific temperature path, was slower still (23-41 t/s). Speculative decoding on this
  arch rolls back through context checkpoints of the recurrent conv state ("speculative decoding
  will use checkpoints" at load), a cost per draft round that plain decoding never pays.
- **Only greedy code gains.** At temperature 0 and `n-max` 3: code 67.5 -> 83.7 t/s (+24 %,
  acceptance 67 %), prose 66.4 -> 51.0 t/s (-23 %, 27 %). A client that sends temperature 0 for
  code could use it, but the entry's default sampling is the vendor's 1.0.
- **ngram-mod alone gained nothing** on these probes (66.5 / 62.2 / 51.3 t/s against
  71.7 / 68.9 / 53.4), within noise of a loss.

## Sampling and reasoning

- **Use temperature 1.0, top-p 1.0, top-k 0, min-p 0.** The vendor's `generation_config.json`
  sets only temperature 1.0; the rest is Unsloth's recommendation.
- **Reasoning is always on; leave the effort to the template.** `reasoning_effort` maps
  `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` to 0.0-0.99 and the embedded template
  defaults to `high` (0.9). Even 0.0 still thinks. Clients set it per request; the vendor warns
  of reasoning loops, so clients should cap `max_tokens`. Tool calls parse through the
  dedicated Inkling handler: a `get_weather` request returned `finish_reason = tool_calls` with
  arguments `{"city":"Berlin"}`.

## Measurements

Measured 2026-11-25 on the RTX PRO 5000 Blackwell Laptop 24 GB (display on the iGPU), build 12727
(`36d818e`), `Inkling-2-Mini.IQ4_XS.gguf`. Base flags: `parallel` 1, `kv-unified`, `fit = off`,
`n-gpu-layers -1`, `flash-attn = on`, `threads` 24, no projector unless noted. Probes, each
`reasoning_effort` `low`, seed 42: *code* (red-black tree, 1024 tokens), *prose* (essay, 1024
tokens), *long* (48,743-token prompt of this repository's docs, 512 tokens). Speed is the
server's `timings`, one run per arm.

| Arm                 | KV   | Ctx x ubatch  | Free after load MiB | Code tok/s | Prose tok/s | Long prefill tok/s | Long decode tok/s |
| ------------------- | ---- | ------------- | ------------------: | ---------: | ----------: | -----------------: | ----------------: |
| f16 131k ub512      | f16  | 131072 x 512  |       does not load |            |             |                    |                   |
| f16 131k ub256      | f16  | 131072 x 256  |       does not load |            |             |                    |                   |
| f16 131k ub128      | f16  | 131072 x 128  |                1466 |      67.00 |       64.66 |              417.5 |             50.63 |
| f16 65k ub512       | f16  | 65536 x 512   |                 380 |      71.74 |       75.33 |              572.4 |             53.75 |
| f16 65k ub256       | f16  | 65536 x 256   |                3537 |      70.94 |       70.88 |              519.0 |             50.98 |
| q8 131k ub128       | q8_0 | 131072 x 128  |                3536 |      71.66 |       68.88 |              435.6 |             53.42 |
| + projector         | q8_0 | 131072 x 128  |                3119 |      70.02 |             |              489.2 |             53.63 |
| + projector         | q8_0 | 196608 x 128  |                 447 |      73.66 |             |              500.7 |             52.83 |
| + projector, entry  | q8_0 | 262144 x 64   |                 879 |      71.64 |             |              457.3 |             55.63 |

Speculative arms at q8_0, 131072 x 128, draft KV q8_0, temperature 1.0 (acceptance in brackets):

| Arm                          | Free after load MiB | Code tok/s    | Prose tok/s   | Long prefill tok/s | Long decode tok/s |
| ---------------------------- | ------------------: | ------------- | ------------- | -----------------: | ----------------: |
| none                         |                3536 | 71.66         | 68.88         |              435.6 |             53.42 |
| ngram-mod                    |                3456 | 66.54         | 62.19         |              434.5 |             51.28 |
| DSpark `n-max` 2             |                2317 | 64.78 (54 %)  | 54.92 (30 %)  |              355.6 |             35.03 |
| DSpark `n-max` 3             |                2313 | 46.70 (57 %)  | 31.49 (21 %)  |              394.0 |             37.42 |
| DSpark `n-max` 4             |                2298 | 58.95 (37 %)  | 43.62 (19 %)  |              405.1 |             40.32 |
| DSpark `n-max` 5             |                2296 | 51.44 (24 %)  | 39.61 (13 %)  |              442.3 |             40.26 |
| DSpark `n-max` 3 + ngram-mod |                2252 | 69.93 (54 %)  | 47.98 (21 %)  |              465.0 |             40.87 |
| DSpark probabilistic 3       |                2252 | 34.28 (50 %)  | 26.38 (28 %)  |              466.9 |             25.27 |
| DSpark probabilistic 5       |                2246 | 41.21 (66 %)  | 23.48 (18 %)  |              413.5 |             23.69 |

- **The code and prose rows carry reasoning of varying length**, so a single row can swing by
  ~20 % (`n-max` 3 against `n-max` 3 + ngram-mod on code); the sign of the DSpark result holds
  across all seven arms.
- **The entry through the router:** `n_ctx_slot = 262144`, 949 MiB free with the model loaded,
  899 MiB after an image request; the 123-token image prompt prefilled at 180 t/s and the digits
  `7391` were read correctly.

## Not done

- **No 16 GB or dual-GPU entry.** Neither tier's machine was available; the compute-buffer
  arithmetic above is what such an entry would be sized from, and Unsloth's `UD-IQ3_XXS` or
  `UD-Q3_K_XL` the starting quants.
- **Decode at depth beyond 48.7k tokens is unmeasured.** Without flash attention the per-token
  attention cost grows with the filled context.
