import { cn } from '@/components/common/cn';

type SegmentedControlProps<T extends string> = {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  className?: string;
};

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div className={cn('flex rounded-md bg-white/7 p-1', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-7 flex-1 rounded px-2 text-xs font-medium text-white/56 transition',
            value === option.value && 'bg-white text-ink shadow-sm',
            option.disabled && 'cursor-not-allowed opacity-35',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
