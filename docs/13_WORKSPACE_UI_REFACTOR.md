# Workspace UI Refactor

Phase 5 moves the editor from a fixed three-column layout to a viewport-first floating dock workspace.

## Why Change The Layout

The previous editor kept left and right sidebars open at full height. That made the Web3D viewport feel cramped and forced every feature to compete for attention. The new layout keeps the viewport as the primary surface and overlays compact dock panels only where needed.

This is a UI/UX refactor only. It does not replace import, capture, projection, bake, save, or transform engine logic.

## Panel System

Workspace UI lives under `apps/web/src/components/workspace/`:

- `WorkspacePanel.tsx`: glass card shell.
- `WorkspacePanelHeader.tsx`: collapse arrow, title, actions, drag handle.
- `WorkspacePanelBody.tsx`: local body scroll.
- `WorkspaceDock.tsx`: ordered left/right dock renderer.
- `WorkspaceModeShell.tsx`: compact empty-state shell for mode placeholders.
- `workspacePanelTypes.ts`: `DockSide`, `PanelId`, `WorkspaceMode`, and panel state types.
- `workspaceLayoutStore.ts`: Zustand store with localStorage persistence.
- `stores/dragInteractionStore.ts`: separates panel drags from model / asset file drags.

The store supports:

- `togglePanelCollapsed(panelId)`
- `setPanelCollapsed(panelId, collapsed)`
- `showPanel(panelId)`
- `hidePanel(panelId)`
- `movePanel(panelId, dock, order)`
- `reorderPanel(panelId, dock, beforePanelId)`
- `resetWorkspaceLayout()`
- `setMode(mode)`
- `setDockDensity('compact' | 'normal')`

Phase 7 keeps the native drag/drop implementation for dock reorder and left/right snapping. It is intentionally dock-based, not free-floating, because the viewport must stay the primary editing surface and panels should never be lost in the center canvas.

Dock widths:

- Normal: left 320px, right 400px.
- Compact: left 300px, right 360px.

The density setting is exposed in Settings and persisted with the workspace layout.

The editor header and bottom toolbar are viewport overlays, not separate layout rows. Top project and function controls are grouped on the left so the right-top ViewCube stays visible. If every panel in a dock is collapsed, that dock aligns its collapsed headers to the bottom, matching a Modddif-style tucked workspace state.

## Default Texture Mode Panels

Left dock:

- Segments: collapsed entry.
- Quick Mask: collapsed entry.
- Objects: collapsed entry.
- Generate: expanded working panel.
- References: collapsed / secondary reference panel.

Right dock:

- Layer Adjustments: first, expanded when useful.
- Viewport: expanded.
- Layers: expanded.
- Object Transform: collapsed until Move / Rotate / Scale is active.

## Contextual Panel Defaults

The default editor layout stays viewport-first and quiet. It follows the Modddif-style interaction model: show the model and the current task first, then unfold deeper controls only when the user asks for that workflow.

## Normal Mode

Normal mode switches the viewport to normal display and shows:

- Normal Visualizer.
- Normal Generation placeholder.

Normal colors are surface-normal debug colors, not final texture output.

## Segments Mode

Segments mode shows:

- Quick Mask placeholder.
- Segments placeholder.

Quick Mask and segmentation are no longer shown in Texture mode by default.

## Export Mode

Export mode shows:

- Scene GLB quick export.
- Viewport PNG snapshot.
- BaseColor download when a baked texture exists.

The full header Export menu exposes Scene, Object, Texture, and Video export groups.

The top Export button switches to Export mode rather than firing a toast.

## Coming Soon Behavior

Unimplemented features should not flood the UI with toasts.

- Prefer disabled buttons with a `title` tooltip.
- If a placeholder must be clickable, route it through `features/commandRegistry.ts`.
- Coming-soon toasts are deduped per command for 3 seconds.
- Toasts appear at the bottom-right and are capped at three visible messages.
- Copy should be short, for example `Coming soon: GLB export`.

## Current Cleanup

- Mock layers no longer seed the active editor layer store.
- Real projects without layers show a Base Layer plus a short empty state.
- Object selection is synchronized so the Object Transform panel does not show `No object selected` while an imported model is selected.

## Reset Layout

The editor header includes `Reset Layout`, which restores the default mode, dock, order, visibility, and collapsed states.
