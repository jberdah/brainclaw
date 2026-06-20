import React from 'react';
import { Avatar } from './components/Avatar.js';
import { Button } from './components/Button.js';
import { formatUserName } from '../util/format.js';
import type { User } from '../util/types.js';

export interface HeaderProps {
  user: User | null;
  onSignOut: () => void;
}

export const Header = ({ user, onSignOut }: HeaderProps) => (
  <header className="app-header">
    {user ? (
      <>
        <Avatar user={user} />
        <span>{formatUserName(user)}</span>
        <Button label="Sign out" onClick={onSignOut} />
      </>
    ) : (
      <span>Welcome</span>
    )}
  </header>
);
