const mutationTails = new Map<string, Promise<void>>();

export function workspaceAssetMutationKey(input: {
  userId: string;
  projectSlug: string;
  category: string;
}) {
  return `${input.userId}:${input.projectSlug}:${input.category}`;
}

export async function runWithWorkspaceAssetMutationLock<T>(
  key: string,
  operation: () => Promise<T>,
) {
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  mutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  }
}
