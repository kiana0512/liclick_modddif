# LIclick Live Texture Photoshop bridge

This UXP plugin is the Photoshop side of LIclick's external texture editor.

- It starts with Photoshop and reconnects to the local texture component at `127.0.0.1:4618` automatically.
- LIclick owns projection/UV metadata; Photoshop owns pixels during an edit session.
- Working PSD files and immutable PNG revisions live under the LIclick workspace.
- Control traffic uses WebSocket; image pixels stay on disk and are never sent as Base64.

During development, load this directory with Adobe UXP Developer Tool. The repo's
current distribution command is:

```bash
corepack pnpm package:photoshop
```

The Photoshop package and the Windows Local Component are separate artifacts; the
retired full Electron desktop installer is not part of the current release path.
