import fs from 'node:fs'
import path from 'node:path'
import type { ProviderHelperDeclarationV1 } from '../../../src/provider-api/v1'
import { isPathInsideRoot, resolveAllowedExistingFile } from '../security/pathPolicy'

/** Validate and canonicalize an argv before a declared helper is spawned. */
export function resolveHelperArguments(
  declaration: ProviderHelperDeclarationV1,
  args: string[],
  cacheRoot: string,
): string[] {
  const template = declaration.argumentTemplate
  if (!template) {
    if (args.some((argument) => !(declaration.allowedArguments ?? []).includes(argument))) {
      throw new Error(`Provider helper ${declaration.id} received an undeclared argument`)
    }
    return args
  }
  if (args.length !== template.length) throw new Error(`Provider helper ${declaration.id} received an invalid argv shape`)
  const canonicalRoot = fs.realpathSync.native(cacheRoot)
  return args.map((argument, index) => {
    const expected = template[index]
    if (typeof expected === 'string') {
      if (argument !== expected) throw new Error(`Provider helper ${declaration.id} received an undeclared argument`)
      return argument
    }
    if (typeof argument !== 'string' || !path.isAbsolute(argument) || argument.includes('\0')) {
      throw new Error(`Provider helper ${declaration.id} requires an absolute cache path`)
    }
    if (expected.cachePath === 'input') {
      const input = resolveAllowedExistingFile(argument, [canonicalRoot])
      if (!input) throw new Error(`Provider helper ${declaration.id} input is outside its cache root`)
      return input
    }
    const parent = fs.realpathSync.native(path.dirname(argument))
    if (!isPathInsideRoot(parent, canonicalRoot)) {
      throw new Error(`Provider helper ${declaration.id} output is outside its cache root`)
    }
    const output = path.join(parent, path.basename(argument))
    if (fs.lstatSync(output, { throwIfNoEntry: false })) {
      throw new Error(`Provider helper ${declaration.id} output already exists`)
    }
    return output
  })
}
