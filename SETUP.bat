@echo off
setlocal
echo ==================================================
echo CLUBIQ SETUP - EINZELNE DATEI SYSTEM START
echo ==================================================

:: 1. Erstelle die Dateistruktur und Dateien via PowerShell
powershell -Command "
    $dir = 'C:\Users\floh5\clubiq_music_dev';
    Set-Location -Path $dir;
    
    'fastapi`nuvicorn`npsycopg`napscheduler`nrequests`npython-dotenv`npydantic' | Out-File requirements.txt -Encoding utf8;

    @'
import uvicorn
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

app = FastAPI()

@app.get('/')
def home():
    with open('index.html', 'r', encoding='utf-8') as f:
        return HTMLResponse(f.read())

if __name__ == '__main__':
    uvicorn.run('main:app', host='127.0.0.1', port=8000, reload=True)
'@ | Out-File main.py -Encoding utf8;

    @'
<!DOCTYPE html>
<html>
<body style='background:#111; color:#fff; text-align:center; padding-top:50px;'>
    <h1>Clubiq System läuft!</h1>
    <p>Das System wurde erfolgreich installiert und gestartet.</p>
</body>
</html>
'@ | Out-File index.html -Encoding utf8;
"

:: 2. Venv erstellen und installieren
echo Erstelle virtuelle Umgebung...
python -m venv venv
call venv\Scripts\activate

echo Installiere Pakete...
pip install -r requirements.txt

echo ==================================================
echo SETUP KOMPLETT. STARTE SYSTEM...
echo ==================================================
uvicorn main:app --reload
pause