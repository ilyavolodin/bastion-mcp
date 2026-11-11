import { slugify } from '@bastion-mcp/core/ids';
import * as React from 'react';

/**
 * A "URL name" that follows the display name until the user edits it (derived with core's `slugify`, 40 characters,
 * like the slugs of the API).
 */
export function useSlug(name: string) {
  const [custom, setCustom] = React.useState<string | null>(null);
  const slug = custom ?? slugify(name);
  return {
    slug,
    setSlug: (value: string) => setCustom(value),
    reset: () => setCustom(null),
  };
}
