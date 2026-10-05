import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The "thank you" that replaces a form once it has been sent. The form's own button (where the focus was) is gone, so the notice takes
 * the focus: a keyboard or screen-reader user lands on what happened instead of at the top of the page, and the dialog's focus trap
 * keeps working. `role="status"` also announces it.
 */
export function SentNotice({ title, children }: { title?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <div className="sent" role="status" tabIndex={-1} ref={box}>
      {title ? <h3 className="sent__title">{title}</h3> : null}
      <p>{children}</p>
    </div>
  );
}
