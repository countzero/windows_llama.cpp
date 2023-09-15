Start-Process "http://127.0.0.1:8080"

# We are increasing the context size of a Llama 2 model from 4096 token
# to 32768 token, which is a ctx_scale of 8.0. The paramters formula is:
#
#     --rope-freq-scale = 1 / ctx_scale
#     --rope-freq-base = 10000 * ctx_scale
#
../vendor/llama.cpp/build/bin/Release/server `
    --model "../vendor/llama.cpp/models/Phind-CodeLlama-34B-v2/model-quantized-q4_K_M.gguf" `
    --ctx-size 16384 `
    --rope-freq-scale 0.125 `
    --rope-freq-base 80000 `
    --threads 16 `
    --n-gpu-layers 10
