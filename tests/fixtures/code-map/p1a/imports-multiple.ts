// §10: multiple imports of one module — each import statement is its own
// module node (legacy emits one module node per import site).
import { a } from './shared';
import { b } from './shared';
import defaultShared from './shared';
