import type { Layer } from '@/types/layer';
import type { Project } from '@/types/project';

function safeFileName(value: string) {
  return value.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'texture';
}

export function downloadBaseColorTexture(imageUrl: string, project: Project, layer?: Layer) {
  const anchor = document.createElement('a');
  anchor.href = imageUrl;
  anchor.download = `liclick_basecolor_${safeFileName(project.name)}_${safeFileName(layer?.name ?? 'layer')}.png`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
