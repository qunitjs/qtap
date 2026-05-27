/**
 * The ISC License
 *
 * Copyright (c) Isaac Z. Schlueter and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
 * IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * --
 *
 * This is based on https://github.com/npm/node-which/blob/v7.0.0/lib/index.js with
 * the following modifications for QTap:
 * - Fork node-which to inline isexe 3.1.1, because isexe 3.1.3 and later are too large.
 *   The increase would fail our structure test for the "Lean" policy (ARCHITECTURE.md).
 *   The essential logic for node-which has been constant for years, easy to understand,
 *   easy to test, and adds more cost than benefit when maintained as a dependency.
 * - Simplify:
 *   - Remove async version, use sync always.
 *   - Remove "nothrow" option, enable always.
 *   - Remove unused "all", "path", "pathExt", "delimiter" options.
 *   - Remove isexe's unused "uid", "gid" options. Use plain `fs.accessSync(,X_OK)` and `stat.isFile()`.
 *   - Restrict feature set to just searching for commands in the pathenv:
 *     - Remove unneeded support for absolute paths (i.e. command with a slash like "/bin/foo").
 *       This responsibility is handled by /src/util.js#spawn.
 *     - Remove unneeded support for relative paths (i.e. "./foo").
 *     - Remove isexe "ignoreErrors" option, enable always.
 *     - Remove isexe feature for locating Windows-executable PATHEXT suffixes.
 *       Programs (e.g. Firefox) don't have suffixes that are user-dependent or otherwise not
 *       knowable in advance. To locate "FOO.COM", just specify that directly to keep code simple,
 *       greppable, and unsurprising. We don't need to emulate or predict everything Windows shell
 *       can find (i.e. locate "FOO.COM" given "FOO"). We only need to search the PATH choices,
 *       and use the absolute path after that. Besides, browsers on Windows aren't installed as
 *       shell commands, they're in PROGRAMFILES (see WINDOWS_DIRS in /src/browsers.js). To run a
 *       custom shell program in a QTap browser plugin, specify the absolute path to your bundled
 *       program or (if installed globally) include your program's suffix.
 */
'use strict';

import path from 'node:path';
import fs from 'node:fs';

// On Windows, this treats all links or files as executable.
function isexeSync (fullpath) {
  try {
    fs.accessSync(fullpath, fs.constants.X_OK);
    // Skip executable directories. https://github.com/npm/node-which/pull/46
    const stat = fs.statSync(fullpath);
    return stat.isSymbolicLink() || stat.isFile();
  } catch (er) {
    return false;
  }
}

function whichSync (cmd) {
  const pathEnv = (process.env.PATH || '').split(path.delimiter);
  for (const pathEnvPart of pathEnv) {
    const cmdPath = path.join(pathEnvPart, cmd);
    if (isexeSync(cmdPath)) {
      return cmdPath;
    }
  }
  return null;
}

export default whichSync;
