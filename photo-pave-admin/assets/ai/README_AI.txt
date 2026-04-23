AI Ultra assets (Patch 2+)

Goal: run premium CV/ML fully on-device. Depth is computed once after photo load and cached.

1) ONNX Runtime Web (ORT) placement (recommended: local, same-version bundle)
Place these files under:
  assets/ai/ort/

Minimum for stable operation:
  - ort.all.min.js  (or ort.min.js, but "all" is recommended)

If you want ORT to run in WASM mode reliably (fallback), also include the matching WASM loader artifacts from the SAME onnxruntime-web version:
  - ort-wasm-simd-threaded.mjs
  - ort-wasm-simd-threaded.wasm
  - ort-wasm-simd-threaded.jsep.mjs
  - ort-wasm-simd-threaded.jsep.wasm
  - (optional but safest) ort-wasm-simd-threaded.asyncify.mjs / .wasm

Important: ORT JS and WASM must be from the SAME build/version, otherwise it will fail to initialize. See ONNX Runtime Web docs (env.wasm.wasmPaths). 

If local ORT is missing, the app will load ORT from pinned CDN URLs and set wasmPaths to the same CDN dist folder.

2) Depth model placement
Place the depth model here:
  assets/ai/models/depth_ultra.onnx

Recommended: export a single-file ONNX (no external data).
If your ONNX uses external data (extra *.data files), either:
  - re-export as a single ONNX, or
  - place the required external data files next to the ONNX (same folder) and keep file names identical.

3) Verification
Open the app, enable "Улучшенный реализм (Ultra)", load a photo.
In the AI status row you should see:
  AI: ready • ... • depth

If the model is missing, status will be ready without "depth" and state.ai.depthStatus="missing_model".
