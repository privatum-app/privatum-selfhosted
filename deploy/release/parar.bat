@echo off
rem Privatum: stops the instance. Data and the .onion address are kept.
cd /d "%~dp0"
docker compose down
if not errorlevel 1 echo Privatum parado. Seus dados e o endereco .onion foram mantidos.
pause
