"""
Backend Connectivity – MongoDB Atlas + Dataset Bootstrap
"""
import os, zipfile, logging
from pathlib import Path
from functools import lru_cache
from pymongo import MongoClient
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError

BASE_DIR    = Path(__file__).parent
DATASET_ZIP = BASE_DIR / "fer2013.zip"
DATASET_DIR = BASE_DIR / "dataset" / "fer2013"
DB_NAME     = "EXPRESSION_ANALYZER"

MONGO_URI = os.environ.get(
    "MONGO_URI",
    "mongodb+srv://mundradeep17_db_user:deep45516@cluster0.vpferkw.mongodb.net/"
    "?retryWrites=true&w=majority&appName=EmotiScan"
)

log = logging.getLogger("emotiscan.db")

@lru_cache(maxsize=1)
def _get_client() -> MongoClient:
    return MongoClient(
        MONGO_URI,
        serverSelectionTimeoutMS=5_000,
        connectTimeoutMS=5_000,
        socketTimeoutMS=10_000,
        maxPoolSize=20,
        retryWrites=True,
    )

def get_db():
    return _get_client()[DB_NAME]

def get_collection(name: str):
    return get_db()[name]

def ping_db() -> bool:
    try:
        _get_client().admin.command("ping")
        log.info("MongoDB Atlas: OK")
        return True
    except (ConnectionFailure, ServerSelectionTimeoutError) as exc:
        log.error(f"MongoDB Atlas: FAILED – {exc}")
        return False

def extract_dataset_if_needed():
    if DATASET_DIR.exists():
        log.info("FER2013 already extracted")
        return
    if not DATASET_ZIP.exists():
        log.warning(f"fer2013.zip not found at {DATASET_ZIP}")
        return
    log.info("Extracting FER2013 …")
    DATASET_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(DATASET_ZIP, "r") as zf:
        zf.extractall(DATASET_DIR)
    log.info("FER2013 extraction complete")

def load_dataset_to_mongodb():
    try:
        if not ping_db():
            log.warning("Skipping dataset bootstrap – Atlas unreachable")
            return
        col = get_collection("fer2013")
        if col.count_documents({}) > 1_000:
            log.info("FER2013 already indexed in Atlas")
            return
        extract_dataset_if_needed()
        if not DATASET_DIR.exists():
            return
        records = []
        for split in ("train", "test"):
            sp = DATASET_DIR / split
            if not sp.exists():
                continue
            for edir in sp.iterdir():
                if not edir.is_dir():
                    continue
                for img in edir.iterdir():
                    records.append({
                        "emotion":    edir.name,
                        "split":      split,
                        "image_path": str(img),
                        "dataset":    "FER2013",
                    })
        if records:
            for i in range(0, len(records), 500):
                col.insert_many(records[i:i+500])
            log.info(f"Inserted {len(records)} FER2013 records")
            col.create_index([("emotion",1),("split",1)], background=True)
    except Exception as exc:
        log.warning(f"MongoDB bootstrap failed (non-fatal): {exc}")
