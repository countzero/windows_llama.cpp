Start-Process "http://127.0.0.1:8080"

# Until llama.cpp supports the conversion of the original models
# from the Pytorch format to GGUF we have to use the following:
#
#     https://huggingface.co/mys/ggml_llava-v1.5-7b
#     https://huggingface.co/mys/ggml_llava-v1.5-13b
#
# @see https://llava-vl.github.io/
# @see https://huggingface.co/liuhaotian/llava-v1.5-7b
# @see https://huggingface.co/liuhaotian/llava-v1.5-13b
#
../vendor/llama.cpp/build/bin/Release/server `
    --model "../vendor/llama.cpp/models/llava-v1.5-7b/ggml-model-q4_k.gguf" `
    --mmproj "../vendor/llama.cpp/models/llava-v1.5-7b/mmproj-model-f16.gguf" `
    --ctx-size 4096 `
    --threads 6 `
    --n-gpu-layers 35
