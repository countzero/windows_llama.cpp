Start-Process "http://127.0.0.1:8080"

../vendor/llama.cpp/build/bin/Release/server `
    --model "../vendor/llama.cpp/models/llava-v1.5-7b/ggml-model-q5_k.gguf" `
    --mmproj "../vendor/llama.cpp/models/llava-v1.5-7b/mmproj-model-f16.gguf" `
    --ctx-size 4096 `
    --threads 16 `
    --n-gpu-layers 35
