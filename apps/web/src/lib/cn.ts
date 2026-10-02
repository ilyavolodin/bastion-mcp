import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The Zest type styles are custom utilities (`text-label`, `text-overline`, ...). Registering them as
 * their own group keeps tailwind-merge from mistaking them for colours and dropping one of the two.
 */
const twMerge = extendTailwindMerge<'zest-type'>({
  extend: {
    classGroups: {
      'zest-type': [
        'text-page-title',
        'text-card-title',
        'text-figure-xl',
        'text-figure-lg',
        'text-figure-sm',
        'text-label',
        'text-caption',
        'text-overline',
      ],
    },
  },
});

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
