<div align="center">

# 🎭 Expression Analyzer

**Real-time, multi-participant facial expression analysis for online meetings.**
Runs fully in your browser, with an optional Python backend for higher accuracy.

[![Live Demo](https://img.shields.io/badge/Live_Demo-open-6366f1?style=for-the-badge)](https://deep455-16.github.io/EXPRESSION-ANALYZER/)
![JavaScript](https://img.shields.io/badge/JavaScript-face--api.js-f7df1e?style=flat-square&logo=javascript&logoColor=black)
![Python](https://img.shields.io/badge/Python-Flask-3776ab?style=flat-square&logo=python&logoColor=white)
![YOLOv8](https://img.shields.io/badge/YOLOv8n-detection-00b894?style=flat-square)
![DeepFace](https://img.shields.io/badge/DeepFace-emotion-8b5cf6?style=flat-square)
![MongoDB](https://img.shields.io/badge/MongoDB-optional-47a248?style=flat-square&logo=mongodb&logoColor=white)
![Privacy](https://img.shields.io/badge/Privacy-no_frames_stored-16a34a?style=flat-square)

[Features](#-features) · [Architecture](#-architecture-at-a-glance) · [Quick Start](#-quick-start) · [Calibration](#-calibrated-confidence-scores) · [Privacy](#-privacy-and-security) · [Docs](#-documentation)

</div>

---

## 💡 Why this exists

Online meetings hide emotional signals. This tool reads facial expressions from each participant's video, turns them into live engagement analytics, and keeps the raw faces private while doing it.

| | |
|---|---|
| 🎯 **Realistic scores** | Confidence is calibrated, so a smile is never reported as `100%` with everything else at `0%`. |
| 🔒 **Private by default** | In browser-only mode, no frame ever leaves your device. |
| 🧩 **Works anywhere** | Open `index.html` and it works. Add the backend later for more accuracy. |
| 👥 **Multi-participant** | Each peer's stream is tracked and smoothed independently. |

---

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### 🎥 Live Analysis
- Real-time webcam emotion detection
- **Multi-participant** support over WebRTC
- **EMA temporal smoothing** per participant, so labels stop flickering
- Face-box overlay with label and confidence
- Session summary on stop: dominant emotion, frame count, duration

</td>
<td width="50%" valign="top">

### 📤 Upload and File Analysis
- Drag-and-drop **images and videos**
- Videos sampled at intervals, then aggregated
- Queue-based processing with per-item status
- Annotated output with boxes and labels

</td>
</tr>
<tr>
<td valign="top">

### 📊 Dashboard
- Merges local **IndexedDB** and backend **MongoDB** history
- KPI cards: sessions, frames, average confidence, accuracy
- **Emotion trend timeline** across a session
- Export to **CSV or JSON**

</td>
<td valign="top">

### ⚙️ Settings
- **General**: theme, accent colour, language, notifications
- **Analysis**: sampling rate, confidence threshold, sensitivity
- **Camera**: device, resolution, FPS, mirror, overlay
- **Export** and **Privacy** (auto-clear, retention)

</td>
</tr>
<tr>
<td valign="top">

### 🔀 Dual Analysis Engine
- **Client**: face-api.js in the browser, offline-capable
- **Backend**: YOLOv8n and DeepFace over Flask
- Auto-prefers the backend via `/health`, falls back to client, then to a safe mock
- Every result carries a **source badge** (`backend` / `client` / `mock`)

</td>
<td valign="top">

### 💾 Data and Persistence
- **IndexedDB (`EmotiDB`)** for local sessions
- **MongoDB Atlas** for backend history (scores only)
- Dashboard works with no backend running
- No facial imagery is persisted anywhere

</td>
</tr>
</table>

---

## 🏗 Architecture at a Glance


```mermaid
flowchart TB
    IN["Webcam or file upload"] --> ENG["face-engine.js<br/>picks a path per frame"]

    subgraph CLIENT["CLIENT PATH - in browser, offline-capable"]
        TF["TinyFaceDetector<br/>face-api.js"] --> EN["faceExpressionNet<br/>7-class softmax"]
    end

    subgraph BACKEND["BACKEND PATH - optional, Flask"]
        API["POST /api/analyze<br/>base64 JPEG in"] --> YOLO["YOLOv8n<br/>person detection"]
        YOLO --> CROP["Head-region crop<br/>top 60% height, 15% side inset"]
        YOLO -. on failure .-> HAAR["Haar Cascade<br/>fallback detector"]
        HAAR -.-> CROP
        CROP --> DF["DeepFace<br/>FER CNN, 7-class softmax"]
        DF -. async .-> MDB[("MongoDB<br/>scores + boxes only, no images")]
    end

    ENG -->|local| TF
    ENG -->|if /health ok| API
    EN --> CAL["Score calibration<br/>temperature scaling + floor"]
    DF --> CAL
    CAL --> EMA["Temporal smoothing<br/>EMA per participant"]
    EMA --> UI["Live / Upload / Dashboard<br/>with source badges"]
    UI <-.-> IDB[("IndexedDB<br/>local only")]

    classDef client fill:#eef2ff,stroke:#6366f1,color:#1e1b4b
    classDef server fill:#ecfdf5,stroke:#059669,color:#064e3b
    classDef tune fill:#fef9c3,stroke:#ca8a04,color:#713f12
    classDef out fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef store fill:#f1f5f9,stroke:#64748b,color:#1e293b
    class TF,EN,ENG,IN client
    class API,YOLO,CROP,HAAR,DF server
    class CAL,EMA tune
    class UI out
    class MDB,IDB store
```


Both paths return the **same JSON shape**, so the UI never needs to know which one produced a result. It only reads the `source` and `method` tags to show a badge.

<details>
<summary><b>📈 Single-frame request flow (backend path)</b></summary>
<br>

```mermaid
sequenceDiagram
    autonumber
    participant UI as Browser UI (live.js)
    participant FE as face-engine.js
    participant API as Flask backend
    participant DET as YOLO / Haar
    participant DF as DeepFace
    participant DB as MongoDB

    UI->>FE: capture frame (canvas)
    FE->>API: POST /api/analyze (base64 JPEG)
    API->>DET: detect person / face
    DET-->>API: boxes + head-region crops
    API->>DF: predict_emotion(crop)
    DF-->>API: raw softmax scores
    Note over API: temperature scale + floor
    API-)DB: persist scores + bbox (async, no image)
    API-->>FE: JSON: label, confidence, scores
    Note over FE: EMA smoothing per participant
    FE-->>UI: render overlay + source badge
```

</details>

### Models used

| Stage | Client path | Backend path |
|---|---|---|
| Detection | TinyFaceDetector (face-api.js) | YOLOv8n person detector, Haar Cascade fallback |
| Face region | Detector box | Head crop: top 60% of box height, 15% side inset |
| Emotion | faceExpressionNet | DeepFace FER CNN |
| Output | 7-class softmax | 7-class softmax |

Full detail lives in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## 🎯 Calibrated Confidence Scores

Both emotion models are softmax classifiers trained on hard labels, which makes them overconfident. A single smile can come out as `happy 99.6%` with every other class near zero. Scores here go through **temperature scaling plus a probability floor** before display. The ranking never changes, so the dominant emotion is always the one the model chose. Only the spread becomes realistic.


| Emotion | Raw model output | After T = 2.0 | After T = 3.0 |
|---|---|---|---|
| happy | `████████████████████████` 99.6% | `█████████████████████` 88.5% | `█████████████████` 69.0% |
| neutral | `▏` 0.2% | `█` 4.1% | `██` 8.8% |
| surprised | `▏` 0.1% | `█` 2.7% | `██` 6.7% |
| sad | `▏` 0.0% | `▏` 1.8% | `█` 5.1% |
| angry | `▏` 0.0% | `▏` 1.3% | `█` 4.0% |
| disgusted | `▏` 0.0% | `▏` 0.9% | `█` 3.2% |
| fearful | `▏` 0.0% | `▏` 0.9% | `█` 3.2% |

<sub>Illustrative example: one saturated softmax vector run through the actual smoothing math (floor 0.8%). Not a measured benchmark.</sub>


1. Normalise raw probabilities.
2. Raise each to `1/T` (temperature scaling, a monotonic transform).
3. Renormalise, then apply a small floor so nothing shows a flat `0%`.
4. Round for display.

> **Tuning:** `T = 2.0` is a mild default. For very saturated outputs, `T = 3.0` spreads them further. An offline script checks calibration against the bundled FER2013 test set, so you can pick `T` from data.

The face crop was also corrected to keep the **mouth and chin in frame**, since that region matters most for telling happy, neutral and disgusted apart.

---

## 🚀 Quick Start

<table>
<tr><td>

**Python**
```bash
python3 -m http.server 8000
```

</td><td>

**Node.js**
```bash
npx http-server -p 8000
```

</td><td>

**Direct**
Double-click `index.html`

</td></tr>
</table>

Then open `http://localhost:8000`.

### Optional: enable the backend

```bash
pip install -r requirements.txt
cp .env.example .env          # set MONGO_URI (optional)
python3 backend.py
```

The frontend detects the backend automatically and falls back to client-side analysis if it is unreachable.

**Requirements:** a modern browser, a webcam for live mode, and Python 3.8+ only if you use the backend.

---

<!--
📸 SCREENSHOTS
Capture your running app and save the images into docs/images/, then
delete these comment markers to show them:

## 🖼 Screenshots
| Live Analysis | Dashboard |
|---|---|
| ![Live](docs/images/screenshot-live.png) | ![Dashboard](docs/images/screenshot-dashboard.png) |
| Upload | Settings |
| ![Upload](docs/images/screenshot-upload.png) | ![Settings](docs/images/screenshot-settings.png) |
-->

## 🔒 Privacy and Security


```mermaid
flowchart LR
    subgraph DEVICE["USER'S DEVICE - trusted"]
        CAM["Webcam frame<br/>in memory"] --> LOCAL["face-api.js analysis<br/>no network call"]
        LOCAL -->|numbers only| IDB[("IndexedDB<br/>scores only, auto-clear")]
    end

    subgraph SERVER["YOUR BACKEND - opt-in, you control it"]
        API["Flask /api/analyze<br/>frame held in RAM"] --> DROP["Frame discarded<br/>after inference"]
    end

    subgraph DBX["DATABASE - credentials via env"]
        MDB[("MongoDB<br/>scores, boxes, timestamps")]
    end

    CAM -->|"opt-in only, base64 JPEG"| API
    API -->|"annotated_frame stripped first"| MDB
    LOCAL -. blocked .-x TP["Third-party servers<br/>never receive frames"]

    classDef ok fill:#ecfdf5,stroke:#16a34a,color:#14532d
    classDef warn fill:#fffbeb,stroke:#d97706,color:#78350f
    classDef bad fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    class CAM,LOCAL,IDB ok
    class API,DROP warn
    class TP bad
```


- **Browser-only mode:** analysis is on-device with no network call carrying a frame.
- **Backend mode (opt-in):** frames are decoded in memory, used once, and discarded. Only scores, boxes and timestamps are stored.
- **No imagery in the database:** the annotated preview is stripped before anything is persisted.
- **Secrets:** `MONGO_URI` comes from the environment, and `.env` is git-ignored.
- **You control retention:** auto-clear and retention window live in Settings.

Before exposing the backend beyond localhost, read the hardening checklist in **[SECURITY.md](SECURITY.md)**. It covers CORS, authentication and TLS.

---

## 📁 Project Structure

```
EXPRESSION-ANALYZER/
├── index.html · live.html · upload.html · dashboard.html · settings.html
├── backend.py                 Flask API: detection, DeepFace, calibration, MongoDB
├── backend_connectivity.py    MongoDB connection and FER2013 loading
├── requirements.txt
├── scripts/
│   ├── face-engine.js         face-api.js pipeline and score calibration
│   ├── live.js                live loop and per-participant EMA
│   ├── webrtc.js              multi-participant peer streams
│   ├── upload.js              file upload and queue
│   ├── dashboard.js           stats and trend rendering
│   ├── settings.js            settings UI and persistence
│   └── main.js                settings manager, IndexedDB, export helpers
├── styles/main.css
└── dataset/fer2013/           reference data for mock weighting and calibration
```

---

## 📚 Documentation

| Document | What's inside |
|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Components, models, data flow, design decisions |
| **[SECURITY.md](SECURITY.md)** | Threat model, data handling, hardening checklist |

---

## 🗺 Roadmap

- [ ] Shared face-landmark model across client and backend
- [ ] Smoothing window and temperature exposed in Settings
- [ ] Head-pose based attention score
- [ ] Exportable session trend reports (PDF)

<div align="center">
<sub>Built by <a href="https://github.com/Deep455-16">Deep455-16</a></sub>
</div>
