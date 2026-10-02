import { useWindowDimensions } from 'react-native';

import { layout } from './theme';

/** Breakpoint flags. Wide = desktop web (sidebar shell, tables); otherwise phone layout. */
export function useLayout() {
  const { width } = useWindowDimensions();
  return {
    width,
    wide: width >= layout.wide,
    medium: width >= layout.medium,
    /** Horizontal page padding. */
    gutter: width >= layout.wide ? 32 : width >= layout.medium ? 24 : 16,
  };
}
