// §10: .jsx extension coverage (resolves to the tsx grammar).
import React from 'react';

export function useToggle() {
  return React.useState(false);
}

export const Box = () => {
  return <div>box</div>;
};

export default Box;
