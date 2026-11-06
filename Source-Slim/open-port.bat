@echo off
chcp 65001 >nul
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall add rule name="SYSTEM HTTPS 4000" dir=in action=allow protocol=TCP localport=4000 profile=private
if %errorlevel% neq 0 (
  echo Failed to add the private-network firewall rule for port 4000.
  pause
  exit /b 1
)
echo Private-network access for HTTPS port 4000 is enabled.
pause