# LIclick Photoshop CEP bridge

Offline Photoshop 2024 adapter used when Creative Cloud / UPIA / UXP Developer Tool is unavailable.

- User-level install path: `%APPDATA%\Adobe\CEP\extensions\com.liclick.live-texture`
- Required debug registry value for this unsigned local build: `HKCU\Software\Adobe\CSXS.11\PlayerDebugMode=1`
- Transport: local WebSocket on `127.0.0.1:4617`
- Pixel transport: local session PNG files, never internet or Base64

The CEP panel starts on Photoshop's `applicationActivate` event, connects without a manual Window menu
action, opens LIclick source images through ExtendScript, keeps an editable PSD, polls document history
without blocking Photoshop, and exports immutable composite PNG revisions back to LIclick.
