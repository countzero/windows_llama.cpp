Start-Process "http://127.0.0.1:8080"

../vendor/llama.cpp/build/bin/Release/server `
    --model "../vendor/llama.cpp/models/falcon-180B-chat/model-quantized-q4_K_M.gguf" `
    --ctx-size 4096 `
    --threads 20 `
    --n-gpu-layers 2
