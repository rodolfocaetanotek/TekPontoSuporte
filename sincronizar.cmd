@echo off
cd /d "%~dp0"
node src\sync.mjs %* >> logs\sincronizacao.log 2>&1
