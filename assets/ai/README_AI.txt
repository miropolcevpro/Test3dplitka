AI Ultra assets (Patch 2+)

This project can load ONNX Runtime Web and models from local assets for stability.

Recommended local placement:
- assets/ai/ort/ort.min.js (and matching wasm/mjs files of the SAME onnxruntime-web version)
- assets/ai/models/depth_ultra.onnx

If local ORT is missing, the app will try CDN fallbacks (pinned versions).
If the depth model is missing, the app continues without AI and shows depth errors in state.ai.errors.
