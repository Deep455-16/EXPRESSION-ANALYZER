# 🔐 Security & Privacy — Expression Analyzer

Facial expression data is sensitive by nature. This document explains **exactly what happens to a face once it's captured**, what protections already exist in this codebase, and what's still worth hardening before running this in front of real participants (e.g. real meetings) or deploying it publicly.

---

## 1. Default Mode: Nothing Leaves the Device

By default — and whenever no backend is configured or reachable — **all face detection and emotion analysis happens entirely inside the user's browser**, via `scripts/face-engine.js` (face-api.js, running on-device through TensorFlow.js).

- The webcam stream is read directly into a `<canvas>` and never transmitted anywhere.
- No network request containing a frame, a face crop, or any derived facial data is made in this mode.
- The only network calls made in client-only mode are to fetch the (non-personal) ML model weight files from a CDN (`cdn.jsdelivr.net`) and Google Fonts — neither ever receives user data.

**This is the safest mode of the app and the one used automatically whenever the backend is absent.**

---

## 2. Backend Mode: What Actually Gets Sent, and What Doesn't

The backend (`backend.py`) is opt-in — the client only sends frames to it when it's explicitly configured (`FaceEngine.setBackend(url)`) *and* reachable *and* `preferBackend` is set. When that path is used:

| What | Sent to backend? | Stored anywhere? |
|---|---|---|
| Raw webcam/video frame | ✅ Sent once per analyzed frame, as a base64 JPEG, over `POST /api/analyze` (or the `frame` Socket.IO event) | ❌ **Not stored.** Decoded in memory with OpenCV, used only for that single detection+inference pass, then discarded — it is never written to disk. |
| Annotated frame (bounding boxes + labels drawn on the image) | Returned to the client so it can render an overlay | ❌ **Explicitly stripped before persistence.** `_persist_frame_result()` removes the `annotated_frame` field before writing to MongoDB, and it's also excluded from every read/export query (`{"annotated_frame": 0}` projections on `/api/history` and export endpoints). It only ever exists transiently in server memory and in the single HTTP response back to the requesting client. |
| Emotion scores, bounding-box coordinates, confidence, timestamps | Returned to client | ✅ Persisted to MongoDB (if connected) as structured metadata — **numbers and coordinates, not imagery.** |
| Participant ID | Provided by the client | ✅ Stored alongside frame metadata for session/history grouping |

**Net effect: no facial imagery is ever written to persistent storage by this backend — only numeric analysis results (what emotion, how confident, where the box was, when).** The one place a frame image briefly exists outside the request/response cycle is an in-memory `session_store` dict used to serve the *current* frame back via `/api/session` — this is not persisted and is overwritten on the next frame.

---

## 3. Local Storage on the Client

- **IndexedDB (`EmotiDB`)**, used by `scripts/main.js`, stores session summaries and per-frame results **on the user's own device only** — this is standard browser storage, not shared with any server, and is scoped to the browser profile it was created in.
- Settings (`localStorage`) include a dedicated **Privacy** section (`settings.html`) with:
  - `autoClearHistory` — automatically purge stored history
  - `historyRetention` — configurable retention window (default 7 days)
  
  These give the person running the app direct control over how long their own analysis history sticks around locally.

---

## 4. Secrets & Credentials

- MongoDB connection strings are read from environment variables (`MONGO_URI` via `os.environ.get(...)` in `backend_connectivity.py`), **never hardcoded** in source.
- `.env` (and `.env.example`, `_env`) are excluded via `.gitignore`, so real credentials aren't committed to the repository. Only `.env.example` (a template with no real secret) should ever be checked in.
- Uploaded filenames are passed through `secure_filename()` (Werkzeug) before touching the filesystem, mitigating path-traversal via crafted filenames.

---

## 5. Known Gaps & Hardening Recommendations

Being upfront about what this project does **not** yet do, so it isn't run in a sensitive context under a false sense of security:

| Gap | Risk | Recommendation |
|---|---|---|
| `CORS(app, origins=["*", ...])` in `backend.py` currently allows requests from **any** origin (the wildcard makes the specific allowed origin redundant) | Any website could point a browser at your running backend and submit frames for analysis if it's exposed on a network | Restrict `origins` to your actual deployed frontend domain(s) only, and drop the `"*"` wildcard, before deploying anywhere reachable beyond localhost |
| No authentication on `/api/analyze`, `/api/session`, `/api/history`, etc. | Anyone who can reach the backend can submit frames or read stored session/participant history | Add an API key or session-token check in front of these routes if the backend is ever exposed outside a trusted local network |
| Traffic is unencrypted by default (`http://`) in local dev | Frames and results could be intercepted on an untrusted network | Always run the backend behind HTTPS/TLS in any real deployment (reverse proxy with a valid certificate) |
| MongoDB access is only as safe as the URI's credentials and network rules | A leaked URI grants full access to stored session/participant history | Use MongoDB Atlas IP allow-lists, least-privilege database users, and rotate credentials if a `.env` is ever suspected to have leaked |
| No data-deletion/export-my-data endpoint for participants | Individuals analyzed in a session have no self-service way to remove their own stored history | Consider adding a "delete my participant history" endpoint alongside the existing history/export routes |
| CDN-hosted ML models (`cdn.jsdelivr.net`) are fetched at runtime | A compromised CDN could theoretically serve altered model weights | Consider self-hosting the face-api.js model files for fully offline/air-gapped deployments |

---

## 6. Summary

- **Default (client-only) mode:** no facial data ever leaves the device — the strongest privacy posture, and the one used automatically with no backend configured.
- **Backend mode:** frames are processed in memory and never persisted; only derived, non-image metadata (scores, coordinates, timestamps) is stored, and even the annotated preview image is deliberately stripped before it reaches the database.
- **Before any real-world/production use**, apply the hardening recommendations above — particularly locking down CORS and adding authentication — since the current configuration is tuned for local development and demos, not for exposure on an open network.