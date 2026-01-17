@echo off
set "VERSION=v1.0"
set "NAME=SearchBookmarksFast_%VERSION%"
set "DIST=dist"

echo ------------------------------------------
echo  Packaging %NAME% ...
echo ------------------------------------------

:: 1. Clean previous build
if exist "%DIST%" rd /s /q "%DIST%"
if exist "%NAME%.zip" del "%NAME%.zip"

:: 2. Create Directory Structure
mkdir "%DIST%"
mkdir "%DIST%\icons"
mkdir "%DIST%\src"

:: 3. Copy Production Files (Allowlist)
echo Copying Manifest and source code...
copy manifest.json "%DIST%\" >nul
copy src\popup.html "%DIST%\src\" >nul
copy src\popup.css "%DIST%\src\" >nul
copy src\popup.js "%DIST%\src\" >nul
copy src\background.js "%DIST%\src\" >nul

echo Copying Icons...
xcopy /s /y icons "%DIST%\icons" >nul

:: 4. Minification (Optional - requires Node.js)
:: If you have Node installed, uncomment lines below to minify
:: echo Minifying JS...
:: call npx terser popup.js -o "%DIST%\popup.js" --compress --mangle
:: call npx terser background.js -o "%DIST%\background.js" --compress --mangle

:: 5. Zip It Up
echo Creating Zip Archive...
powershell -Command "Compress-Archive -Path '%DIST%\*' -DestinationPath '%NAME%.zip'"

echo ------------------------------------------
echo  Build Success! 
echo  Output: %NAME%.zip
echo ------------------------------------------
pause
