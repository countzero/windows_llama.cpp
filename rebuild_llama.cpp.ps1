Write-Host "Downloading ${directory}..." -ForegroundColor "DarkYellow"

git submodule update --remote --merge

Remove-Item  -Path "./vendor/llama.cpp/build" -Force -Recurse

New-Item -Path "./vendor/llama.cpp" -Name "build" -ItemType "directory"

Push-Location -Path "./"

Push-Location -Path "./vendor/llama.cpp/build"

cmake .. -DLLAMA_CUBLAS=ON

cmake --build . --config Release

Push-Location -Path "../"

conda activate llama.cpp

pip install -r ./requirements.txt

Pop-Location
Pop-Location
Pop-Location
