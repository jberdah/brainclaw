import React, { useState } from 'react';
import { Button } from './Button.js';
import { useAuth } from '../../hooks/useAuth.js';

export const LoginForm = () => {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void signIn(email, password);
      }}
    >
      <input value={email} onChange={(e) => setEmail(e.target.value)} />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Button label="Sign in" onClick={() => void signIn(email, password)} />
    </form>
  );
};
