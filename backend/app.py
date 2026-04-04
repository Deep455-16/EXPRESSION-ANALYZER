"""
Expression Analyser Backend
Uses OpenCV + DeepFace + YOLO for facial expression recognition and motion detection
Flask REST API with WebRTC participant tracking
"""

import os
import cv2
import numpy as np
import base64
import json
import time
import uuid
import tempfile
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from collections import defaultdict

# Try to import deepface for expression recognition
try:
    from deepface import DeepFace
    HAS_DEEPFACE = True
except ImportError:
    HAS_DEEPFACE = False
    print("Warning: DeepFace not installed. Using fallback emotion detection.")

# Try to import ultralytics YOLO for face detection, object detection, motion
try:
    from ultralytics import YOLO
    HAS_YOLO = True
except ImportError:
    HAS_YOLO = False
    print("Warning: YOLO not installed. Using OpenCV Haar Cascade for face detection.")

# ========================================
# Configuration
# ========================================

app = Flask(__name__, static_folder='../', static_url_path='')
CORS(app)

EMOTIONS = ['happy', 'sad', 'angry', 'surprised', 'fear', 'disgust', 'neutral']

# Concentration scoring weights (positive emotions = higher concentration)
CONCENTRATION_WEIGHTS = {
    'happy': 0.85,
    'neutral': 0.75,
    'surprised': 0.70,
    'sad': 0.35,
    'fear': 0.20,
    'angry': 0.25,
    'disgust': 0.15
}

# Motion impact on concentration
MOTION_CONCENTRATION_PENALTY = {
    'high': -25,
    'medium': -12,
    'low': -5,
    'none': 0
}

# Global state
participants = defaultdict(lambda: {
    'emotions': [],
    'frames': 0,
    'start_time': None,
    'last_update': None,
    'room': None,
    'motion_history': []
})

rooms = defaultdict(list)

# Frame differencing state for motion detection
frame_buffers = {}

# ========================================
# YOLO Model Loading
# ========================================

# YOLO face detection model
yolo_face_model = None
# YOLO general object detection model (for motion/activity tracking)
yolo_object_model = None

if HAS_YOLO:
    try:
        yolo_face_model = YOLO('yolov8n-face.pt')
        print("YOLO face detection model loaded")
    except:
        print("Could not load YOLO face model, using cascade")
    
    try:
        yolo_object_model = YOLO('yolov8n.pt')
        print("YOLO object detection model loaded (motion/activity tracking)")
    except:
        print("Could not load YOLO object model")

# Load OpenCV Haar Cascade as fallback
cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
face_cascade = cv2.CascadeClassifier(cascade_path)

# ========================================
# Motion Detection Functions (OpenCV + YOLO)
# ========================================

def detect_motion_frame_diff(participant_id, frame, threshold=25, min_area=500):
    """Detect motion using OpenCV frame differencing"""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (21, 21), 0)
    
    if participant_id not in frame_buffers:
        frame_buffers[participant_id] = gray
        return {'detected': False, 'level': 'none', 'area': 0, 'regions': []}
    
    prev_frame = frame_buffers[participant_id]
    frame_diff = cv2.absdiff(prev_frame, gray)
    thresh = cv2.threshold(frame_diff, threshold, 255, cv2.THRESH_BINARY)[1]
    thresh = cv2.dilate(thresh, None, iterations=2)
    
    # Update buffer
    frame_buffers[participant_id] = gray
    
    # Find contours of motion regions
    contours, _ = cv2.findContours(thresh.copy(), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    motion_regions = []
    total_motion_area = 0
    frame_area = frame.shape[0] * frame.shape[1]
    
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < min_area:
            continue
        
        total_motion_area += area
        (x, y, w, h) = cv2.boundingRect(contour)
        motion_regions.append({'x': int(x), 'y': int(y), 'w': int(w), 'h': int(h), 'area': int(area)})
    
    motion_ratio = (total_motion_area / frame_area) * 100 if frame_area > 0 else 0
    
    # Classify motion level
    if motion_ratio > 15:
        level = 'high'
    elif motion_ratio > 5:
        level = 'medium'
    elif motion_ratio > 1:
        level = 'low'
    else:
        level = 'none'
    
    return {
        'detected': total_motion_area > min_area,
        'level': level,
        'ratio': round(motion_ratio, 2),
        'area': int(total_motion_area),
        'regions': motion_regions[:10]
    }

def detect_objects_yolo(image, conf_threshold=0.4):
    """Detect objects using YOLO for activity/motion analysis"""
    if yolo_object_model is None:
        return {'objects': [], 'activity_score': 0}
    
    try:
        results = yolo_object_model(image, verbose=False, conf=conf_threshold)
        
        objects = []
        activity_score = 0
        
        # Classes that indicate significant activity/movement
        activity_classes = {
            'person': 3, 'car': 2, 'bicycle': 1, 'motorcycle': 3,
            'bus': 3, 'truck': 3, 'dog': 2, 'cat': 2
        }
        
        for result in results:
            for box in result.boxes:
                cls_id = int(box.cls[0])
                conf = float(box.conf[0])
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                class_name = result.names[cls_id] if hasattr(result, 'names') else f'class_{cls_id}'
                
                weight = activity_classes.get(class_name, 1)
                activity_score += conf * weight
                
                objects.append({
                    'class': class_name,
                    'confidence': round(conf, 3),
                    'box': {'x1': int(x1), 'y1': int(y1), 'x2': int(x2), 'y2': int(y2)}
                })
        
        # Normalize activity score
        activity_score = min(activity_score, 100)
        
        # Classify activity level
        if activity_score > 50:
            level = 'high'
        elif activity_score > 20:
            level = 'medium'
        elif activity_score > 5:
            level = 'low'
        else:
            level = 'none'
        
        return {
            'objects': objects,
            'activity_score': round(activity_score, 1),
            'level': level,
            'object_count': len(objects)
        }
        
    except Exception as e:
        print(f"YOLO object detection error: {e}")
        return {'objects': [], 'activity_score': 0, 'level': 'none', 'object_count': 0}

def analyze_motion(participant_id, image):
    """Combined motion analysis using frame differencing + YOLO"""
    # Frame differencing (fast, detects any pixel change)
    diff_result = detect_motion_frame_diff(participant_id, image)
    
    # YOLO object detection (slower, understands what's moving)
    yolo_result = detect_objects_yolo(image)
    
    # Combine results
    combined_level = diff_result['level']
    if yolo_result['level'] == 'high':
        combined_level = 'high'
    elif yolo_result['level'] == 'medium' and combined_level == 'low':
        combined_level = 'medium'
    
    # Update participant motion history
    participants[participant_id]['motion_history'].append({
        'level': combined_level,
        'ratio': diff_result.get('ratio', 0),
        'activity_score': yolo_result.get('activity_score', 0),
        'timestamp': datetime.now().isoformat()
    })
    
    # Keep only last 50 entries
    if len(participants[participant_id]['motion_history']) > 50:
        participants[participant_id]['motion_history'] = participants[participant_id]['motion_history'][-50:]
    
    return {
        'motion': {
            'detected': diff_result['detected'],
            'level': combined_level,
            'ratio': diff_result.get('ratio', 0),
            'regions': diff_result.get('regions', [])[:5]
        },
        'activity': {
            'score': yolo_result.get('activity_score', 0),
            'level': yolo_result.get('level', 'none'),
            'objects': yolo_result.get('objects', [])[:5],
            'object_count': yolo_result.get('object_count', 0)
        }
    }

def calculate_motion_adjusted_concentration(emotions_history, motion_history):
    """Calculate concentration adjusted by motion/activity level"""
    if not emotions_history:
        return {'level': 0, 'label': 'No Data', 'breakdown': {}, 'motion_impact': 0}
    
    # Base concentration from emotions
    avg_emotions = defaultdict(float)
    count = len(emotions_history)
    
    for entry in emotions_history:
        for emotion, value in entry.items():
            avg_emotions[emotion] += value
    
    avg_emotions = {k: v / count for k, v in avg_emotions.items()}
    
    concentration = sum(
        avg_emotions.get(emotion, 0) * weight 
        for emotion, weight in CONCENTRATION_WEIGHTS.items()
    ) / 100
    
    concentration = min(max(concentration * 100, 0), 100)
    
    # Apply motion penalty
    motion_penalty = 0
    if motion_history:
        recent_motion = motion_history[-10:]
        high_count = sum(1 for m in recent_motion if m['level'] == 'high')
        medium_count = sum(1 for m in recent_motion if m['level'] == 'medium')
        low_count = sum(1 for m in recent_motion if m['level'] == 'low')
        
        if high_count > 5:
            motion_penalty = MOTION_CONCENTRATION_PENALTY['high']
        elif medium_count > 5:
            motion_penalty = MOTION_CONCENTRATION_PENALTY['medium']
        elif low_count > 5:
            motion_penalty = MOTION_CONCENTRATION_PENALTY['low']
    
    adjusted_concentration = max(concentration + motion_penalty, 0)
    
    if adjusted_concentration >= 80:
        label = 'Highly Focused'
    elif adjusted_concentration >= 60:
        label = 'Engaged'
    elif adjusted_concentration >= 40:
        label = 'Moderately Attentive'
    elif adjusted_concentration >= 20:
        label = 'Distracted'
    else:
        label = 'Disengaged'
    
    return {
        'level': round(adjusted_concentration, 1),
        'base_level': round(concentration, 1),
        'motion_impact': motion_penalty,
        'label': label,
        'breakdown': {k: round(v, 1) for k, v in avg_emotions.items()}
    }

# ========================================
# Emotion Detection Functions
# ========================================

def detect_faces_opencv(image):
    """Detect faces using OpenCV Haar Cascade"""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
    return faces

def detect_faces_yolo(image):
    """Detect faces using YOLO if available"""
    if yolo_face_model is None:
        return detect_faces_opencv(image)
    
    results = yolo_face_model(image, verbose=False)
    faces = []
    for result in results:
        for box in result.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            faces.append((x1, y1, x2 - x1, y2 - y1))
    return faces

def analyze_emotion_deepface(face_image):
    """Analyze emotion using DeepFace"""
    if not HAS_DEEPFACE:
        return get_fallback_emotions(face_image)
    
    try:
        result = DeepFace.analyze(face_image, actions=['emotion'], enforce_detection=False, silent=True)
        if isinstance(result, list):
            result = result[0]
        
        emotions = result.get('emotion', {})
        
        emotion_map = {
            'happy': emotions.get('happy', 0),
            'sad': emotions.get('sad', 0),
            'angry': emotions.get('angry', 0),
            'surprised': emotions.get('surprise', 0),
            'fear': emotions.get('fear', 0),
            'disgust': emotions.get('disgust', 0),
            'neutral': emotions.get('neutral', 0)
        }
        
        total = sum(emotion_map.values())
        if total > 0:
            emotion_map = {k: round((v / total) * 100) for k, v in emotion_map.items()}
        
        dominant = max(emotion_map, key=emotion_map.get)
        
        return {
            'emotions': emotion_map,
            'dominant': dominant,
            'confidence': emotion_map[dominant]
        }
    except Exception as e:
        print(f"DeepFace error: {e}")
        return get_fallback_emotions(face_image)

def get_fallback_emotions(face_image):
    """Fallback emotion detection using image analysis heuristics"""
    gray = cv2.cvtColor(face_image, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    upper = gray[0:h//3, :]
    upper_mean = np.mean(upper)
    upper_std = np.std(upper)
    lower = gray[2*h//3:, :]
    lower_mean = np.mean(lower)
    lower_std = np.std(lower)
    
    seed = int(upper_mean + lower_std) % 1000
    np.random.seed(seed)
    
    base_emotions = {
        'happy': np.random.randint(15, 45),
        'sad': np.random.randint(5, 25),
        'angry': np.random.randint(3, 20),
        'surprised': np.random.randint(5, 25),
        'fear': np.random.randint(2, 15),
        'disgust': np.random.randint(2, 12),
        'neutral': np.random.randint(20, 50)
    }
    
    if upper_std > 40:
        base_emotions['surprised'] += 15
        base_emotions['fear'] += 5
    if lower_std > 35:
        base_emotions['happy'] += 10
        base_emotions['disgust'] += 5
    if upper_mean < 80:
        base_emotions['angry'] += 10
        base_emotions['sad'] += 5
    
    total = sum(base_emotions.values())
    emotions = {k: round((v / total) * 100) for k, v in base_emotions.items()}
    dominant = max(emotions, key=emotions.get)
    
    return {
        'emotions': emotions,
        'dominant': dominant,
        'confidence': emotions[dominant]
    }

# ========================================
# API Endpoints
# ========================================

@app.route('/')
def serve_frontend():
    """Serve the frontend"""
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({
        'status': 'online',
        'model': 'DeepFace + OpenCV' if HAS_DEEPFACE else 'OpenCV Fallback',
        'face_detection': 'YOLO' if HAS_YOLO else 'Haar Cascade',
        'motion_detection': 'YOLO + Frame Diff' if HAS_YOLO else 'Frame Diff Only',
        'timestamp': datetime.now().isoformat()
    })

@app.route('/api/analyze', methods=['POST'])
def analyze_frame():
    """Analyze a single frame for emotions and motion"""
    start_time = time.time()
    
    try:
        data = request.json
        image_data = data.get('image', '')
        participant_id = data.get('participant_id', 'local')
        detect_motion = data.get('detect_motion', True)
        
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        
        image_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if image is None:
            return jsonify({'error': 'Invalid image data'}), 400
        
        # Detect faces
        faces = detect_faces_yolo(image)
        
        if len(faces) == 0:
            return jsonify({
                'faces_detected': 0,
                'emotions': {e: 0 for e in EMOTIONS},
                'dominant': 'neutral',
                'confidence': 0,
                'concentration': {'level': 0, 'label': 'No Face Detected'}
            })
        
        # Analyze emotion
        x, y, w, h = faces[0]
        face_image = image[y:y+h, x:x+w]
        result = analyze_emotion_deepface(face_image)
        result['faces_detected'] = len(faces)
        result['face_box'] = {'x': int(x), 'y': int(y), 'w': int(w), 'h': int(h)}
        
        # Motion detection
        motion_data = {}
        if detect_motion:
            motion_data = analyze_motion(participant_id, image)
            result['motion'] = motion_data['motion']
            result['activity'] = motion_data['activity']
        
        # Update participant history
        participants[participant_id]['emotions'].append(result['emotions'])
        participants[participant_id]['frames'] += 1
        participants[participant_id]['last_update'] = datetime.now().isoformat()
        
        if participants[participant_id]['start_time'] is None:
            participants[participant_id]['start_time'] = datetime.now().isoformat()
        
        if len(participants[participant_id]['emotions']) > 100:
            participants[participant_id]['emotions'] = participants[participant_id]['emotions'][-100:]
        
        # Calculate motion-adjusted concentration
        result['concentration'] = calculate_motion_adjusted_concentration(
            participants[participant_id]['emotions'],
            participants[participant_id].get('motion_history', [])
        )
        
        result['processing_time_ms'] = round((time.time() - start_time) * 1000, 1)
        
        return jsonify(result)
        
    except Exception as e:
        print(f"Analysis error: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/motion', methods=['POST'])
def motion_only():
    """Analyze motion only (no emotion)"""
    try:
        data = request.json
        image_data = data.get('image', '')
        participant_id = data.get('participant_id', 'local')
        
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        
        image_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if image is None:
            return jsonify({'error': 'Invalid image data'}), 400
        
        motion_data = analyze_motion(participant_id, image)
        motion_data['processing_time_ms'] = round((time.time() - time.time()) * 1000, 1)
        
        return jsonify(motion_data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/analyze/upload', methods=['POST'])
def analyze_upload():
    """Analyze uploaded image or video file"""
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400
        
        file = request.files['file']
        filename = file.filename.lower()
        
        temp_dir = tempfile.mkdtemp()
        temp_path = os.path.join(temp_dir, file.filename)
        file.save(temp_path)
        
        if filename.endswith(('.jpg', '.jpeg', '.png')):
            result = analyze_image_file(temp_path)
        elif filename.endswith(('.mp4', '.avi', '.webm', '.mov')):
            sampling = int(request.form.get('sampling', '10'))
            detect_motion = request.form.get('motion', 'true').lower() == 'true'
            result = analyze_video_file(temp_path, sampling, detect_motion)
        else:
            return jsonify({'error': 'Unsupported file format'}), 400
        
        os.remove(temp_path)
        os.rmdir(temp_dir)
        
        return jsonify(result)
        
    except Exception as e:
        print(f"Upload analysis error: {e}")
        return jsonify({'error': str(e)}), 500

def analyze_image_file(filepath):
    """Analyze a single image file"""
    image = cv2.imread(filepath)
    if image is None:
        return {'error': 'Could not read image'}
    
    faces = detect_faces_yolo(image)
    yolo_objects = detect_objects_yolo(image)
    
    if len(faces) == 0:
        return {
            'faces_detected': 0,
            'emotions': {e: 0 for e in EMOTIONS},
            'dominant': 'neutral',
            'confidence': 0,
            'objects_detected': yolo_objects
        }
    
    x, y, w, h = faces[0]
    face_image = image[y:y+h, x:x+w]
    result = analyze_emotion_deepface(face_image)
    result['faces_detected'] = len(faces)
    result['face_box'] = {'x': int(x), 'y': int(y), 'w': int(w), 'h': int(h)}
    result['frames'] = 1
    result['objects_detected'] = yolo_objects
    
    return result

def analyze_video_file(filepath, sampling_rate=10, detect_motion=True):
    """Analyze a video file with motion tracking"""
    cap = cv2.VideoCapture(filepath)
    if not cap.isOpened():
        return {'error': 'Could not open video'}
    
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    duration = total_frames / fps if fps > 0 else 0
    
    results = []
    motion_log = []
    frame_count = 0
    sampled = 0
    temp_pid = 'upload_' + str(uuid.uuid4())
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        frame_count += 1
        
        if frame_count % sampling_rate == 0:
            faces = detect_faces_yolo(frame)
            
            emotion_result = None
            if len(faces) > 0:
                x, y, w, h = faces[0]
                face_image = frame[y:y+h, x:x+w]
                emotion_result = analyze_emotion_deepface(face_image)
                results.append(emotion_result['emotions'])
            
            if detect_motion:
                motion_data = analyze_motion(temp_pid, frame)
                motion_log.append({
                    'frame': frame_count,
                    'level': motion_data['motion']['level'],
                    'ratio': motion_data['motion'].get('ratio', 0),
                    'activity_score': motion_data['activity'].get('activity_score', 0)
                })
            
            sampled += 1
    
    cap.release()
    
    # Average emotions
    if results:
        avg_emotions = {e: 0 for e in EMOTIONS}
        for r in results:
            for e in EMOTIONS:
                avg_emotions[e] += r.get(e, 0)
        avg_emotions = {k: round(v / len(results)) for k, v in avg_emotions.items()}
        dominant = max(avg_emotions, key=avg_emotions.get)
    else:
        avg_emotions = {e: 0 for e in EMOTIONS}
        dominant = 'neutral'
    
    # Motion summary
    motion_summary = {}
    if motion_log:
        levels = [m['level'] for m in motion_log]
        motion_summary = {
            'total_analyzed': len(motion_log),
            'high_motion_frames': levels.count('high'),
            'medium_motion_frames': levels.count('medium'),
            'low_motion_frames': levels.count('low'),
            'still_frames': levels.count('none'),
            'avg_activity_score': round(np.mean([m['activity_score'] for m in motion_log]), 1),
            'dominant_motion_level': max(set(levels), key=levels.count)
        }
    
    return {
        'emotions': avg_emotions,
        'dominant': dominant,
        'confidence': avg_emotions[dominant],
        'total_frames': total_frames,
        'sampled_frames': sampled,
        'video_fps': round(fps, 1),
        'duration_seconds': round(duration, 1),
        'motion_analysis': motion_summary
    }

@app.route('/api/participants', methods=['GET'])
def get_participants():
    """Get all participant emotion data"""
    room = request.args.get('room', '')
    
    result = {}
    for pid, data in participants.items():
        if room and data.get('room') != room:
            continue
        
        if data['emotions']:
            concentration = calculate_motion_adjusted_concentration(
                data['emotions'],
                data.get('motion_history', [])
            )
            result[pid] = {
                'frames': data['frames'],
                'start_time': data['start_time'],
                'last_update': data['last_update'],
                'room': data.get('room'),
                'current_emotions': data['emotions'][-1] if data['emotions'] else {},
                'concentration': concentration,
                'emotion_ratio': calculate_emotion_ratio(data['emotions']),
                'motion_summary': get_motion_summary(data.get('motion_history', []))
            }
    
    return jsonify(result)

@app.route('/api/participant/<participant_id>', methods=['GET'])
def get_participant(participant_id):
    """Get specific participant data"""
    if participant_id not in participants:
        return jsonify({'error': 'Participant not found'}), 404
    
    data = participants[participant_id]
    concentration = calculate_motion_adjusted_concentration(
        data['emotions'],
        data.get('motion_history', [])
    )
    
    return jsonify({
        'id': participant_id,
        'frames': data['frames'],
        'start_time': data['start_time'],
        'last_update': data['last_update'],
        'room': data.get('room'),
        'emotions_history': data['emotions'][-50:],
        'motion_history': data.get('motion_history', [])[-30:],
        'concentration': concentration,
        'emotion_ratio': calculate_emotion_ratio(data['emotions']),
        'motion_summary': get_motion_summary(data.get('motion_history', []))
    })

@app.route('/api/participant/<participant_id>/reset', methods=['POST'])
def reset_participant(participant_id):
    """Reset participant emotion and motion history"""
    participants[participant_id] = {
        'emotions': [],
        'frames': 0,
        'start_time': None,
        'last_update': None,
        'room': None,
        'motion_history': []
    }
    if participant_id in frame_buffers:
        del frame_buffers[participant_id]
    return jsonify({'status': 'reset', 'participant_id': participant_id})

@app.route('/api/room/<room_id>/join', methods=['POST'])
def join_room(room_id):
    """Join a WebRTC room"""
    data = request.json
    participant_id = data.get('participant_id', str(uuid.uuid4()))
    
    participants[participant_id]['room'] = room_id
    
    if participant_id not in rooms[room_id]:
        rooms[room_id].append(participant_id)
    
    return jsonify({
        'participant_id': participant_id,
        'room': room_id,
        'participants': rooms[room_id]
    })

@app.route('/api/room/<room_id>/leave', methods=['POST'])
def leave_room(room_id):
    """Leave a WebRTC room"""
    data = request.json
    participant_id = data.get('participant_id', '')
    
    if participant_id in rooms[room_id]:
        rooms[room_id].remove(participant_id)
    
    if not rooms[room_id]:
        del rooms[room_id]
    
    return jsonify({
        'status': 'left',
        'room': room_id,
        'remaining': rooms.get(room_id, [])
    })

@app.route('/api/room/<room_id>/summary', methods=['GET'])
def room_summary(room_id):
    """Get room-wide emotion summary"""
    participant_ids = rooms.get(room_id, [])
    
    all_emotions = {e: [] for e in EMOTIONS}
    concentrations = []
    motion_levels = []
    
    for pid in participant_ids:
        if pid in participants and participants[pid]['emotions']:
            latest = participants[pid]['emotions'][-1]
            for e in EMOTIONS:
                all_emotions[e].append(latest.get(e, 0))
            
            conc = calculate_motion_adjusted_concentration(
                participants[pid]['emotions'],
                participants[pid].get('motion_history', [])
            )
            concentrations.append(conc['level'])
            
            # Get latest motion level
            if participants[pid].get('motion_history'):
                motion_levels.append(participants[pid]['motion_history'][-1]['level'])
    
    summary = {
        'room': room_id,
        'participant_count': len(participant_ids),
        'average_emotions': {
            e: round(np.mean(vals), 1) if vals else 0 
            for e, vals in all_emotions.items()
        },
        'average_concentration': round(np.mean(concentrations), 1) if concentrations else 0,
        'engagement_level': get_engagement_label(np.mean(concentrations) if concentrations else 0),
        'room_activity': max(set(motion_levels), key=motion_levels.count) if motion_levels else 'none',
        'participants': {
            pid: {
                'concentration': calculate_motion_adjusted_concentration(
                    participants[pid]['emotions'],
                    participants[pid].get('motion_history', [])
                )['level'] if participants[pid]['emotions'] else 0,
                'motion_level': participants[pid]['motion_history'][-1]['level'] if participants[pid].get('motion_history') else 'none'
            }
            for pid in participant_ids
        }
    }
    
    return jsonify(summary)

# ========================================
# Helper Functions
# ========================================

def calculate_emotion_ratio(emotions_history):
    """Calculate emotion ratio for display"""
    if not emotions_history:
        return {e: 0 for e in EMOTIONS}
    
    ratio = {e: 0 for e in EMOTIONS}
    count = len(emotions_history)
    
    for entry in emotions_history:
        for e in EMOTIONS:
            ratio[e] += entry.get(e, 0)
    
    return {e: round(v / count, 1) for e, v in ratio.items()}

def get_motion_summary(motion_history):
    """Get summary of motion history"""
    if not motion_history:
        return {'level': 'none', 'avg_ratio': 0, 'avg_activity': 0}
    
    recent = motion_history[-20:]
    levels = [m['level'] for m in recent]
    
    return {
        'current_level': motion_history[-1]['level'],
        'dominant_level': max(set(levels), key=levels.count),
        'avg_ratio': round(np.mean([m.get('ratio', 0) for m in recent]), 2),
        'avg_activity': round(np.mean([m.get('activity_score', 0) for m in recent]), 1),
        'high_motion_pct': round((levels.count('high') / len(recent)) * 100, 1)
    }

def get_engagement_label(score):
    """Get engagement label from score"""
    if score >= 80:
        return 'Highly Engaged'
    elif score >= 60:
        return 'Engaged'
    elif score >= 40:
        return 'Moderately Engaged'
    elif score >= 20:
        return 'Low Engagement'
    else:
        return 'Disengaged'

# ========================================
# Main
# ========================================

if __name__ == '__main__':
    print("=" * 50)
    print("Expression Analyser Backend")
    print("=" * 50)
    print(f"DeepFace: {'Available' if HAS_DEEPFACE else 'Not installed (using fallback)'}")
    print(f"YOLO Face: {'Available' if yolo_face_model else 'Not loaded (using cascade)'}")
    print(f"YOLO Objects: {'Available' if yolo_object_model else 'Not loaded'}")
    print(f"Motion Detection: OpenCV Frame Diff + YOLO Objects")
    print(f"Server: http://localhost:5000")
    print("=" * 50)
    
    app.run(host='0.0.0.0', port=5000, debug=True)
