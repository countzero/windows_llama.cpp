../vendor/llama.cpp/build/bin/Release/llava `
    --model "../vendor/llama.cpp/models/llava-v1.5-7b/ggml-model-q5_k.gguf" `
    --mmproj "../vendor/llama.cpp/models/llava-v1.5-7b/mmproj-model-f16.gguf" `
    --image "../images/the_ocean_race_flyby_kiel.jpg" `
    --temp 0.1 `
    --prompt  "Explain the image. Where could it be?" `
    --threads 16 `
    --n-gpu-layers 35
