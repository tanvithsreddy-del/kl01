KL01 runtime directory

No runtime binary or GGUF model is bundled in the source ZIP.

Windows x64 local inference target:
- llama.cpp release: b10107
- asset: llama-b10107-bin-win-cpu-x64.zip
- expected executable: runtime/llama-server.exe
- keep the DLLs from the official archive beside llama-server.exe

Native desktop packages include the matching verified llama.cpp runtime but never a GGUF model. See desktop/RUNTIMES.md for the pinned Windows, Ubuntu x64, and macOS assets and hashes.
