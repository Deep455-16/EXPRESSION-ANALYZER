# 🎭 Expression Analyzer

A real-time, multi-participant facial expression analysis platform for meetings and video sessions — built with HTML, CSS, JavaScript, and Python.

🔗 **Live demo:** https://deep455-16.github.io/EXPRESSION-ANALYZER/

---

## 🚀 How to Start

### Option 1: Using Python (Recommended)
```bash
python3 -m http.server 8000
```
Then open `http://localhost:8000`

### Option 2: Using Node.js
```bash
npx http-server -p 8000
```
Then open `http://localhost:8000`

### Option 3: Direct Open
Double-click `index.html` to open it in your browser (some features, like backend-assisted analysis, need a server to work).

### Optional: Backend (for higher-accuracy analysis + persistence)
```bash
pip install -r requirements.txt
python3 backend.py
```
The frontend automatically detects and prefers the backend when it's reachable, and falls back to fully client-side analysis when it isn't.

---

## 🧠 Core Features

### 🎥 Live Analysis (`live.html`)
- Real-time emotion detection from your webcam, sampled continuously while the session runs.
- **Multi-participant support** via WebRTC — each connected peer's video stream is analyzed independently, with per-participant emotion state tracked live.
- **Temporal smoothing** — an exponential moving average over recent frames per participant keeps the on-screen emotion from flickering between adjacent expressions frame-to-frame.
- Live face-box overlay with emotion label and confidence, drawn directly on the video feed.
- Session start/stop controls, with the session automatically finalized and summarized (dominant emotion, frame count, duration) when you stop.

### 📤 Upload & File Analysis (`upload.html`)
- Drag-and-drop or file-picker upload for both **images and videos**.
- Video files are sampled at intervals (not analyzed frame-by-frame) and aggregated into an overall dominant emotion + per-emotion distribution across sampled frames.
- Queue-based processing — upload and track multiple files at once, with per-item status.
- Annotated preview output: uploaded images/frames are returned with bounding boxes and emotion labels drawn on top.

### 📊 Dashboard (`dashboard.html`)
- Session history pulled from both **local IndexedDB storage** and, when available, the **backend/MongoDB history**, merged into one view.
- KPI summary cards: total sessions, total frames analyzed, average confidence, and dominant-emotion accuracy (share of frames where the top emotion clears 50% confidence).
- Per-session breakdowns and an **emotion trend timeline** showing how the emotional mix shifted over the course of a session, not just a single end-of-call number.
- Export session data to **CSV or JSON** for external reporting.

### ⚙️ Settings (`settings.html`)
Grouped, persisted (via `localStorage`) configuration covering:
- **General** — theme (dark/light), accent color, language, date format, completion/low-confidence notifications.
- **Analysis** — detection sampling rate, minimum confidence threshold, sensitivity, autosave, GPU acceleration toggle.
- **Camera** — device selection, resolution, FPS, face-overlay toggle, mirrored video.
- **Export** — default export format, timestamp inclusion.
- **Privacy** — automatic history clearing and configurable retention period.

### 🔀 Dual Analysis Engine (client + backend)
- **Client-side (always available, offline-capable):** face detection and emotion recognition run entirely in-browser via face-api.js — no data ever leaves the device on this path.
- **Backend (optional, higher accuracy):** a Flask server runs YOLOv8n-based detection and DeepFace-based emotion recognition, with results persisted to MongoDB for cross-session history.
- The app automatically prefers the backend when reachable (`/health` check) and transparently falls back to the client-side model — and finally to a safe mock result — so analysis never hard-fails.
- Every result is tagged with its **source** (`backend` / `client` / `mock`) and **detection method**, so the UI can show users exactly what produced a given number instead of presenting every result as equally authoritative.

### 🎯 Calibrated Confidence Scores
- Raw model outputs from both engines are **temperature-scaled and floored** before display, so results look like `happy 62% · neutral 15% · surprised 10% · ...` — a realistic spread reflecting genuine model uncertainty — instead of a hard, misleading `100%` / `0%` split. The dominant emotion reported is never changed by this step, only the displayed confidence spread.
- The face-crop region used before emotion prediction is sized and centered to keep the **mouth and chin in frame**, since that region is critical for distinguishing happy/neutral/disgusted.
- An offline calibration script validates this against the bundled FER2013 test set so the smoothing behavior is chosen from data rather than guesswork.

### 💾 Data & Persistence
- **IndexedDB (`EmotiDB`)** — always-available local storage for sessions and results, so the dashboard works even with no backend running.
- **MongoDB Atlas** (backend only) — session upsert/finalization, per-frame history, participant tracking, and the FER2013 reference distribution used to seed mock results.
- **Export utilities** — download any session's data as CSV or JSON.

### 🔒 Privacy
- Client-side mode processes everything locally in your browser; nothing is sent anywhere.
- The optional backend only processes frames you explicitly send to it — no third-party services are involved.
- Configurable auto-clear and retention settings for stored history.
- Works fully offline (client-side mode) after the initial model load.

---

## 🛠 Requirements

- Modern web browser (Chrome, Firefox, Edge, Safari)
- Webcam (for live analysis)
- JavaScript enabled
- Python 3.8+ (optional, for the higher-accuracy backend + MongoDB persistence)

---

## 📁 Project Structure

```
EXPRESSION-ANALYZER/
├── index.html               # Home page
├── live.html                 # Live multi-participant analysis
├── upload.html                # File upload & batch analysis
├── dashboard.html              # Analytics dashboard + trend charts
├── settings.html                # Settings
├── backend.py                  # Flask backend — detection, DeepFace scoring,
│                                #   score smoothing, MongoDB persistence
├── backend_connectivity.py      # MongoDB connection + FER2013 dataset loading
├── requirements.txt
├── scripts/
│   ├── face-engine.js          # Client-side face-api.js analysis + score smoothing
│   ├── live.js                  # Live webcam loop + per-participant temporal smoothing
│   ├── webrtc.js                  # Multi-participant peer connection handling
│   ├── upload.js                   # File upload & queue processing
│   ├── dashboard.js                 # Session stats + emotion trend rendering
│   ├── settings.js                   # Settings UI + persistence
│   └── main.js                        # Shared utilities: settings manager, IndexedDB, export
├── styles/
│   └── main.css
└── dataset/fer2013/                    # Reference dataset for mock weighting + calibration
```

---

## 📊 How Confidence Scores Work

1. The face/emotion model produces raw softmax probabilities per emotion.
2. Those probabilities are **temperature-scaled** (a monotonic transform — the top emotion never changes) to undo the model's native overconfidence.
3. A small floor is applied so no emotion ever displays as a flat, misleading `0%`.
4. The result is renormalized to sum to 100% and rounded for display.

---

## 🗺 Roadmap Ideas

- Dedicated face-landmark model shared across backend and client for perfect detection parity
- Configurable smoothing window and temperature exposed directly in Settings
- Exportable session trend reports (PDF)