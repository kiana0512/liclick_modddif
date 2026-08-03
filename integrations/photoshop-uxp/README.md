# LIclick Live Texture Photoshop bridge

This UXP plugin is the Photoshop side of LIclick's external texture editor.

- It starts with Photoshop and reconnects to the local texture component at `127.0.0.1:4618` automatically.
- LIclick owns projection/UV metadata; Photoshop owns pixels during an edit session.
- Working PSD files and immutable PNG revisions live under the LIclick workspace.
- Control traffic uses WebSocket; image pixels stay on disk and are never sent as Base64.

During development, load this directory with Adobe UXP Developer Tool. For distribution,
package it as a `.ccx` using Adobe UXP Developer Tool and place the result under
`dist-plugins/LIclick Live Texture.ccx` before creating the Windows installer.
