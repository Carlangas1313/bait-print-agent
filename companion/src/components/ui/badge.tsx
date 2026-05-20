import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 tracking-wide uppercase",
  {
    variants: {
      variant: {
        default:
          "border-bait-cyan-500/30 bg-bait-cyan-500/15 text-bait-cyan-300",
        secondary:
          "border-white/15 bg-white/[0.06] text-foreground/80",
        destructive:
          "border-red-500/40 bg-red-500/15 text-red-300",
        warning:
          "border-bait-orange-500/40 bg-bait-orange-500/15 text-bait-orange-300",
        success:
          "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
        muted:
          "border-white/10 bg-white/[0.04] text-muted-foreground",
        outline: "text-foreground border-white/20",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
