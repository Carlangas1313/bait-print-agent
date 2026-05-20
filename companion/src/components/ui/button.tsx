import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.98]",
  {
    variants: {
      variant: {
        default:
          "bg-bait-cyan-500 text-bait-navy-900 hover:bg-bait-cyan-400 shadow-[0_0_0_1px_rgba(0,188,212,0.3),0_4px_14px_-2px_rgba(0,188,212,0.35)] hover:shadow-[0_0_0_1px_rgba(0,188,212,0.45),0_6px_18px_-2px_rgba(0,188,212,0.5)]",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-white/15 bg-white/[0.03] text-foreground hover:bg-white/[0.08] hover:border-white/25",
        secondary:
          "bg-white/[0.06] text-foreground hover:bg-white/[0.10] border border-white/10",
        ghost: "hover:bg-white/[0.06] text-foreground",
        link: "text-bait-cyan-400 underline-offset-4 hover:underline",
        accent:
          "bg-bait-orange-500 text-white hover:bg-bait-orange-400 shadow-[0_4px_14px_-2px_rgba(255,107,53,0.45)]",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-lg px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
