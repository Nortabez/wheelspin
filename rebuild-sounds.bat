@echo off
REM Run this after adding/removing sound files from the sounds/ folder
REM It regenerates sounds/sounds.js with the current file list

setlocal enabledelayedexpansion
set first=1
set "list="
set q="
for %%f in (sounds\*.mp3 sounds\*.wav sounds\*.ogg) do (
    if !first!==0 set "list=!list!,"
    set "list=!list!!q!%%~nxf!q!"
    set first=0
)
>sounds\sounds.js echo window.SOUND_FILES = [!list!];
echo Done. sounds\sounds.js updated.
