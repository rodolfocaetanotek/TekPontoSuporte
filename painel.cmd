@echo off
cd /d "%~dp0"
if not exist .env (
  echo Arquivo .env nao encontrado. Copie .env.exemplo para .env e preencha.
  pause
  exit /b 1
)
start "" http://localhost:4250
node src\server.mjs
pause
