# Expression Analyser

A simple web application for real-time facial expression analysis. Built with HTML, CSS, and JavaScript.

## How to Start

### Option 1: Using Python (Recommended)

1. Open terminal in the project folder
2. Run:
   ```bash
   python3 -m http.server 8000
   ```
3. Open browser and go to: `http://localhost:8000`

### Option 2: Using Node.js

1. Open terminal in the project folder
2. Run:
   ```bash
   npx http-server -p 8000
   ```
3. Open browser and go to: `http://localhost:8000`

### Option 3: Direct Open

Simply double-click `index.html` to open in your browser (some features may not work without a server).

## Features

- **Live Analysis**: Real-time emotion detection from webcam
- **Upload**: Analyze images and videos
- **Dashboard**: View session statistics and charts
- **Settings**: Customize preferences

## Requirements

- Modern web browser (Chrome, Firefox, Edge, Safari)
- Webcam (for live analysis)
- JavaScript enabled

## Project Structure

```
Expression analyser/
├── index.html          # Home page
├── live.html           # Live analysis
├── upload.html         # File upload
├── dashboard.html      # Analytics dashboard
├── settings.html       # Settings
├── scripts/            # JavaScript files
└── styles/             # CSS files
```

## Notes

- All processing happens locally in your browser
- No data is sent to external servers
- Works offline after initial load
