import { cn } from "@/lib/utils";

interface CategoryPillProps {
  category: {
    name: string;
    color: string;
  };
  className?: string;
}

/**
 * Renders a small pill using the category's own colour field.
 * The colour is used as both the text and background (at low opacity),
 * keeping the design consistent with the project's token approach while
 * still allowing per-category customisation.
 */
export function CategoryPill({ category, className }: CategoryPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[3px] px-2 py-0.5 text-[11px] font-medium leading-none",
        className,
      )}
      style={{
        color: category.color,
        backgroundColor: `${category.color}18`, // 9% opacity background
        border: `1px solid ${category.color}30`, // 19% opacity border
      }}
    >
      {category.name}
    </span>
  );
}
