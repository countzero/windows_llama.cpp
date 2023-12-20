Start-Process "http://127.0.0.1:8080"

../vendor/llama.cpp/build/bin/Release/server `
    --model "../vendor/llama.cpp/models/SOLAR-10.7B-Instruct-v1.0/model-quantized-q4_K_M.gguf" `
    --ctx-size 4096 `
    --threads 6 `
    --n-gpu-layers 35
