// §10: alias imports / exports — source-side names are recorded (not aliases).
import { original as renamed, other as o } from './source';

function localThing(): void {}

export { localThing as exportedName };
