import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/components/common/cn';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: ReactNode;
};

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-gradient-to-r from-liclick-pink to-liclick-purple text-white shadow-glow hover:brightness-110',
  secondary: 'bg-white/10 text-white hover:bg-white/16 border border-white/10',
  ghost: 'text-white/76 hover:bg-white/10',
  danger: 'bg-rose-500/18 text-rose-100 hover:bg-rose-500/28 border border-rose-300/20',
};

export function Button({ className, variant = 'secondary', icon, children, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}
