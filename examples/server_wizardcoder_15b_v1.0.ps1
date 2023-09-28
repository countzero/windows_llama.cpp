Start-Process "http://127.0.0.1:8080"

# CUDA offloading is not yet supported: https://github.com/ggerganov/llama.cpp/pull/3187#issuecomment-1721531644
../vendor/llama.cpp/build/bin/Release/server `
    --model "../vendor/llama.cpp/models/WizardCoder-15B-V1.0/model-quantized-q4_k_M.gguf" `
    --ctx-size 2048 `
    --threads 16 `
    --n-gpu-layers 0
