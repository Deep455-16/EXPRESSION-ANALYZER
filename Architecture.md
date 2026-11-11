# 🏗 Architecture

How Expression Analyzer is put together: the two analysis paths, the models each runs, how one frame flows through the system, and why the design looks the way it does.

**Contents:** [Overview](#1-overview) · [Components](#2-components) · [Models](#3-models) · [Frame flow](#4-frame-flow) · [Calibration](#5-score-calibration) · [Temporal smoothing](#6-temporal-smoothing) · [Storage](#7-storage) · [API](#8-api-surface) · [Decisions](#9-design-decisions) · [Limits](#10-known-limitations) · [Files](#11-key-files)

---

## 1. Overview

The system is **hybrid**. It always works with zero setup in the browser, and it gets more accurate when a Python backend is reachable.

<div align="center">
<img src="docs/images/architecture.png" alt="Hybrid architecture" width="680">
</div>

Both paths produce the **same JSON shape** (`label`, `confidence`, `scores`, plus provenance tags). The UI, dashboard and storage layers never branch on which path ran.

---

## 2. Components

| Layer | Component | Responsibility |
|---|---|---|
| Capture | `live.js`, `upload.js`, `webrtc.js` | Grab frames from webcam, files, or remote WebRTC peers |
| Orchestration | `face-engine.js` | Choose backend or client per frame, fall back on failure, apply calibration |
| Client inference | face-api.js | TinyFaceDetector, faceExpressionNet, running in-browser via TensorFlow.js |
| Server inference | `backend.py` (Flask) | YOLOv8n detection, Haar fallback, DeepFace emotion, calibration, persistence |
| Smoothing | `live.js` | Per-participant exponential moving average |
| Presentation | `live.js`, `dashboard.js` | Overlays, KPIs, trend charts, source badges |
| Local storage | `main.js` | IndexedDB (`EmotiDB`), `localStorage` settings, CSV/JSON export |
| Server storage | `backend_connectivity.py` | MongoDB sessions, per-frame metadata, FER2013 reference distribution |

---

## 3. Models

### 3.1 Client path (in browser)

| Stage | Model | Notes |
|---|---|---|
| Face detection | **TinyFaceDetector** | Lightweight single-shot detector built for real-time browser use. `inputSize: 416`, `scoreThreshold: 0.4`. |
| Expression recognition | **faceExpressionNet** | Small CNN head. Outputs a softmax over `neutral, happy, sad, angry, fearful, disgusted, surprised`. |

Nothing leaves the device on this path. The only network traffic is fetching model weights from a CDN.

### 3.2 Backend path (Flask)

| Stage | Model | Notes |
|---|---|---|
| Detection | **YOLOv8n** (`yolov8n.pt`) | Run with `classes=[0]`. That is the COCO **person** class, because stock COCO has no face class. Confidence threshold 0.45. |
| Head region | Heuristic crop | The person box is cut to the **top 60% of its height** and inset **15% per side**, which keeps hairline to chin and drops shoulders. |
| Fallback detection | **Haar Cascade** | OpenCV `haarcascade_frontalface_default.xml`. CPU-only, used when YOLO is unavailable or finds nothing. |
| Emotion | **DeepFace** FER CNN | `analyze(actions=["emotion"])` with `detector_backend="skip"`, since detection and cropping are already done. Labels are remapped (`disgust→disgusted`, `fear→fearful`, `surprise→surprised`). |

> **Why the crop matters.** YOLO detects a whole *person*, so the face region is inferred. An earlier crop of the top 42% cut off the mouth for most poses. The mouth is the single most informative region for separating happy, neutral and disgusted, so the crop was widened.

### 3.3 Why two paths

| | Client | Backend |
|---|---|---|
| Setup | None | Python and dependencies |
| Privacy | Frames stay on device | Frames go to your server |
| Accuracy | Good, browser-constrained | Higher-capacity models |
| History | Local only | MongoDB-backed |
| Offline | ✅ | ❌ |

`face-engine.js` treats the backend as an **enhancement**. If `/health` fails, it uses the client model, and if that cannot load it returns a labelled mock result, so the app never hard-fails.

---

## 4. Frame Flow

<div align="center">
<img src="docs/images/sequence.png" alt="Single-frame sequence" width="860">
</div>

1. The browser captures a frame to a canvas and encodes it as a base64 JPEG.
2. `POST /api/analyze` sends it to Flask.
3. YOLOv8n finds people. If it fails or finds none, Haar runs instead.
4. Each box is cropped to the head region.
5. DeepFace returns raw softmax scores for each crop.
6. Calibration is applied (section 5).
7. Scores, boxes and timestamps are persisted asynchronously. **The frame itself is not.**
8. The JSON result returns to the browser, which applies EMA smoothing and renders.

---

## 5. Score Calibration

Both emotion models are softmax classifiers trained on one-hot labels, so they are **overconfident by construction**. A moderately happy face can come out as `happy 99.6%`, everything else near zero.

<div align="center">
<img src="docs/images/calibration.png" alt="Before and after calibration" width="900">
</div>

```
raw softmax → normalise → p^(1/T) → renormalise → floor → renormalise → round
```

| Step | Why |
|---|---|
| `p^(1/T)` | Temperature scaling. Monotonic, so the argmax never changes. |
| Floor (about 0.8%) | No class ever displays as a flat `0%`. |
| Renormalise | Scores always sum to 100%. |

**Choosing T.** `T = 2.0` is mild (99.6% → about 88%). `T = 3.0` is softer (→ about 69%). The right value depends on how overconfident your model actually is, so the offline calibration script replays `dataset/fer2013/test/` through the pipeline and reports a reliability diagram and Brier score across a range of `T`. Pick from that data rather than by eye.

> Calibration changes how *confident* the display looks. It does not make the model more *accurate*, and it cannot fix a wrong dominant emotion.

---

## 6. Temporal Smoothing

Frames are scored independently, so labels can flicker between neighbours even after calibration. In live sessions, `live.js` keeps a rolling buffer (about 8 frames) of score dictionaries **per participant** and computes an exponential moving average (α ≈ 0.3).

- Both the raw and the smoothed result are available (`scores` vs `smoothed_scores`). The UI shows the smoothed one by default.
- The buffer resets when a participant's face has been absent for more than about 2 seconds, so history never bleeds between two people.

---

## 7. Storage

| Store | Where | Holds | Never holds |
|---|---|---|---|
| `EmotiDB` (IndexedDB) | User's browser | Session summaries, per-frame scores | Images |
| `localStorage` | User's browser | Settings | Images |
| MongoDB | Your server | Sessions, per-frame scores, boxes, timestamps, participant IDs | Images (`annotated_frame` is stripped before write and excluded from reads) |

---

## 8. API Surface

| Route | Purpose |
|---|---|
| `GET /health` | Lets the client decide whether the backend is usable |
| `POST /api/analyze` | Base64 frame in, emotion JSON out |
| `GET /api/history` | Stored per-frame metadata (no imagery) |
| Socket.IO `frame` | Streaming variant of analyze for live sessions |

Response fields: `label`, `confidence`, `scores`, `face_emotions[]` (each with `bbox`, `method`), and the provenance tags `source` and `method`.

---

## 9. Design Decisions

| Decision | Reasoning |
|---|---|
| Hybrid client and backend | Zero-setup demos and privacy by default, with an accuracy upgrade path |
| Same JSON from both paths | UI and storage stay path-agnostic |
| Calibrate after inference, not by retraining | Cheap, reversible, and keeps the model's ranking intact |
| Show provenance badges | Users should know when they are looking at a fallback or mock result |
| Strip images before persistence | Only derived numbers have any reason to outlive a request |
| EMA over a rolling window | Stable labels without the latency of a heavy sequence model |

---

## 10. Known Limitations

- **Person detector, not face detector.** The backend infers the face from a person box, so unusual poses (leaning, partial occlusion) can crop poorly. A dedicated face detector would be more robust.
- **Two detectors disagree.** Client and backend use different detectors and models, so they can report different emotions for the same frame. The source badge exists for this reason.
- **FER2013-class accuracy ceiling.** These models are trained on small, noisy, posed or acted data. Treat output as a signal, not ground truth about feelings.
- **Expression is not emotion.** A neutral face is not a neutral mood, and cultural and individual differences are large.
- **Calibration is global.** One `T` for every face and lighting condition. It is a pragmatic correction, not per-user calibration.

---

## 11. Key Files

| File | Role |
|---|---|
| `backend.py` | Flask server, detection, DeepFace, calibration, persistence, routes |
| `backend_connectivity.py` | MongoDB setup and FER2013 loading |
| `scripts/face-engine.js` | Path selection, face-api.js pipeline, calibration, mock fallback |
| `scripts/live.js` | Live loop, per-participant EMA |
| `scripts/webrtc.js` | Remote participant streams |
| `scripts/upload.js` | File queue and video sampling |
| `scripts/dashboard.js` | KPIs and trend charts |
| `scripts/main.js` | Settings manager, IndexedDB, export |
