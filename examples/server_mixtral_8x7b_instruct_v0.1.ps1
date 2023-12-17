Start-Process "http://127.0.0.1:8080"

../vendor/llama.cpp/build/bin/Release/server `
    --model "../vendor/llama.cpp/models/Mixtral-8x7B-Instruct-v0.1/model-quantized-q4_K_M.gguf" `
    --ctx-size 4096 `
    --threads 20 `
    --n-gpu-layers 6
