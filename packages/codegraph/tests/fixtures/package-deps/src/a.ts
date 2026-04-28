import _ from 'lodash'
import { readFile } from 'node:fs/promises'
import { join } from 'path'

export const a = _.chunk([1, 2, 3, 4], 2)
export { readFile, join }
