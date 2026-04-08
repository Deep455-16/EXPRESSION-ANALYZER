"""
Expression Analyser — Backend Server
=====================================
Stack  : Flask · Flask-SocketIO · OpenCV · YOLOv8 · DeepFace
API    : REST  /api/analyze  /api/upload  /api/session  /health
WebSocket: socket events  frame → result  (real-time stream)
Signal  : socket event  signal  (WebRTC relay)

Quick Start
-----------
pip install flask flask-cors flask-socketio eventlet
pip install opencv-python-headless ultralytics deepface
pip install numpy pillow werkzeug

python backend.py
→ http://localhost:5000
"""

# ── stdlib ────────────────────────────────────────────────────────
import os, cv2, base64, time, json, threading, logging, zipfile
from pathlib import Path
from pymongo import MongoClient

# ── pip packages ──────────────────────────────────────────────────
import numpy as np
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.utils import secure_filename

# ── Optional heavy models (graceful degradation) ──────────────────
try:
    from ultralytics import YOLO
    YOLO_OK = True
except ImportError:
    YOLO_OK = False
    print("[WARN] ultralytics not installed – YOLO disabled")

try:
    from deepface import DeepFace
    DEEPFACE_OK = True
except ImportError:
    DEEPFACE_OK = False
    print("[WARN] deepface not installed – mock emotions used")

# ═══════════════════════════════════════════════════════════════════
# APP SETUP
# ═══════════════════════════════════════════════════════════════════

BASE_DIR    = Path(__file__).parent
UPLOAD_DIR  = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

ALLOWED_EXT = {"jpg","jpeg","png","gif","webp","mp4","webm","mov","avi"}

app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024   # 100 MB
CORS(app, origins="*")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading",
                    logger=False, engineio_logger=False)

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("expr")

# ── FER2013 Dataset + MongoDB bootstrap ──────────────────────────
DATASET_ZIP = BASE_DIR / "fer2013.zip"
DATASET_DIR = BASE_DIR / "dataset" / "fer2013"

def extract_dataset_if_needed():
    if DATASET_DIR.exists():
        log.info("FER2013 already extracted")
        return

    if not DATASET_ZIP.exists():
        log.warning("fer2013.zip not found")
        return

    log.info("Extracting FER2013 dataset...")
    with zipfile.ZipFile(DATASET_ZIP, "r") as zip_ref:
        zip_ref.extractall(DATASET_DIR)
    log.info("FER2013 extraction complete")


def load_dataset_to_mongodb():
    try:
        client = MongoClient("mongodb+srv://mundradeep17_db_user:deep45516@cluster0.vpferkw.mongodb.net/?retryWrites=true&w=majority")
        db = client["EXPRESSION_ANALYZER"]
        collection = db["fer2013"]

        if collection.count_documents({}) > 1000:
            log.info("FER2013 already present in Atlas MongoDB")
            return

        if not DATASET_DIR.exists():
            log.warning("Dataset folder missing")
            return

        records = []

        for split in ["train", "test"]:
            split_path = DATASET_DIR / split
            if not split_path.exists():
                continue

            for emotion in os.listdir(split_path):
                emotion_path = split_path / emotion
                if not emotion_path.is_dir():
                    continue

                for img in os.listdir(emotion_path):
                    records.append({
                        "emotion": emotion,
                        "split": split,
                        "image_path": str(emotion_path / img),
                        "dataset": "FER2013"
                    })

        if records:
            collection.insert_many(records)
            log.info(f"Inserted {len(records)} records into Atlas MongoDB")

    except Exception as e:
        log.warning(f"MongoDB bootstrap failed: {e}")

# ═══════════════════════════════════════════════════════════════════
# MODEL LAYER
# ═══════════════════════════════════════════════════════════════════

EMOTION_LABELS = ["angry","disgusted","fearful","happy","neutral","sad","surprised"]

# Haar cascade – always available via OpenCV
HAAR_PATH   = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
haar_face   = cv2.CascadeClassifier(HAAR_PATH)

# YOLOv8 – for person / motion detection
yolo_model  = None
if YOLO_OK:
    try:
        yolo_model = YOLO("yolov8n.pt")   # auto-downloads on first run
        log.info("YOLOv8n loaded")
    except Exception as e:
        log.warning(f"YOLOv8 load failed: {e}")

# per-participant previous frame for motion delta
_prev_gray: dict = {}

# session store  participant_id → latest result dict
session_store: dict = {}
session_lock  = threading.Lock()


# ── Face Detection ─────────────────────────────────────────────────

def detect_faces_haar(gray: np.ndarray, frame: np.ndarray) -> list:
    rects = haar_face.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5, minSize=(36, 36)
    )
    results = []
    for x, y, w, h in rects:
        results.append({
            "bbox": [int(x), int(y), int(w), int(h)],
            "method": "haar",
            "confidence": 0.88,
            "crop": frame[y:y+h, x:x+w],
        })
    return results


def detect_faces_yolo(frame: np.ndarray) -> list:
    """Use YOLOv8 to detect persons, then sub-crop the face region."""
    if yolo_model is None:
        return []
    results = yolo_model(frame, classes=[0], verbose=False)
    faces = []
    h_frame, w_frame = frame.shape[:2]
    for r in results:
        for box in r.boxes:
            if float(box.conf[0]) < 0.50:
                continue
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            # Estimate face = top 40 % of person bounding box
            face_h = int((y2 - y1) * 0.40)
            fy1, fy2 = y1, min(y1 + face_h, y2)
            fx1, fx2 = x1, x2
            crop = frame[fy1:fy2, fx1:fx2]
            if crop.size == 0:
                continue
            faces.append({
                "bbox": [fx1, fy1, fx2-fx1, fy2-fy1],
                "method": "yolo",
                "confidence": float(box.conf[0]),
                "crop": crop,
            })
    return faces


def detect_faces(frame: np.ndarray, method: str = "yolo") -> list:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    if method == "yolo" and yolo_model is not None:
        faces = detect_faces_yolo(frame)
        if not faces:                      # YOLO fallback → Haar
            faces = detect_faces_haar(gray, frame)
    else:
        faces = detect_faces_haar(gray, frame)
    return faces


# ── Emotion Recognition ────────────────────────────────────────────

def _mock_emotion() -> dict:
    import random
    w = {"happy":2.2,"neutral":1.8,"surprised":1.2,
         "sad":0.8,"angry":0.6,"fearful":0.5,"disgusted":0.4}
    raw   = {e: random.random() * w.get(e,1) for e in EMOTION_LABELS}
    total = sum(raw.values())
    scores = {e: round(v/total, 4) for e,v in raw.items()}
    dom    = max(scores, key=scores.get)
    return {"label": dom, "confidence": scores[dom], "scores": scores}


def predict_emotion(crop: np.ndarray) -> dict:
    if DEEPFACE_OK and crop is not None and crop.size > 0:
        try:
            res = DeepFace.analyze(
                img_path=crop,
                actions=["emotion"],
                enforce_detection=False,
                detector_backend="skip",
                silent=True,
            )
            emo    = res[0]["emotion"]
            dom    = res[0]["dominant_emotion"]
            total  = sum(emo.values()) or 1
            scores = {k: round(v/total, 4) for k,v in emo.items()}
            return {"label": dom, "confidence": round(scores[dom], 4), "scores": scores}
        except Exception:
            pass
    return _mock_emotion()


# ── Motion Score ───────────────────────────────────────────────────

def motion_score(frame: np.ndarray, pid: str) -> float:
    gray = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (21,21), 0)
    if pid not in _prev_gray:
        _prev_gray[pid] = gray
        return 0.0
    diff = cv2.absdiff(_prev_gray[pid], gray)
    _, thresh = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
    score = float(np.sum(thresh)) / (thresh.size * 255 + 1e-9)
    _prev_gray[pid] = gray
    return round(score, 4)


# ── Attention Score ────────────────────────────────────────────────

def attention_score(faces: list, mv: float, frame_shape: tuple) -> int:
    if not faces: return 0
    h, w = frame_shape[:2]
    x, y, fw, fh = faces[0]["bbox"]
    ratio  = (fw * fh) / (w * h + 1)
    score  = 50 + min(25, ratio * 250) + max(0, 15 - mv * 160) + 10
    return min(100, int(score))


# ── Annotation ─────────────────────────────────────────────────────

EMOTION_BGR = {
    "happy":    (80,200, 80), "sad":      (200,100, 50),
    "angry":    ( 50, 50,220),"surprised":(  0,200,220),
    "fearful":  (180, 50,220),"disgusted":(200,  0,150),
    "neutral":  (160,160,160),
}

def annotate(frame: np.ndarray, face_emotions: list) -> np.ndarray:
    out = frame.copy()
    for fe in face_emotions:
        x, y, w, h = fe["bbox"]
        color = EMOTION_BGR.get(fe["emotion"], (100,200,100))
        cs, t = 16, 2
        # Corner-bracket bounding box
        for (cx,cy,dx,dy) in [(x,y,1,1),(x+w,y,-1,1),(x,y+h,1,-1),(x+w,y+h,-1,-1)]:
            cv2.line(out,(cx, cy),(cx+dx*cs, cy), color, t)
            cv2.line(out,(cx, cy),(cx, cy+dy*cs), color, t)
        # Label
        lbl = f"{fe['emotion'].upper()} {int(fe['confidence']*100)}%"
        (tw, th), _ = cv2.getTextSize(lbl, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
        cv2.rectangle(out,(x, y-th-8),(x+tw+4, y), color, -1)
        cv2.putText(out, lbl, (x+2, y-4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0,0,0), 1)
    return out


# ═══════════════════════════════════════════════════════════════════
# MAIN PIPELINE
# ═══════════════════════════════════════════════════════════════════

def process_frame(b64: str, pid: str = "local",
                  method: str = "yolo") -> dict:
    """
    Full pipeline:
      base64 JPEG → decode → face/motion detect → emotion → annotate
    Returns structured dict consumed by frontend.
    """
    raw  = base64.b64decode(b64)
    arr  = np.frombuffer(raw, np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        return {"error": "bad frame"}

    t0    = time.time()
    faces = detect_faces(frame, method=method)
    mv    = motion_score(frame, pid)

    face_emotions = []
    for f in faces:
        em = predict_emotion(f.get("crop"))
        face_emotions.append({
            "bbox":       f["bbox"],
            "emotion":    em["label"],
            "confidence": em["confidence"],
            "scores":     em["scores"],
        })

    attn  = attention_score(faces, mv, frame.shape)
    anno  = annotate(frame, face_emotions)
    _, buf = cv2.imencode(".jpg", anno, [int(cv2.IMWRITE_JPEG_QUALITY), 74])
    anno_b64 = base64.b64encode(buf).decode()

    result = {
        "participant_id":  pid,
        "faces_detected":  len(faces),
        "face_emotions":   face_emotions,
        "motion_score":    mv,
        "attention":       attn,
        "latency_ms":      round((time.time()-t0)*1000, 1),
        "annotated_frame": anno_b64,
        "timestamp":       time.time(),
    }

    with session_lock:
        session_store[pid] = result
    return result


# ═══════════════════════════════════════════════════════════════════
# REST ROUTES
# ═══════════════════════════════════════════════════════════════════

@app.route("/")
def root():
    return send_from_directory(str(BASE_DIR), "index.html")

@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(str(BASE_DIR), path)


@app.route("/health")
def health():
    return jsonify({
        "status":   "ok",
        "yolo":     yolo_model is not None,
        "deepface": DEEPFACE_OK,
        "haar":     not haar_face.empty(),
        "opencv":   cv2.__version__,
    })


@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    """
    POST /api/analyze
    Body: { frame: <base64 jpeg>, participant_id: str, method: "yolo"|"haar" }
    """
    data   = request.get_json(force=True)
    frame  = data.get("frame","")
    pid    = data.get("participant_id","local")
    method = data.get("method","yolo")
    if not frame:
        return jsonify({"error":"no frame"}), 400
    return jsonify(process_frame(frame, pid, method))


@app.route("/api/session")
def api_session():
    with session_lock:
        parts = list(session_store.values())
    avg_att = round(np.mean([p["attention"] for p in parts]),1) if parts else 0
    ec = {}
    for p in parts:
        for fe in p.get("face_emotions",[]):
            ec[fe["emotion"]] = ec.get(fe["emotion"],0)+1
    return jsonify({
        "participants":   parts,
        "count":          len(parts),
        "avg_attention":  avg_att,
        "emotion_counts": ec,
        "timestamp":      time.time(),
    })


@app.route("/api/session/clear", methods=["POST"])
def api_session_clear():
    with session_lock:
        session_store.clear()
    return jsonify({"status":"cleared"})


# ── Upload endpoint ────────────────────────────────────────────────

@app.route("/api/upload", methods=["POST"])
def api_upload():
    """
    Accepts an image or video file.
    Images  → single-frame emotion analysis.
    Videos  → sample every N frames.
    Returns aggregated emotion result.
    """
    if "file" not in request.files:
        return jsonify({"error":"no file"}), 400

    f    = request.files["file"]
    name = secure_filename(f.filename)
    ext  = name.rsplit(".",1)[-1].lower()
    if ext not in ALLOWED_EXT:
        return jsonify({"error":"unsupported file type"}), 400

    path = UPLOAD_DIR / name
    f.save(str(path))

    try:
        if ext in {"jpg","jpeg","png","gif","webp"}:
            result = _process_image(str(path))
        else:
            result = _process_video(str(path))
    finally:
        path.unlink(missing_ok=True)

    return jsonify(result)


def _process_image(path: str) -> dict:
    frame = cv2.imread(path)
    if frame is None:
        return {"error":"cannot read image"}
    _, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY),85])
    b64    = base64.b64encode(buf).decode()
    return process_frame(b64, "upload_image")


def _process_video(path: str, sample_every: int = 30) -> dict:
    cap      = cv2.VideoCapture(path)
    results  = []
    idx      = 0
    while cap.isOpened():
        ret, frame = cap.read()
        if not ret: break
        if idx % sample_every == 0:
            _, buf = cv2.imencode(".jpg", frame,
                                  [int(cv2.IMWRITE_JPEG_QUALITY),80])
            b64 = base64.b64encode(buf).decode()
            r   = process_frame(b64, "upload_video")
            if r.get("face_emotions"):
                results.append(r)
        idx += 1
    cap.release()

    if not results:
        return {"error":"no faces detected in video", "frames_sampled": idx}

    # Aggregate
    agg_scores = {e:0.0 for e in EMOTION_LABELS}
    for r in results:
        for fe in r["face_emotions"]:
            for e,v in fe["scores"].items():
                agg_scores[e] = agg_scores.get(e,0)+v
    total = sum(agg_scores.values()) or 1
    norm  = {e:round(v/total,4) for e,v in agg_scores.items()}
    dom   = max(norm, key=norm.get)
    return {
        "dominant_emotion": dom,
        "confidence":       norm[dom],
        "scores":           norm,
        "frames_sampled":   len(results),
        "total_frames":     idx,
    }


# ═══════════════════════════════════════════════════════════════════
# WEBSOCKET — real-time frame stream
# ═══════════════════════════════════════════════════════════════════

@socketio.on("frame")
def ws_frame(data):
    result = process_frame(
        data.get("frame",""),
        data.get("participant_id","local"),
        data.get("method","yolo"),
    )
    emit("result", result)


# ── WebRTC signalling relay ────────────────────────────────────────

@socketio.on("signal")
def ws_signal(data):
    room     = data.get("room","default")
    msg_type = data.get("type","")
    if msg_type == "join":
        join_room(room)
        emit("signal",{**data,"type":"joined"}, to=room, include_self=False)
    elif msg_type == "leave":
        leave_room(room)
        emit("signal",{**data,"type":"left"},   to=room, include_self=False)
    elif msg_type in ("offer","answer","ice"):
        emit("signal", data, to=room, include_self=False)


@socketio.on("connect")
def ws_connect():
    log.info(f"WS connect  {request.sid}")

@socketio.on("disconnect")
def ws_disconnect():
    log.info(f"WS disconnect {request.sid}")
    with session_lock:
        session_store.pop(request.sid, None)


# ═══════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    extract_dataset_if_needed()
    load_dataset_to_mongodb()

    print("\n" + "="*52)
    print("  Expression Analyser – Backend")
    print(f"  OpenCV  : {cv2.__version__}")
    print(f"  YOLOv8  : {'✓ yolov8n.pt' if yolo_model else '✗ not loaded'}")
    print(f"  DeepFace: {'✓' if DEEPFACE_OK else '✗ mock mode'}")
    print(f"  Haar    : {'✓' if not haar_face.empty() else '✗'}")
    print()
    print(f"  Frontend : http://localhost:5000")
    print(f"  REST API : http://localhost:5000/api/analyze")
    print(f"  WebSocket: ws://localhost:5000")
    print("="*52 + "\n")
    socketio.run(app, host="0.0.0.0", port=5000, debug=False)
