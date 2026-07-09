# Draggable Dock Panels

Phase 7 polishes the draggable dock implementation.

## Scope

Panels can be dragged by the header handle:

- reorder within the same dock;
- move from left dock to right dock;
- move from right dock to left dock.

Panels do not freely float over the viewport yet. They always snap to the left or right dock.

Only the right-side handle in the panel header starts a drag. Clicking the collapse chevron, title area, or panel controls does not start a panel move.

## Implementation

The current implementation uses native HTML drag/drop instead of adding a dependency. This keeps the phase small and avoids new package review risk. `WorkspacePanelHeader` writes the dragged `panelId` to `dataTransfer` and sets `dragInteractionStore.activeDragType = 'panel'`. `WorkspaceDock` receives drops and calls:

```ts
reorderPanel(panelId, dock, beforePanelId)
```

The layout store normalizes dock order to increments of 10 and persists the layout to localStorage.

During drag:

- the dragged panel scales slightly, fades, and receives a pink / purple glow;
- the valid left or right dock highlights when hovered;
- dropping on a panel reorders before that panel;
- dropping on the dock background appends to that dock;
- dropping outside a dock does not change the saved layout.

## Drag Type Isolation

`apps/web/src/stores/dragInteractionStore.ts` tracks:

- `activeDragType: 'none' | 'panel' | 'model-file' | 'asset-file'`
- `isPanelDragging`
- `isFileDragging`

The viewport import overlay checks this store and only appears for real model file drags (`.glb`, `.gltf`, `.fbx`, `.obj`, `.stl`). A panel drag sets `activeDragType='panel'`, so dragging panels over the viewport no longer shows `Drop model to import`.

This split also leaves room for future reference-image asset drops without accidentally activating model import.

## Reset

The editor header exposes `Reset Layout`, which calls `resetWorkspaceLayout()` and restores default panel order, side, collapse state, and mode.

## Current Limits

- Mobile panel drag/drop is disabled; mobile uses dock drawers.
- No arbitrary viewport-positioned floating panels.
- No keyboard-accessible panel reorder yet.

## Next Step

A later phase can replace native drag/drop with `@dnd-kit/core` and `@dnd-kit/sortable` if richer keyboard and touch behavior is needed.
