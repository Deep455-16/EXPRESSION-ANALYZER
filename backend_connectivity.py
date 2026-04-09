"""
Backend Connectivity – MongoDB + Dataset Bootstrap
Provides: load_dataset_to_mongodb(), get_db()
"""
import os, zipfile, logging
from pathlib import Path
from pymongo import MongoClient

BASE_DIR = Path(__file__).parent
DATASET_ZIP = BASE_DIR / "fer2013.zip"
DATASET_DIR = BASE_DIR / "dataset" / "fer2013"
log = logging.getLogger("expr_connect")

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

        extract_dataset_if_needed()

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

def get_db():
    """Lazy connection to EXPRESSION_ANALYZER db for model use."""
    extract_dataset_if_needed()
    client = MongoClient("mongodb+srv://mundradeep17_db_user:deep45516@cluster0.vpferkw.mongodb.net/?retryWrites=true&w=majority")
    return client["EXPRESSION_ANALYZER"]

