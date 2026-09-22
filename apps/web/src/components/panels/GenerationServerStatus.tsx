import { useEffect, useState } from 'react';
import type { Generation } from '@/types/generation';

export function GenerationServerStatus({ generation }: { generation: Generation }) {
  const [server, setServer] = useState<{ id: string; provider: unknown; label: string }>();
  const provider = generation.metadata.provider;
  useEffect(() => {
    const controller = new AbortController();
    void import('@/services/modelviewApiClient').then(async ({ getGenerationServerLabel }) => {
      const label = await getGenerationServerLabel(provider, controller.signal);
      if (!controller.signal.aborted) setServer({ id: generation.id, provider, label });
    }).catch(() => {
      if (!controller.signal.aborted) setServer({ id: generation.id, provider, label: '服务器信息暂不可用' });
    });
    return () => controller.abort();
  }, [generation.id, provider]);
  return <span className="block break-all text-xs font-normal text-white/62">
    服务器：{server?.id === generation.id && server.provider === provider ? server.label : '正在确认'}
  </span>;
}
