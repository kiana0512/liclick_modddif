export const allowedLicenseFamilies = ['MIT', 'Apache-2.0', 'BSD', 'ISC', 'Zlib'] as const;
export const blockedCoreLicenseFamilies = ['GPL', 'AGPL'] as const;

export function isCoreLicenseAllowed(license: string) {
  const normalized = license.toLowerCase();
  return !blockedCoreLicenseFamilies.some((blocked) => normalized.includes(blocked.toLowerCase()));
}
