import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { AgentStatus } from "@/lib/mock-data";

interface StatusDotProps {
  status: AgentStatus | "pending" | "warning" | "active" | "inactive";
  size?: "sm" | "md" | "lg";
  pulse?: boolean;
  className?: string;
}

const STATUS_TO_COLOR: Record<string, string> = {
  online: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]",
  active: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]",
  degraded: "bg-bait-orange-400 shadow-[0_0_8px_rgba(255,122,82,0.7)]",
  warning: "bg-bait-orange-400 shadow-[0_0_8px_rgba(255,122,82,0.7)]",
  pending: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]",
  offline: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.7)]",
  inactive: "bg-zinc-500",
};

const SIZE_MAP = {
  sm: "h-1.5 w-1.5",
  md: "h-2.5 w-2.5",
  lg: "h-3 w-3",
};

export function StatusDot({
  status,
  size = "md",
  pulse = true,
  className,
}: StatusDotProps) {
  const colorClass = STATUS_TO_COLOR[status] ?? STATUS_TO_COLOR.inactive;
  const sizeClass = SIZE_MAP[size];
  const isAlive = status !== "offline" && status !== "inactive";

  return (
    <div className={cn("relative inline-flex items-center", className)}>
      {isAlive && pulse && (
        <motion.span
          className={cn(
            "absolute inset-0 rounded-full",
            colorClass,
            "opacity-50"
          )}
          animate={{ scale: [1, 1.8, 1], opacity: [0.5, 0, 0.5] }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      )}
      <span
        className={cn(
          "relative inline-block rounded-full",
          sizeClass,
          colorClass
        )}
      />
    </div>
  );
}
