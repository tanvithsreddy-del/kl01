# KL01 Pre Beta

KL01 Pre Beta is a local-first desktop AI chat. Local chats and local inference stay on the device. Research can read public web pages when a request needs current or externally verifiable facts; optional external OpenAI-compatible services are clearly marked because those requests leave the computer.

## First-release scope

- Local llama.cpp-compatible chat and a persistent, processed text/code document library with bounded per-chat retrieval; images, audio, video, and native PDF extraction are not accepted.
- KL01 Pre Beta is entirely unfinished: every feature and output needs independent verification.
- Four bounded effort choices: Instant, Quick, Thorough, and Deep.
- Research with deterministic activation, public-network destination controls, bounded persistence across source failures, exact evidence excerpts, and visible verification limits.
- Deterministic calculator and other local reasoning helpers.
- Chat export, archive, branching, shortening, retry/resume, and privacy-safe diagnostics.
- Generic OpenAI-compatible external service support. There are no provider-specific shortcuts.

This release intentionally does not add cross-chat personal Memory, media understanding, hidden workflow fan-out, telemetry, analytics, or a hosted KL01 service. Uploaded text documents are processed and stored locally for the chats that reference them; legacy workflow records remain readable for compatibility but new chat runs use the bounded sequential path.

## Privacy and network boundaries

- The application and llama.cpp bind to `127.0.0.1`.
- Public Research blocks loopback, private, link-local, multicast, documentation, transition, and nonstandard-port destinations. Redirects are re-authorized.
- Research uses a temporary KL01-owned Chromium profile only when bounded direct reading cannot extract a page; personal browser profiles are never opened.
- Diagnostic reports exclude chat text, prompts, attachment names and contents, page URLs and bodies, credentials, headers, proxy/browser paths, and external-service addresses.
- “Report a bug” downloads that allowlisted diagnostic and opens an email draft. Nothing is sent automatically.

## Model and runtime integrity

The Pre Beta catalogue contains 23 independently curated GGUF choices from pinned Hugging Face revisions. Every download requires its recorded byte size and SHA-256 digest. Native desktop packages use pinned upstream llama.cpp archives whose byte sizes and SHA-256 digests are recorded in `desktop/RUNTIMES.md`.

## Source use

Node.js 20 or 22 is required for the source build:

```text
npm test
npm start
```

On Windows, `KL01.bat` performs the same local startup. User data is stored under `%LOCALAPPDATA%\KL01` by default. `KL01_DATA_DIR` can select an isolated data directory for testing.

## Included in this Pre Beta release

- **AnythingLLM: LOGOS ONLY.** The only AnythingLLM-derived material is attributed MIT-licensed provider/model-maker logo artwork. KL01 contains no AnythingLLM code, runtime, package, database, services, or routing.
- Expanded the catalogue to 23 checksum-pinned models from primary upstream records, with upstream licence links and display-only compatibility/provenance marks.
- Set the packaged Windows interface to a 75% default zoom and added visible controls spanning 50% to 150%.
- Added a guarded local-only Restart AI action for a stuck or failed model process; active responses are never interrupted.
- Added authenticated llama.cpp acquisition and bounded ZIP extraction.
- Added a privacy-safe bug-report flow and persistent Pre Beta labels.
- Added a hardened Electron boundary and desktop lifecycle handling.
- Expanded unit, fault, privacy, live-question, and packaged-app smoke tests.
- Marked the entire KL01 Pre Beta product as unfinished in the badge, welcome screen, effort controls, and release scope; no individual feature is presented as the only unfinished area.
- Normalized composed system instructions before local inference so strict GGUF chat templates remain runnable, and added a one-time final-answer recovery for reasoning-only streams.
- Routed calculation requests with trailing output-format instructions through the deterministic calculator instead of leaving their result to model arithmetic.
- Clarified that local inference stays local while enabled Research can still use public web sources.
- Made attached text source-first: KL01 now selects a bounded local document context for the current request and does not spend automatic web research on a notes-to-plan task.
- Made Web Search explicit as Off, Auto, or On; Off is an absolute no-request setting.
- Added an atomic local document database, bounded chunk processing, per-chat document links, deduplication, persistence across restarts, inferred follow-up retrieval, and cleanup when the final reference is removed.
- Added guarded deterministic recovery for common first-year coding, SQL, arithmetic, and textbook-answer failures.
- Native desktop packages include the matching validated llama.cpp runtime and no GGUF model.

Electron and its build tools are isolated under `desktop/`; the application source package keeps empty root `dependencies` and `devDependencies`.
