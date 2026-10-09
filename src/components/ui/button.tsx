import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "btn-press inline-flex cursor-pointer touch-manipulation items-center justify-center gap-2 whitespace-nowrap rounded-xl font-semibold transition-[transform,background-color,opacity] duration-150 ease-out select-none disabled:pointer-events-none disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-fg-brand)] active:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--color-fg-brand)] text-[var(--color-fg-always-dark)] hover:bg-[var(--color-green-3)] active:bg-[var(--color-green-3)]",
        surface:
          "bg-[var(--color-bg-surface)] text-[var(--color-fg-base)] hover:bg-[color-mix(in_srgb,var(--color-bg-surface)_82%,var(--color-white-1))] active:bg-[color-mix(in_srgb,var(--color-bg-surface)_75%,var(--color-white-1))]",
        secondary:
          "bg-[var(--color-bg-surface)] text-[var(--color-fg-base)] hover:bg-[color-mix(in_srgb,var(--color-bg-surface)_82%,var(--color-white-1))] active:bg-[color-mix(in_srgb,var(--color-bg-surface)_75%,var(--color-white-1))]",
        ghost: "bg-transparent text-[var(--color-fg-base)] hover:bg-[var(--color-bg-surface)]",
        outline:
          "border border-white/15 bg-transparent text-[var(--color-fg-base)] hover:bg-[var(--color-bg-surface)]",
        destructive:
          "bg-[var(--color-bg-danger)] text-white hover:bg-[color-mix(in_srgb,var(--color-bg-danger)_85%,black)]",
        link: "h-auto rounded-none bg-transparent p-0 text-[var(--color-fg-brand)] underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        default: "h-14 px-5 text-lg",
        lg: "h-16 px-6 text-xl w-full",
        sm: "h-9 gap-1.5 rounded-lg px-3 text-sm",
        xs: "h-7 gap-1 rounded-md px-2 text-xs",
        icon: "size-12",
        "icon-sm": "size-8 rounded-lg",
        "icon-xs": "size-6 rounded-md",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button"
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { buttonVariants }
