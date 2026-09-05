// @ts-check

import path from 'node:path';

import { isSameOrDescendant, resolvePathIdentity } from './installOps.mjs';

/**
 * @typedef {{ configRoot: string; dataRoot: string; stateRoot: string }} DesktopXdgRoots
 */

/**
 * Resolve the XDG roots that belong to one destination home. Desktop state is
 * recovered through that home, so an XDG root outside it would make recovery
 * authority ambiguous.
 *
 * Callers decide whether an omitted environment means `process.env` or an
 * empty environment. This owner only validates and resolves the supplied
 * values.
 *
 * @param {string} userHome
 * @param {NodeJS.ProcessEnv} environment
 * @returns {DesktopXdgRoots}
 */
export function resolveDesktopXdgRoots(userHome, environment) {
  const resolvedHome = resolvePathIdentity(userHome);

  /**
   * @param {'XDG_CONFIG_HOME' | 'XDG_DATA_HOME' | 'XDG_STATE_HOME'} variable
   * @param {string} fallback
   * @returns {string}
   */
  const resolveRoot = (variable, fallback) => {
    const configured = environment[variable];

    if (configured !== undefined && !path.isAbsolute(configured)) {
      throw new Error(`${variable} must be an absolute path`);
    }

    const root = resolvePathIdentity(configured ?? path.join(resolvedHome, fallback));

    if (!isSameOrDescendant(resolvedHome, root)) {
      throw new Error(`${variable} outside the destination home is unsupported for recovery`);
    }

    return root;
  };

  return {
    configRoot: resolveRoot('XDG_CONFIG_HOME', '.config'),
    dataRoot: resolveRoot('XDG_DATA_HOME', '.local/share'),
    stateRoot: resolveRoot('XDG_STATE_HOME', '.local/state'),
  };
}

/**
 * Resolve one logical path inside the destination's XDG config root. The
 * containment check is repeated after physical path resolution so a symlinked
 * suffix cannot turn a config-key into authority outside that root.
 *
 * @param {DesktopXdgRoots} xdgRoots
 * @param {string} configRelativePath
 * @returns {string}
 */
export function resolveDesktopXdgConfigPath(xdgRoots, configRelativePath) {
  if (
    path.isAbsolute(configRelativePath) ||
    configRelativePath.length === 0 ||
    configRelativePath
      .split(/[\\/]/u)
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`XDG config path must be a non-empty relative path: ${configRelativePath}`);
  }

  const configPath = resolvePathIdentity(path.join(xdgRoots.configRoot, configRelativePath));

  if (!isSameOrDescendant(xdgRoots.configRoot, configPath)) {
    throw new Error(`XDG config path escapes XDG_CONFIG_HOME: ${configRelativePath}`);
  }

  return configPath;
}
