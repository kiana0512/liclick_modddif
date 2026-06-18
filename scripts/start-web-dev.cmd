@echo off
cd /d "%~dp0.."
corepack pnpm --filter @liclick/web dev -- --port 5173 > dev-server.log 2> dev-server.err.log
