@echo off
echo ==========================================
echo   AEGIS DUAL-STATE ENGINE - STABLE TUNNEL
echo ==========================================
echo.
echo Starting Stable Cloudflare Tunnel on Port 8081...
echo.

:: Using the correct Cloudflare tunnel command
npx cloudflared tunnel --url http://localhost:8081

echo.
echo ------------------------------------------
echo SUCCESS! OPEN THE URL ABOVE ON YOUR PHONE
echo ------------------------------------------
pause
