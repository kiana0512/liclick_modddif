export const localComponentDownloadAvailable = false;

export async function downloadLocalComponent(): Promise<never> {
  throw new Error('Cloud Build does not support downloadable host extensions.');
}
