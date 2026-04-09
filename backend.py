"""
EmotiScan — Backend Server (MongoDB-Integrated)
================================================
Stack  : Flask · Flask-SocketIO · OpenCV · YOLOv8 · DeepFace · MongoDB Atlas
MongoDB: Real-time result persistence, session history, participant tracking,
         FER2013 reference dataset, emotion statistics aggregation

API    : REST  /api/analyze  /api/upload  /api/session  /api/history
         /api/stats  /api/participants  /health
WebSocket: frame → result (real-time stream), signal (WebRTC relay)

Quick Start
-----------
1. cp .env.example .env  →  set MONGO_URI with real password
2. pip install -r requirements.txt
3. python backend.py  →  http://localhost:5000
"""

# ── stdlib ─────────────────────────────────────────────────────────────────────
import os, cv2, base64, time, json, threading, logging, uuid
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict

# Load .env
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ── pip packages ───────────────────────────────────────────────────────────────
import numpy as np
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.utils import secure_filename

# ── MongoDB ────────────────────────────────────────────────────────────────────
from backend_connectivity import (
    load_dataset_to_mongodb,
    get_db,
    get_collection,
    ping_db,
)

# ── Optional ML models ─────────────────────────────────────────────────────────
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
    print("[WARN] deepface not installed – using FER2013-weighted mock")


# ═══════════════════════════════════════════════════════════════════════════════
# APP SETUP
# ═══════════════════════════════════════════════════════════════════════════════

BASE_DIR   = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

ALLOWED_EXT = {"jpg","jpeg","png","gif","webp","mp4","webm","mov","avi"}

app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024
CORS(app, origins="*")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading",
                    logger=False, engineio_logger=False)

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("emotiscan")


# ═══════════════════════════════════════════════════════════════════════════════
# MONGODB COLLECTIONS  (populated at startup)
# ═══════════════════════════════════════════════════════════════════════════════

_col_results     = None   # real-time per-frame results
_col_sessions    = None   # session-level summaries
_col_participants = None  # participant registry
_col_fer2013     = None   # FER2013 reference data

# FER2013 emotion distribution loaded into memory for weighted fallback
_fer_weights: dict = {}

def _init_mongo_collections():
    global _col_results, _col_sessions, _col_participants, _col_fer2013, _fer_weights
    try:
        if not ping_db():
            log.warning("MongoDB offline – running without persistence")
            return

        db = get_db()
        _col_results      = db["analysis_results"]
        _col_sessions     = db["sessions"]
        _col_participants = db["participants"]
        _col_fer2013      = db["fer2013"]

        # Indexes for fast real-time queries
        _col_results.create_index([("participant_id",1),("timestamp",-1)], background=True)
        _col_results.create_index([("session_id",1),("timestamp",-1)],     background=True)
        _col_sessions.create_index([("session_id",1)],                      unique=True, background=True)
        _col_participants.create_index([("participant_id",1)],              unique=True, background=True)

        # Load FER2013 emotion distribution for smarter mock fallback
        _load_fer_weights()
        log.info("MongoDB: all collections ready")

    except Exception as exc:
        log.warning(f"MongoDB init failed (non-fatal): {exc}")


def _load_fer_weights():
    """
    Pull emotion counts from FER2013 collection → used to weight mock predictions
    so the fallback distribution matches real-world training data statistics.
    """
    global _fer_weights
    if _col_fer2013 is None:
        return
    try:
        pipeline = [
            {"$match": {"split": "train"}},
            {"$group": {"_id": "$emotion", "count": {"$sum": 1}}},
        ]
        rows = list(_col_fer2013.aggregate(pipeline))
        if rows:
            total = sum(r["count"] for r in rows)
            _fer_weights = {r["_id"]: r["count"] / total for r in rows}
            log.info(f"FER2013 weights loaded: {_fer_weights}")
    except Exception as exc:
        log.warning(f"Could not load FER2013 weights: {exc}")


# ═══════════════════════════════════════════════════════════════════════════════
# SESSION MANAGEMENT
# ═══════════════════════════════════════════════════════════════════════════════

session_store: dict = {}    # pid → latest result (in-memory, fast)
session_lock  = threading.Lock()

# Active sessions: session_id → { start_time, participants, frame_count, emotions }
active_sessions: dict = {}
sessions_lock   = threading.Lock()

_prev_gray: dict = {}


def _get_or_create_session(pid: str) -> str:
    """Return existing session_id for participant or create a new one."""
    with sessions_lock:
        for sid, sess in active_sessions.items():
            if pid in sess["participants"]:
                return sid
        # New session
        sid = str(uuid.uuid4())
        active_sessions[sid] = {
            "session_id":   sid,
            "start_time":   time.time(),
            "participants": {pid},
            "frame_count":  0,
            "emotion_totals": defaultdict(float),
            "peak_participants": 1,
        }
        # Upsert session doc in MongoDB
        if _col_sessions:
            try:
                _col_sessions.update_one(
                    {"session_id": sid},
                    {"$set": {
                        "session_id":  sid,
                        "start_time":  datetime.now(timezone.utc).isoformat(),
                        "status":      "active",
                        "participants":[pid],
                    }},
                    upsert=True,
                )
            except Exception:
                pass
        return sid


def _register_participant(pid: str, session_id: str):
    if _col_participants is None:
        return
    try:
        _col_participants.update_one(
            {"participant_id": pid},
            {
                "$set":  {"last_seen": datetime.now(timezone.utc).isoformat(),
                           "last_session": session_id},
                "$inc":  {"total_sessions": 1},
                "$setOnInsert": {
                    "participant_id": pid,
                    "first_seen": datetime.now(timezone.utc).isoformat(),
                    "total_frames": 0,
                },
            },
            upsert=True,
        )
    except Exception:
        pass


def _close_session(session_id: str):
    """Finalise session summary in MongoDB when all participants disconnect."""
    with sessions_lock:
        sess = active_sessions.pop(session_id, None)
    if sess is None or _col_sessions is None:
        return
    try:
        duration = round(time.time() - sess["start_time"], 1)
        totals   = dict(sess["emotion_totals"])
        grand    = sum(totals.values()) or 1
        dominant = max(totals, key=totals.get) if totals else "neutral"
        _col_sessions.update_one(
            {"session_id": session_id},
            {"$set": {
                "end_time":           datetime.now(timezone.utc).isoformat(),
                "status":             "completed",
                "duration_seconds":   duration,
                "total_frames":       sess["frame_count"],
                "peak_participants":  sess["peak_participants"],
                "emotion_totals":     totals,
                "dominant_emotion":   dominant,
                "emotion_distribution": {e: round(v/grand,4) for e,v in totals.items()},
            }},
        )
        log.info(f"Session {session_id} closed  ({duration}s, {sess['frame_count']} frames)")
    except Exception as exc:
        log.warning(f"Session close failed: {exc}")


# ═══════════════════════════════════════════════════════════════════════════════
# MODEL LAYER
# ═══════════════════════════════════════════════════════════════════════════════

EMOTION_LABELS = ["angry","disgusted","fearful","happy","neutral","sad","surprised"]
# Map DeepFace keys → our canonical labels
_DF_MAP = {
    "angry":"angry","disgust":"disgusted","fear":"fearful",
    "happy":"happy","neutral":"neutral","sad":"sad","surprise":"surprised",
}

HAAR_PATH  = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
haar_face  = cv2.CascadeClassifier(HAAR_PATH)

yolo_model = None
if YOLO_OK:
    try:
        yolo_model = YOLO(str(BASE_DIR / "yolov8n.pt"))
        log.info("YOLOv8n loaded from yolov8n.pt")
    except Exception as e:
        try:
            yolo_model = YOLO("yolov8n.pt")   # auto-download fallback
            log.info("YOLOv8n auto-downloaded")
        except Exception as e2:
            log.warning(f"YOLOv8 load failed: {e2}")


# ── Face Detection ─────────────────────────────────────────────────────────────

def detect_faces_haar(gray, frame):
    rects = haar_face.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5, minSize=(36,36)
    )
    return [{"bbox":[int(x),int(y),int(w),int(h)],
              "method":"haar","confidence":0.88,
              "crop":frame[y:y+h, x:x+w]}
             for x,y,w,h in rects]


def detect_faces_yolo(frame):
    if yolo_model is None:
        return []
    results = yolo_model(frame, classes=[0], verbose=False)
    faces   = []
    for r in results:
        for box in r.boxes:
            if float(box.conf[0]) < 0.45:
                continue
            x1,y1,x2,y2 = map(int, box.xyxy[0])
            face_h = int((y2-y1)*0.42)
            fy2    = min(y1+face_h, y2)
            crop   = frame[y1:fy2, x1:x2]
            if crop.size == 0:
                continue
            faces.append({"bbox":[x1,y1,x2-x1,fy2-y1],
                           "method":"yolo","confidence":float(box.conf[0]),
                           "crop":crop})
    return faces


def detect_faces(frame, method="yolo"):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    if method == "yolo" and yolo_model is not None:
        faces = detect_faces_yolo(frame)
        return faces if faces else detect_faces_haar(gray, frame)
    return detect_faces_haar(gray, frame)


# ── Emotion Recognition ────────────────────────────────────────────────────────

def _fer_weighted_mock() -> dict:
    """
    Mock emotion using FER2013 dataset distribution from MongoDB.
    Falls back to uniform weights if DB isn't loaded.
    """
    import random
    base = _fer_weights if _fer_weights else {e: 1/len(EMOTION_LABELS) for e in EMOTION_LABELS}
    raw  = {e: random.random() * base.get(e, 1/7) for e in EMOTION_LABELS}
    total = sum(raw.values())
    scores = {e: round(v/total, 4) for e,v in raw.items()}
    dom    = max(scores, key=scores.get)
    return {"label": dom, "confidence": scores[dom], "scores": scores}


def predict_emotion(crop: np.ndarray) -> dict:
    """
    Primary path: DeepFace (ResNet/VGG-Face) on the face crop.
    Fallback: FER2013-weighted probabilistic mock.
    """
    if DEEPFACE_OK and crop is not None and crop.size > 0:
        try:
            # Ensure minimum crop size for DeepFace
            h, w = crop.shape[:2]
            if h < 48 or w < 48:
                crop = cv2.resize(crop, (max(w,48), max(h,48)))

            res    = DeepFace.analyze(
                img_path=crop,
                actions=["emotion"],
                enforce_detection=False,
                detector_backend="skip",
                silent=True,
            )
            raw_emo = res[0]["emotion"]
            dom_raw = res[0]["dominant_emotion"]

            # Re-map DeepFace keys to our canonical label set
            scores  = {}
            for k, v in raw_emo.items():
                mapped = _DF_MAP.get(k.lower(), k.lower())
                scores[mapped] = scores.get(mapped, 0) + v

            total   = sum(scores.values()) or 1
            scores  = {e: round(v/total, 4) for e,v in scores.items()}
            dom     = _DF_MAP.get(dom_raw.lower(), dom_raw.lower())
            return {"label": dom, "confidence": round(scores.get(dom,0), 4), "scores": scores}

        except Exception as exc:
            log.debug(f"DeepFace error: {exc}")

    return _fer_weighted_mock()


# ── Motion / Attention ─────────────────────────────────────────────────────────

def motion_score(frame, pid) -> float:
    gray = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (21,21), 0)
    if pid not in _prev_gray:
        _prev_gray[pid] = gray
        return 0.0
    diff   = cv2.absdiff(_prev_gray[pid], gray)
    _,thr  = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
    score  = float(np.sum(thr)) / (thr.size * 255 + 1e-9)
    _prev_gray[pid] = gray
    return round(score, 4)


def attention_score(faces, mv, frame_shape) -> int:
    if not faces: return 0
    h, w    = frame_shape[:2]
    x,y,fw,fh = faces[0]["bbox"]
    ratio   = (fw*fh) / (w*h + 1)
    score   = 50 + min(25, ratio*250) + max(0, 15 - mv*160) + 10
    return min(100, int(score))


# ── Annotation ─────────────────────────────────────────────────────────────────

EMOTION_BGR = {
    "happy":    (80,220, 80),  "sad":       (200,100, 50),
    "angry":    (50, 50,230),  "surprised": (0, 210,230),
    "fearful":  (180,50,230),  "disgusted": (210,  0,150),
    "neutral":  (160,160,160),
}
EMOTION_EMOJI = {
    "happy":"😊","sad":"😢","angry":"😠","surprised":"😲",
    "fearful":"😨","disgusted":"🤢","neutral":"😐",
}

def annotate(frame, face_emotions):
    out = frame.copy()
    for fe in face_emotions:
        x,y,w,h = fe["bbox"]
        color   = EMOTION_BGR.get(fe["emotion"],(120,210,120))
        cs, t   = 18, 2
        # Corner-bracket box
        for (cx,cy,dx,dy) in [(x,y,1,1),(x+w,y,-1,1),(x,y+h,1,-1),(x+w,y+h,-1,-1)]:
            cv2.line(out,(cx,cy),(cx+dx*cs,cy),color,t)
            cv2.line(out,(cx,cy),(cx,cy+dy*cs),color,t)
        # Label pill
        conf_pct = int(fe["confidence"]*100)
        lbl      = f"{fe['emotion'].upper()}  {conf_pct}%"
        (tw,th),_= cv2.getTextSize(lbl, cv2.FONT_HERSHEY_SIMPLEX, 0.48, 1)
        cv2.rectangle(out,(x,y-th-10),(x+tw+8,y), color,-1)
        cv2.putText(out, lbl,(x+4,y-5), cv2.FONT_HERSHEY_SIMPLEX,0.48,(0,0,0),1,cv2.LINE_AA)
    return out


# ═══════════════════════════════════════════════════════════════════════════════
# CORE FRAME PROCESSOR
# ═══════════════════════════════════════════════════════════════════════════════

def process_frame(frame_b64: str, pid: str, method: str = "yolo",
                  session_id: str = None) -> dict:
    t0 = time.time()

    # Decode
    raw   = base64.b64decode(frame_b64)
    arr   = np.frombuffer(raw, np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        return {"error": "invalid frame"}

    # Ensure we have a session
    if not session_id:
        session_id = _get_or_create_session(pid)

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
            "method":     f.get("method","haar"),
        })

    attn    = attention_score(faces, mv, frame.shape)
    anno    = annotate(frame, face_emotions)
    _, buf  = cv2.imencode(".jpg", anno, [int(cv2.IMWRITE_JPEG_QUALITY), 76])
    anno_b64= base64.b64encode(buf).decode()

    result = {
        "participant_id":  pid,
        "session_id":      session_id,
        "faces_detected":  len(faces),
        "face_emotions":   face_emotions,
        "motion_score":    mv,
        "attention":       attn,
        "latency_ms":      round((time.time()-t0)*1000, 1),
        "annotated_frame": anno_b64,
        "timestamp":       time.time(),
        "datetime":        datetime.now(timezone.utc).isoformat(),
    }

    # In-memory session store (fast, for /api/session)
    with session_lock:
        session_store[pid] = result

    # Update in-memory session stats
    with sessions_lock:
        sess = active_sessions.get(session_id)
        if sess:
            sess["frame_count"] += 1
            for fe in face_emotions:
                for em, score in fe["scores"].items():
                    sess["emotion_totals"][em] += score

    # Async MongoDB persist
    threading.Thread(target=_persist_frame_result, args=(result,), daemon=True).start()

    return result


def _persist_frame_result(result: dict):
    """Write frame result to MongoDB. Runs in background thread."""
    if _col_results is None:
        return
    try:
        doc = {k: v for k, v in result.items() if k != "annotated_frame"}
        _col_results.insert_one(doc)

        # Also update participant frame counter
        if _col_participants:
            _col_participants.update_one(
                {"participant_id": result["participant_id"]},
                {"$inc":  {"total_frames": 1},
                 "$set":  {"last_seen": result["datetime"],
                           "last_emotion": result["face_emotions"][0]["emotion"]
                                           if result["face_emotions"] else "none"}},
                upsert=True,
            )
    except Exception as exc:
        log.debug(f"Persist skipped: {exc}")


# ═══════════════════════════════════════════════════════════════════════════════
# REST ROUTES
# ═══════════════════════════════════════════════════════════════════════════════

@app.route("/")
def root():
    return send_from_directory(str(BASE_DIR), "index.html")

@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(str(BASE_DIR), path)


@app.route("/health")
def health():
    mongo_ok = _col_results is not None
    return jsonify({
        "status":       "ok",
        "yolo":         yolo_model is not None,
        "deepface":     DEEPFACE_OK,
        "haar":         not haar_face.empty(),
        "opencv":       cv2.__version__,
        "mongodb":      mongo_ok,
        "fer_weights":  bool(_fer_weights),
        "active_sessions": len(active_sessions),
    })


@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    data       = request.get_json(force=True)
    frame      = data.get("frame","")
    pid        = data.get("participant_id","local")
    method     = data.get("method","yolo")
    session_id = data.get("session_id")
    if not frame:
        return jsonify({"error":"no frame"}), 400
    return jsonify(process_frame(frame, pid, method, session_id))


@app.route("/api/session")
def api_session():
    with session_lock:
        parts = list(session_store.values())
    avg_att = round(np.mean([p["attention"] for p in parts]),1) if parts else 0
    ec = {}
    for p in parts:
        for fe in p.get("face_emotions",[]):
            ec[fe["emotion"]] = ec.get(fe["emotion"],0) + 1
    # Active sessions
    with sessions_lock:
        sessions_info = [
            {"session_id":s["session_id"],
             "participants":list(s["participants"]),
             "frame_count": s["frame_count"],
             "duration_s":  round(time.time()-s["start_time"],1)}
            for s in active_sessions.values()
        ]
    return jsonify({
        "participants":    parts,
        "count":           len(parts),
        "avg_attention":   avg_att,
        "emotion_counts":  ec,
        "active_sessions": sessions_info,
        "timestamp":       time.time(),
    })


@app.route("/api/session/clear", methods=["POST"])
def api_session_clear():
    with session_lock:
        session_store.clear()
    return jsonify({"status":"cleared"})


# ── History: per-participant ───────────────────────────────────────────────────

@app.route("/api/history/<participant_id>")
def api_history(participant_id: str):
    """GET /api/history/<pid>?limit=50  — recent frames from MongoDB"""
    if _col_results is None:
        return jsonify({"error":"MongoDB not connected"}), 503
    limit = min(int(request.args.get("limit",50)), 500)
    docs  = list(
        _col_results
        .find({"participant_id": participant_id},
              {"_id":0, "annotated_frame":0})
        .sort("timestamp",-1)
        .limit(limit)
    )
    return jsonify({"participant_id":participant_id,"results":docs,"count":len(docs)})


# ── Stats: aggregated emotion stats from Atlas ─────────────────────────────────

@app.route("/api/stats")
def api_stats():
    """
    GET /api/stats?participant_id=<pid>&session_id=<sid>
    Returns aggregated emotion statistics from MongoDB.
    """
    if _col_results is None:
        return jsonify({"error":"MongoDB not connected"}), 503

    match = {}
    pid = request.args.get("participant_id")
    sid = request.args.get("session_id")
    if pid: match["participant_id"] = pid
    if sid: match["session_id"]     = sid

    pipeline = [
        {"$match": match},
        {"$unwind": "$face_emotions"},
        {"$group": {
            "_id":           "$face_emotions.emotion",
            "count":         {"$sum": 1},
            "avg_confidence":{"$avg": "$face_emotions.confidence"},
        }},
        {"$sort": {"count": -1}},
    ]

    rows        = list(_col_results.aggregate(pipeline))
    total_frames= _col_results.count_documents(match)

    stats = [{
        "emotion":        r["_id"],
        "count":          r["count"],
        "avg_confidence": round(r["avg_confidence"],4),
        "pct":            round(r["count"]/max(total_frames,1)*100,2),
    } for r in rows]

    return jsonify({"stats":stats,"total_frames":total_frames,
                    "filter":{"participant_id":pid,"session_id":sid}})


# ── Participants registry ──────────────────────────────────────────────────────

@app.route("/api/participants")
def api_participants():
    if _col_participants is None:
        return jsonify({"error":"MongoDB not connected"}), 503
    docs = list(_col_participants.find({},{"_id":0}).sort("last_seen",-1).limit(100))
    return jsonify({"participants":docs,"count":len(docs)})


# ── Sessions list ──────────────────────────────────────────────────────────────

@app.route("/api/sessions")
def api_sessions():
    if _col_sessions is None:
        return jsonify({"error":"MongoDB not connected"}), 503
    limit = min(int(request.args.get("limit",20)),100)
    docs  = list(_col_sessions.find({},{"_id":0}).sort("start_time",-1).limit(limit))
    return jsonify({"sessions":docs,"count":len(docs)})


# ── FER2013 dataset stats ─────────────────────────────────────────────────────

@app.route("/api/dataset/fer2013")
def api_fer_stats():
    if _col_fer2013 is None:
        return jsonify({"error":"MongoDB not connected or FER2013 not loaded"}), 503
    pipeline = [
        {"$group": {"_id":{"emotion":"$emotion","split":"$split"},"count":{"$sum":1}}},
        {"$sort": {"_id.split":1,"count":-1}},
    ]
    rows  = list(_col_fer2013.aggregate(pipeline))
    total = _col_fer2013.count_documents({})
    return jsonify({"rows":rows,"total":total,"weights":_fer_weights})


# ── Upload ─────────────────────────────────────────────────────────────────────

@app.route("/api/upload", methods=["POST"])
def api_upload():
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
        result = (_process_image(str(path))
                  if ext in {"jpg","jpeg","png","gif","webp"}
                  else _process_video(str(path)))
    finally:
        path.unlink(missing_ok=True)
    return jsonify(result)


def _process_image(path: str) -> dict:
    frame = cv2.imread(path)
    if frame is None:
        return {"error":"cannot read image"}
    _, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY),85])
    return process_frame(base64.b64encode(buf).decode(), "upload_image")


def _process_video(path: str, sample_every: int = 30) -> dict:
    cap, results, idx = cv2.VideoCapture(path), [], 0
    while cap.isOpened():
        ret, frame = cap.read()
        if not ret: break
        if idx % sample_every == 0:
            _, buf = cv2.imencode(".jpg",frame,[int(cv2.IMWRITE_JPEG_QUALITY),80])
            r = process_frame(base64.b64encode(buf).decode(), "upload_video")
            if r.get("face_emotions"):
                results.append(r)
        idx += 1
    cap.release()

    if not results:
        return {"error":"no faces detected in video","frames_sampled":idx}

    agg = {e:0.0 for e in EMOTION_LABELS}
    for r in results:
        for fe in r["face_emotions"]:
            for e,v in fe["scores"].items():
                agg[e] = agg.get(e,0)+v
    total = sum(agg.values()) or 1
    norm  = {e:round(v/total,4) for e,v in agg.items()}
    dom   = max(norm, key=norm.get)
    return {"dominant_emotion":dom,"confidence":norm[dom],"scores":norm,
            "frames_sampled":len(results),"total_frames":idx}


# ═══════════════════════════════════════════════════════════════════════════════
# WEBSOCKET
# ═══════════════════════════════════════════════════════════════════════════════

@socketio.on("frame")
def ws_frame(data):
    result = process_frame(
        data.get("frame",""),
        data.get("participant_id","local"),
        data.get("method","yolo"),
        data.get("session_id"),
    )
    emit("result", result)


@socketio.on("signal")
def ws_signal(data):
    room     = data.get("room","default")
    msg_type = data.get("type","")
    if msg_type == "join":
        join_room(room)
        emit("signal",{**data,"type":"joined"}, to=room, include_self=False)
    elif msg_type == "leave":
        leave_room(room)
        emit("signal",{**data,"type":"left"}, to=room, include_self=False)
    elif msg_type in ("offer","answer","ice"):
        emit("signal", data, to=room, include_self=False)


@socketio.on("connect")
def ws_connect():
    pid = request.args.get("participant_id", request.sid)
    sid = _get_or_create_session(pid)
    _register_participant(pid, sid)
    log.info(f"WS connect  {request.sid}  pid={pid}  session={sid}")
    emit("connected", {"participant_id": pid, "session_id": sid})


@socketio.on("disconnect")
def ws_disconnect():
    sid_ws = request.sid
    log.info(f"WS disconnect {sid_ws}")
    with session_lock:
        session_store.pop(sid_ws, None)
    # Check if this disconnect empties any session
    with sessions_lock:
        for sess_id, sess in list(active_sessions.items()):
            if sid_ws in sess["participants"]:
                sess["participants"].discard(sid_ws)
                if not sess["participants"]:
                    threading.Thread(
                        target=_close_session, args=(sess_id,), daemon=True
                    ).start()
                break


# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    load_dataset_to_mongodb()
    _init_mongo_collections()

    print("\n" + "═"*54)
    print("  EmotiScan — Expression Analyser Backend")
    print(f"  OpenCV   : {cv2.__version__}")
    print(f"  YOLOv8   : {'✓ yolov8n.pt' if yolo_model else '✗ not loaded'}")
    print(f"  DeepFace : {'✓' if DEEPFACE_OK else '✗ FER2013-weighted mock'}")
    print(f"  Haar     : {'✓' if not haar_face.empty() else '✗'}")
    print(f"  MongoDB  : {'✓ Atlas connected' if _col_results else '✗ offline'}")
    print(f"  FER2013  : {'✓ weights loaded' if _fer_weights else '✗ not loaded'}")
    print()
    print(f"  Frontend : http://localhost:5000")
    print(f"  REST API : http://localhost:5000/api/analyze")
    print(f"  Stats    : http://localhost:5000/api/stats")
    print(f"  Sessions : http://localhost:5000/api/sessions")
    print(f"  WebSocket: ws://localhost:5000")
    print("═"*54 + "\n")
    socketio.run(app, host="0.0.0.0", port=5000, debug=False)
