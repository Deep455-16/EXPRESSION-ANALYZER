# 🏗 Architecture — Expression Analyzer

This document describes how the system is put together end to end: the two parallel analysis paths (client-side and backend), the exact models each one runs, how a frame flows through the pipeline, and how the new calibration and feature layers slot in.

---

## 1. High-Level Overview

The analyzer is a **hybrid client/backend system** — it always works with zero setup (pure browser, no server), and transparently gets more accurate when a Python backend is reachable.

```
┌─────────────────────────────────────────────────────────────────────┐
│                              BROWSER                                 │
│                                                                       │
│   Webcam / Upload ──▶ face-engine.js ──▶ decides path per frame      │
│                              │                                       │
│              ┌───────────────┴────────────────┐                     │
│              ▼                                 ▼                     │
│     CLIENT-SIDE PATH                   BACKEND PATH (preferred)      │
│     (face-api.js, in-browser)          (HTTP → Flask backend)        │
│              │                                 │                     │
│              ▼                                 ▼                     │
│     TinyFaceDetector (detect face)     YOLOv8n (detect person)       │
│              │                                 │                     │
│              ▼                                 ▼                     │
│     faceExpressionNet (emotion)        head-region crop → DeepFace   │
│              │                                 │                     │
│              └────────────────┬────────────────┘                     │
│                                ▼                                     │
│                     Score Smoothing (temperature scaling + floor)     │
│                                ▼                                     │
│                     Temporal Smoothing (EMA across recent frames)     │
│                                ▼                                     │
│                UI: live.js / upload.js / dashboard.js                │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ (backend path only)
                        MongoDB Atlas (persistence:
                        sessions, per-frame history,
                        FER2013 reference distribution)
```

Both paths return results in the **same JSON shape**, so the rest of the app (UI, dashboard, history) doesn't need to know which one produced a given result — it only reads a `source` / `method` / `detector` tag to display where the number came from.

---

## 2. The Two Analysis Paths

### 2.1 Client-side path — `scripts/face-engine.js`

Runs entirely in the browser via **[face-api.js](https://github.com/vladmandic/face-api)** (TensorFlow.js), loaded from a CDN. No data ever leaves the device on this path.

| Stage | Model | What it does | How |
|---|---|---|---|
| Face detection | **TinyFaceDetector** | Locates face bounding boxes in a frame | A lightweight, mobile-oriented single-shot detector (MobileNetV1-style depthwise-separable convolutions). Configured with `inputSize: 416`, `scoreThreshold: 0.4` — trades some accuracy for real-time speed in-browser. |
| Expression recognition | **faceExpressionNet** | Classifies the detected face into 7 emotions | A small CNN classification head trained on facial-expression data, run on the cropped/aligned face region. Outputs a **softmax vector** over `neutral, happy, sad, angry, fearful, disgusted, surprised`. |

This is the **fallback path** (`_analyzeLocally`) and also the **primary path** for anything the backend doesn't need to touch, e.g. re-detecting on every animation frame during live video.

### 2.2 Backend path — `backend.py`

A **Flask + Flask-SocketIO** server (`EmotiScan`) that trades browser portability for higher-accuracy, server-grade models and persistence.

| Stage | Model | What it does | How |
|---|---|---|---|
| Face/person detection | **YOLOv8n** (`ultralytics`, `yolov8n.pt`) | Detects people in the frame | YOLOv8's nano variant — a single-stage, anchor-free CNN detector. Run with `classes=[0]` (COCO "person" class — there is no dedicated "face" class in stock COCO weights), confidence threshold `0.45`. |
| Head-region extraction | Heuristic crop (not a model) | Approximates the face from the person box | Since YOLO here detects the *whole person*, the code crops the **top 60% of box height** (hairline → below the chin) and insets **15% off each side** width-wise (drops shoulders). This was widened from an earlier 42%-height crop that was accidentally excluding the mouth/chin — the single most informative region for happy/neutral/disgusted. |
| Fallback face detection | **Haar Cascade** (OpenCV, `haarcascade_frontalface_default.xml`) | Backup detector if YOLO is unavailable/fails | Classic Viola-Jones cascade classifier — fast, CPU-only, less accurate than YOLO/deep detectors but has no ML dependency risk. |
| Expression recognition | **DeepFace** (`deepface==0.0.93`) → its bundled **FER CNN** | Classifies the cropped head region into 7 emotions | DeepFace's `analyze(actions=["emotion"])` runs its internal Keras CNN (trained on FER2013-style grayscale 48×48 face crops) and returns a softmax distribution, re-mapped from DeepFace's native labels (`disgust→disgusted`, `fear→fearful`, `surprise→surprised`, etc.) to this app's canonical label set. `detector_backend="skip"` is used since face detection/cropping is already handled upstream by YOLO/Haar. |
| Persistence | **MongoDB Atlas** (`pymongo`) | Stores sessions, per-frame results, and the FER2013 label distribution | Used for: session upsert/finalization, async per-frame history writes, and loading the FER2013 class-frequency table that seeds the mock/fallback emotion generator. |

The backend is contacted over `POST /api/analyze` (base64 JPEG frame in, JSON result out) and is preferred by the client whenever `/health` reports it reachable (`_backendOk`).

---

## 3. Why Two Paths Instead of One

| | Client-side (face-api.js) | Backend (YOLO + DeepFace) |
|---|---|---|
| Setup | Zero — works by opening `index.html` | Needs Python + `pip install -r requirements.txt` running |
| Privacy | Frame never leaves the device | Frame is sent to the backend over HTTP |
| Accuracy | Good, real-time, browser-constrained models | Higher-capacity models, generally more accurate |
| Persistence/history | None (in-memory only) | MongoDB-backed session/participant history |
| Offline support | ✅ Works fully offline after model load | ❌ Needs the backend process running |

`face-engine.js` treats the backend as an *enhancement*, not a requirement — `analyze()` tries the backend first only if `preferBackend` is set and `_backendOk`, and transparently falls back to the local path (and finally to a `_mockResult()` if even the local model fails to load) so the app never hard-fails.

---

## 4. Score Calibration Layer (applied to both paths)

Both `faceExpressionNet` and DeepFace's FER CNN are **softmax classifiers trained with hard one-hot labels**, which makes them chronically overconfident — a genuinely ambiguous expression can still come out as `happy: 0.999, everything else: ~0.0001`. This is a well-known property of that style of model, not a data or detection bug.

To correct for this, every raw score vector — from face-api.js, from DeepFace, and from the FER2013-weighted mock generator — passes through the same smoothing step before it's returned:

```
raw softmax scores
      │
      ▼
normalize → sum to 1
      │
      ▼
temperature scaling:  p_i^(1/T)   (T ≈ 2.0, monotonic — argmax never changes)
      │
      ▼
renormalize → sum to 1
      │
      ▼
apply floor (≈0.008 per class) so nothing displays as a hard 0%
      │
      ▼
renormalize + round → final displayed scores
```

Because temperature scaling is a **monotonic transform**, the *dominant emotion never changes* — only the displayed spread becomes realistic (e.g. `happy 62% · neutral 15% · surprised 10% · sad 6% · angry 4% · disgusted 2% · fearful 1%` instead of `happy 100%`, others `0%`).

An offline calibration script replays the bundled `dataset/fer2013/test/` images through `predict_emotion()` across a range of `temperature` values and reports a reliability diagram + Brier score, so `T` is chosen from data rather than guessed.

---

## 5. Temporal Smoothing (live sessions only)

Per-frame results (from either path) can still flicker between adjacent emotions even after calibration, since each frame is scored independently. For live webcam sessions, `live.js` keeps a rolling buffer (last ~8 frames) of `scores` **per participant_id**, and computes an **exponential moving average** (α ≈ 0.3) across that buffer. The raw per-frame result and the smoothed result are both available (`smoothed_scores` / `smoothed_emotion`), with the UI defaulting to the smoothed version for display. The buffer resets whenever a participant's face is lost for >2 seconds, so it never blends across two different people.

---

## 6. Face Detection Method Transparency

Because there are three possible sources for any given result (backend/YOLO+DeepFace, client/face-api.js, or the mock fallback) and two possible face-detection methods on the backend (YOLO or Haar), every result carries tags identifying its provenance:

- `source`: `"backend" | "client" | "mock"`
- `face_emotions[i].method`: `"yolo" | "face-api" | "mock"`
- `face_emotions[i].detector` *(new)*: which detector actually produced that face's bounding box

The UI surfaces these as small badges so a user can tell, at a glance, whether they're looking at a high-confidence backend result or a client-side/mock fallback — rather than trusting every number equally.

---

## 7. Data Flow Summary (single frame, backend path)

1. Browser captures a video frame → canvas → base64 JPEG.
2. `POST /api/analyze` sends the frame to Flask.
3. `detect_faces(frame, method="yolo")` runs YOLOv8n; on failure/empty, falls back to Haar.
4. For each detected person box, the head-region heuristic crop is extracted.
5. `predict_emotion(crop)` runs DeepFace's FER CNN → raw softmax scores.
6. `_smooth_scores()` applies temperature scaling + floor to the raw scores.
7. Result is optionally persisted to MongoDB (async, non-blocking) and returned as JSON.
8. Client applies EMA temporal smoothing (if in a live session) and renders via `live.js` / `dashboard.js`.

---

## 8. Key Files

| File | Role |
|---|---|
| `backend.py` | Flask server: face detection (YOLO/Haar), DeepFace emotion inference, score smoothing, MongoDB persistence, REST + Socket.IO endpoints |
| `backend_connectivity.py` | MongoDB connection setup and FER2013 dataset loading |
| `scripts/face-engine.js` | Client-side face-api.js pipeline, backend-call wrapper, score smoothing, mock fallback |
| `scripts/live.js` | Live webcam loop, per-participant temporal smoothing (EMA) |
| `scripts/upload.js` | Image/video file analysis flow |
| `scripts/dashboard.js` | Session stats rendering + emotion trend timeline |
| `dataset/fer2013/` | Reference dataset — seeds the mock generator's class distribution and powers the offline calibration script |