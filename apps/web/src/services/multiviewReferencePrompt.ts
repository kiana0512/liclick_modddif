import templateUrl from './multiviewReferencePrompt.txt?no-inline&url';

// MULTIVIEW-REFERENCE-PROMPT/1.1.0: Vite hashes the template with the release.
let templatePromise: Promise<string> | undefined;

export async function buildMultiviewPrompt(userPrompt: string): Promise<string> {
  templatePromise ??= fetch(templateUrl, { signal: AbortSignal.timeout(10_000) })
    .then(async (response) => {
      if (!response.ok) throw new Error('六视图提示词加载失败，请重试。');
      const template = await response.text();
      if (!template.trim()) throw new Error('六视图提示词为空，请刷新后重试。');
      return template;
    })
    .catch((error) => {
      templatePromise = undefined;
      throw error;
    });
  const template = await templatePromise;
  const trimmedPrompt = userPrompt.trim();
  return trimmedPrompt ? `${template}\n\n用户补充要求：${trimmedPrompt}` : template;
}
