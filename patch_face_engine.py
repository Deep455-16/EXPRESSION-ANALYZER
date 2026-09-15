import re

with open('scripts/face-engine.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Add _computeAttention before _analyzeLocally
compute_att = '''
  _computeAttention(landmarks) {
    if (!landmarks) return null;
    const pts = landmarks.positions;
    if (pts.length < 68) return null;
    
    let leftEyeX = 0, leftEyeY = 0;
    for (let i = 36; i <= 41; i++) { leftEyeX += pts[i].x; leftEyeY += pts[i].y; }
    leftEyeX /= 6; leftEyeY /= 6;

    let rightEyeX = 0, rightEyeY = 0;
    for (let i = 42; i <= 47; i++) { rightEyeX += pts[i].x; rightEyeY += pts[i].y; }
    rightEyeX /= 6; rightEyeY /= 6;

    const nose = pts[30];
    const midEyeX = (leftEyeX + rightEyeX) / 2;
    const midEyeY = (leftEyeY + rightEyeY) / 2;
    const eyeDist = Math.hypot(rightEyeX - leftEyeX, rightEyeY - leftEyeY);
    if (eyeDist === 0) return 0;
    
    const yawDeg = ((nose.x - midEyeX) / eyeDist) * 90;
    const pitchDeg = (((nose.y - midEyeY) / eyeDist) - 0.65) * 100;
    
    const penalty = (Math.abs(yawDeg) / 45 + Math.abs(pitchDeg) / 30) / 2;
    return Math.round(100 * Math.max(0, 1 - penalty));
  },
  
  async _analyzeLocally'''

content = content.replace('async _analyzeLocally', compute_att)

# Chain .withFaceLandmarks()
content = content.replace('.withFaceExpressions();', '.withFaceLandmarks().withFaceExpressions();')

# Use landmarks for attention
content = re.sub(
    r'const face_emotions = detections\.map\(d => \{',
    'let attentionVal = null;\\n      if (detections.length > 0 && detections[0].landmarks) {\\n        attentionVal = this._computeAttention(detections[0].landmarks);\\n      }\\n\\n      const face_emotions = detections.map(d => {',
    content
)

# Replace attention output
content = re.sub(
    r'attention: face_emotions\.length > 0 \? 70 \+ Math\.floor\(Math\.random\(\) \* 25\) : 0,',
    'attention: attentionVal,',
    content
)

# Replace mock attention output with null
content = re.sub(
    r'attention: 50 \+ Math\.floor\(Math\.random\(\) \* 45\),',
    'attention: null,',
    content
)

with open('scripts/face-engine.js', 'w', encoding='utf-8') as f:
    f.write(content)

