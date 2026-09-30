import type { CSSProperties, ReactNode } from 'react';
import type { Direction } from '../i18n';

export interface SheetDirectionProps {
  /** The sheet's own direction (rules `output.direction`, or the input table's `direction`). */
  direction: Direction;
  children: ReactNode;
  className?: string;
}

const isolate: CSSProperties = { unicodeBidi: 'isolate' };

/**
 * SPEC 16.2 "Sheet direction": a preview grid follows the sheet's direction, not the UI
 * language, so a Hebrew sheet renders right-to-left even in the English UI (and an
 * English sheet stays left-to-right in the Hebrew UI). Wrap a grid (or any sheet
 * content) in this; `dir` on the element sets the reading order of everything inside,
 * and `unicode-bidi: isolate` keeps it from mixing with the surrounding page text.
 */
export function SheetDirection({ direction, children, className }: SheetDirectionProps) {
  return (
    <div dir={direction} className={className} style={isolate} data-sheet-direction={direction}>
      {children}
    </div>
  );
}
