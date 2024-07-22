./vendor/llama.cpp/build/bin/Release/llama-bench `
--model ./vendor/llama.cpp/models/Phi-3-mini-128k-instruct.Q4_K_S.gguf `
--model ./vendor/llama.cpp/models/Phi-3-mini-128k-instruct.Q4_K_M.gguf `
--model ./vendor/llama.cpp/models/Phi-3-mini-128k-instruct.IQ3_XXS.gguf `
--model ./vendor/llama.cpp/models/Phi-3-mini-128k-instruct.IQ3_XS.gguf `
--model ./vendor/llama.cpp/models/Phi-3-mini-128k-instruct.IQ3_S.gguf `
--model ./vendor/llama.cpp/models/Phi-3-mini-128k-instruct.IQ3_M.gguf `
--model ./vendor/llama.cpp/models/Phi-3-mini-128k-instruct.IQ4_XS.gguf `
--model ./vendor/llama.cpp/models/Phi-3-mini-128k-instruct.IQ4_NL.gguf `
--model ./vendor/llama.cpp/models/Phi-3-mini-128k-instruct.Q3_K_S.gguf `
--model ./vendor/llama.cpp/models/Phi-3-mini-128k-instruct.Q3_K_L.gguf `
--model ./vendor/llama.cpp/models/Phi-3-mini-128k-instruct.Q3_K_M.gguf `
--n-prompt 0 `
--n-gen 128 `
--threads 6 `
--n-gpu-layers 999 `
--flash-attn 1
