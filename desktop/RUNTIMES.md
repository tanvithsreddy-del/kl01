# Native llama.cpp runtimes

Desktop packages use the platform-native CPU runtime from the pinned upstream llama.cpp release `b10107`. A release build must set `KL01_RUNTIME_DIR` to an extracted runtime directory whose `llama-server` executable and companion libraries are at its root. Windows may use the repository-local `runtime/` directory after the verified archive has been extracted there.

| Platform | Upstream asset | Bytes | SHA256 |
| --- | --- | ---: | --- |
| Windows x64 | `llama-b10107-bin-win-cpu-x64.zip` | 18,213,827 | `52133a0a5a8f6035b1bdd2f89c3425ea8b742413d9bdb9a2dee30e3a1681b18c` |
| Ubuntu x64 | `llama-b10107-bin-ubuntu-x64.tar.gz` | 16,275,561 | `afe1ae0b706c4a0830b218a9249037b7a6cc723f81deb78825662128b25453e6` |
| macOS Apple Silicon | `llama-b10107-bin-macos-arm64.tar.gz` | 10,804,162 | `b9554ab4c9f6e91199f48387cb4ab27466fb1d724881f81463ef03f6370cfa32` |
| macOS Intel | `llama-b10107-bin-macos-x64.tar.gz` | 11,075,592 | `6f35c90a6e9f33c905d09694946b82a29b4ab530a358226d95d832262f526ea2` |

Assets come from `https://github.com/ggml-org/llama.cpp/releases/tag/b10107`. Verify both exact byte size and SHA256 before extraction. GGUF models are never part of a desktop package.

Build commands are run from `desktop/`:

```text
npm run pack:win
KL01_RUNTIME_DIR=/absolute/linux/runtime npm run pack:linux
KL01_RUNTIME_DIR=/absolute/macos/runtime npm run pack:mac
```

macOS artifacts must be built and validated on macOS. Linux artifacts must be executed on Linux before being called validated.
