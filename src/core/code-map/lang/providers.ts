/**
 * Code Map — default provider REGISTRATION list (P1b §3.2).
 *
 * This is the single declared EXTENSION POINT for "which language providers ship
 * by default". Adding a language = importing its provider here and adding it to
 * the `createRegistry(...)` call below — NOT editing `core.ts` (the orchestration)
 * or the registry mechanics. `core.ts` imports the constructed `defaultRegistry`
 * from this module.
 *
 * Registration order is the secondary collision tiebreak (after `priority`); keep
 * it intentional. Pure construction — no behavior change vs the P1a inline
 * `createRegistry(typeScriptProvider)` that previously lived in `core.ts`.
 */
import { DefaultCodeLanguageRegistry, createRegistry } from './registry.js';
import { typeScriptProvider } from './typescript/index.js';
import { pythonProvider } from './python/index.js';
import { phpProvider } from './php/index.js';
import { javaProvider } from './java/index.js';
import { goProvider } from './go/index.js';

/**
 * The default registry, pre-loaded with the bundled providers. Add a new
 * provider's singleton to this `createRegistry(...)` call to register it.
 */
export const defaultRegistry: DefaultCodeLanguageRegistry = createRegistry(
  typeScriptProvider,
  pythonProvider,
  phpProvider,
  javaProvider,
  goProvider,
);
