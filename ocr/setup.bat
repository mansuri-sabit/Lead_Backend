@echo off
echo ============================================
echo  PaddleOCR Setup for Lead Capture
echo ============================================
echo.
echo This will install Python dependencies for the
echo PaddleOCR engine used by Lead Capture.
echo.
echo Requirements:
echo   - Python 3.10+
echo   - Internet access on first run to download model files
echo.

REM Try python first, then python3
where python >nul 2>&1
if %errorlevel% equ 0 (
    set PYTHON=python
) else (
    where python3 >nul 2>&1
    if %errorlevel% equ 0 (
        set PYTHON=python3
    ) else (
        echo ERROR: Python not found in PATH!
        exit /b 1
    )
)

echo Using: %PYTHON%
%PYTHON% --version
echo.

echo [1/2] Installing Python dependencies...
%PYTHON% -m pip install -r requirements.txt --quiet
if %errorlevel% neq 0 (
    echo ERROR: pip install failed!
    exit /b 1
)

echo [2/2] Verifying PaddleOCR import...
%PYTHON% -c "from paddleocr import PaddleOCR; print('PaddleOCR import OK')"
if %errorlevel% neq 0 (
    echo WARNING: PaddleOCR import check failed.
)

echo.
echo ============================================
echo  Setup complete! PaddleOCR will be used
echo  automatically by the Lead Capture pipeline.
echo ============================================
