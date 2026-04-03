@echo off
echo ========================================
echo Expression Analyser - Backend Setup
echo ========================================
echo.

echo [1/4] Creating virtual environment...
python -m venv venv
call venv\Scripts\activate

echo.
echo [2/4] Upgrading pip...
python -m pip install --upgrade pip

echo.
echo [3/4] Installing core dependencies...
pip install flask flask-cors opencv-python numpy

echo.
echo ========================================
echo Basic setup complete!
echo ========================================
echo.
echo To add AI expression recognition, run:
echo   pip install deepface tensorflow keras
echo.
echo To add YOLO face detection, run:
echo   pip install ultralytics
echo.
echo Then start the server:
echo   cd backend
echo   python app.py
echo ========================================
pause
