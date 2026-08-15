export const CONTENT_AWARE_REPAIR_REQUEST_EVENT = 'liclick:content-aware-repair-request';

export type ContentAwareRepairRequestDetail = {
  source: 'multiview-texture';
  projectId?: string;
  objectId?: string;
  batchId: string;
  silentForeground?: boolean;
  handled: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export function requestContentAwareRepair(
  detail: Omit<ContentAwareRepairRequestDetail, 'handled' | 'resolve' | 'reject'>,
) {
  return new Promise<void>((resolve, reject) => {
    const request: ContentAwareRepairRequestDetail = {
      ...detail,
      handled: false,
      resolve,
      reject,
    };
    window.dispatchEvent(
      new CustomEvent<ContentAwareRepairRequestDetail>(CONTENT_AWARE_REPAIR_REQUEST_EVENT, {
        detail: request,
      }),
    );
    if (!request.handled) {
      reject(new Error('当前编辑器没有可用的内容识别修补处理器。'));
    }
  });
}
