Start-Process "http://127.0.0.1:8080"

../vendor/llama.cpp/build/bin/Release/server `
    --model "../vendor/llama.cpp/models/Llama-2-70b-instruct-v2/model-quantized-q4_K_M.gguf" `
    --ctx-size 4096 `
    --threads 16 `
    --n-gpu-layers 0
