import React from 'react';
import type { User } from '../../util/types.js';
import { capitalize } from '../../util/format.js';

export interface AvatarProps {
  user: User;
  size?: number;
}

export const Avatar = ({ user, size = 32 }: AvatarProps) => {
  const initial = capitalize(user.name[0] ?? '?');
  return (
    <span className="avatar" style={{ width: size, height: size }}>
      {initial}
    </span>
  );
};
