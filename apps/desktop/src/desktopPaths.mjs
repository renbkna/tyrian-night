// @ts-check

import path from 'node:path';

import { isSameOrDescendant, resolvePathIdentity } from './installOps.mjs';

/**
 * @typedef {{ configRoot: string; dataRoot: string; stateRoot: string }} DesktopXdgRoots
 */

/**
 * Resolve the XDG roots that belong to one destination home. Backups record
 * their targets relative to that home, so an XDG root outside it could not be
 * backed up or restored.
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
      throw new Error(`${variable} outside the destination home is unsupported`);
    }

    return root;
  };

  return {
    configRoot: resolveRoot('XDG_CONFIG_HOME', '.config'),
    dataRoot: resolveRoot('XDG_DATA_HOME', '.local/share'),
    stateRoot: resolveRoot('XDG_STATE_HOME', '.local/state'),
  };
}
