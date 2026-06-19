import React from 'react';

export interface ButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export const Button = ({ label, onClick, disabled }: ButtonProps) => (
  <button type="button" disabled={disabled} onClick={onClick}>
    {label}
  </button>
);
