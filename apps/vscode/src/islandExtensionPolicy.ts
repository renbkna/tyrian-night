import type { IslandUiSupervisorStatus } from './islandSupervisor.js';

type PackageAccessResetStatus = IslandUiSupervisorStatus & {
  productWorkbenchChecksum: string;
  workbenchChecksum: string;
  writeAccess: NonNullable<IslandUiSupervisorStatus['writeAccess']> & {
    writable: true;
  };
};

export const OPEN_DOCTOR_ACTION = 'Open Doctor';
export const RESET_FILE_ACCESS_ACTION = 'Reset File Access';
export const TRUST_DOCS_ACTION = 'Why This Is Needed';
export const LATER_ACTION = 'Later';

export function buildWriteAccessActions(primaryAction: string | undefined): string[] {
  return primaryAction
    ? [primaryAction, TRUST_DOCS_ACTION, OPEN_DOCTOR_ACTION, LATER_ACTION]
    : [TRUST_DOCS_ACTION, OPEN_DOCTOR_ACTION, LATER_ACTION];
}

export function shouldOfferPackageAccessReset(
  status: IslandUiSupervisorStatus | undefined,
  writeAccessAvailable: boolean,
  restoreChanged: boolean,
  accessUnlockedForAppRoot: boolean
): status is PackageAccessResetStatus {
  return (
    restoreChanged &&
    accessUnlockedForAppRoot &&
    writeAccessAvailable &&
    status?.workbenchChecksum !== undefined &&
    status.productWorkbenchChecksum !== undefined &&
    status.writeAccess?.writable === true
  );
}
