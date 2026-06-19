// §10: named / default / namespace imports.
import { readFileSync } from 'node:fs';
import defaultHelper from './helper';
import * as utils from './utils';
import { join, resolve } from 'node:path';
