import fs from 'node:fs'
import path from 'node:path'

// electron-builder discovers transitive runtime dependencies from appDir.
// Symlinking packages to the developer checkout makes that graph incomplete
// (for example, bindings loses file-uri-to-path), producing a package that
// stays alive behind a main-process error dialog. Clone the complete tree so
// the native rebuild remains isolated and dependency collection is faithful.
export function copyIsolatedNodeModules(repoRoot, copyRoot) {
  const sourceRoot = path.join(repoRoot, 'node_modules')
  const targetRoot = path.join(copyRoot, 'node_modules')
  if (!fs.statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Missing dependencies: ${sourceRoot}`)
  }
  fs.cpSync(sourceRoot, targetRoot, {
    recursive: true,
    dereference: true,
    mode: fs.constants.COPYFILE_FICLONE,
  })

  const isolatedNativeModule = path.join(targetRoot, 'better-sqlite3')
  if (fs.realpathSync(isolatedNativeModule) === fs.realpathSync(path.join(sourceRoot, 'better-sqlite3'))) {
    throw new Error('Native dependency is not isolated from the developer checkout')
  }
}
