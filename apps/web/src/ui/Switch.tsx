import { useId, type ReactNode } from 'react';

export interface SwitchProps {
  checked: boolean;
  onChange(checked: boolean): void;
  label: ReactNode;
  /** id of the element that explains the switch (read after its label). */
  describedBy?: string;
  disabled?: boolean;
}

/** A real checkbox with role="switch": keyboard, screen readers and forms work as they should. */
export function Switch({ checked, onChange, label, describedBy, disabled }: SwitchProps) {
  const id = useId();
  return (
    <label className="switch" htmlFor={id}>
      <input
        id={id}
        className="switch__input"
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
      <span className="switch__label">{label}</span>
    </label>
  );
}
