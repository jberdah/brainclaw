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
import { rustProvider } from './rust/index.js';
import { csharpProvider } from './csharp/index.js';
import { rubyProvider } from './ruby/index.js';
import { cppProvider } from './cpp/index.js';
import { cProvider } from './c/index.js';

/**
 * The default registry, pre-loaded with the bundled providers. Add a new
 * provider's singleton to this `createRegistry(...)` call to register it.
 *
 * Registration ORDER is the collision tiebreak (earliest wins, after `priority`).
 * `cpp` is registered BEFORE `c` so the C++ provider (a superset that parses C
 * fine) wins the shared `.h` extension — a C header parses correctly as C++, but
 * a C++ header would not parse as C.
 */
export const defaultRegistry: DefaultCodeLanguageRegistry = createRegistry(
  typeScriptProvider,
  pythonProvider,
  phpProvider,
  javaProvider,
  goProvider,
  rustProvider,
  csharpProvider,
  rubyProvider,
  cppProvider,
  cProvider,
);
