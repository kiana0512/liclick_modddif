type LocalIdentityProofRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

function unavailable(): never {
  throw new Error('Cloud Build 使用平台会话，不支持设备身份桥接。');
}

export async function getLocalIdentityProof(
  _options: LocalIdentityProofRequestOptions = {},
): Promise<never> {
  return unavailable();
}

export async function fetchWithLocalIdentityProof(
  _input: string | URL,
  _init: RequestInit,
  _proofOptions: LocalIdentityProofRequestOptions = {},
): Promise<never> {
  return unavailable();
}
