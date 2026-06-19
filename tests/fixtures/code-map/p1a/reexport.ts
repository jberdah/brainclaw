// §10: re-exports from / * — module node + imports edge, NO phantom symbol.
export { helper, other as o } from './helper';
export * from './star';
import { localImport } from './local';
