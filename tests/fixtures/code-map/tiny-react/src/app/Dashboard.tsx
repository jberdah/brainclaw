import React from 'react';
import { useToggle } from '../hooks/useToggle.js';
import { Button } from './components/Button.js';
import { pluralize } from '../util/format.js';
import type { User } from '../util/types.js';

export interface DashboardProps {
  user: User;
  items: string[];
}

export const Dashboard = ({ user, items }: DashboardProps) => {
  const [expanded, toggle] = useToggle(false);
  return (
    <section>
      <h1>Hello {user.name}</h1>
      <p>
        {items.length} {pluralize(items.length, 'item')}
      </p>
      <Button label={expanded ? 'Collapse' : 'Expand'} onClick={toggle} />
      {expanded && <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>}
    </section>
  );
};
