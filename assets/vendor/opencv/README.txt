Local OpenCV.js (recommended)

Purpose:
- Auto-calibration (vanishing point / horizon) uses OpenCV.js.
- To avoid CDN/network instability in Tilda iframe, ship OpenCV locally.

What to add:
- Place a SINGLE-FILE build (WASM embedded) at:
  assets/vendor/opencv/opencv.js

Where to get it (official):
- https://docs.opencv.org/4.x/opencv.js

Notes:
- Single-file build does NOT require opencv_js.wasm.
- Keep the file name exactly "opencv.js".
