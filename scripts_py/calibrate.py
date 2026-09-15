import os
import sys
import glob
import math
from collections import defaultdict

try:
    import numpy as np
    import cv2
except ImportError:
    print("Please install numpy and opencv-python")
    sys.exit(1)

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import backend

TEST_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dataset', 'fer2013', 'test'))

def run_calibration():
    if not os.path.exists(TEST_DIR) or not os.listdir(TEST_DIR):
        print("Dataset directory is empty or missing. Exiting cleanly.")
        sys.exit(0)

    images = []
    for emotion in backend.EMOTION_LABELS:
        folder = os.path.join(TEST_DIR, emotion)
        if os.path.exists(folder):
            for path in glob.glob(os.path.join(folder, '*.jpg')):
                images.append((path, emotion))

    if not images:
        print("No test images found. Exiting cleanly.")
        sys.exit(0)

    print(f"Found {len(images)} test images. Running predictions (this may take a moment)...")
    
    # Intercept raw scores by patching _smooth_scores
    original_smooth = backend._smooth_scores
    raw_scores_list = []
    
    def intercept_smooth(scores, temperature=2.0, floor=0.008):
        raw_scores_list.append(scores.copy())
        return original_smooth(scores, temperature, floor)
    
    backend._smooth_scores = intercept_smooth
    
    results = []
    for path, true_label in images:
        img = cv2.imread(path)
        if img is None: continue
        
        raw_scores_list.clear()
        backend.predict_emotion(img)
        
        if raw_scores_list:
            results.append({
                'true_label': true_label,
                'raw_scores': raw_scores_list[0]
            })

    backend._smooth_scores = original_smooth

    print(f"\nSuccessfully predicted {len(results)} images.")
    print("\n--- Calibration Results ---")
    print(f"{'Temperature':<12} | {'Accuracy':<10} | {'Brier Score':<12}")
    print("-" * 40)

    temperatures = [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0]
    
    best_temp = None
    best_brier = float('inf')
    
    for T in temperatures:
        brier_sum = 0.0
        correct = 0
        
        for r in results:
            smoothed = backend._smooth_scores(r['raw_scores'], temperature=T)
            dom_emotion = max(smoothed, key=smoothed.get)
            
            if dom_emotion == r['true_label']:
                correct += 1
                
            # Brier score = sum((p - true_p)^2) for all classes
            for em in backend.EMOTION_LABELS:
                p = smoothed.get(em, 0.0)
                true_p = 1.0 if em == r['true_label'] else 0.0
                brier_sum += (p - true_p) ** 2
                
        acc = correct / len(results)
        brier = brier_sum / len(results)
        
        print(f"{T:<12.2f} | {acc:<10.4f} | {brier:<12.4f}")
        
        if brier < best_brier:
            best_brier = brier
            best_temp = T

    print("-" * 40)
    print(f"Optimal Temperature (lowest Brier): {best_temp}")

if __name__ == '__main__':
    run_calibration()
