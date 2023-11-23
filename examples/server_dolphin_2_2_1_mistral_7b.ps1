Start-Process "http://127.0.0.1:8080"

../vendor/llama.cpp/build/bin/Release/server `
    --model "../vendor/llama.cpp/models/dolphin-2.2.1-mistral-7b/model-quantized-q4_K_M.gguf" `
    --ctx-size 4096 `
    --threads 6 `
    --n-gpu-layers 32
