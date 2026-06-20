import React from 'react';
import { useAuth } from '../hooks/useAuth.js';
import { Header } from './Header.js';
import { Dashboard } from './Dashboard.js';
import { LoginForm } from './components/LoginForm.js';

export const App = () => {
  const { session, status, signOut } = useAuth();

  return (
    <div className="app">
      <Header user={session.user} onSignOut={signOut} />
      {status === 'authenticated' && session.user ? (
        <Dashboard user={session.user} items={['alpha', 'beta']} />
      ) : (
        <LoginForm />
      )}
    </div>
  );
};

export default App;
