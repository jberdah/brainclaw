import { useCallback, useState } from 'react';

export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : initial;
  });

  const update = useCallback(
    (next: T) => {
      localStorage.setItem(key, JSON.stringify(next));
      setValue(next);
    },
    [key],
  );

  return [value, update] as const;
}
