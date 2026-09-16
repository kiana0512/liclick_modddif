import React from 'react';
import { createRoot } from 'react-dom/client';
import { TextureOnboardingTour } from '/src/components/editor/TextureOnboardingTour.tsx';
import { EditorShell } from '/src/layouts/EditorShell.tsx';
import { WorkflowModuleSwitcher } from '/src/features/workflow/WorkflowModuleSwitcher.tsx';
import { useWorkspaceLayoutStore } from '/src/components/workspace/workspaceLayoutStore.ts';
import '/src/styles/globals.css';
const host = document.createElement('div');
document.body.append(host);
document.body.style.background = '#080914';
const targets = [
  'import-model',
  'reference-images',
  'generate-texture',
  'single-view',
  'repaint-mask',
  'repaint-generate',
  'repaint-apply',
];
for (const [index, name] of targets.entries()) {
  const button = document.createElement('button');
  button.dataset.textureOnboarding = name;
  button.dataset.onboardingComplete = 'false';
  button.dataset.onboardingGeneration = 'existing';
  button.dataset.onboardingView = 'single';
  button.textContent = name;
  button.style.cssText = `position:fixed;left:24px;top:${100 + index * 64}px;width:180px;height:38px;background:#282038;color:white`;
  document.body.append(button);
}
let root = createRoot(host);
let props;
function render() {
  root.render(
    React.createElement(EditorShell, {
      projectName: '新项目11',
      workspaceLabel: 'Saved',
      onBack() {},
      exportMenu: null,
      bottomToolbar: null,
      center: null,
      panels: [],
      workflowSwitcher: React.createElement(WorkflowModuleSwitcher, {
        activeModule: 'texture',
        compact: true,
        onOpenTexture() {},
        onOpenRetopology() {},
        onOpenUv() {},
        onOpenBake() {},
      }),
      onboarding: React.createElement(TextureOnboardingTour, props),
    }),
  );
}
window.fixture = {
  mount(id, suspended = false) {
    props = {
      key: id,
      projectId: id,
      projectCreatedAt: new Date().toISOString(),
      forceStart: true,
      suspended,
    };
    useWorkspaceLayoutStore.getState().setMode('scene');
    render();
  },
  remount() {
    root.unmount();
    root = createRoot(host);
    render();
  },
  suspend(value) {
    props = { ...props, suspended: value };
    render();
  },
  complete(name, value = true, generation = 'existing') {
    const target = document.querySelector(`[data-texture-onboarding="${name}"]`);
    target.dataset.onboardingComplete = String(value);
    target.dataset.onboardingGeneration = generation;
  },
  progress() {
    return JSON.parse(window.localStorage.getItem(`li3d:texture-onboarding:v3:${props.projectId}`));
  },
};
