import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GPT_TEXTURE_MODELS, getGptTextureQualities } from '@/engine/generation/gptTextureModels';

type Props = {
  model: string;
  quality: string;
  disabled: boolean;
  onModelChange: (value: string) => void;
  onQualityChange: (value: string) => void;
};

/** Presentation only: request validation stays in the generation policy. */
export function GptGenerationOptions({ model, quality, disabled, onModelChange, onQualityChange }: Props) {
  const [open, setOpen] = useState<'model' | 'quality' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const options = open === 'model' ? GPT_TEXTURE_MODELS : getGptTextureQualities(model);
  const selected = open === 'model' ? model : quality;
  const modelLabel = (value: string, label: string) => value.startsWith('gpt-image-2.5-') ? `GPT-Image 2.5 ${label}` : label;

  useLayoutEffect(() => {
    if (!open || disabled) {
      if (disabled) setOpen(null);
      return;
    }
    const position = () => {
      const anchor = root.current, menu = popup.current;
      if (!anchor || !menu) return;
      const rect = anchor.getBoundingClientRect();
      menu.style.width = `${Math.min(Math.max(rect.width, 280), window.innerWidth - 16)}px`;
      menu.style.maxHeight = `${Math.max(80, rect.top - 16)}px`;
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, rect.top - menu.offsetHeight - 8)}px`;
    };
    position();
    popup.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(null);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, disabled]);

  return <div ref={root} className="col-span-full mb-2 grid grid-cols-2 gap-2" aria-label="GPT 生图参数">
    {(['model', 'quality'] as const).map((kind) => <button
      key={kind}
      type="button"
      aria-label={kind === 'model' ? 'GPT 模型选择' : 'GPT 生图质量'}
      aria-haspopup="menu"
      aria-expanded={open === kind && !disabled}
      disabled={disabled}
      onClick={(event) => { trigger.current = event.currentTarget; setOpen(open === kind ? null : kind); }}
      className="gen-options-trigger"
    >
      <span className="truncate">{kind === 'model'
        ? GPT_TEXTURE_MODELS.find((item) => item.value === model)?.label
        : `质量 · ${getGptTextureQualities(model).find((item) => item.value === quality)?.label}`}</span>
      <span aria-hidden="true">▾</span>
    </button>)}
    {open && !disabled && createPortal(<div
      ref={popup}
      role="menu"
      aria-label={open === 'model' ? '选择模型' : '选择质量'}
      className="gen-options-popup"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !root.current?.contains(event.relatedTarget)) setOpen(null);
      }}
      onKeyDown={(event) => {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length
          : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
        if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
      }}
    >
      <p className="px-3 py-1 text-xs text-white/50">{open === 'model' ? 'GPT-Image' : '质量'}</p>
      {options.map((item) => <button
        key={item.value}
        type="button"
        role="menuitemradio"
        aria-checked={selected === item.value}
        onClick={() => {
          (open === 'model' ? onModelChange : onQualityChange)(item.value);
          setOpen(null);
          trigger.current?.focus();
        }}
        className={`gen-options-item ${selected === item.value ? 'bg-white/10 text-liclick-pink' : ''}`}
      >
        {open === 'model' ? modelLabel(item.value, item.label) : item.label}
        <span aria-hidden="true">{selected === item.value ? '✓' : ''}</span>
      </button>)}
    </div>, document.body)}
  </div>;
}
