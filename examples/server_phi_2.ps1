Start-Process "http://127.0.0.1:8080"

../vendor/llama.cpp/build/bin/Release/server `
    --model "../vendor/llama.cpp/models/Phi-2/model-quantized-q8_0.gguf" `
    --ctx-size 4096 `
    --threads 16 `
    --n-gpu-layers 33
