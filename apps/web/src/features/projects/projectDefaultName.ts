export function getNextDefaultProjectName(projectNames: string[], prefix: string) {
  const normalizedPrefix = prefix.trim() ? prefix : 'Project ';
  const usedNames = new Set(
    projectNames.map((name) => name.trim().toLocaleLowerCase()).filter(Boolean),
  );
  let index = 1;
  while (usedNames.has(`${normalizedPrefix}${index}`.toLocaleLowerCase())) index += 1;
  return `${normalizedPrefix}${index}`;
}
