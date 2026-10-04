import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Keep equal to the `--text-*` and `--radius-*` ramps in style.css `@theme`, or tailwind-merge reads `text-10.5` as a colour
// and drops it, and keeps `rounded-10` beside another radius instead of replacing it.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['10', '10.5', '11', '11.5', '12.5', '13', '13.5', '15'],
      radius: ['5', '7', '8', '9', '10', '11'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
