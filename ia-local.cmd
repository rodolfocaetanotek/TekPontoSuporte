@echo off
rem Sobe o Ollama portatil (IA local gratuita) com os modelos guardados em .tools\ollama\models
cd /d "%~dp0"
set OLLAMA_MODELS=%~dp0.tools\ollama\models
set OLLAMA_HOST=127.0.0.1:11434
.tools\ollama\ollama.exe serve
