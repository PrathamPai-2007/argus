import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Slot } from "@radix-ui/react-slot";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { motion } from "motion/react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/format.ts";

// shadcn/ui-style primitives (Radix + cva), restyled to the Argus palette.

const buttonStyles = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-amber text-bg hover:bg-amber/90",
        ghost: "text-muted hover:bg-raised hover:text-text",
        outline: "border border-line text-text hover:bg-raised",
      },
      size: { sm: "h-7 px-2.5", md: "h-9 px-3.5", icon: "size-8" },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

export function Button({ className, variant, size, asChild, ...props }: ComponentProps<"button"> & VariantProps<typeof buttonStyles> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}

const badgeStyles = cva("inline-flex items-center gap-1 rounded px-1.5 py-px text-[11.5px] font-medium leading-5", {
  variants: {
    tone: {
      neutral: "bg-raised text-muted",
      amber: "bg-amber-soft text-amber",
      gain: "bg-gain/12 text-gain",
      warn: "bg-warn/12 text-warn",
      loss: "bg-loss/12 text-loss",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeStyles>) {
  return <span className={cn(badgeStyles({ tone }), className)} {...props} />;
}

export function Tip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TooltipPrimitive.Root delayDuration={200}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={6} className="z-50 max-w-xs rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-text shadow-lg shadow-black/20 data-[state=delayed-open]:animate-in">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const TipProvider = TooltipPrimitive.Provider;

/** Segmented control: one choice from a small set, with a sliding indicator. */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode }>; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("relative rounded-md px-3 py-1 text-[13px] transition-colors", value === o.value ? "text-text" : "text-muted hover:text-text")}
        >
          {value === o.value && <motion.span layoutId={`seg-${label}`} className="absolute inset-0 rounded-md bg-raised" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Sheet({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; children: ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" />
        <DialogPrimitive.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-line bg-surface shadow-2xl outline-none">
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <DialogPrimitive.Title className="font-display text-lg font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button size="icon" aria-label="Close"><X /></Button>
            </DialogPrimitive.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-5">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-raised", className)} />;
}

export function Panel({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border border-line bg-surface", className)}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-[13.5px] font-semibold">{title}</h2>
          {aside && <div className="text-[12.5px] text-muted">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <p className="font-medium">{title}</p>
      {children && <p className="mt-1 max-w-md text-[13px] text-muted">{children}</p>}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-loss/30 bg-loss/8 px-4 py-3 text-[13px]">
      <span>{message}</span>
      {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>}
    </div>
  );
}
