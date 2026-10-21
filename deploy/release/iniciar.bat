@echo off
rem Privatum: starts the instance and opens the page with its .onion address.
setlocal
cd /d "%~dp0"
title Privatum

where docker >nul 2>nul
if errorlevel 1 goto nodocker

docker info >nul 2>nul
if not errorlevel 1 goto start
echo Iniciando o Docker Desktop...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
set /a n=0
:waitdocker
timeout /t 2 /nobreak >nul
docker info >nul 2>nul
if not errorlevel 1 goto start
set /a n+=1
if %n% lss 90 goto waitdocker
echo O Docker nao respondeu. Abra o Docker Desktop e tente de novo.
goto fail

:start
echo Iniciando o Privatum. Na primeira vez ele baixa as imagens; pode levar alguns minutos...
docker compose up -d
if errorlevel 1 goto upfailed
echo Aguardando o endereco .onion...
set "HOST="
set /a n=0
:waithost
for /f "delims=" %%h in ('docker compose exec -T tor cat /run/onion/hostname 2^>nul') do set "HOST=%%h"
if defined HOST goto ready
set /a n+=1
if %n% geq 90 goto nohost
timeout /t 2 /nobreak >nul
goto waithost

:ready
echo.
echo Seu Privatum esta no ar:  http://%HOST%
echo Abra este endereco no Tor Browser, no nivel de seguranca Standard.
if not defined PRIVATUM_INFO_PORT set "PRIVATUM_INFO_PORT=8099"
start "" "http://127.0.0.1:%PRIVATUM_INFO_PORT%"
echo O Privatum continua rodando em segundo plano depois que esta janela for fechada.
pause
exit /b 0

:upfailed
echo Nao foi possivel iniciar o Privatum.
goto fail

:nohost
echo O Tor ainda nao publicou o endereco. Rode este atalho de novo em alguns minutos.
goto fail

:nodocker
echo O Docker Desktop nao esta instalado.
echo Baixe em: https://docs.docker.com/desktop/setup/install/windows-install/
start "" "https://docs.docker.com/desktop/setup/install/windows-install/"

:fail
pause
exit /b 1
