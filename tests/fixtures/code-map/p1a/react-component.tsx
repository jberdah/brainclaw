// §10: React component + hook subtypes.
import React, { useEffect } from 'react';

export function useAuth() {
  const [user] = React.useState(null);
  useEffect(() => {}, []);
  return user;
}

export const Panel = () => {
  useEffect(() => {}, []);
  return <div className="panel"><span>hi</span></div>;
};

function Widget() {
  return <p>widget</p>;
}

const notAComponent = () => 42;
